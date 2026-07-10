/** Review gate：唯讀 reviewer 執行 + fail-closed 解析（prompt 由 orchestrator 組裝並落盤） */
import { AgentRunner, ReviewVerdict } from "../libs/types";
import { parseVerdict } from "./verdict";

export async function runReviewGate(
  runner: AgentRunner,
  prompt: string,
): Promise<ReviewVerdict> {
  const raw = await runner.runReview(prompt);
  return parseVerdict(raw);
}
