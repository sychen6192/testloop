// Shared types (SSOT: all other modules import from here).

export type BuildTool = "maven" | "gradle";

export interface GateResult {
  passed: boolean;
  report: string;
  // Full raw output (persisted to build.log).
  raw?: string;
}

// One agent run's outcome. `status` separates infrastructure failures from bad answers:
// "spawn-error" means the agent never ran — retrying or blaming the model is wrong there.
// toolCallCount undefined = the runner cannot observe tool usage (must-read check disabled).
// outputTokens undefined = the runner cannot observe token usage.
export type AgentRunStatus = "ok" | "timeout" | "spawn-error";

export interface AgentRunOutput {
  text: string;
  status: AgentRunStatus;
  toolCallCount?: number;
  outputTokens?: number;
}

// Runtime adapter: the interface that keeps the core free of SDK imports.
export interface AgentRunner {
  runWriter(prompt: string): Promise<AgentRunOutput>;
  runReview(prompt: string): Promise<AgentRunOutput>;
}

export const REVIEW_DIMENSIONS = [
  "effectiveness",
  "coverage",
  "independence",
  "readability",
  "fast_reliable",
  "mock_appropriateness",
] as const;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number];

export type ReviewScores = Record<ReviewDimension, number>;

export interface ReviewVerdict {
  passed: boolean;
  // Six 0-10 integer scores (per skill rubric); empty object on parse failure.
  scores: Partial<ReviewScores>;
  // Hard-rule violations (~ skill severity=high): all must be fixed to pass.
  blockers: string[];
  // Advisory improvements (~ severity=medium/low): non-blocking, kept out of feedback to avoid thrash.
  advisories: string[];
  // Dimensions below threshold, e.g. "coverage (6 < threshold 7)".
  belowThreshold: string[];
  // Σ(score×weight)×10 (0-100), computed deterministically by the pipeline.
  weightedScore?: number;
  // A/B/C/D (skill bands 85/70/55); report-only, not a gate condition.
  grade?: string;
  parseError?: string;
  raw?: string;
}

// Module info: derived by walking up to the nearest pom.xml / build.gradle.
export interface ModuleInfo {
  // Module root (absolute). Equals REPO_ROOT for a single module.
  moduleRoot: string;
  // Module path relative to REPO_ROOT. "" for a single module.
  moduleRel: string;
  // moduleRel !== "" — the target lives inside a submodule.
  multiModule: boolean;
}
