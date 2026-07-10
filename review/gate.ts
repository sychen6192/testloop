// Review gate: run the read-only reviewer + fail-closed parse (prompt assembled by the orchestrator).
import { AgentRunner, ReviewVerdict } from "../libs/types";
import { parseVerdict } from "./verdict";

export async function runReviewGate(
  runner: AgentRunner,
  prompt: string,
): Promise<ReviewVerdict> {
  const raw = await runner.runReview(prompt);
  return parseVerdict(raw);
}
