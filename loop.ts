// Entry point: npx tsx <clone>/loop.ts <target dir or .java file> (or bin/testgen)
// Must run from the Java repo root (REPO_ROOT = cwd).
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPO_ROOT,
  TARGET_ARG,
  MAX_ITER,
  MAX_FEEDBACK_CHARS,
  MIN_LINE_COV,
  MIN_BRANCH_COV,
  SKIP_REVIEW,
  SKIP_BASELINE,
  ALLOW_DIRTY_BASELINE,
  REPAIR_BASELINE,
  REPAIR_MAX_ITER,
  ALLOW_TEST_SHRINK,
  TEST_SCOPE,
  STANDARDS_PATH,
  SKILL_DIR_CANDIDATES,
  RUNS_DIR,
  RUNNER_KIND,
  WRITER_MODEL,
  REVIEWER_MODEL,
  SCORE_THRESHOLDS,
  STRICT_COV,
  ALLOW_ZERO_TESTS,
  REVIEWER_MUST_READ,
  AGENT_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  MAVEN_EXTRA_ARGS,
} from "./config";
import { execSync } from "node:child_process";
import { banner, log, die } from "./libs/log";
import { listJavaClasses, findModuleInfo, findExistingTests, stripRaw } from "./libs/utils";
import { scanTestConventions } from "./libs/conventions";
import { loadRubric } from "./libs/rubric";
import { assertAgents } from "./libs/guard";
import { getToolVersion } from "./libs/version";
import { detectBuildTool, runBaseline } from "./gates/build";
import { createRunner } from "./runners/runner";
import { orchestrate, repairBaseline, RepairResult } from "./orchestrator";
import { PreExistingFailures } from "./prompts";

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
  // path.relative-based containment: a plain startsWith would accept /work/repo-evil
  // as being inside /work/repo.
  const rel = path.relative(REPO_ROOT, absTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
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

  // Existing tests, resolved deterministically rather than left to the writer to discover.
  const existingTests = targetClasses.map((cls) => ({
    cls,
    tests: findExistingTests(cls, REPO_ROOT),
  }));
  const withExisting = existingTests.filter((e) => e.tests.length > 0);
  if (withExisting.length) {
    log(`既有測試檔（writer 將被要求修改這些檔案，而非另建新檔）：`);
    withExisting.forEach((e) => log(`  - ${e.cls} → ${e.tests.join("、")}`));
  }

  // Measured, not guessed: no blanket rule on test-class visibility is correct (JUnit 5 wants
  // package-private, a @SelectClasses suite needs public), so the repo decides.
  const conventions = scanTestConventions(
    path.join(mod.moduleRoot, "src", "test", "java"),
    REPO_ROOT,
  );
  if (conventions.classRefSuites.length) {
    log(`測試套件（強制 public 測試類別）：${conventions.classRefSuites.join("、")}`);
  } else if (conventions.publicCount + conventions.packagePrivateCount > 0) {
    log(
      `既有測試可見性慣例：public ${conventions.publicCount} 個、` +
        `package-private ${conventions.packagePrivateCount} 個（掃描 ${conventions.scanned} 檔）`,
    );
  }
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

  // The target repo's HEAD, so a run record says what code the tests were written against.
  let targetGitSha = "no-git";
  try {
    targetGitSha = execSync("git rev-parse HEAD", {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    /* not a git repo */
  }

  // Every effective knob goes in — a params.json that omits half the config cannot
  // reproduce the run it describes.
  fs.writeFileSync(
    path.join(runDir, "params.json"),
    JSON.stringify(
      {
        target: TARGET_ARG,
        module: mod.moduleRel || "(root)",
        buildTool,
        targetClasses,
        targetGitSha,
        thresholds: { MIN_LINE_COV, MIN_BRANCH_COV, scores: SCORE_THRESHOLDS },
        runner: RUNNER_KIND,
        writerModel: WRITER_MODEL || "(agent default)",
        reviewerModel: REVIEWER_MODEL || "(agent default)",
        maxIter: MAX_ITER,
        strictCov: STRICT_COV,
        allowZeroTests: ALLOW_ZERO_TESTS,
        skipBaseline: SKIP_BASELINE,
        allowDirtyBaseline: ALLOW_DIRTY_BASELINE,
        repairBaseline: REPAIR_BASELINE,
        repairMaxIter: REPAIR_MAX_ITER,
        allowTestShrink: ALLOW_TEST_SHRINK,
        testScope: TEST_SCOPE,
        existingTests: Object.fromEntries(
          existingTests.filter((e) => e.tests.length).map((e) => [e.cls, e.tests]),
        ),
        conventions,
        maxFeedbackChars: MAX_FEEDBACK_CHARS,
        reviewerMustRead: REVIEWER_MUST_READ,
        skipReview: SKIP_REVIEW,
        agentTimeoutMs: AGENT_TIMEOUT_MS,
        buildTimeoutMs: BUILD_TIMEOUT_MS,
        mavenExtraArgs: MAVEN_EXTRA_ARGS,
        rubricSource: rubric ? source : "(standards fallback)",
        toolVersion,
      },
      null,
      2,
    ),
  );
  log(`artifacts：${runDir}`);

  // Baseline pre-check. The build gate runs `mvn -pl <module> -am test`, so every test source
  // in the module *and its upstream modules* must compile — a test file the tool never touched
  // can fail the gate on round 1 and keep failing it forever. A red baseline is repaired first:
  // same writer, same guards, same build command, and no generation until it is green. Only
  // when repair gives up does the run stop; UT_ALLOW_DIRTY_BASELINE=1 pushes on regardless.
  const runner = await createRunner({ writableRoot: path.join(mod.moduleRoot, "src", "test") });
  let preExisting: PreExistingFailures | undefined;
  let repair: RepairResult | undefined;
  if (SKIP_BASELINE) {
    log("[WARN] UT_SKIP_BASELINE=1：跳過預檢，既有紅燈將無法與 writer 造成的失敗區分");
  } else {
    banner("預檢基準（baseline）");
    const baseline = await runBaseline(buildTool, mod);
    fs.writeFileSync(path.join(runDir, "baseline.md"), baseline.summary);
    fs.writeFileSync(path.join(runDir, "baseline.log"), baseline.raw);
    console.log(baseline.summary);

    let clean = baseline.clean;
    if (!clean && REPAIR_BASELINE) {
      banner("修復既有紅燈（repair）");
      repair = await repairBaseline({ runner, buildTool, standards, mod, runDir, baseline });
      fs.writeFileSync(
        path.join(runDir, "repair-summary.md"),
        [
          `結果：${repair.success ? "已修復" : "未修復"}（${repair.stopReason}，${repair.rounds} 輪）`,
          `變更的測試檔（commit 前請檢視 diff）：`,
          ...(repair.changedFiles.length ? repair.changedFiles.map((f) => `  - ${f}`) : ["  （無）"]),
          ...(repair.success
            ? []
            : [
                "仍然紅燈：",
                ...repair.remaining.compileErrorFiles.map((f) => `  - ${f}（編譯失敗）`),
                ...repair.remaining.failingTestClasses.map((c) => `  - ${c}（測試失敗）`),
                "",
                repair.report,
              ]),
        ].join("\n"),
      );
      if (repair.success) {
        clean = true;
        log(
          `[OK] 既有紅燈已修復（${repair.rounds} 輪，變更 ${repair.changedFiles.length} 個測試檔）` +
            "——這些是 writer 對別人測試的改動，commit 前請檢視 diff：",
        );
        repair.changedFiles.forEach((f) => log(`  - ${f}`));
      } else {
        log(`[FAIL] 修復未能讓模組回到綠燈（${repair.stopReason}，${repair.rounds} 輪）`);
      }
    }

    if (!clean) {
      preExisting = repair
        ? repair.remaining
        : {
            compileErrorFiles: baseline.compileErrorFiles,
            failingTestClasses: baseline.failingTestClasses,
          };
      if (!ALLOW_DIRTY_BASELINE) {
        fs.writeFileSync(
          path.join(runDir, "summary.json"),
          JSON.stringify(
            {
              success: false,
              stopReason: repair ? `repair-failed:${repair.stopReason}` : "dirty-baseline",
              ...preExisting,
              repair,
            },
            null,
            2,
          ),
        );
        const still = [
          ...preExisting.compileErrorFiles.map((f) => `  - ${f}（編譯失敗）`),
          ...preExisting.failingTestClasses.map((c) => `  - ${c}（測試失敗）`),
        ].join("\n");
        die(
          (repair
            ? `修復 ${repair.rounds} 輪後模組仍無法通過建置（${repair.stopReason}）。仍然紅燈的：\n${still}\n` +
              "常見原因：根因在 production code 或建置設定（例如 pom.xml 的 Lombok annotation processor），" +
              "writer 無權修改。請人工修好後重跑，或：\n"
            : "模組在本工具介入前就無法通過建置，而 UT_REPAIR_BASELINE=0 關閉了自動修復。請先修好：\n" +
              `${still}\n或：\n`) +
            "  UT_ALLOW_DIRTY_BASELINE=1  照樣執行（已知紅燈會標記為 pre-existing 並要求 writer 不要碰）\n" +
            "  UT_SKIP_BASELINE=1         完全跳過預檢\n" +
            `詳見 ${runDir}`,
        );
      }
      log("[WARN] UT_ALLOW_DIRTY_BASELINE=1：帶著既有紅燈繼續，已知失敗會標記為 pre-existing");
    }
  }

  let result;
  try {
    result = await orchestrate({
      targetClasses,
      buildTool,
      runner,
      standards,
      rubric: effectiveRubric,
      skipReview: SKIP_REVIEW,
      mod,
      runDir,
      existingTests,
      preExisting,
      conventions,
    });
  } catch (e) {
    // A crashed run must still leave a summary — otherwise the artifacts directory
    // is indistinguishable from a run that is still going.
    fs.writeFileSync(
      path.join(runDir, "summary.json"),
      JSON.stringify({ success: false, stopReason: "crash", error: String(e) }, null, 2),
    );
    throw e;
  }

  banner("SUMMARY");
  log(
    `結果：${result.success ? "[OK] 全部關卡通過" : "[FAIL] 未通過"}` +
      `（迭代 ${result.iterations} 輪，stop=${result.stopReason}）`,
  );
  console.log(result.coverageReport);
  if (result.totalOutputTokens !== undefined) {
    log(`writer output tokens 合計：${result.totalOutputTokens}`);
  }
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
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ ...result, repair }, stripRaw, 2));
  log(`artifacts 已寫入：${runDir}`);
  process.exit(result.success ? 0 : 2);
}

main().catch((e) => die(String(e?.stack ?? e)));
