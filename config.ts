// Central config (SSOT: every threshold and param is defined only here).
// Loads the tool's own .env without overriding existing env vars.
// REPO_ROOT = cwd at run time (must run from the Java repo root).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { skillDirCandidates, runsDirFor } from "./libs/utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// testgen's own dir (independent of cwd).
export const TESTGEN_ROOT = __dirname;

// --- Minimal .env loader (TESTGEN_ROOT/.env; never overrides existing env vars) ---
(function loadDotEnv() {
  const p = path.join(TESTGEN_ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

// Java repo root (= cwd). The reactor root for multi-module builds.
export const REPO_ROOT = process.cwd();
// First CLI arg: target dir or single .java file.
export const TARGET_ARG = process.argv[2];

export const MAX_ITER = Number(process.env.UT_MAX_ITER ?? 5);
export const MIN_LINE_COV = Number(process.env.UT_MIN_LINE_COV ?? 80);
export const MIN_BRANCH_COV = Number(process.env.UT_MIN_BRANCH_COV ?? 70);
// 1 = fail the coverage gate when no JaCoCo report is found (default: skip leniently).
export const STRICT_COV = process.env.UT_STRICT_COV === "1";
export const SKIP_REVIEW = process.env.UT_SKIP_REVIEW === "1";
export const QUIET = process.env.UT_QUIET === "1";
// 1 = skip the agent frontmatter permission guard (not recommended).
export const SKIP_GUARD = process.env.UT_SKIP_GUARD === "1";

// Runner: opencode (default) | qwen (needs the qwen-code SDK installed).
export const RUNNER_KIND = (process.env.UT_RUNNER ?? "opencode") as "opencode" | "qwen";

// Models: empty = don't pass --model; the agent .md's model field decides (agent file is SSOT).
// Env vars only override.
export const WRITER_MODEL = process.env.UT_WRITER_MODEL ?? process.env.UT_MODEL ?? "";
export const REVIEWER_MODEL = process.env.UT_REVIEWER_MODEL ?? "";

// Per-run agent wall-clock timeout (replaces the SDK's maxSessionTurns).
export const AGENT_TIMEOUT_MS = Number(process.env.UT_AGENT_TIMEOUT_MS ?? 15 * 60 * 1000);
export const OPENCODE_BIN = process.env.UT_OPENCODE_BIN ?? "opencode";
// 0 = drop --format json (fallback for versions without JSONL events; loses live progress).
export const OPENCODE_JSON_EVENTS = process.env.UT_OPENCODE_JSON !== "0";
// 1 = append --dangerously-skip-permissions to the writer call.
// Last resort when non-interactive permission blocks writes; the writer's bash/webfetch
// are already off at the agent-tools layer, so risk is bounded. Off by default.
export const OPENCODE_SKIP_PERMS = process.env.UT_OC_SKIP_PERMS === "1";

export const STANDARDS_PATH =
  process.env.UT_STANDARDS_PATH ??
  path.join(TESTGEN_ROOT, "standards", "java-ut-standards.md");

// Rubric search order: env override -> target repo -> the tool's own copy.
export const SKILL_DIR_CANDIDATES = skillDirCandidates(
  REPO_ROOT,
  TESTGEN_ROOT,
  process.env.UT_SKILL_DIR,
);

// Artifacts, namespaced per target repo.
export const RUNS_DIR = runsDirFor(TESTGEN_ROOT, REPO_ROOT);

// Six score thresholds (0-10, per skill rubric). Partial override via UT_SCORE_THRESHOLDS='{"coverage":6}'.
export interface ScoreThresholds {
  effectiveness: number;
  coverage: number;
  independence: number;
  readability: number;
  fast_reliable: number;
  mock_appropriateness: number;
}
export const SCORE_THRESHOLDS: ScoreThresholds = (() => {
  const def: ScoreThresholds = {
    effectiveness: 7,
    coverage: 7,
    independence: 7,
    readability: 6,
    fast_reliable: 7,
    mock_appropriateness: 6,
  };
  const raw = process.env.UT_SCORE_THRESHOLDS;
  if (!raw) return def;
  try {
    return { ...def, ...JSON.parse(raw) };
  } catch {
    return def;
  }
})();

// Dimension weights (skill rubric Part 3.1): weighted = Σ(score×weight)×10 -> 0-100.
export const RUBRIC_WEIGHTS: ScoreThresholds = {
  effectiveness: 0.25,
  coverage: 0.2,
  independence: 0.15,
  readability: 0.15,
  fast_reliable: 0.15,
  mock_appropriateness: 0.1,
};

// Grade bands (skill rubric Part 3.2); grade is report-only, not a gate condition.
export const GRADE_BANDS: ReadonlyArray<{ min: number; grade: string }> = [
  { min: 85, grade: "A" },
  { min: 70, grade: "B" },
  { min: 55, grade: "C" },
  { min: -Infinity, grade: "D" },
];

// Extra maven args, e.g. UT_MAVEN_ARGS="jacoco:report" (when report isn't bound to the test phase).
export const MAVEN_EXTRA_ARGS = (process.env.UT_MAVEN_ARGS ?? "")
  .split(" ")
  .filter(Boolean);

// Global opencode config dir (agents/skill installed here by scripts/setup.ts).
export const GLOBAL_OPENCODE_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "opencode",
);
