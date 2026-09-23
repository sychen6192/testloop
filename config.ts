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
export function numEnv(name: string, def: number, min = 0, max = Infinity): number {
  const raw = process.env[name];
  // Blank is unset — a quoted `NAME=" "` in .env, a blank string in a CI config — not the 0 that
  // Number(" ") makes of it.
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(
      `FATAL: ${name}=${raw} 不是有效數值（需 >= ${min}${Number.isFinite(max) ? ` 且 <= ${max}` : ""}）`,
    );
    process.exit(1);
  }
  return n;
}

// A count: a fraction is a typo, not a setting — UT_API_MAX_TOKENS=4096.5 reached the endpoint as a
// max_tokens it rejected, and UT_BATCH_SIZE=1.5 quietly ran batches of one.
// Written out in decimal digits, too: Number() also reads "1e3" and "0x10", neither of which anyone
// types for a count on purpose.
export function intEnv(name: string, def: number, min = 0, max = Infinity): number {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() !== "" && !/^[+-]?\d+$/.test(raw.trim())) {
    console.error(`FATAL: ${name}=${raw} 必須是十進位整數`);
    process.exit(1);
  }
  const n = numEnv(name, def, min, max);
  if (!Number.isSafeInteger(n)) {
    console.error(`FATAL: ${name}=${raw} 必須是整數`);
    process.exit(1);
  }
  return n;
}

// setTimeout's ceiling. A longer delay is not "wait longer": Node clamps it to 1ms and fires at
// once, so an operator who sets a huge UT_AGENT_TIMEOUT_MS to mean "never time out" would have
// every agent and every build killed the moment it starts. ~24.8 days is already "never".
export const MAX_TIMER_MS = 2_147_483_647;

export const MAX_ITER = intEnv("UT_MAX_ITER", 5, 1);
// Target classes per batch when the target is a folder. Each batch is a full maker-checker loop
// of its own — fresh writer and reviewer sessions, its own MAX_ITER rounds — and a batch that
// fails is set aside without ending the run. One class per batch is what a writer session can
// reliably finish; a whole package in one session outgrew the model's context and the agent
// timeout, and one class that would not go green ended the run for every other class.
export const BATCH_SIZE = intEnv("UT_BATCH_SIZE", 1, 1);
// Upper bound on the failure report fed back to the writer each round. A build log grows with
// the module, not with the writer's mistake — an unbounded report crowds the model's context
// out with maven boilerplate and leaves no room to actually fix anything.
export const MAX_FEEDBACK_CHARS = intEnv("UT_MAX_FEEDBACK_CHARS", 12000, 500);
// Per-round caps on surefire failure detail: how many failing test classes get quoted, and
// how much of each. Without these, one broken module produces a report longer than the tests.
export const MAX_FAILURE_BLOCKS = intEnv("UT_MAX_FAILURE_BLOCKS", 5, 1);
// Failing test cases quoted per class. One @Nested test class can fail 50 cases at once, and
// quoting all of them would spend the whole feedback budget on one mistake repeated 50 times.
export const MAX_FAILURE_CASES = intEnv("UT_MAX_FAILURE_CASES", 10, 1);
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
// A red baseline is repaired by default: a bounded writer loop fixes the pre-existing failures
// (scope- and shrink-guarded) until the same build command is green, and only then does test
// generation start. 0 = abort on a red baseline instead, as before.
export const REPAIR_BASELINE = process.env.UT_REPAIR_BASELINE !== "0";
export const REPAIR_MAX_ITER = intEnv("UT_REPAIR_MAX_ITER", 5, 1);
// Consecutive repair rounds whose red count did not go down before the loop gives up. The
// stuck check needs two *identical* reports; a writer that fixes one file and breaks another
// keeps producing fresh text forever, so only the count catches it. On a module whose existing
// tests are @SpringBootTest a wasted round is 8-15 minutes, which is what makes this worth
// its own cut-off rather than leaving it to REPAIR_MAX_ITER.
export const REPAIR_NO_PROGRESS_ROUNDS = intEnv("UT_REPAIR_NO_PROGRESS_ROUNDS", 2, 1);
// Which tests the build gate runs each round. "module" (default) runs the whole module and its
// upstream modules, exactly as before. "generated" narrows surefire to the target classes' own
// tests during iterations and does one full module run before declaring success — the module
// run is what proves the new tests broke nothing, so it is not optional, only deferred.
// Measured on a 200-test fixture with a simulated Spring context: 23.6s -> 3.2s per iteration.
// Maven only; gradle falls back to "module" with a warning.
export const TEST_SCOPE = (process.env.UT_TEST_SCOPE ?? "module") as "module" | "generated";
// 1 = only warn when the writer shrinks a pre-existing test file (fewer @Test methods or
// assertions, or a new @Disabled). Default fails the round and feeds the shrink back — to the
// build gate, "fixed the test" and "deleted the test" look the same; this is what tells them apart.
export const ALLOW_TEST_SHRINK = process.env.UT_ALLOW_TEST_SHRINK === "1";
// 0 = accept reviewer verdicts produced without a single tool call (default: fail-closed).
export const REVIEWER_MUST_READ = process.env.UT_REVIEWER_MUST_READ !== "0";
// Extra reviewer attempts when its output cannot be parsed into a verdict. A parse failure is
// the reviewer malfunctioning, not the tests being bad — the writer cannot fix it by rewriting
// them, so the retries happen here rather than costing writer rounds. 0 disables them.
export const REVIEW_MAX_RETRIES = intEnv("UT_REVIEW_MAX_RETRIES", 2, 0);
export const SKIP_REVIEW = process.env.UT_SKIP_REVIEW === "1";
export const QUIET = process.env.UT_QUIET === "1";
// 1 = skip the agent frontmatter permission guard (not recommended).
export const SKIP_GUARD = process.env.UT_SKIP_GUARD === "1";

// Runner: opencode (default) | api (direct OpenAI-compatible endpoint, no agent CLI)
// | qwen (needs the qwen-code SDK installed).
export const RUNNER_KIND = (process.env.UT_RUNNER ?? "opencode") as "opencode" | "api" | "qwen";

// Models: empty = don't pass --model; the agent .md's model field decides (agent file is SSOT).
// Env vars only override.
export const WRITER_MODEL = process.env.UT_WRITER_MODEL ?? process.env.UT_MODEL ?? "";
export const REVIEWER_MODEL = process.env.UT_REVIEWER_MODEL ?? "";

// Per-run agent wall-clock timeout (replaces the SDK's maxSessionTurns).
export const AGENT_TIMEOUT_MS = numEnv("UT_AGENT_TIMEOUT_MS", 15 * 60 * 1000, 1000, MAX_TIMER_MS);

// --- api runner (UT_RUNNER=api): POST <base>/chat/completions with tools ---
// Base URL of any OpenAI-compatible server, e.g. http://localhost:11434/v1 (Ollama),
// http://host:8000/v1 (vLLM). OPENAI_BASE_URL / OPENAI_API_KEY are honoured as fallbacks so an
// existing qwen-runner .env keeps working. Models come from UT_WRITER_MODEL / UT_REVIEWER_MODEL
// (required for this runner — there is no agent file to default from).
export const API_BASE_URL = (process.env.UT_API_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "")
  .trim()
  .replace(/\/+$/, "");
export const API_KEY = process.env.UT_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
// Assistant turns per session before the run is cut off — the loop's own bound, since the
// model has none.
export const API_MAX_TURNS = intEnv("UT_API_MAX_TURNS", 60, 1);
// Passed as max_tokens when > 0; 0 = server default (some local servers default too low to
// write a full test class).
export const API_MAX_TOKENS = intEnv("UT_API_MAX_TOKENS", 8192);
// Tool results are clipped to this many characters so one read cannot fill the context.
export const API_MAX_TOOL_RESULT_CHARS = intEnv("UT_API_MAX_TOOL_RESULT_CHARS", 24000, 500);
export const WRITER_TEMPERATURE = numEnv("UT_WRITER_TEMPERATURE", 0.2);
// How long a transient model-side failure is retried before the session is reported as not
// finished. api runner: network errors, 429 and 5xx on one request, once the endpoint has answered
// this run. opencode runner: re-running a session whose opencode exited abnormally (it gives up on
// a provider error by itself), once that agent has completed a session this run. A model server
// restarting or a gateway shedding load is over in a minute or two; three quick attempts used to
// end the whole run on a few seconds of 503. Bounded by UT_AGENT_TIMEOUT_MS too. 0 = no retries;
// any other value gets at least one. Before the endpoint has answered (api) or the agent has done
// anything (opencode) this does not apply: 3 quick attempts, or none, and the failure is reported
// as configuration.
export const AGENT_RETRY_WINDOW_MS = numEnv("UT_AGENT_RETRY_WINDOW_MS", 3 * 60 * 1000, 0, MAX_TIMER_MS);
// The reviewer's temperature is 0 by architecture (hard rule 3), not by configuration.
export const REVIEWER_TEMPERATURE = 0;
// Build/test gate wall-clock timeout. A hung mvn (unreachable repo, a test with a real
// socket) was the one unbounded wait left in the pipeline.
export const BUILD_TIMEOUT_MS = numEnv("UT_BUILD_TIMEOUT_MS", 30 * 60 * 1000, 1000, MAX_TIMER_MS);
// How much build output is kept in memory for the gates (characters). Beyond it the head is
// dropped and only its [ERROR] / "Tests run:" lines survive. An unbounded capture crashed the
// whole tool at V8's ~512M-character string limit when a test logged heavily.
// At most 200M: the window is trimmed once it reaches twice this, and that join must stay under
// V8's ~536M-character limit.
export const MAX_BUILD_OUTPUT_CHARS = intEnv("UT_MAX_BUILD_OUTPUT_CHARS", 64 * 1024 * 1024, 100_000, 200 * 1024 * 1024);
export const OPENCODE_BIN = process.env.UT_OPENCODE_BIN ?? "opencode";

// --- Corporate network: proxy and TLS interception ---------------------------
// The UT_ form wins so a run can override a shell that already exports the standard names;
// otherwise the standard lowercase/uppercase variables are honoured, the way curl and git do.
function envAny(names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v.trim();
  }
  return "";
}

export const HTTPS_PROXY = envAny(["UT_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"]);
export const HTTP_PROXY = envAny(["UT_HTTP_PROXY", "HTTP_PROXY", "http_proxy"]);
export const NO_PROXY = envAny(["UT_NO_PROXY", "NO_PROXY", "no_proxy"]);
// CA bundle(s) to trust where a proxy re-signs TLS. Comma-separated; a root and its
// intermediate often arrive as two files. Read at request time rather than process start,
// so it works however the tool was launched — NODE_EXTRA_CA_CERTS does not.
export const CA_CERTS = envAny(["UT_CA_CERTS"]);
// Some proxies filter the CONNECT request by User-Agent.
export const USER_AGENT_OVERRIDE = envAny(["UT_USER_AGENT"]);
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
