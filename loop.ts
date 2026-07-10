// Entry point: npx tsx <clone>/loop.ts <target dir or .java file> (or bin/testgen)
// Must run from the Java repo root (REPO_ROOT = cwd).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPO_ROOT,
  TARGET_ARG,
  MAX_ITER,
  MIN_LINE_COV,
  MIN_BRANCH_COV,
  SKIP_REVIEW,
  STANDARDS_PATH,
  SKILL_DIR_CANDIDATES,
  RUNS_DIR,
  RUNNER_KIND,
  WRITER_MODEL,
  REVIEWER_MODEL,
  SCORE_THRESHOLDS,
  STRICT_COV,
} from "./config";
import { banner, log, die } from "./libs/log";
import { listJavaClasses, findModuleInfo } from "./libs/utils";
import { loadRubric } from "./libs/rubric";
import { assertAgents } from "./libs/guard";
import { getToolVersion } from "./libs/version";
import { detectBuildTool } from "./gates/build";
import { createRunner } from "./runners/runner";
import { orchestrate } from "./orchestrator";

async function main() {
  banner("write-java-ut pipeline 啟動");
  const toolVersion = getToolVersion();
  log(`工具版本：${toolVersion}`);

  if (!TARGET_ARG) {
    die(
      "請提供要寫 UT 的類別資料夾或 .java 檔，例如：\n" +
        "  npx tsx <clone 路徑>/loop.ts core-module/src/main/java/com/acme/service",
    );
  }
  const absTarget = path.resolve(REPO_ROOT, TARGET_ARG);
  if (!fs.existsSync(absTarget)) die(`找不到目標：${absTarget}`);
  if (!absTarget.startsWith(REPO_ROOT)) {
    die("目標必須位於目前工作目錄底下（請在 Java repo 根目錄執行本指令）");
  }

  const mod = findModuleInfo(absTarget, REPO_ROOT);
  const buildTool = detectBuildTool(mod.moduleRoot);
  const targetClasses = listJavaClasses(absTarget, REPO_ROOT);
  if (targetClasses.length === 0) die(`目標沒有 .java 檔：${absTarget}`);

  if (!fs.existsSync(STANDARDS_PATH)) die(`找不到品質標準檔：${STANDARDS_PATH}`);
  const standards = fs.readFileSync(STANDARDS_PATH, "utf8");

  const { rubric, source } = loadRubric(SKILL_DIR_CANDIDATES);
  const effectiveRubric = rubric || standards;

  log(`工作目錄（repo root）：${REPO_ROOT}`);
  log(`目標模組：${mod.multiModule ? mod.moduleRel : "（單一模組）"}`);
  log(`建置工具：${buildTool}`);
  log(`目標類別 ${targetClasses.length} 個：`);
  targetClasses.forEach((c) => log(`  - ${c}`));
  log(`品質標準：${STANDARDS_PATH}`);
  log(
    rubric
      ? `審查 rubric 來源：${source}`
      : "[WARN] 找不到 skill rubric（references/rubric.md 或 rubric/*.md），review gate 退回使用 standards 全文",
  );
  log(
    `runner=${RUNNER_KIND}, writer_model=${WRITER_MODEL || "（agent 預設）"}, ` +
      `reviewer_model=${REVIEWER_MODEL || "（agent 預設）"}`,
  );
  log(
    `參數：MAX_ITER=${MAX_ITER}, LINE>=${MIN_LINE_COV}, BRANCH>=${MIN_BRANCH_COV}, ` +
      `STRICT_COV=${STRICT_COV ? "on" : "off"}, review_gate=${SKIP_REVIEW ? "關閉" : "開啟"}`,
  );

  if (RUNNER_KIND === "opencode") assertAgents();

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "params.json"),
    JSON.stringify(
      {
        target: TARGET_ARG,
        module: mod.moduleRel || "(root)",
        buildTool,
        targetClasses,
        thresholds: { MIN_LINE_COV, MIN_BRANCH_COV, scores: SCORE_THRESHOLDS },
        runner: RUNNER_KIND,
        toolVersion,
      },
      null,
      2,
    ),
  );
  log(`artifacts：${runDir}`);

  const runner = await createRunner();
  const result = await orchestrate({
    targetClasses,
    buildTool,
    runner,
    standards,
    rubric: effectiveRubric,
    skipReview: SKIP_REVIEW,
    mod,
    runDir,
  });

  banner("SUMMARY");
  log(`結果：${result.success ? "[OK] 全部關卡通過" : "[FAIL] 未通過"}（迭代 ${result.iterations} 輪）`);
  console.log(result.coverageReport);
  if (result.finalVerdict) {
    const v = result.finalVerdict;
    console.log(`review scores：${JSON.stringify(v.scores)}`);
    if (v.weightedScore !== undefined) {
      console.log(`weighted_score=${v.weightedScore} grade=${v.grade}（依 skill 權重 25/20/15/15/15/10 確定性計算）`);
    }
  }
  if (!result.success && result.finalFeedback) {
    console.log(`最後失敗報告：\n${result.finalFeedback}`);
  }
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(result, (k, v) => (k === "raw" ? undefined : v), 2),
  );
  log(`artifacts 已寫入：${runDir}`);
  process.exit(result.success ? 0 : 2);
}

main().catch((e) => die(String(e?.stack ?? e)));
