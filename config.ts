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

// Numeric env vars fail fast on garbage. `Number("five")` is NaN, and NaN silently
// disables whatever it configures: a NaN MAX_ITER runs zero rounds, a NaN timeout
// fires immediately and kills every agent. Exiting with the variable's name beats both.
export function numEnv(name: string, def: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.error(`FATAL: ${name}=${raw} 不是有效數值（需 >= ${min}）`);
    process.exit(1);
  }
  return n;
}

export const MAX_ITER = numEnv("UT_MAX_ITER", 5, 1);
// Upper bound on the failure report fed back to the writer each round. A build log grows with
// the module, not with the writer's mistake — an unbounded report crowds the model's context
// out with maven boilerplate and leaves no room to actually fix anything.
export const MAX_FEEDBACK_CHARS = numEnv("UT_MAX_FEEDBACK_CHARS", 12000, 500);
// Per-round caps on surefire failure detail: how many failing test classes get quoted, and
// how much of each. Without these, one broken module produces a report longer than the tests.
export const MAX_FAILURE_BLOCKS = numEnv("UT_MAX_FAILURE_BLOCKS", 5, 1);
export const MIN_LINE_COV = numEnv("UT_MIN_LINE_COV", 80);
export const MIN_BRANCH_COV = numEnv("UT_MIN_BRANCH_COV", 70);
// 1 = fail the coverage gate when no JaCoCo report is found (default: skip leniently).
export const STRICT_COV = process.env.UT_STRICT_COV === "1";
// 1 = let a passing build through even when zero tests actually ran (default: fail-closed).
export const ALLOW_ZERO_TESTS = process.env.UT_ALLOW_ZERO_TESTS === "1";
// 1 = skip the baseline pre-check build (saves one full build; the loop then cannot tell
// a pre-existing red module from one the writer broke).
export const SKIP_BASELINE = process.env.UT_SKIP_BASELINE === "1";
// 1 = run the pre-check but proceed on a red baseline instead of aborting. The known-broken
// files are then carried into every fix prompt as "not yours, do not fix".
export const ALLOW_DIRTY_BASELINE = process.env.UT_ALLOW_DIRTY_BASELINE === "1";
// 0 = accept reviewer verdicts produced without a single tool call (default: fail-closed).
export const REVIEWER_MUST_READ = process.env.UT_REVIEWER_MUST_READ !== "0";
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
export const AGENT_TIMEOUT_MS = numEnv("UT_AGENT_TIMEOUT_MS", 15 * 60 * 1000, 1000);
// Build/test gate wall-clock timeout. A hung mvn (unreachable repo, a test with a real
// socket) was the one unbounded wait left in the pipeline.
export const BUILD_TIMEOUT_MS = numEnv("UT_BUILD_TIMEOUT_MS", 30 * 60 * 1000, 1000);
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

// Artifacts, namespaced per target repo. UT_RUNS_DIR overrides the base for shared or
// read-only installs (default: the tool's own clone).
export const RUNS_DIR = process.env.UT_RUNS_DIR
  ? path.join(process.env.UT_RUNS_DIR, path.basename(REPO_ROOT))
  : runsDirFor(TESTGEN_ROOT, REPO_ROOT);

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
    // A silently ignored override would make the operator believe their thresholds apply.
    console.error(`[WARN] UT_SCORE_THRESHOLDS 不是合法 JSON，已改用預設門檻：${raw}`);
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
