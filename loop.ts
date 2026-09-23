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
  BATCH_SIZE,
} from "./config";
import { execSync } from "node:child_process";
import { banner, log, die } from "./libs/log";
import { listJavaClasses, findModuleInfo, findExistingTests, stripRaw, codelessTypeReason } from "./libs/utils";
import { scanTestConventions } from "./libs/conventions";
import { loadRubric } from "./libs/rubric";
import { assertAgents } from "./libs/guard";
import { getToolVersion } from "./libs/version";
import { detectBuildTool, runBaseline, writableRel } from "./gates/build";
import { createRunner } from "./runners/runner";
import { orchestrate, repairBaseline, RepairResult } from "./orchestrator";
import { captureTree, chunk, rollbackTree, RollbackReport } from "./libs/batch";
import { AgentRunner, BuildTool, ModuleInfo, ReviewVerdict } from "./libs/types";
import { describeTestStack, measureTestStack, TestStack } from "./libs/teststack";
import { isUtf8Name, measureSourceEncoding, SourceEncoding } from "./libs/encoding";
import { installShutdownHandlers, onShutdown } from "./libs/shell";
import { acquireRepoLock } from "./libs/lock";
import { PreExistingFailures } from "./prompts";

async function main() {
  // Before anything can be interrupted: the SIGHUP rule in particular has to be in place before
  // a terminal can hang up on a run that is still in its baseline build.
  installShutdownHandlers();
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
  const javaFiles = listJavaClasses(absTarget, REPO_ROOT);
  if (javaFiles.length === 0) die(`目標沒有 .java 檔：${absTarget}`);
  // Types that compile to no executable code are not targets: no test can cover them, so the
  // coverage gate has nothing to hold the writer to and a reviewer has nothing to review.
  const codeless = javaFiles
    .map((cls) => ({ cls, why: codelessTypeReason(fs.readFileSync(path.join(REPO_ROOT, cls), "utf8")) }))
    .filter((c): c is { cls: string; why: string } => c.why !== null);
  const targetClasses = javaFiles.filter((cls) => !codeless.some((c) => c.cls === cls));
  if (targetClasses.length === 0) {
    die(
      `目標底下只有沒有可執行程式碼的型別（${codeless.map((c) => `${path.basename(c.cls)}：${c.why}`).join("、")}），` +
        "沒有東西可以寫單元測試。請改指定實作類別（例如 FooServiceImpl.java）或其所在資料夾。",
    );
  }

  if (!fs.existsSync(STANDARDS_PATH)) die(`找不到品質標準檔：${STANDARDS_PATH}`);
  const standards = fs.readFileSync(STANDARDS_PATH, "utf8");

  const { rubric, source } = loadRubric(SKILL_DIR_CANDIDATES);
  const effectiveRubric = rubric || standards;

  log(`工作目錄（repo root）：${REPO_ROOT}`);
  log(`目標模組：${mod.multiModule ? mod.moduleRel : "（單一模組）"}`);
  log(`建置工具：${buildTool}`);
  log(`目標類別 ${targetClasses.length} 個：`);
  targetClasses.forEach((c) => log(`  - ${c}`));
  if (codeless.length) {
    log(`略過 ${codeless.length} 個沒有可執行程式碼的型別（不產生測試、不列入覆蓋率門檻）：`);
    codeless.forEach((c) => log(`  - ${c.cls}（${c.why}）`));
  }

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
  // Locked before the directory exists: a run refused for sharing the repo leaves nothing behind.
  const busy = acquireRepoLock(REPO_ROOT, runDir);
  if (busy) {
    die(
      `同一個 repo（${REPO_ROOT}）已有另一個 testgen 在執行（pid ${busy.pid}，artifacts：${busy.runDir}）。\n` +
        "同一個 repo 併行會互相觸發 scope-violation（對方 writer 寫的檔案落在本次範圍外），-am 建置也會共用上游模組的 target/。\n" +
        `請等它結束，或改在另一個 clone / git worktree 執行。確定沒有在跑卻看到這個訊息，刪除 ${busy.lock} 即可。`,
    );
  }
  fs.mkdirSync(runDir, { recursive: true });
  crashRunDir = runDir;
  // Ctrl-C, SIGTERM, a hangup on an interactive terminal: the run still leaves a summary that
  // says it was interrupted, rather than a directory that looks like a run still going.
  onShutdown((reason) => {
    const p = path.join(runDir, "summary.json");
    if (!fs.existsSync(p)) {
      fs.writeFileSync(
        p,
        JSON.stringify({ success: false, stopReason: `interrupted:${reason}`, batches: batchProgress }, stripRaw, 2),
      );
    }
  });

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
        skippedCodeless: codeless,
        targetGitSha,
        thresholds: { MIN_LINE_COV, MIN_BRANCH_COV, scores: SCORE_THRESHOLDS },
        runner: RUNNER_KIND,
        writerModel: WRITER_MODEL || "(agent default)",
        reviewerModel: REVIEWER_MODEL || "(agent default)",
        maxIter: MAX_ITER,
        batchSize: BATCH_SIZE,
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
  // The baseline's failing identities, handed to the gate only under UT_ALLOW_DIRTY_BASELINE.
  let tolerate: string[] | undefined;
  let repair: RepairResult | undefined;
  // What the module's tests compile and run against, measured — see libs/teststack.ts. Measured
  // again after anything that runs tests, since a surefire classpath beats a reading of the pom.
  let testStack: TestStack | undefined;
  // And the encoding javac reads the sources in (libs/encoding.ts): the pom's, or the platform's,
  // which Maven names in every build log when the pom sets none.
  let sourceEncoding: SourceEncoding | undefined;
  const measureStack = (buildLog = "") => {
    const m = measureTestStack(mod, REPO_ROOT, buildLog);
    if (m) m.javaRelease ??= testStack?.javaRelease;
    testStack = m ?? testStack;
    sourceEncoding = measureSourceEncoding(mod, REPO_ROOT, buildLog) ?? sourceEncoding;
    fs.writeFileSync(
      path.join(runDir, "project-facts.json"),
      JSON.stringify({ testStack: testStack ?? null, sourceEncoding: sourceEncoding ?? null }, null, 2),
    );
  };
  const logFacts = () => {
    log(`測試相依：${describeTestStack(testStack)}`);
    if (sourceEncoding && !isUtf8Name(sourceEncoding.name)) {
      log(
        `[WARN] 原始碼編碼：${sourceEncoding.name}（${sourceEncoding.source === "pom" ? "pom 設定" : "pom 沒設定，Maven 用平台編碼"}）` +
          "——writer 留下的非 ASCII 字元會轉成 \\uXXXX，以這個編碼存、含中文的既有測試檔不讓 writer 修改",
      );
    } else if (sourceEncoding) {
      log(`原始碼編碼：${sourceEncoding.name}`);
    }
  };
  if (SKIP_BASELINE && ALLOW_DIRTY_BASELINE) {
    die(
      "UT_SKIP_BASELINE=1 與 UT_ALLOW_DIRTY_BASELINE=1 不能並用：沒有預檢就沒有「writer 介入前\n" +
        "就在失敗的測試」這份基準，gate 無從扣除。靜默退回全綠要求會讓你以為扣除生效了，\n" +
        "所以這裡直接中止。請擇一：要扣除就留著預檢，要省一次建置就拿掉 UT_ALLOW_DIRTY_BASELINE。",
    );
  }
  if (SKIP_BASELINE) {
    log("[WARN] UT_SKIP_BASELINE=1：跳過預檢，既有紅燈將無法與 writer 造成的失敗區分");
    measureStack();
    logFacts();
  } else {
    banner("預檢基準（baseline）");
    const baseline = await runBaseline(buildTool, mod);
    fs.writeFileSync(path.join(runDir, "baseline.md"), baseline.summary);
    fs.writeFileSync(path.join(runDir, "baseline.log"), baseline.raw);
    console.log(baseline.summary);
    if (baseline.aborted) {
      fs.writeFileSync(
        path.join(runDir, "summary.json"),
        JSON.stringify({ success: false, stopReason: "baseline-aborted", error: baseline.aborted }, null, 2),
      );
      die(
        `預檢建置沒有跑完：${baseline.aborted}\n` +
          "這不是既有紅燈，修復迴圈幫不上忙。建置每次都要跑這麼久時請調高 UT_BUILD_TIMEOUT_MS；" +
          `被 signal 終止多半是記憶體不足。詳見 ${path.join(runDir, "baseline.log")}`,
      );
    }
    measureStack(baseline.raw);
    logFacts();

    let clean = baseline.clean;
    // Repairing is only possible where the writer may write. A red common/ in a reactor, or a
    // broken production file, is not a slow repair — it is an impossible one, and entering the
    // loop spends the whole budget discovering that the writes are refused.
    // Two ways a red baseline is unfixable rather than slow to fix: the file is outside the
    // writer's scope, or the file is inside it but the cause is the environment. Both spend the
    // entire repair budget proving the same thing, which on a @SpringBootTest module is an hour.
    const repairable = baseline.outOfScope.length === 0 && baseline.envFailures.length === 0;
    if (!clean && REPAIR_BASELINE && baseline.outOfScope.length) {
      log(`[FAIL] 既有紅燈不在 writer 的可寫範圍（${writableRel(mod)}）內，略過修復迴圈：`);
      baseline.outOfScope.forEach((f) => log(`  - ${f}`));
    }
    if (!clean && REPAIR_BASELINE && baseline.envFailures.length) {
      log("[FAIL] 既有紅燈來自環境/設定，不是測試碼，略過修復迴圈：");
      baseline.envFailures.forEach((w) => log(`  - ${w}`));
    }
    if (!clean && REPAIR_BASELINE && repairable) {
      banner("修復既有紅燈（repair）");
      repair = await repairBaseline({ runner, buildTool, standards, mod, runDir, baseline, testStack, sourceEncoding });
      measureStack();
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
        if (repair.stopReason === "flaky-baseline") {
          log(`[WARN] ${repair.report}——不是穩定的紅燈，照常開始產生測試；這些測試本身需要人檢視`);
        } else {
          log(
            `[OK] 既有紅燈已修復（${repair.rounds} 輪，變更 ${repair.changedFiles.length} 個測試檔）` +
              "——這些是 writer 對別人測試的改動，commit 前請檢視 diff：",
          );
          repair.changedFiles.forEach((f) => log(`  - ${f}`));
        }
      } else {
        log(`[FAIL] 修復未能讓模組回到綠燈（${repair.stopReason}，${repair.rounds} 輪）`);
      }
    }

    // Some ways repair ends are not "could not make it green" and must not be pushed through by
    // UT_ALLOW_DIRTY_BASELINE: a scope violation leaves production code the writer changed on disk
    // (every later snapshot starts from the changed tree, so nothing would flag it again, and the
    // run could end gates-passed on it); a runner that cannot run or a build that does not finish
    // will not do better in the main loop.
    if (!clean && repair && ["scope-violation", "runner-spawn-error", "build-aborted"].includes(repair.stopReason)) {
      fs.writeFileSync(
        path.join(runDir, "summary.json"),
        JSON.stringify({ success: false, stopReason: `repair-failed:${repair.stopReason}`, repair }, null, 2),
      );
      die(`修復迴圈以 ${repair.stopReason} 結束，不論 UT_ALLOW_DIRTY_BASELINE 都不能繼續：\n${repair.report}\n詳見 ${runDir}`);
    }
    if (!clean) {
      // What the writer is told to leave alone: still red after repair AND red before it. A class
      // the repair writer turned red was not pre-existing — telling the writer not to touch it
      // while the gate (which tolerates only the baseline) demands it be fixed was a contradiction
      // that ended in stuck.
      preExisting = repair
        ? {
            compileErrorFiles: repair.remaining.compileErrorFiles.filter((f) => baseline.compileErrorFiles.includes(f)),
            failingTestClasses: repair.remaining.failingTestClasses.filter((c) => baseline.failingTestClasses.includes(c)),
          }
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
              stopReason: repair
                ? `repair-failed:${repair.stopReason}`
                : baseline.outOfScope.length
                  ? "dirty-baseline:out-of-scope"
                  : baseline.envFailures.length
                    ? "dirty-baseline:env-failure"
                    : "dirty-baseline",
              ...preExisting,
              outOfScope: baseline.outOfScope,
              envFailures: baseline.envFailures,
              repair,
            },
            null,
            2,
          ),
        );
        const stillLines = [
          ...preExisting.compileErrorFiles.map((f) => `  - ${f}（編譯失敗）`),
          ...preExisting.failingTestClasses.map((c) => `  - ${c}（測試失敗）`),
        ];
        // The classifier can name nothing — a build that failed before reaching any file, or
        // output it could not parse. Printing an empty list under "仍然紅燈的：" and then
        // guessing at Lombok tells the operator nothing; the summary carries the real extract.
        const still = stillLines.length
          ? stillLines.join("\n")
          : (repair?.report ?? baseline.summary);
        const outOfScopeList = baseline.outOfScope.map((f) => `  - ${f}`).join("\n");
        die(
          (repair
            ? `修復 ${repair.rounds} 輪後模組仍無法通過建置（${repair.stopReason}）。仍然紅燈的：\n${still}\n` +
              `${repairHint(repair.stopReason)}請人工修好後重跑，或：\n`
            : baseline.envFailures.length
              ? "模組在本工具介入前就無法通過建置，而紅燈來自環境/設定，不是測試碼——" +
                "檔案就算在 writer 可寫範圍內，改測試碼也不會讓它變綠：\n" +
                `${baseline.envFailures.map((w) => `  - ${w}`).join("\n")}\n` +
                "重量級整合測試（@SpringBootTest）的模組最常見。請先讓該環境起得來，或：\n"
            : baseline.outOfScope.length
              ? `模組在本工具介入前就無法通過建置，而其中 ${baseline.outOfScope.length} 項紅燈落在 writer 的可寫範圍` +
                `（${writableRel(mod)}）之外——它沒有權限修改這些檔案，所以沒有進入修復迴圈：\n` +
                `${outOfScopeList}\n` +
                (mod.multiModule
                  ? `多模組常見原因：build gate 跑的是 \`mvn -pl ${mod.moduleRel} -am test\`，` +
                    "上游模組的測試原始碼也要編得過、也會被執行。"
                  : "") +
                "請先人工修好上面這些，或：\n"
              : "模組在本工具介入前就無法通過建置，而 UT_REPAIR_BASELINE=0 關閉了自動修復。請先修好：\n" +
                `${still}\n或：\n`) +
            "  UT_ALLOW_DIRTY_BASELINE=1  照樣執行（已知紅燈會標記為 pre-existing 並要求 writer 不要碰）\n" +
            "  UT_SKIP_BASELINE=1         完全跳過預檢\n" +
            `詳見 ${runDir}`,
        );
      }
      log("[WARN] UT_ALLOW_DIRTY_BASELINE=1：帶著既有紅燈繼續，已知失敗會標記為 pre-existing");
      // The gate now compares instead of requiring: these identities may keep failing, anything
      // else that fails is the writer's doing and still turns the round red.
      // Only what failed before any writer ran. After a failed repair, something failing now that
      // did not fail then is the repair writer's doing — tolerating it would let a test it broke
      // ride through every later gate. A failing method it merely renamed fails closed, by design.
      tolerate = baseline.failingTests;
      if (tolerate.length) {
        log(`[dirty-baseline] build gate 將容忍以下 ${tolerate.length} 個既有失敗：`);
        tolerate.forEach((id) => log(`  - ${id}`));
      } else {
        log(
          "[WARN] 預檢認不出任何失敗的測試（沒有 surefire XML，或紅燈不是測試失敗），" +
            "gate 維持全綠要求——這個 run 很可能無法通過。",
        );
      }
    }
  }

  // A folder target runs as batches, each its own maker-checker loop; one batch is today's run.
  const batches = chunk(targetClasses, BATCH_SIZE);
  if (batches.length > 1) {
    const code = await runBatches({
      batches,
      buildTool,
      runner,
      standards,
      rubric: effectiveRubric,
      mod,
      runDir,
      preExisting,
      tolerate,
      repair,
      testStack,
      sourceEncoding,
    });
    log(`artifacts 已寫入：${runDir}`);
    process.exit(code);
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
      tolerate,
      conventions,
      testStack,
      sourceEncoding,
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
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify({ ...result, repair, toleratedFailures: tolerate ?? [] }, stripRaw, 2),
  );
  log(`artifacts 已寫入：${runDir}`);
  process.exit(result.success ? 0 : 2);
}

// ─── Batches ─────────────────────────────────────────────────────────────────
//
// A folder target used to be one run: one writer session for every class, one reviewer session
// reading every test, one budget of rounds. With more than a few classes the sessions outgrew the
// model's context and the agent timeout (the README advised targeting one class at a time), and a
// single class that would not go green ended the run for all the others. Each batch is now a
// maker-checker loop of its own. A batch that fails has its changes to the test tree set aside —
// copied to <batch>/rejected and the tree put back — so the next batch starts from a module that
// still builds, and src/test ends the run holding only tests that passed every gate.

interface BatchRecord {
  batch: number;
  targetClasses: string[];
  dir: string;
  success: boolean;
  stopReason: string;
  iterations: number;
  totalOutputTokens?: number;
  coverageReport?: string;
  finalFeedback?: string;
  finalVerdict?: ReviewVerdict;
  rolledBack?: RollbackReport & { rejectedDir: string };
}

// Read by the interrupt and crash handlers, so a run cut short still says which batches finished.
let batchProgress: BatchRecord[] | undefined;

// Stop reasons that belong to the environment rather than the batch: the next batch would meet them
// too. A scope violation also leaves files outside src/test changed on disk for a human to look at,
// and every later batch would be built against them.
const RUN_STOPS = new Set(["runner-spawn-error", "scope-violation"]);
// Failures that come from outside the batch when they repeat — a writer session that never gets to
// write, a reviewer model that does not answer in JSON. Two batches in a row end the run rather
// than every remaining batch spending its rounds and builds rediscovering it.
const REPEAT_STOPS = new Set(["writer-no-op", "reviewer-unparseable"]);

interface BatchRunInput {
  batches: string[][];
  buildTool: BuildTool;
  runner: AgentRunner;
  standards: string;
  rubric: string;
  mod: ModuleInfo;
  runDir: string;
  preExisting?: PreExistingFailures;
  tolerate?: string[];
  repair?: RepairResult;
  testStack?: TestStack;
  sourceEncoding?: SourceEncoding;
}

async function runBatches(o: BatchRunInput): Promise<number> {
  const records: BatchRecord[] = [];
  batchProgress = records;
  const total = o.batches.reduce((n, b) => n + b.length, 0);
  const width = String(o.batches.length).length;
  const testTree = path.join(o.mod.moduleRoot, "src", "test");
  const treeRel = path.relative(REPO_ROOT, testTree).replace(/\\/g, "/");
  let stopped: { reason: string; message: string } | undefined;
  let stack = o.testStack;
  banner(`分批執行：${total} 個目標類別分成 ${o.batches.length} 批（UT_BATCH_SIZE=${BATCH_SIZE}）`);

  for (let i = 0; i < o.batches.length; i++) {
    const batch = o.batches[i];
    const tag = `batch-${String(i + 1).padStart(width, "0")}-${path.basename(batch[0], ".java")}`;
    const dir = path.join(o.runDir, tag);
    banner(`第 ${i + 1}/${o.batches.length} 批：${batch.map((c) => path.basename(c)).join("、")}`);
    // Measured again per batch: earlier batches add tests, and a later class's test may be among them.
    const existingTests = batch.map((cls) => ({ cls, tests: findExistingTests(cls, REPO_ROOT) }));
    const conventions = scanTestConventions(path.join(testTree, "java"), REPO_ROOT);
    // Earlier batches' builds leave a surefire classpath behind even when the baseline had none.
    const measured = measureTestStack(o.mod, REPO_ROOT);
    if (measured) measured.javaRelease ??= stack?.javaRelease;
    stack = measured ?? stack;
    const start = captureTree(testTree);
    const r = await orchestrate({
      targetClasses: batch,
      buildTool: o.buildTool,
      runner: o.runner,
      standards: o.standards,
      rubric: o.rubric,
      skipReview: SKIP_REVIEW,
      mod: o.mod,
      runDir: dir,
      existingTests,
      preExisting: o.preExisting,
      tolerate: o.tolerate,
      conventions,
      testStack: stack,
      sourceEncoding: o.sourceEncoding,
    });
    const rec: BatchRecord = {
      batch: i + 1,
      targetClasses: batch,
      dir,
      success: r.success,
      stopReason: r.stopReason,
      iterations: r.iterations,
      totalOutputTokens: r.totalOutputTokens,
      coverageReport: r.coverageReport,
      finalFeedback: r.finalFeedback,
      finalVerdict: r.finalVerdict,
    };
    // A scope violation is left exactly as it is: the changes outside src/test are the reason the
    // run stops, and the test files beside them are part of what a human has to look at.
    if (!r.success && r.stopReason !== "scope-violation") {
      const rejectedDir = path.join(dir, "rejected");
      const rb = rollbackTree(start, rejectedDir, treeRel);
      const touched = rb.created.length + rb.restored.length + rb.undeleted.length + rb.unrestorable.length;
      if (touched) {
        rec.rolledBack = { ...rb, rejectedDir };
        fs.writeFileSync(path.join(dir, "rollback.md"), renderRollback(rb, rejectedDir, treeRel));
        log(
          `這批的測試變更已移出 ${treeRel}（新增 ${rb.created.length}、還原 ${rb.restored.length + rb.undeleted.length} 個檔），` +
            `嘗試的版本保留在 ${rejectedDir}`,
        );
        if (rb.unrestorable.length) {
          log(`[WARN] 以下檔案過大、沒有備份，維持這批留下的狀態：${rb.unrestorable.join("、")}`);
        }
      }
    }
    records.push(rec);
    fs.writeFileSync(path.join(o.runDir, "batches.json"), JSON.stringify(records, stripRaw, 2));
    log(
      r.success
        ? `[OK] 第 ${i + 1}/${o.batches.length} 批通過（${r.iterations} 輪）`
        : `[FAIL] 第 ${i + 1}/${o.batches.length} 批未通過（${r.stopReason}，${r.iterations} 輪）`,
    );

    if (RUN_STOPS.has(r.stopReason)) {
      stopped = {
        reason: r.stopReason,
        message:
          r.stopReason === "scope-violation"
            ? "writer 改了測試範圍以外的檔案，變更未還原、需要人工檢視"
            : "agent 無法執行——這是環境問題，後面的批次也會一樣",
      };
      break;
    }
    const prev = records[records.length - 2];
    if (!r.success && REPEAT_STOPS.has(r.stopReason) && prev && !prev.success && prev.stopReason === r.stopReason) {
      stopped = {
        reason: r.stopReason,
        message: `連續兩批都以 ${r.stopReason} 結束——多半是模型端或權限的問題，不是這兩個類別本身`,
      };
      break;
    }
  }

  const passed = records.filter((r) => r.success).length;
  const notRun = o.batches.slice(records.length).flat();
  const success = passed === o.batches.length;
  const stopReason = success ? "gates-passed" : stopped ? `stopped:${stopped.reason}` : "some-batches-failed";
  const tokens = records.reduce<number | undefined>(
    (n, r) => (r.totalOutputTokens === undefined ? n : (n ?? 0) + r.totalOutputTokens),
    undefined,
  );

  banner("SUMMARY");
  log(`結果：${passed}/${o.batches.length} 批通過（stop=${stopReason}）`);
  for (const r of records) {
    const names = r.targetClasses.map((c) => path.basename(c, ".java")).join("、");
    log(
      r.success
        ? `  [OK]   ${names}（${r.iterations} 輪）`
        : `  [FAIL] ${names}：${r.stopReason}（${r.iterations} 輪）` +
            (r.rolledBack ? `——測試已移出 src/test，見 ${r.rolledBack.rejectedDir}` : ""),
    );
  }
  if (notRun.length) {
    log(`未執行的 ${notRun.length} 個類別（${stopped?.message ?? "提前停止"}）：`);
    notRun.forEach((c) => log(`  - ${c}`));
  }
  if (tokens !== undefined) log(`writer output tokens 合計：${tokens}`);
  const failed = records.filter((r) => !r.success);
  if (failed.length) {
    log("未通過的批次，失敗報告在各自的 artifacts 目錄（feedback.md、rollback.md）。");
  }
  fs.writeFileSync(
    path.join(o.runDir, "summary.json"),
    JSON.stringify(
      {
        success,
        stopReason,
        batchSize: BATCH_SIZE,
        batches: records,
        notRun,
        targetClasses: o.batches.flat(),
        totalOutputTokens: tokens,
        repair: o.repair,
        toleratedFailures: o.tolerate ?? [],
      },
      stripRaw,
      2,
    ),
  );
  return success ? 0 : 2;
}

function renderRollback(rb: RollbackReport, rejectedDir: string, treeRel: string): string {
  const list = (title: string, files: string[]) =>
    files.length ? [`${title}：`, ...files.map((f) => `  - ${treeRel}/${f}`)] : [];
  return [
    `這批沒有通過所有 gate，它對 ${treeRel} 的變更已撤回，嘗試的版本保留在：`,
    `  ${rejectedDir}`,
    "（依原本的 repo 相對路徑存放，要採用時整個複製回 repo 即可）",
    "",
    ...list("這批新增、已移出的檔案", rb.created),
    ...list("這批修改過、已還原為原本內容的檔案", rb.restored),
    ...list("這批刪掉、已放回的檔案", rb.undeleted),
    ...list("過大沒有備份、維持這批留下狀態的檔案", rb.unrestorable),
  ].join("\n");
}

// Why repair gave up decides what the operator should look at. The one hint used for all of them
// — production code or Lombok in pom.xml — was wrong for most: a writer that could not finish, a
// build that did not, a repair that went round in circles.
function repairHint(stopReason: string): string {
  switch (stopReason) {
    case "build-aborted":
      return "修復後的建置沒有跑完（逾時或被 signal 終止），見上方訊息。";
    case "writer-no-op":
      return "writer 沒有改任何檔案——它可能判斷這些紅燈不是測試碼能修的，或 session 沒有正常完成（見上方 [WARN]）。";
    case "unlocatable-failure":
      return "建置失敗但定位不到任何測試檔或測試類別，請直接看建置 log。";
    case "repair-no-progress":
    case "stuck":
    case "repair-max-iterations":
      return "writer 修了幾輪都沒讓紅燈減少——根因常在 production code 或建置設定（例如 pom.xml 的 Lombok annotation processor），writer 無權修改。";
    case "scope-violation":
      return "writer 動了測試範圍以外的檔案，見上方清單。";
    default:
      return "";
  }
}

// Set once the artifacts dir exists. A crash anywhere after that — baseline, repair, a round —
// must still leave a summary, or the directory looks exactly like a run that is still going.
// Only orchestrate() used to be covered; a crash in the repair loop left no summary at all.
let crashRunDir: string | undefined;

main().catch((e) => {
  if (crashRunDir && !fs.existsSync(path.join(crashRunDir, "summary.json"))) {
    try {
      fs.writeFileSync(
        path.join(crashRunDir, "summary.json"),
        JSON.stringify(
          { success: false, stopReason: "crash", error: String(e?.stack ?? e), batches: batchProgress },
          stripRaw,
          2,
        ),
      );
    } catch {
      /* best effort: the FATAL line below still says what happened */
    }
  }
  die(String(e?.stack ?? e));
});
