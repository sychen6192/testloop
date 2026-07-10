/**
 * 集中設定（SSOT：所有門檻與參數只在此定義）
 * - 讀取 tools/testgen/.env（不覆蓋既有環境變數）
 * - REPO_ROOT = 執行時的工作目錄（必須在 Java repo 根執行）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** testgen 自身所在目錄（與執行 cwd 無關） */
export const TESTGEN_ROOT = __dirname;

// --- 極簡 .env 載入（TESTGEN_ROOT/.env；已存在的環境變數不覆蓋） ---
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

/** Java repo 根（= 執行 cwd）。多模組時是 reactor root。 */
export const REPO_ROOT = process.cwd();
/** CLI 第一個參數：目標資料夾或單一 .java 檔 */
export const TARGET_ARG = process.argv[2];

export const MAX_ITER = Number(process.env.UT_MAX_ITER ?? 5);
export const MIN_LINE_COV = Number(process.env.UT_MIN_LINE_COV ?? 80);
export const MIN_BRANCH_COV = Number(process.env.UT_MIN_BRANCH_COV ?? 70);
/** 1 = 找不到 JaCoCo 報告時 coverage gate 直接 FAIL（預設寬鬆略過） */
export const STRICT_COV = process.env.UT_STRICT_COV === "1";
export const SKIP_REVIEW = process.env.UT_SKIP_REVIEW === "1";
export const QUIET = process.env.UT_QUIET === "1";
/** 1 = 跳過 agent frontmatter 權限 guard（不建議） */
export const SKIP_GUARD = process.env.UT_SKIP_GUARD === "1";

/** runner 選擇：opencode（預設）| qwen（需另裝 @qwen-code/sdk） */
export const RUNNER_KIND = (process.env.UT_RUNNER ?? "opencode") as "opencode" | "qwen";

/**
 * 模型：留空 = 不傳 --model，由 .opencode/agent/*.md 的 model 欄位決定（agent 檔為 SSOT）。
 * 環境變數僅作覆蓋用。
 */
export const WRITER_MODEL = process.env.UT_WRITER_MODEL ?? process.env.UT_MODEL ?? "";
export const REVIEWER_MODEL = process.env.UT_REVIEWER_MODEL ?? "";

/** 單輪 agent wall-clock 逾時（取代 SDK 的 maxSessionTurns） */
export const AGENT_TIMEOUT_MS = Number(process.env.UT_AGENT_TIMEOUT_MS ?? 15 * 60 * 1000);
export const OPENCODE_BIN = process.env.UT_OPENCODE_BIN ?? "opencode";
/** 0 = 不加 --format json（版本不支援 JSONL 事件時的退路，會失去即時進度） */
export const OPENCODE_JSON_EVENTS = process.env.UT_OPENCODE_JSON !== "0";
/**
 * 1 = writer 呼叫附加 --dangerously-skip-permissions。
 * 僅在非互動模式被 permission 擋住寫檔時的最後手段；writer 的 bash/webfetch
 * 已在 agent tools 層關閉，風險受控，但預設關閉。
 */
export const OPENCODE_SKIP_PERMS = process.env.UT_OC_SKIP_PERMS === "1";

export const STANDARDS_PATH =
  process.env.UT_STANDARDS_PATH ??
  path.join(TESTGEN_ROOT, "standards", "java-ut-standards.md");

/** skill rubric 搜尋順序：env 指定 → .opencode/skills → .claude/skills */
export const SKILL_DIR_CANDIDATES = [
  process.env.UT_SKILL_DIR,
  path.join(REPO_ROOT, ".opencode", "skills", "test-quality-evaluator"),
  path.join(REPO_ROOT, ".claude", "skills", "test-quality-evaluator"),
].filter(Boolean) as string[];

/** 每次執行的 artifacts 落盤位置 */
export const RUNS_DIR = path.join(TESTGEN_ROOT, "runs");

/** 六維分數門檻（0-10 制，對齊 skill rubric）。可用 UT_SCORE_THRESHOLDS='{"coverage":6}' 局部覆蓋。 */
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

/** skill rubric 的維度權重（SKILL.md Part 3.1）：weighted = Σ(score×weight)×10 → 0-100 */
export const RUBRIC_WEIGHTS: ScoreThresholds = {
  effectiveness: 0.25,
  coverage: 0.2,
  independence: 0.15,
  readability: 0.15,
  fast_reliable: 0.15,
  mock_appropriateness: 0.1,
};

/** skill rubric 的 grade bands（SKILL.md Part 3.2）；grade 僅供報告，不作 gate 條件 */
export const GRADE_BANDS: ReadonlyArray<{ min: number; grade: string }> = [
  { min: 85, grade: "A" },
  { min: 70, grade: "B" },
  { min: 55, grade: "C" },
  { min: -Infinity, grade: "D" },
];

/** 額外 maven 參數，例如 UT_MAVEN_ARGS="jacoco:report"（report 未綁 test phase 時） */
export const MAVEN_EXTRA_ARGS = (process.env.UT_MAVEN_ARGS ?? "")
  .split(" ")
  .filter(Boolean);
