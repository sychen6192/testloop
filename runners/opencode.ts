/**
 * OpencodeRunner：spawn `opencode run --agent <name> --format json <prompt>`。
 * - --format json → stdout 為 JSONL 事件流，逐行 parse 即時轉印
 *   （對應 QwenRunner 的 traceAssistantMessage，解決黑盒子卡 heartbeat 問題）。
 * - 未指定模型時不傳 --model，由 .opencode/agent/*.md 的 model 欄位決定。
 * - wall-clock timeout 兜底（SIGTERM → 10 秒後 SIGKILL）。
 * - 錯誤語義 fail-closed：spawn 失敗/逾時仍回傳已累積文字，成敗由上層 gate 判定。
 */
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

/**
 * 單行 JSONL 事件 → 可讀進度；text 事件累積為 finalText。
 * 實測 opencode 事件結構（--format json）：
 *   - 真正的型別在 part.type，且用「連字號」：step-start / step-finish / text / tool
 *   - text 內容在 part.text；tool 在 part.tool、狀態在 part.state.status
 *   - 外層 ev.type 只是 envelope 標籤，不可靠，一律以 part.type 為準
 * 相容處理：同時接受連字號與底線、part.type 缺漏時退回 ev.type。
 */
export function traceEvent(line: string, prefix: string, acc: { text: string; lastText: string }) {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // 非 JSON 行（診斷雜訊），略過
  }
  const part = (ev.part ?? {}) as Record<string, unknown>;
  const kindRaw = String(part.type ?? ev.type ?? "");
  const kind = kindRaw.replace(/_/g, "-"); // step_start ↔ step-start 一律正規化

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
        acc.lastText = t; // 保險：模型常把最終 JSON 放在最後一個完整 text part
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
      args.push(prompt); // prompt 一律最後（positional；opencode run 不吃 stdin）

      const child = spawn(OPENCODE_BIN, args, { cwd: REPO_ROOT, env: process.env });

      const acc = { text: "", lastText: "" };
      let rawStdout = "";
      let stdoutBuf = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        rawStdout += chunk;
        stdoutBuf += chunk;
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? ""; // 殘行留待下次（chunk 邊界處理）
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

      // 逾時：SIGTERM → 10 秒未退出再 SIGKILL
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
        if (stdoutBuf.trim()) traceEvent(stdoutBuf, `[${label}]`, acc); // flush 殘行
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        log(`[OK] [${label}] 完成（耗時 ${secs} 秒）`);
        // JSONL 模式取累積 text（空則退回最後一個 text part）；
        // 非 JSONL（UT_OPENCODE_JSON=0）退回整段 stdout
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
    // 權限契約在 .opencode/agent/ut-writer.md（write/edit 開、bash/web 關）
    return this.runAgent("writer", "ut-writer", WRITER_MODEL, prompt, true);
  }

  async runReview(prompt: string): Promise<string> {
    // 唯讀 reviewer；skip-perms 永不套用在 reviewer
    return this.runAgent("reviewer", "ut-reviewer", REVIEWER_MODEL, prompt, false);
  }
}
