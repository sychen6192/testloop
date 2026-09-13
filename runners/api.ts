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
  // Tests inject a scripted transport; production uses global fetch.
  fetchImpl?: typeof fetch;
}

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}
interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  usage?: { completion_tokens?: number };
}
type ChatMessage = Record<string, unknown>;
type ChatResult =
  | { ok: true; json: ChatResponse }
  | { ok: false; error: string; timedOut: boolean };

const RETRY_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  private readonly fetchImpl: typeof fetch;

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

  // One POST with bounded retries. 429 and 5xx are retried with backoff, as is a failed
  // connection; 4xx otherwise is final (auth, unknown model, bad request). The deadline is
  // the run's, so a slow model cannot stretch a single request past the run's timeout.
  private async chat(body: Record<string, unknown>, deadline: number): Promise<ChatResult> {
    let lastError = "";
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error: "逾時", timedOut: true };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), remaining);
      let res: Response;
      const url = `${this.baseUrl}/chat/completions`;
      try {
        res = await this.fetchImpl(url, {
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
      } catch (e) {
        clearTimeout(timer);
        if (ctl.signal.aborted) return { ok: false, error: "逾時", timedOut: true };
        lastError = `連線失敗：${e instanceof Error ? e.message : String(e)}`;
        if (attempt < RETRY_ATTEMPTS) {
          await sleep(this.retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, error: lastError, timedOut: false };
      }
      clearTimeout(timer);
      if (res.ok) {
        try {
          return { ok: true, json: (await res.json()) as ChatResponse };
        } catch (e) {
          return {
            ok: false,
            error: `回應不是 JSON：${e instanceof Error ? e.message : String(e)}`,
            timedOut: false,
          };
        }
      }
      const detail = await res.text().catch(() => "");
      lastError = `HTTP ${res.status}${detail ? `：${short(detail, 300)}` : ""}`;
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && attempt < RETRY_ATTEMPTS) {
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      return { ok: false, error: lastError, timedOut: false };
    }
    return { ok: false, error: lastError, timedOut: false };
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
            ...(this.maxTokens > 0 ? { max_tokens: this.maxTokens } : {}),
          },
          deadline,
        );
        if (!r.ok) {
          if (r.timedOut) {
            return finish("timeout", lastText, `逾時 ${this.timeoutMs}ms（模型較慢時請調高 UT_AGENT_TIMEOUT_MS）`);
          }
          if (turn === 1) {
            stopHeartbeat();
            return spawnError(`第一個請求就失敗：${r.error}`);
          }
          // A partial run is not a completed one; say so, and let the gates judge the disk.
          return finish("timeout", lastText, `第 ${turn} 回合請求失敗：${r.error}`);
        }

        const msg = r.json.choices?.[0]?.message ?? {};
        outputTokens += Number(r.json.usage?.completion_tokens ?? 0) || 0;
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        const content = typeof msg.content === "string" ? msg.content : "";
        // Echo the assistant turn back verbatim (content "" rather than null: some servers
        // reject a null-content assistant message on the next request).
        messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });
        if (content.trim()) {
          lastText = content;
          logVerbose(`[${label}]  ${short(content.replace(/\s+/g, " ").trim(), 160)}`);
        }
        if (!calls.length) return finish("ok", content);

        for (const tc of calls) {
          toolCalls++;
          const name = tc.function?.name ?? "?";
          const { args, error } = parseArgs(tc.function?.arguments);
          const result = error ?? execTool(name, args, ctx, specs);
          logVerbose(
            `[${label}]  [tool] ${name} ${short(JSON.stringify(args))} -> ${result.length} 字元` +
              (result.startsWith("錯誤") ? "（錯誤）" : ""),
          );
          messages.push({
            role: "tool",
            tool_call_id: tc.id ?? `${name}-${toolCalls}`,
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
