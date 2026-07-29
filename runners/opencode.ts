// OpencodeRunner: spawn `opencode run --agent <name> --format json <prompt>`.
// --format json makes stdout a JSONL event stream, parsed line-by-line for live tracing.
// No --model unless a model is set; otherwise the agent .md's model field decides.
// Wall-clock timeout backstop (SIGTERM, then SIGKILL after 10s).
// Fail-closed: on spawn failure/timeout it still returns accumulated text; the gate decides pass/fail.
// Spawning goes through planSpawn — no `shell: true` here, because the prompt is an argument
// and would be re-parsed by the shell; see libs/shell.ts for what that costs on Windows.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunner, ReviewRunOutput } from "../libs/types";
import {
  REPO_ROOT,
  WRITER_MODEL,
  REVIEWER_MODEL,
  AGENT_TIMEOUT_MS,
  OPENCODE_BIN,
  OPENCODE_JSON_EVENTS,
  OPENCODE_SKIP_PERMS,
} from "../config";
import { log, logVerbose, startHeartbeat } from "../libs/log";
import { explainSpawnError, planSpawn } from "../libs/shell";

// One JSONL event -> readable progress; text events accumulate into finalText.
// Observed opencode structure (--format json): the real type is in part.type, hyphenated
// (step-start / step-finish / text / tool); text in part.text, tool in part.tool, status in
// part.state.status. The outer ev.type is an unreliable envelope label — trust part.type.
// Compat: accept both hyphen and underscore; fall back to ev.type when part.type is missing.
export function traceEvent(
  line: string,
  prefix: string,
  acc: { text: string; lastText: string; toolCalls?: Set<string> },
) {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // non-JSON line (diagnostic noise), skip
  }
  const part = (ev.part ?? {}) as Record<string, unknown>;
  const kindRaw = String(part.type ?? ev.type ?? "");
  const kind = kindRaw.replace(/_/g, "-"); // normalize step_start <-> step-start

  switch (kind) {
    case "step-start":
      logVerbose(`${prefix}  -- step 開始`);
      break;
    case "step-finish": {
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      if (tokens.output !== undefined) {
        logVerbose(`${prefix}  -- step 結束（output tokens=${String(tokens.output)}）`);
      }
      break;
    }
    case "tool": {
      const tool = String(part.tool ?? "unknown");
      const state = (part.state ?? {}) as Record<string, unknown>;
      const status = String(state.status ?? "");
      const input = JSON.stringify(state.input ?? {});
      const shortInput = input.length > 140 ? input.slice(0, 140) + "…" : input;
      const outRaw = state.output;
      const outNote =
        typeof outRaw === "string" && outRaw.length <= 60 ? ` -> ${outRaw}` : "";
      logVerbose(`${prefix}  [tool] ${tool} [${status}] ${shortInput}${outNote}`);
      // completed tool calls, deduped by callID (reviewer must-read evidence)
      if (status === "completed" && acc.toolCalls) {
        acc.toolCalls.add(String(part.callID ?? `${tool}#${acc.toolCalls.size}`));
      }
      break;
    }
    case "text": {
      const t = String(part.text ?? "");
      if (t) {
        acc.text += t;
        acc.lastText = t; // safety: models often put the final JSON in the last complete text part
        const oneLine = t.replace(/\s+/g, " ").trim();
        if (oneLine) {
          logVerbose(
            `${prefix}  ${oneLine.length > 160 ? oneLine.slice(0, 160) + "…" : oneLine}`,
          );
        }
      }
      break;
    }
    case "error":
      logVerbose(`${prefix}  [WARN] ${JSON.stringify(ev).slice(0, 300)}`);
      break;
  }
}

// The positional message still has to say what to do with the attachment: opencode attaches
// the file's content, but the instruction itself lives in the message.
const ATTACHED_FILE_MESSAGE = "請完全依照附加檔案中的指示執行，不要再詢問或要求補充。";

/**
 * Decides how the prompt reaches opencode.
 *
 * Passing it as a positional argument is simplest and is what every POSIX run does. On
 * Windows it is not always possible: CreateProcess caps the command line at 32767 chars and
 * a .cmd shim routed through cmd.exe at 8191, while a fix-iteration prompt carrying a Maven
 * failure report runs well past that. `opencode run --file <path>` attaches file content to
 * the message, which is the documented way to hand it more text than an argument can hold.
 *
 * The file route is used only when the inline one would not fit, so the common path stays
 * unchanged and this cannot regress a working setup.
 */
export function buildInvocation(
  agent: string,
  model: string,
  prompt: string,
  opts: {
    jsonEvents: boolean;
    skipPerms: boolean;
    bin?: string;
    platform?: string;
    writeFile?: (text: string) => string;
  },
): { args: string[]; promptFile?: string; note?: string } {
  const base = ["run", "--agent", agent];
  if (model) base.push("--model", model);
  if (opts.jsonEvents) base.push("--format", "json");
  if (opts.skipPerms) base.push("--dangerously-skip-permissions");

  const inline = [...base, prompt];
  const plan = planSpawn(opts.bin ?? OPENCODE_BIN, inline, opts.platform);
  if (!plan.error || !opts.writeFile) return { args: inline };

  const promptFile = opts.writeFile(prompt);
  return {
    args: [...base, "--file", promptFile, ATTACHED_FILE_MESSAGE],
    promptFile,
    note: `prompt（${prompt.length} 字元）改以 --file 傳遞：${plan.error}`,
  };
}

export class OpencodeRunner implements AgentRunner {
  private runAgent(
    label: string,
    agent: string,
    model: string,
    prompt: string,
    allowSkipPerms: boolean,
  ): Promise<ReviewRunOutput> {
    return new Promise((resolve) => {
      log(
        `[${label}] session 啟動（agent=${agent}, model=${model || "（agent 預設）"}）`,
      );
      const stopHeartbeat = startHeartbeat(`[${label}]`);
      const started = Date.now();

      const skipPerms = allowSkipPerms && OPENCODE_SKIP_PERMS;
      if (skipPerms) {
        logVerbose(`[${label}] [WARN] UT_OC_SKIP_PERMS=1：已附加 --dangerously-skip-permissions`);
      }

      let tmpDir: string | undefined;
      const invocation = buildInvocation(agent, model, prompt, {
        jsonEvents: OPENCODE_JSON_EVENTS,
        skipPerms,
        writeFile: (text) => {
          tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-oc-"));
          const file = path.join(tmpDir, "prompt.md");
          fs.writeFileSync(file, text, "utf8");
          return file;
        },
      });
      if (invocation.note) logVerbose(`[${label}] ${invocation.note}`);

      // Windows needs the command resolved through PATHEXT, and .cmd shims routed via
      // cmd.exe — Node refuses to spawn them directly since the CVE-2024-27980 fix.
      const plan = planSpawn(OPENCODE_BIN, invocation.args);
      if (plan.error) {
        log(`[FAIL] [${label}] ${plan.error}`);
        stopHeartbeat();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve({ text: "" });
        return;
      }

      const child = spawn(plan.file, plan.args, {
        cwd: REPO_ROOT,
        env: process.env,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "pipe"], // opencode >=1.17 waits for stdin EOF on a piped stdin
      });

      const acc = { text: "", lastText: "", toolCalls: new Set<string>() };
      let rawStdout = "";
      let stdoutBuf = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        rawStdout += chunk;
        stdoutBuf += chunk;
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? ""; // keep the partial line for the next chunk
        for (const line of lines) {
          if (line.trim()) traceEvent(line, `[${label}]`, acc);
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        for (const line of chunk.trim().split("\n")) {
          if (line.trim()) logVerbose(`[${label}] ${line}`);
        }
      });

      // timeout: SIGTERM, then SIGKILL if still alive after 10s
      let killEscalation: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        logVerbose(`[${label}] 逾時 ${AGENT_TIMEOUT_MS}ms，送出 SIGTERM`);
        child.kill("SIGTERM");
        killEscalation = setTimeout(() => {
          logVerbose(`[${label}] SIGTERM 未生效，SIGKILL`);
          child.kill("SIGKILL");
        }, 10_000);
      }, AGENT_TIMEOUT_MS);

      let finished = false;
      let spawnError: string | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (killEscalation) clearTimeout(killEscalation);
        stopHeartbeat();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        if (spawnError) {
          log(`[FAIL] [${label}] ${spawnError}`);
          resolve({ text: "" });
          return;
        }
        if (stdoutBuf.trim()) traceEvent(stdoutBuf, `[${label}]`, acc); // flush the partial line
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        log(`[OK] [${label}] 完成（耗時 ${secs} 秒）`);
        // JSONL mode: use accumulated text (or the last text part if empty);
        // non-JSONL (UT_OPENCODE_JSON=0): return the whole stdout — no events to count,
        // so tool usage is unobservable (undefined), not zero.
        if (OPENCODE_JSON_EVENTS) {
          resolve({
            text: acc.text.trim() ? acc.text : acc.lastText,
            toolCallCount: acc.toolCalls.size,
          });
        } else {
          resolve({ text: rawStdout });
        }
      };

      child.on("close", finish);
      child.on("error", (err) => {
        // The old message blamed a missing install for every errno, which is wrong for the
        // two failures that actually bite on Windows (EINVAL on a .cmd, and an oversized
        // command line) and sends people to reinstall a CLI that is already there.
        spawnError = `${explainSpawnError(err, OPENCODE_BIN)}——請確認已安裝 opencode CLI，或以 UT_OPENCODE_BIN 指定路徑`;
        finish();
      });
    });
  }

  async runWriter(prompt: string): Promise<string> {
    // permission contract in .opencode/agent/ut-writer.md (write/edit on, bash/web off)
    const r = await this.runAgent("writer", "ut-writer", WRITER_MODEL, prompt, true);
    return r.text;
  }

  async runReview(prompt: string): Promise<ReviewRunOutput> {
    // read-only reviewer; skip-perms never applies to the reviewer
    return this.runAgent("reviewer", "ut-reviewer", REVIEWER_MODEL, prompt, false);
  }
}
