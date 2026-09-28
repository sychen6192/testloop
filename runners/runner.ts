// Runner factory: opencode by default; api for a direct OpenAI-compatible endpoint; qwen via
// dynamic import (a missing SDK never affects the other paths).
import { AgentRunner } from "../libs/types";
import { API_BASE_URL, OPENCODE_BIN, REVIEWER_MODEL, RUNNER_KIND, WRITER_MODEL } from "../config";
import { findOnPath } from "../libs/shell";
import { OpencodeRunner } from "./opencode";
import { ApiRunner } from "./api";

export interface RunnerOptions {
  // The writer's write scope (the target module's src/test). The api runner enforces it at
  // the tool level; the opencode/qwen runners rely on the orchestrator's snapshot guard alone.
  writableRoot?: string;
}

export async function createRunner(opts: RunnerOptions = {}): Promise<AgentRunner> {
  if (RUNNER_KIND === "qwen") {
    const { QwenRunner } = await import("./qwen");
    return new QwenRunner();
  }
  if (RUNNER_KIND === "api") return new ApiRunner({ writableRoot: opts.writableRoot });
  return new OpencodeRunner();
}

export const RUNNER_KINDS: readonly string[] = ["opencode", "api", "qwen"];

export interface RunnerSettings {
  kind: string;
  apiBaseUrl: string;
  writerModel: string;
  reviewerModel: string;
  // false under UT_SKIP_REVIEW: no reviewer session is ever started.
  reviewNeeded: boolean;
  opencodeBin: string;
}

/**
 * Pure but for `lookup`: what keeps the runner from starting a session, one line each; empty when
 * nothing does. loop.ts asks before the baseline build — the baseline of a module with heavyweight
 * integration tests takes 8–15 minutes, and a run that then stops on "the writer's model is not
 * set" spent them for nothing. Only settings and the file system: nothing here contacts an endpoint
 * or runs the CLI (scripts/doctor.ts does both), and each runner still checks when a session starts.
 */
export function runnerConfigProblems(
  s: RunnerSettings,
  lookup: (cmd: string) => string | undefined = findOnPath,
): string[] {
  const out: string[] = [];
  // createRunner starts opencode for anything it does not know: UT_RUNNER=openai would run opencode.
  if (!RUNNER_KINDS.includes(s.kind)) {
    out.push(`UT_RUNNER=${s.kind} 不是可用的 runner——只能是 opencode（預設）、api 或 qwen`);
  } else if (s.kind === "api") {
    if (!s.apiBaseUrl) out.push("UT_API_BASE_URL 未設定（例如 Ollama 的 http://localhost:11434/v1、vLLM 的 http://host:8000/v1）");
    if (!s.writerModel) out.push("UT_WRITER_MODEL 未設定——api runner 的 writer 需要模型名稱");
    if (s.reviewNeeded && !s.reviewerModel) {
      out.push("UT_REVIEWER_MODEL 未設定——api runner 的 reviewer 需要模型名稱（或以 UT_SKIP_REVIEW=1 關閉 review gate）");
    }
  } else if (s.kind === "opencode" && !lookup(s.opencodeBin)) {
    out.push(`找不到 ${s.opencodeBin}（PATH 上沒有這個可執行檔）——安裝 opencode CLI，或以 UT_OPENCODE_BIN 指定它的路徑`);
  }
  return out;
}

/** runnerConfigProblems for the configured runner. */
export function configuredRunnerProblems(reviewNeeded: boolean): string[] {
  return runnerConfigProblems({
    kind: RUNNER_KIND,
    apiBaseUrl: API_BASE_URL,
    writerModel: WRITER_MODEL,
    reviewerModel: REVIEWER_MODEL,
    reviewNeeded,
    opencodeBin: OPENCODE_BIN,
  });
}
