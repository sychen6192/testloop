// ApiRunner: OpenAI-compatible chat completions with tool calling, no agent CLI in between.
//
// Why a third runner. The opencode path spawns a CLI per session and inherits its permission
// model, event format, ripgrep dependency and Windows spawn rules — most of README's
// troubleshooting section — plus a fixed ~20k-token session overhead from plugin/MCP schemas.
// Here the loop is ours: the tools the model can call are the ones in api-tools.ts and nothing
// else, tool calls are counted exactly (the reviewer must-read guard), and the only transport
// is HTTP. Any server speaking POST /v1/chat/completions with `tools` works: Ollama, vLLM,
// LM Studio, OpenAI, and Anthropic's OpenAI-compatibility endpoint.
//
// Runs are single-shot and stateless, like the other runners: one system prompt (the agent's
// role contract), one user prompt, a tool loop, one final text. Nothing is carried between
// calls — cross-round state stays in runs/ artifacts (AGENTS.md mechanism 4).
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentRunner, AgentRunOutput, AgentRunStatus } from "../libs/types";
import {
  REPO_ROOT,
  TESTGEN_ROOT,
  GLOBAL_OPENCODE_DIR,
  API_BASE_URL,
  API_KEY,
  API_MAX_TURNS,
  API_MAX_TOKENS,
  API_MAX_TOOL_RESULT_CHARS,
  AGENT_TIMEOUT_MS,
  AGENT_RETRY_WINDOW_MS,
  WRITER_MODEL,
  REVIEWER_MODEL,
  WRITER_TEMPERATURE,
  REVIEWER_TEMPERATURE,
} from "../config";
import { log, logVerbose, startHeartbeat } from "../libs/log";
import { resolveAgentPath } from "../libs/guard";
import { ToolSpec, execTool, toOpenAiTools, toolsFor } from "./api-tools";
import { dispatcherFor, USER_AGENT } from "../libs/proxy";

export interface RoleContract {
  text: string;
  source: "repo" | "global" | "tool";
  path: string;
}

/**
 * The agent's role contract: the agent file's body with the frontmatter stripped. Same SSOT
 * and the same resolution order as the opencode runner (target repo .opencode/agent →
 * ~/.config/opencode/agent → this tool's own .opencode/agent), so a repo-level override of the
 * reviewer applies to both runners and `npm run setup` is not required for this one. The
 * frontmatter's tools/permissions are not consulted — permissions here are the tool list.
 */
export function loadRoleContract(agent: string, repoRoot: string): RoleContract | null {
  const found = resolveAgentPath(agent, repoRoot, GLOBAL_OPENCODE_DIR);
  const builtIn = path.join(TESTGEN_ROOT, ".opencode", "agent", `${agent}.md`);
  const pick: { path: string; source: RoleContract["source"] } | null =
    found ?? (fs.existsSync(builtIn) ? { path: builtIn, source: "tool" } : null);
  if (!pick) return null;
  const raw = fs.readFileSync(pick.path, "utf8");
  const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return { text, source: pick.source, path: pick.path };
}

export interface ApiRunnerOptions {
  repoRoot?: string;
  // The writer's write scope (the target module's src/test). Undefined = the writer's
  // write tools refuse every path.
  writableRoot?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: { writer: string; reviewer: string };
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxToolResultChars?: number;
  retryDelayMs?: number;
  // How long one request keeps being retried through transient failures, once the endpoint has
  // answered at least once this run.
  retryWindowMs?: number;
  // Tests inject a scripted transport; production uses global fetch.
  fetchImpl?: typeof fetch;
}

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}
interface ChatResponse {
  choices?: Array<{
    // reasoning_content: QwQ, DeepSeek-R1 and friends served by vLLM or Ollama put the answer
    // there and leave content empty, so a reader of content alone sees a model that said nothing.
    // `reasoning` is the current name (vLLM, Ollama, OpenRouter); reasoning_content the older
    // one. content may also arrive as an array of parts (Mistral, some LiteLLM passthroughs).
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { completion_tokens?: number };
}
type ChatMessage = Record<string, unknown>;

// Why a request failed, which decides what the run does next:
// - timeout:   the run's own deadline passed.
// - config:    401/403/404 — the key, the permission or the model name is wrong. No amount of
//              retrying changes that, and the loop must stop rather than blame the model.
// - context:   the conversation no longer fits the model's context window. Recoverable by
//              making the conversation shorter, never by sending the same request again.
// - transient: network errors, 408/425/429/5xx, a body that is not JSON — still failing after
//              the retry window.
// - rejected:  any other 4xx: the server refused this particular request.
type FailureKind = "timeout" | "config" | "context" | "transient" | "rejected";
type ChatResult =
  | { ok: true; json: ChatResponse }
  | { ok: false; error: string; kind: FailureKind; limit?: number; used?: number };

// Before the endpoint has answered once, a failure is almost always configuration (wrong URL,
// server not up, proxy in the way); the first run of a new setup should say so in seconds,
// not minutes. After it has answered, the same failure is an outage, and outages end.
const FIRST_CONTACT_ATTEMPTS = 3;
// Attempts inside the retry window are bounded too, so a zero backoff cannot spin — by a count
// derived from the window (it fills the window at the capped backoff), never one that ends a
// long window early.
const MAX_ATTEMPTS = 20;
const MAX_BACKOFF_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Context-overflow wording across OpenAI-compatible servers: vLLM and OpenAI ("maximum context
// length is N tokens"), TGI ("`inputs` tokens + `max_new_tokens` must be <= N"), llama.cpp
// (exceed_context_size_error with n_ctx), SGLang ("longer than the model's context length"),
// LM Studio ("context length of only N tokens").
const CONTEXT_OVERFLOW =
  /context length|context_length|context window|context size|exceed_context|maximum context|max_model_len|max_new_tokens|max_tokens.{0,40}too large|too many tokens|prompt is too long|reduce the length/i;

/** Pure: the limit and the prompt size a context-overflow error states, when it states them. */
export function parseContextOverflow(body: string): { limit?: number; used?: number } {
  const num = (res: RegExp[]) => {
    for (const re of res) {
      const m = re.exec(body);
      if (m) return Number(m[1]);
    }
    return undefined;
  };
  return {
    limit: num([
      /maximum context length is (\d+)/i,
      /must be <= (\d+)/i,
      /"n_ctx"\s*:\s*(\d+)/i,
      /context length of (?:only )?(\d+)/i,
      /model'?s context length \((\d+)/i,
    ]),
    used: num([
      /\((\d+) in the messages/i,
      /request has (\d+) input tokens/i,
      /messages resulted in (\d+) tokens/i,
      /Given: (\d+) `inputs` tokens/i,
      /"n_prompt_tokens"\s*:\s*(\d+)/i,
      /The input \((\d+) tokens\)/i,
    ]),
  };
}

/** Pure: which FailureKind an HTTP error status and body amount to. */
export function classifyHttpFailure(status: number, body: string): FailureKind {
  if ((status === 400 || status === 413 || status === 422) && CONTEXT_OVERFLOW.test(body)) return "context";
  if (status === 401 || status === 403 || status === 404) return "config";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
  return "rejected";
}

/** Pure: Retry-After (seconds or an HTTP date) in ms, or undefined. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

// How many times one session is told its tool call did not arrive (cut off, or sent as text)
// before its output is taken as it is.
const MAX_NUDGES = 3;

function truncatedNudge(maxTokens: number): string {
  return (
    `（系統）你上一則回覆超過輸出上限（max_tokens=${maxTokens || "伺服器預設"}）被截斷，工具呼叫沒有完整送出，` +
    "檔案沒有被寫入。請把工作拆成較小的步驟重新呼叫工具：例如先用 write_file 寫出只含部分測試方法的較短版本，" +
    "再用 replace_in_file 逐段補上其餘方法。不要重複送出同樣長度的內容。"
  );
}

// For a session without write tools (the reviewer) a cut-off answer is shortened, not split into
// file writes it has no tool for.
const TRUNCATED_ANSWER_NUDGE =
  "（系統）你上一則回覆超過輸出上限被截斷了。請重新輸出，只給最終要求的內容（例如單一 JSON 物件），不要附加說明或草稿。";

const UNPARSED_CALL_NUDGE =
  "（系統）你上一則回覆把工具呼叫寫成了文字，伺服器沒有把它解析成 tool call，所以什麼都沒有執行、檔案沒有被寫入。" +
  "請直接使用提供的工具（function calling）重新呼叫，不要把呼叫內容寫在回覆文字裡。";

/** Pure: does this text look like a tool call the server failed to parse? */
export function looksLikeToolCallText(text: string, specs: readonly ToolSpec[]): boolean {
  if (/<\/?tool_call>|<\|tool_call|<function=/.test(text)) return true;
  const names = specs.map((t) => t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`"name"\\s*:\\s*"(?:${names})"\\s*,\\s*"(?:arguments|parameters)"`).test(text);
}

/** Pure: the text in a message field that may be a string or an array of content parts. */
export function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((p) =>
      typeof p === "string"
        ? p
        : p && typeof p === "object" && (p as { type?: string }).type === "text"
          ? String((p as { text?: unknown }).text ?? "")
          : "",
    )
    .join("");
}

/**
 * Pure: a completion rebuilt from a server-sent-events body, or null if it is not one.
 * Some gateways stream whatever the request asked for; the deltas are joined back into the one
 * message a stream:false response would have carried.
 */
export function completionFromSse(body: string): ChatResponse | null {
  if (!/^\s*(?:data|event|id):/m.test(body.slice(0, 200))) return null;
  let content = "";
  let reasoning = "";
  let finish: string | undefined;
  let completionTokens: number | undefined;
  const calls: ToolCall[] = [];
  let sawChunk = false;
  let done = false;
  let streamError: unknown;
  for (const line of body.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (m && m[1].trim() === "[DONE]") done = true;
    if (!m || m[1].trim() === "[DONE]" || !m[1].trim()) continue;
    let chunk: {
      choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
      usage?: { completion_tokens?: number };
      error?: unknown;
    };
    try {
      chunk = JSON.parse(m[1]);
    } catch {
      continue;
    }
    sawChunk = true;
    if (chunk.error !== undefined && chunk.error !== null) streamError = chunk.error;
    if (chunk.usage?.completion_tokens !== undefined) completionTokens = chunk.usage.completion_tokens;
    const c = chunk.choices?.[0];
    if (!c) continue;
    if (c.finish_reason) finish = c.finish_reason;
    const d = c.delta ?? {};
    content += textOf(d.content);
    reasoning += textOf(d.reasoning_content) || textOf(d.reasoning);
    for (const tc of (d.tool_calls as Array<ToolCall & { index?: number }>) ?? []) {
      const i = tc.index ?? calls.length;
      const into = (calls[i] ??= { id: undefined, type: "function", function: { name: "", arguments: "" } });
      if (tc.id) into.id = tc.id;
      if (tc.function?.name) into.function!.name = (into.function!.name ?? "") + tc.function.name;
      if (typeof tc.function?.arguments === "string") into.function!.arguments = String(into.function!.arguments ?? "") + tc.function.arguments;
    }
  }
  if (!sawChunk) return null;
  // A gateway reports an upstream failure mid-stream as an error event, and a stream cut off by a
  // dropped connection simply ends: neither is an answer, and rebuilt as one they became an empty
  // "final answer". Both are handed back as errors, which chat() retries like a 5xx.
  if (streamError !== undefined) return { error: streamError } as ChatResponse;
  if (!finish && !done) return { error: "串流在沒有 finish_reason、也沒有 [DONE] 的情況下中斷" } as ChatResponse;
  return {
    choices: [
      {
        message: { content, ...(reasoning ? { reasoning } : {}), ...(calls.length ? { tool_calls: calls.filter(Boolean) } : {}) },
        finish_reason: finish,
      },
    ],
    ...(completionTokens !== undefined ? { usage: { completion_tokens: completionTokens } } : {}),
  };
}

/**
 * Pure: why a 2xx body is not a usable completion, or null when it is one. Gateways (LiteLLM,
 * one-api, OpenRouter) answer an upstream timeout with HTTP 200 and `{"error": …}` or an empty
 * `choices`; read as a completion, that became an empty "final answer" — the writer reported
 * as done, having written nothing, and the next round ended the run as writer-no-op.
 */
export function unusableCompletion(json: unknown): string | null {
  const j = json as { error?: unknown; choices?: Array<{ message?: unknown }> } | null;
  if (!j || typeof j !== "object") return "回應不是 JSON 物件";
  if (j.error !== undefined && j.error !== null) {
    return `閘道回報錯誤：${short(typeof j.error === "string" ? j.error : JSON.stringify(j.error), 300)}`;
  }
  if (!Array.isArray(j.choices) || !j.choices.length) return "回應沒有 choices";
  if (!j.choices[0]?.message) return "回應的 choices[0] 沒有 message";
  return null;
}

/** Pure: the tool a model meant, from names like `functions.write_file` or `read_file<|call|>`. */
export function normalizeToolName(name: string): string {
  return name.replace(/<\|.*$/, "").replace(/^functions\./, "").trim();
}

// Room a completion needs to be worth sending at all: a writer's write_file carries a whole test
// class, and a completion cut off mid-call arrives as truncated JSON the model cannot recover from.
const MIN_COMPLETION_TOKENS = 1024;
const COMPLETION_MARGIN_TOKENS = 32;

/**
 * Makes the conversation shorter so it fits the context window again, oldest material first.
 *
 * What goes: the bodies of earlier tool results (files the model already read — it can read them
 * again) and the file content inside earlier write_file / replace_in_file calls (already on disk).
 * What stays: the system prompt, the task prompt, every message's role and tool_call_id pairing
 * (servers reject a conversation whose tool messages do not answer a call), and the latest turn in
 * full — those are the results the model asked for a moment ago and is about to act on.
 *
 * `targetChars` is how much to free; 0 means everything that can go. Returns the characters freed.
 * `done` records what was already elided, so the same message is never counted twice.
 */
export function compactHistory(messages: ChatMessage[], done: Set<ChatMessage>, targetChars = 0): number {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const stop = lastAssistant >= 0 ? lastAssistant : messages.length;
  let freed = 0;
  for (let i = 2; i < stop && (targetChars === 0 || freed < targetChars); i++) {
    const m = messages[i];
    if (done.has(m)) continue;
    const content = m.content;
    if (m.role === "tool" && typeof content === "string" && content.length > 200) {
      const stub = `（為騰出 context 已省略這次 ${String(m.name ?? "工具")} 的結果，原 ${content.length} 字元；仍需要時請重新呼叫工具）`;
      m.content = stub;
      freed += content.length - stub.length;
      done.add(m);
    } else if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as ToolCall[]) {
        const raw = tc.function?.arguments;
        if (typeof raw !== "string" || raw.length <= 400) continue;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }
        for (const k of ["content", "old_string", "new_string"]) {
          const v = args[k];
          if (typeof v === "string" && v.length > 200) args[k] = `（已省略 ${v.length} 字元；內容已在磁碟上，需要時請 read_file）`;
        }
        const next = JSON.stringify(args);
        if (next.length < raw.length && tc.function) {
          tc.function.arguments = next;
          freed += raw.length - next.length;
        }
      }
      done.add(m);
    }
  }
  return freed;
}

// Tool-call arguments arrive as a JSON string (OpenAI, vLLM) or, from some servers, already
// as an object. Malformed JSON is reported back to the model as a tool error, not thrown.
function parseArgs(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (raw && typeof raw === "object") return { args: raw as Record<string, unknown> };
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { args: {} };
  try {
    const v: unknown = JSON.parse(s);
    return { args: v && typeof v === "object" ? (v as Record<string, unknown>) : {} };
  } catch {
    return { args: {}, error: `錯誤：工具 arguments 不是合法 JSON：${s.slice(0, 120)}` };
  }
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class ApiRunner implements AgentRunner {
  private readonly repoRoot: string;
  private readonly writableRoot?: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: { writer: string; reviewer: string };
  private readonly maxTurns: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxToolResultChars: number;
  private readonly retryDelayMs: number;
  private readonly retryWindowMs: number;
  private readonly fetchImpl: typeof fetch;
  // Set by the first successful response of this run. From then on a failed request is an
  // outage to wait out, not a misconfiguration to stop on — see FIRST_CONTACT_ATTEMPTS.
  private reachable = false;

  constructor(opts: ApiRunnerOptions = {}) {
    this.repoRoot = opts.repoRoot ?? REPO_ROOT;
    this.writableRoot = opts.writableRoot;
    this.baseUrl = (opts.baseUrl ?? API_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? API_KEY;
    this.models = opts.models ?? { writer: WRITER_MODEL, reviewer: REVIEWER_MODEL };
    this.maxTurns = opts.maxTurns ?? API_MAX_TURNS;
    this.maxTokens = opts.maxTokens ?? API_MAX_TOKENS;
    this.timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS;
    this.maxToolResultChars = opts.maxToolResultChars ?? API_MAX_TOOL_RESULT_CHARS;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
    this.retryWindowMs = opts.retryWindowMs ?? AGENT_RETRY_WINDOW_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  runWriter(prompt: string): Promise<AgentRunOutput> {
    return this.runAgent(
      "writer",
      "ut-writer",
      this.models.writer,
      WRITER_TEMPERATURE,
      toolsFor(false),
      this.writableRoot,
      prompt,
    );
  }

  // Read-only by construction: the tool list has no write in it, and temperature is the
  // architectural 0 (hard rule 3), not a configured value.
  runReview(prompt: string): Promise<AgentRunOutput> {
    return this.runAgent(
      "reviewer",
      "ut-reviewer",
      this.models.reviewer,
      REVIEWER_TEMPERATURE,
      toolsFor(true),
      undefined,
      prompt,
    );
  }

  // One POST, retried through transient failures. Before the endpoint has answered once this
  // run, a handful of quick attempts (a wrong URL should fail in seconds); after that, retries
  // continue with backoff for up to retryWindowMs — a model server restarting or a gateway
  // shedding load is over in a minute or two, and ending the run over it threw away every round
  // before it. The deadline is the run's and it covers the body too: the timer used to be
  // cleared once the headers arrived, and a body that then stalled was waited on forever.
  private async chat(body: Record<string, unknown>, deadline: number, label: string): Promise<ChatResult> {
    const url = `${this.baseUrl}/chat/completions`;
    // The window is measured from the first failure, not from the first attempt: a generation that
    // ran four minutes and then got a gateway 504 has not been "retrying for four minutes".
    let failingSince: number | undefined;
    const maxAttempts = this.reachable
      ? MAX_ATTEMPTS + Math.ceil(this.retryWindowMs / MAX_BACKOFF_MS)
      : FIRST_CONTACT_ATTEMPTS;
    let lastError = "";
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error: "逾時", kind: "timeout" };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), remaining);
      let status = 0;
      let text = "";
      let retryAfter: string | null = null;
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: ctl.signal,
          // Node's fetch ignores HTTP_PROXY, and undici's own 300s timeouts would fire
          // underneath the AbortController above. Both are the dispatcher's job.
          dispatcher: dispatcherFor(url),
        } as RequestInit);
        status = res.status;
        retryAfter = res.headers.get("retry-after");
        text = await res.text();
      } catch (e) {
        if (ctl.signal.aborted) return { ok: false, error: "逾時", kind: "timeout" };
        // The connection can also drop after the status line, while the body is read; that is
        // the same transient failure, not a 2xx with a malformed body.
        status = 0;
        lastError = `連線失敗：${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timer);
      }

      let kind: FailureKind = "transient";
      if (status >= 200 && status < 300) {
        let json: unknown = completionFromSse(text);
        if (!json) {
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
        }
        const unusable = json === undefined ? null : unusableCompletion(json);
        if (json !== undefined && !unusable) {
          this.reachable = true;
          return { ok: true, json: json as ChatResponse };
        }
        // Not JSON: a proxy's error page, or a body cut off mid-transfer. JSON but not a
        // completion: a gateway reporting an upstream failure with a 200. Either way a failed
        // request, retried like a 5xx — never a model's (empty) answer.
        lastError = unusable ?? `回應不是 JSON：${short(text.replace(/\s+/g, " "), 200)}`;
      } else if (status) {
        lastError = `HTTP ${status}${text ? `：${short(text, 300)}` : ""}`;
        kind = classifyHttpFailure(status, text);
        // The server answered, so the endpoint and the credentials are fine up to this point.
        if (kind === "context") return { ok: false, error: lastError, kind, ...parseContextOverflow(text) };
        if (kind !== "transient") return { ok: false, error: lastError, kind };
      }

      failingSince ??= Date.now();
      const waited = Date.now() - failingSince;
      const backoff = Math.min(this.retryDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      // Retry-After is the least the server asks for, not a reason to hurry our own backoff.
      const delay = Math.min(Math.max(retryAfterMs(retryAfter) ?? 0, backoff), MAX_BACKOFF_MS);
      // A window of 0 means no retries once the endpoint has answered. Any other window gets at
      // least one retry, even when the first wait alone is longer than the window; the window
      // bounds the ones after that.
      const outOfWindow =
        this.reachable && (this.retryWindowMs === 0 || (attempt > 1 && waited + delay > this.retryWindowMs));
      if (attempt >= maxAttempts || outOfWindow || Date.now() + delay >= deadline) {
        return { ok: false, error: lastError, kind: "transient" };
      }
      log(`[WARN] [${label}] ${lastError}——${(delay / 1000).toFixed(0)} 秒後重試（第 ${attempt} 次）`);
      await sleep(delay);
    }
  }

  private async runAgent(
    label: string,
    agent: string,
    model: string,
    temperature: number,
    specs: ToolSpec[],
    writableRoot: string | undefined,
    prompt: string,
  ): Promise<AgentRunOutput> {
    // Never ran: an environment problem, and the orchestrator must not blame the model.
    const spawnError = (why: string): AgentRunOutput => {
      log(`[FAIL] [${label}] ${why}`);
      return { text: "", status: "spawn-error" };
    };
    if (!this.baseUrl) {
      return spawnError(
        "UT_API_BASE_URL 未設定（例如 Ollama 的 http://localhost:11434/v1、vLLM 的 http://host:8000/v1）",
      );
    }
    if (!model) {
      return spawnError(`${label} 的模型未設定——api runner 需要 UT_WRITER_MODEL 與 UT_REVIEWER_MODEL`);
    }
    const role = loadRoleContract(agent, this.repoRoot);
    if (!role) {
      return spawnError(
        `找不到 agent 定義 ${agent}.md（目標 repo .opencode/agent、~/.config/opencode/agent 與工具內建皆無）`,
      );
    }

    log(`[${label}] api session 啟動（model=${model}，endpoint=${this.baseUrl}，角色契約=${role.source}）`);
    const stopHeartbeat = startHeartbeat(`[${label}]`);
    const started = Date.now();
    const deadline = started + this.timeoutMs;
    const messages: ChatMessage[] = [
      { role: "system", content: role.text },
      { role: "user", content: prompt },
    ];
    const tools = toOpenAiTools(specs);
    const ctx = { repoRoot: this.repoRoot, writableRoot, maxResultChars: this.maxToolResultChars };
    let toolCalls = 0;
    let outputTokens = 0;
    let lastText = "";
    // Shrinks only when the server says the completion does not fit; see the context branch.
    let maxTokens = this.maxTokens;
    const compacted = new Set<ChatMessage>();
    let contextRecoveries = 0;
    let nudges = 0;
    let truncatedCalls = 0;

    const finish = (status: AgentRunStatus, text: string, note?: string): AgentRunOutput => {
      stopHeartbeat();
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      log(
        status === "ok"
          ? `[OK] [${label}] 完成（${toolCalls} 次工具呼叫，耗時 ${secs} 秒）`
          : `[WARN] [${label}] ${note ?? "未完成"}（${toolCalls} 次工具呼叫，耗時 ${secs} 秒），以已收到的輸出繼續`,
      );
      return { text, status, toolCallCount: toolCalls, outputTokens };
    };

    try {
      for (let turn = 1; turn <= this.maxTurns; turn++) {
        const r = await this.chat(
          {
            model,
            messages,
            tools,
            tool_choice: "auto",
            temperature,
            stream: false,
            ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
          },
          deadline,
          label,
        );
        if (!r.ok && r.kind === "context" && contextRecoveries < 12) {
          // The conversation outgrew the context window — every file read stays in it, so on a
          // 32k model a few large classes are enough. Sending it again fails identically, and
          // ending the session here is what used to leave a writer that had read everything and
          // written nothing: writer-no-op one round later, the run over. Make it shorter instead:
          // elide older tool output first (the model can re-read a file), and only when nothing
          // is left to elide give up completion room the server says does not fit.
          contextRecoveries++;
          // A read-only session (the reviewer) is never compacted: its verdict must rest on the files
          // it read, and a verdict given over "(content elided)" stubs would still count those reads
          // for the must-read guard. It can only make room for its answer; if that is not enough, the
          // session ends unfinished and the orchestrator retries the reviewer.
          const readOnly = !specs.some((t) => !t.readOnly);
          const over =
            r.limit !== undefined && r.used !== undefined ? r.used + Math.max(maxTokens, 0) - r.limit : undefined;
          // ~4 characters per token for code, generous on purpose: freeing too much costs a
          // re-read, freeing too little costs another rejected request.
          const freed = readOnly ? 0 : compactHistory(messages, compacted, over !== undefined && over > 0 ? over * 4 + 2000 : 0);
          const limitNote = r.limit ? `模型上限 ${r.limit} tokens` : "超出模型 context";
          if (freed > 0) {
            log(`[WARN] [${label}] context 已滿（${limitNote}）：省略較早的工具結果約 ${freed} 字元後重送`);
            turn--;
            continue;
          }
          const fit = r.limit !== undefined && r.used !== undefined ? r.limit - r.used - COMPLETION_MARGIN_TOKENS : 0;
          if (fit >= MIN_COMPLETION_TOKENS && (maxTokens <= 0 || fit < maxTokens)) {
            log(`[WARN] [${label}] context 已滿（${limitNote}）：max_tokens ${maxTokens || "（伺服器預設）"} → ${fit} 後重送`);
            maxTokens = fit;
            turn--;
            continue;
          }
        }
        if (!r.ok) {
          if (r.kind === "timeout") {
            return finish("timeout", lastText, `逾時 ${this.timeoutMs}ms（模型較慢時請調高 UT_AGENT_TIMEOUT_MS）`);
          }
          // Never ran, or cannot run: an endpoint that has not answered once this run is a
          // configuration problem, and so is a rejected key or an unknown model at any point.
          // Anything else, once the endpoint has proven reachable, is an outage or a rejected
          // request mid-session — reporting it as spawn-error ended whole runs, several rounds
          // in, on a three-second 503 burst, with a message about installing opencode.
          if (!this.reachable || r.kind === "config") {
            stopHeartbeat();
            return spawnError(`${turn === 1 ? "第一個請求就失敗" : `第 ${turn} 回合請求失敗`}：${r.error}`);
          }
          if (r.kind === "context") {
            return finish(
              "timeout",
              lastText,
              `context 已滿且無法再縮短（${r.error}）。請調大伺服器的 context（例如 vLLM 的 --max-model-len）、` +
                "調小 UT_API_MAX_TOKENS 或 UT_API_MAX_TOOL_RESULT_CHARS",
            );
          }
          // A partial run is not a completed one; say so, and let the gates judge the disk.
          return finish("timeout", lastText, `第 ${turn} 回合請求失敗：${r.error}`);
        }

        const choice = r.json.choices?.[0];
        const msg = choice?.message ?? {};
        outputTokens += Number(r.json.usage?.completion_tokens ?? 0) || 0;
        const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        // What goes back to the server must be something it accepts on the next request: every
        // call with an id (the tool message has to answer it), type "function", and arguments
        // that are a JSON-object string. vLLM up to 0.11 json.loads every echoed arguments string
        // and rejects the whole conversation — every later request, 400 — over one call whose
        // arguments a model cut short or mis-escaped (Java source in a JSON string does that).
        const calls: ToolCall[] = rawCalls.map((tc, i) => {
          const a = tc.function?.arguments;
          let argStr = typeof a === "string" ? a : a && typeof a === "object" ? JSON.stringify(a) : "{}";
          if (parseArgs(argStr).error) argStr = "{}";
          return {
            ...tc,
            id: tc.id || `call_${turn}_${i}`,
            type: tc.type ?? "function",
            function: { ...(tc.function ?? {}), name: tc.function?.name ?? "?", arguments: argStr },
          };
        });
        const content = textOf(msg.content);
        // Kept apart from `content`: the echo below must send back what the server actually
        // gave us, or the next request is malformed. This is only for the run's own output.
        const reasoning = textOf(msg.reasoning_content) || textOf(msg.reasoning);
        const said = content.trim() ? content : reasoning;
        const cutOff = choice?.finish_reason === "length";
        // A turn with no tool call is normally the answer. Two shapes only look like one: the
        // completion hit max_tokens (a writer emitting a whole test class in one write_file is
        // the usual way), or the model wrote its call as text the server's tool parser could not
        // read — vLLM hands both back as plain content with no tool_calls. Taken as the answer,
        // the writer "completed" having written nothing, and the next round ended the run as
        // writer-no-op. The model is told what happened instead, a bounded number of times.
        const misfire = !calls.length && (cutOff || looksLikeToolCallText(said, specs));
        const canWrite = specs.some((t) => !t.readOnly);
        if (misfire && nudges < MAX_NUDGES) {
          nudges++;
          // The half-written call goes back clipped: echoing a 30k-character fragment would
          // spend the context the retry needs.
          messages.push({ role: "assistant", content: short(content, 1500) });
          messages.push({
            role: "user",
            content: cutOff ? (canWrite ? truncatedNudge(maxTokens) : TRUNCATED_ANSWER_NUDGE) : UNPARSED_CALL_NUDGE,
          });
          log(
            `[WARN] [${label}] ${cutOff ? `回覆超過輸出上限被截斷（finish_reason=length，max_tokens=${maxTokens || "伺服器預設"}）` : "工具呼叫以文字送出、伺服器沒有解析成 tool call"}` +
              `——要求模型改用較小的步驟重送（第 ${nudges}/${MAX_NUDGES} 次）`,
          );
          continue;
        }
        // Echo the assistant turn back verbatim (content "" rather than null: some servers
        // reject a null-content assistant message on the next request).
        messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });
        if (said.trim() && !misfire) {
          lastText = said;
          logVerbose(`[${label}]  ${short(said.replace(/\s+/g, " ").trim(), 160)}`);
        }
        if (misfire) {
          return finish(
            "timeout",
            lastText,
            `連續 ${MAX_NUDGES} 次${cutOff ? "回覆被輸出上限截斷" : "工具呼叫無法被伺服器解析"}，沒有任何工具呼叫送達` +
              (cutOff ? "（可調大 UT_API_MAX_TOKENS）" : "（檢查伺服器的 tool-call parser 設定，例如 vLLM 的 --tool-call-parser）"),
          );
        }
        if (!calls.length) {
          // A turn that ends with no tool call is the run's answer — but it can carry nothing:
          // a reasoning model answering in reasoning_content, or a server sending an empty
          // message to close a tool round. Falling back to the last thing the model actually
          // said recovers a verdict it already produced; reporting "ok" for an empty answer
          // would hand the reviewer gate an empty string and blame the writer for it.
          const answer = said.trim() ? said : lastText;
          if (!answer.trim()) {
            return finish(
              "timeout",
              "",
              `模型回了空訊息（finish_reason=${choice?.finish_reason ?? "?"}），沒有任何可用輸出`,
            );
          }
          return finish("ok", answer);
        }

        // Arguments cut off by max_tokens, turn after turn: the hint alone does not stop a model
        // that keeps resending the same oversized write, and each attempt costs a full-length
        // generation. Counted like the no-tool-call misfires above, with the same bound.
        const brokenArgs = calls.some((_tc, i) => parseArgs(rawCalls[i].function?.arguments).error);
        // Counted consecutively: a writer covering several classes may be cut off now and then and
        // recover each time; only a run of cut-offs with nothing in between says it cannot.
        if (!(cutOff && brokenArgs)) truncatedCalls = 0;
        if (calls.length) nudges = 0;
        if (cutOff && brokenArgs) {
          truncatedCalls++;
          if (truncatedCalls > MAX_NUDGES) {
            return finish(
              "timeout",
              lastText,
              `連續 ${truncatedCalls} 次工具呼叫的參數被輸出上限截斷（max_tokens=${maxTokens || "伺服器預設"}），可調大 UT_API_MAX_TOKENS`,
            );
          }
          log(`[WARN] [${label}] 工具呼叫的參數被輸出上限截斷（finish_reason=length）——要求模型改用較小的步驟（第 ${truncatedCalls}/${MAX_NUDGES} 次）`);
        }

        for (const [i, tc] of calls.entries()) {
          toolCalls++;
          const name = normalizeToolName(tc.function?.name ?? "?");
          const { args, error } = parseArgs(rawCalls[i].function?.arguments);
          // Arguments cut off by max_tokens parse as broken JSON; saying why is what stops the
          // model from resending the same oversized call until the turn budget runs out.
          const result = error
            ? `${error}${cutOff ? `\n${truncatedNudge(maxTokens)}` : ""}`
            : execTool(name, args, ctx, specs);
          logVerbose(
            `[${label}]  [tool] ${name} ${short(JSON.stringify(args))} -> ${result.length} 字元` +
              (result.startsWith("錯誤") ? "（錯誤）" : ""),
          );
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name,
            content: result,
          });
        }
      }
      return finish("timeout", lastText, `回合預算用盡（UT_API_MAX_TURNS=${this.maxTurns}）`);
    } catch (e) {
      return finish("timeout", lastText, `runner 內部錯誤：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
