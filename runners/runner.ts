// Runner factory: opencode by default; qwen via dynamic import (a missing SDK never affects the default path).
import { AgentRunner } from "../libs/types";
import { RUNNER_KIND } from "../config";
import { OpencodeRunner } from "./opencode";

export async function createRunner(): Promise<AgentRunner> {
  if (RUNNER_KIND === "qwen") {
    const { QwenRunner } = await import("./qwen");
    return new QwenRunner();
  }
  return new OpencodeRunner();
}
