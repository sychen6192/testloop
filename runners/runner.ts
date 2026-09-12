// Runner factory: opencode by default; api for a direct OpenAI-compatible endpoint; qwen via
// dynamic import (a missing SDK never affects the other paths).
import { AgentRunner } from "../libs/types";
import { RUNNER_KIND } from "../config";
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
