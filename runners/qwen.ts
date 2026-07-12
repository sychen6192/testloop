// QwenRunner (fallback path): dynamically loads @qwen-code/sdk only when UT_RUNNER=qwen.
// A missing SDK errors only if this runner is selected; the default opencode path is unaffected.
import { AgentRunner, ReviewRunOutput } from "../libs/types";
import { REPO_ROOT, WRITER_MODEL, REVIEWER_MODEL } from "../config";
import { log, logVerbose, startHeartbeat } from "../libs/log";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Returns the number of tool_use blocks in this assistant message (must-read evidence).
function traceAssistantMessage(m: any, prefix: string): number {
  const content = m?.message?.content;
  const blocks = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
  let toolUses = 0;
  for (const b of blocks) {
    if (b?.type === "tool_use") {
      toolUses++;
      const input = JSON.stringify(b.input ?? {});
      logVerbose(
        `${prefix}  呼叫工具 ${b.name}(${input.length > 120 ? input.slice(0, 120) + "…" : input})`,
      );
    } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      const oneLine = b.text.replace(/\s+/g, " ").trim();
      logVerbose(
        `${prefix}  ${oneLine.length > 160 ? oneLine.slice(0, 160) + "…" : oneLine}`,
      );
    }
  }
  return toolUses;
}

export class QwenRunner implements AgentRunner {
  private sdk: any;

  private async load(): Promise<any> {
    if (this.sdk) return this.sdk;
    try {
      // dynamic import: this package is only needed when UT_RUNNER=qwen
      this.sdk = await import("@qwen-code/sdk" as string);
    } catch {
      throw new Error(
        "找不到 @qwen-code/sdk。UT_RUNNER=qwen 需要先 `npm i -D @qwen-code/sdk`，" +
          "或改用預設的 UT_RUNNER=opencode。",
      );
    }
    return this.sdk;
  }

  private async runAgent(
    label: string,
    prompt: string,
    model: string,
    options: Record<string, unknown>,
  ): Promise<ReviewRunOutput> {
    const { query, isSDKAssistantMessage, isSDKResultMessage, isSDKSystemMessage } =
      await this.load();
    log(`[${label}] session 啟動（model=${model || "（預設）"}）`);
    const stopHeartbeat = startHeartbeat(`[${label}]`);
    const started = Date.now();
    let finalText = "";
    let turns = 0;
    let toolCalls = 0;
    try {
      const q = query({
        prompt,
        options: {
          cwd: REPO_ROOT,
          authType: "openai",
          ...(model ? { model } : {}),
          env: {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "none",
            OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "",
            ...(model ? { OPENAI_MODEL: model } : {}),
          },
          ...options,
        },
      });
      for await (const m of q) {
        if (isSDKSystemMessage(m)) {
          logVerbose(`[${label}] session 初始化完成`);
        } else if (isSDKAssistantMessage(m)) {
          turns++;
          toolCalls += traceAssistantMessage(m, `[${label}]`);
        } else if (isSDKResultMessage(m)) {
          finalText = (m as any).result ?? finalText;
        }
      }
    } finally {
      stopHeartbeat();
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    log(`[OK] [${label}] 完成（${turns} 個 assistant 回合，耗時 ${secs} 秒）`);
    return { text: finalText, toolCallCount: toolCalls };
  }

  async runWriter(prompt: string): Promise<string> {
    const r = await this.runAgent("writer", prompt, WRITER_MODEL, {
      permissionMode: "auto-edit",
      excludeTools: ["ShellTool", "web_fetch", "web_search"],
      maxSessionTurns: 40,
    });
    return r.text;
  }

  async runReview(prompt: string): Promise<ReviewRunOutput> {
    return this.runAgent("reviewer", prompt, REVIEWER_MODEL, {
      permissionMode: "plan",
      excludeTools: ["ShellTool", "web_fetch", "web_search"],
      systemPrompt: {
        type: "preset",
        preset: "qwen_code",
        append:
          "你是嚴格的 Java 測試審查者。只審查、不修改任何檔案。" +
          "最終回覆必須是單一 JSON 物件，不得包含 markdown 圍欄或其他文字。",
      },
      maxSessionTurns: 25,
    });
  }
}
