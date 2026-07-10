// OpencodeRunner: spawn `opencode run --agent <name> --format json <prompt>`.
// --format json makes stdout a JSONL event stream, parsed line-by-line for live tracing.
// No --model unless a model is set; otherwise the agent .md's model field decides.
// Wall-clock timeout backstop (SIGTERM, then SIGKILL after 10s).
// Fail-closed: on spawn failure/timeout it still returns accumulated text; the gate decides pass/fail.
import { spawn } from "node:child_process";
import { AgentRunner } from "../libs/types";
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

// One JSONL event -> readable progress; text events accumulate into finalText.
// Observed opencode structure (--format json): the real type is in part.type, hyphenated
// (step-start / step-finish / text / tool); text in part.text, tool in part.tool, status in
// part.state.status. The outer ev.type is an unreliable envelope label — trust part.type.
// Compat: accept both hyphen and underscore; fall back to ev.type when part.type is missing.
export function traceEvent(line: string, prefix: string, acc: { text: string; lastText: string }) {
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

export class OpencodeRunner implements AgentRunner {
  private runAgent(
    label: string,
    agent: string,
    model: string,
    prompt: string,
    allowSkipPerms: boolean,
  ): Promise<string> {
    return new Promise((resolve) => {
      log(
        `[${label}] session 啟動（agent=${agent}, model=${model || "（agent 預設）"}）`,
      );
      const stopHeartbeat = startHeartbeat(`[${label}]`);
      const started = Date.now();

      const args = ["run", "--agent", agent];
      if (model) args.push("--model", model);
      if (OPENCODE_JSON_EVENTS) args.push("--format", "json");
      if (allowSkipPerms && OPENCODE_SKIP_PERMS) {
        args.push("--dangerously-skip-permissions");
        logVerbose(`[${label}] [WARN] UT_OC_SKIP_PERMS=1：已附加 --dangerously-skip-permissions`);
      }
      args.push(prompt); // prompt goes last (positional)

      const child = spawn(OPENCODE_BIN, args, {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"], // opencode >=1.17 waits for stdin EOF on a piped stdin
      });

      const acc = { text: "", lastText: "" };
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
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (killEscalation) clearTimeout(killEscalation);
        stopHeartbeat();
        if (stdoutBuf.trim()) traceEvent(stdoutBuf, `[${label}]`, acc); // flush the partial line
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        log(`[OK] [${label}] 完成（耗時 ${secs} 秒）`);
        // JSONL mode: use accumulated text (or the last text part if empty);
        // non-JSONL (UT_OPENCODE_JSON=0): return the whole stdout.
        if (OPENCODE_JSON_EVENTS) {
          resolve(acc.text.trim() ? acc.text : acc.lastText);
        } else {
          resolve(rawStdout);
        }
      };

      child.on("close", finish);
      child.on("error", (err) => {
        logVerbose(
          `[${label}] spawn 失敗：${err.message}（請確認 opencode CLI 已安裝，或設 UT_OPENCODE_BIN）`,
        );
        finish();
      });
    });
  }

  async runWriter(prompt: string): Promise<string> {
    // permission contract in .opencode/agent/ut-writer.md (write/edit on, bash/web off)
    return this.runAgent("writer", "ut-writer", WRITER_MODEL, prompt, true);
  }

  async runReview(prompt: string): Promise<string> {
    // read-only reviewer; skip-perms never applies to the reviewer
    return this.runAgent("reviewer", "ut-reviewer", REVIEWER_MODEL, prompt, false);
  }
}
