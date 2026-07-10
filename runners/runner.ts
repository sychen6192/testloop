/** Runner factory：預設 opencode；qwen 走動態 import（未裝 SDK 不影響預設路徑） */
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
