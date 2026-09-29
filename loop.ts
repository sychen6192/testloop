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
  TESTGEN_ROOT,
  SCORE_THRESHOLDS,
  STRICT_COV,
  ALLOW_ZERO_TESTS,
  REVIEWER_MUST_READ,
  AGENT_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  MAVEN_EXTRA_ARGS,
  BATCH_SIZE,
  RESUME,
  OTHER_RUN_WAIT_MS,
} from "./config";
import { execSync } from "node:child_process";
import { banner, log, die } from "./libs/log";
import { listJavaClasses, findModuleInfo, findExistingTests, stripRaw, codelessTypeReason, snapshotTree } from "./libs/utils";
import { scanTestConventions } from "./libs/conventions";
import { loadRubric } from "./libs/rubric";
import { assertAgents } from "./libs/guard";
import { getToolVersion } from "./libs/version";
import {
  checkTestsRan,
  detectBuildTool,
  detectEnvFailures,
  ExpectedTest,
  expectedTestOf,
  gradleTestTaskRan,
  runBaseline,
  targetModuleSkipped,
  writableRel,
} from "./gates/build";
import { checkCoverage, locateJacocoXml, reportIsStale } from "./gates/coverage";
import { parseVerdict } from "./gates/review";
import { configuredRunnerProblems, createRunner } from "./runners/runner";
import { IterationRecord, orchestrate, repairBaseline, RepairResult, WriterTrace, writerChangesSoFar } from "./orchestrator";
import {
  batchFailureFingerprint,
  captureOutputs,
  captureTree,
  chunk,
  closeJournal,
  DeadBatch,
  dirIdentity,
  findJournals,
  JOURNAL_STALE_MS,
  journalCapture,
  JournalHandle,
  journalOutputs,
  decideRecovery,
  openJournal,
  OutputCapture,
  RecoveryDecision,
  removeBatchOutputs,
  rollbackTree,
  RollbackReport,
  samePids,
  testOutputDirs,
  thisHost,
  traceJournal,
  TreeCapture,
  waitWhileBusy,
} from "./libs/batch";
import { AgentRunner, BuildTool, ModuleInfo, ReviewVerdict } from "./libs/types";
import { describeTestStack, measureTestStack, mergeTestStack, TestStack } from "./libs/teststack";
import {
  describeSourceEncoding,
  findJdk,
  finishOpenViews,
  isUtf8Name,
  measureSourceEncoding,
  recoverEncodingViews,
  refineSourceEncoding,
  SourceEncoding,
} from "./libs/encoding";
import {
  ChildrenJournal,
  groupAlive,
  groupMembers,
  installShutdownHandlers,
  journalChildren,
  killAll,
  onShutdown,
  orphanAction,
  processStart,
  startMsOf,
} from "./libs/shell";
import { acquireRepoLock, canonicalRoot, LOCK_HEARTBEAT_MS, LOCK_WAIT_MS } from "./libs/lock";
import {
  findPass,
  hashFile,
  ledgerEntry,
  passedEntries,
  PassedEntry,
  readLedgers,
  sha256,
  testClassOf,
  writeLedger,
} from "./libs/resume";
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
  // Types with nothing to unit-test are not targets (see codelessTypeReason): no code, only code
  // Lombok or the compiler generated, or an entry point that only starts Spring. A test of them is
  // effort spent on nothing, and a gate that holds them to coverage blocks a batch it cannot pass.
  const codeless = javaFiles
    .map((cls) => ({ cls, why: codelessTypeReason(fs.readFileSync(path.join(REPO_ROOT, cls), "utf8")) }))
    .filter((c): c is { cls: string; why: string } => c.why !== null);
  const targetClasses = javaFiles.filter((cls) => !codeless.some((c) => c.cls === cls));
  if (targetClasses.length === 0) {
    die(
      `目標底下沒有需要單元測試的程式碼（${codeless.map((c) => `${path.basename(c.cls)}：${c.why}`).join("、")}）。` +
        "請改指定有邏輯的類別（例如 FooServiceImpl.java）或其所在資料夾。",
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
    log(`略過 ${codeless.length} 個沒有需要單元測試的程式碼的型別（不產生測試）：`);
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

  // Before the lock and the baseline: a runner that cannot start a session fails the first writer on
  // the spot, and the baseline of a heavy module takes minutes to get there.
  const runnerProblems = configuredRunnerProblems(!SKIP_REVIEW);
  if (runnerProblems.length) {
    die(
      `runner 設定不完整，agent session 無法啟動（在預檢建置之前先中止）：\n${runnerProblems.map((p) => `  - ${p}`).join("\n")}\n` +
        `完整的環境檢查（含連線與認證）：npx tsx ${path.join(TESTGEN_ROOT, "scripts", "doctor.ts")}`,
    );
  }
  if (RUNNER_KIND === "opencode") assertAgents();

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS_DIR, runId);
  // Locked before the directory exists: a run refused for sharing the repo leaves nothing behind.
  const busy = acquireRepoLock(REPO_ROOT, runDir);
  if (busy) {
    die(
      (busy.pid
        ? `同一個 repo（${REPO_ROOT}）已有另一個 testgen 在執行（pid ${busy.pid}，artifacts：${busy.runDir ?? "未知"}）。\n`
        : `同一個 repo（${REPO_ROOT}）的執行鎖一直在被另一個 testgen 建立或接手，等了 ${LOCK_WAIT_MS / 1000} 秒仍無法確定——當作它在執行。\n`) +
        "同一個 repo 併行會互相觸發 scope-violation（對方 writer 寫的檔案落在本次範圍外），-am 建置也會共用上游模組的 target/。\n" +
        `請等它結束，或改在另一個 clone / git worktree 執行。確定沒有在跑卻看到這個訊息，刪除 ${busy.lock} 即可。`,
    );
  }
  fs.mkdirSync(runDir, { recursive: true });
  crashRunDir = runDir;
  // What a run killed outright left running goes first: a build still writing target/, an agent
  // session still writing src/test, would race everything below (libs/shell.ts).
  const orphansStoppedAt = stopOrphans(runDir);
  // A run killed while its test sources were in their ASCII view (libs/encoding.ts) left them so;
  // with the repo locked, nothing else can be using its journal.
  const recovered = recoverEncodingViews(path.join(mod.moduleRoot, "src", "test", "java"));
  if (recovered.length) {
    log(`[WARN] 上一次執行在轉換編碼途中被終止，已把 ${recovered.length} 個測試檔還原成原本的內容：`);
    recovered.forEach((f) => log(`  - ${path.relative(REPO_ROOT, f)}`));
  }
  // And a batch a killed run never got to set aside: its writer's half-written tests (libs/batch.ts).
  await recoverKilledBatches(runDir, orphansStoppedAt);
  // From here on, this run's children are on disk too, for the next run should this one be killed.
  journalChildren(path.join(runDir, "children.json"), {
    repoRoot: canonicalRoot(REPO_ROOT),
    ...thisHost(),
    pid: process.pid,
    start: processStart(process.pid) ?? "",
  });
  // Ctrl-C, SIGTERM, a hangup on an interactive terminal: the run still leaves a summary that
  // says it was interrupted, rather than a directory that looks like a run still going.
  onShutdown((reason) => {
    const p = path.join(runDir, "summary.json");
    if (!fs.existsSync(p)) {
      fs.writeFileSync(
        p,
        JSON.stringify({ success: false, stopReason: `interrupted:${reason}`, ...resumedField(), ...batchShutdownState() }, stripRaw, 2),
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
        resume: RESUME,
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
  // The test classes the module's build ran before any writer: every green round must still run
  // them (gates/build.ts checkTestsRan). None without a baseline.
  let ranAtBaseline: string[] | undefined;
  // What the module's tests compile and run against, measured — see libs/teststack.ts. Measured
  // again after anything that runs tests, since a surefire classpath beats a reading of the pom.
  let testStack: TestStack | undefined;
  // And the encoding javac reads the sources in (libs/encoding.ts): the pom's, or the platform's,
  // which Maven names in every build log when the pom sets none.
  let sourceEncoding: SourceEncoding | undefined;
  // When the build that left the module green before any writer started — the baseline, or the
  // repair after it. Its reports are what an earlier run's pass is checked against (libs/resume.ts);
  // undefined when there was none: the baseline skipped, or red and let through.
  let greenSince: number | undefined;
  let noGreenBaseline = "這次沒有跑預檢建置（UT_SKIP_BASELINE=1）";
  // What failed before any writer — a class whose own tests are among it passed with tests that failed
  // this time, green again only after a rebuild or a repair the reviewer never saw.
  let baselineFailing: { classes: string[]; files: string[] } = { classes: [], files: [] };
  // The green build's log, when it was the baseline's own: which classes it ran, where reports say nothing.
  let greenLog = "";
  const measureStack = (buildLog = "", since?: number) => {
    testStack = mergeTestStack(testStack, measureTestStack(mod, REPO_ROOT, buildLog, since));
    sourceEncoding = refineSourceEncoding(sourceEncoding, measureSourceEncoding(mod, REPO_ROOT, buildLog));
    fs.writeFileSync(
      path.join(runDir, "project-facts.json"),
      JSON.stringify({ testStack: testStack ?? null, sourceEncoding: sourceEncoding ?? null }, null, 2),
    );
  };
  const logFacts = () => {
    log(`測試相依：${describeTestStack(testStack)}`);
    if (sourceEncoding && !isUtf8Name(sourceEncoding.name)) {
      const jdk = sourceEncoding.source === "sniffed" ? undefined : findJdk();
      log(
        `[WARN] 原始碼編碼：${describeSourceEncoding(sourceEncoding)}` +
          (jdk
            ? `——測試檔以 \\uXXXX 的 ASCII 形式交給 writer 與 reviewer，寫回時以 ${sourceEncoding.name} 存（轉碼用 ${jdk.java}）`
            : "——無法轉換編碼（" +
              (sourceEncoding.source === "sniffed" ? "不知道是哪一種" : "沒有可用的 JDK") +
              "）：writer 留下的非 ASCII 字元會轉成 \\uXXXX，含非 ASCII 字元的既有測試檔不讓 writer 修改"),
      );
    } else if (sourceEncoding) {
      log(`原始碼編碼：${describeSourceEncoding(sourceEncoding)}`);
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
    const baselineStartedAt = Date.now();
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
    if (baseline.testsSkipped) {
      fs.writeFileSync(
        path.join(runDir, "summary.json"),
        JSON.stringify({ success: false, stopReason: "tests-skipped", error: baseline.testsSkipped }, null, 2),
      );
      die(
        `預檢時目標模組一個測試都沒有執行——每一輪的建置也都會一樣，writer 寫的測試永遠驗證不了，所以在產生測試之前中止。\n` +
          `${baseline.testsSkipped}\n詳見 ${path.join(runDir, "baseline.log")}`,
      );
    }
    measureStack(baseline.raw, baselineStartedAt);
    logFacts();
    ranAtBaseline = baseline.ranTests;

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
        // The repair's green build ran what the red one could not: compile errors hide every test.
        ranAtBaseline = [...new Set([...(ranAtBaseline ?? []), ...(repair.ranTests ?? [])])].sort();
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
    if (clean) {
      greenSince = baselineStartedAt;
      greenLog = repair?.success ? "" : baseline.raw;
    } else noGreenBaseline = "這次的預檢建置是紅的（UT_ALLOW_DIRTY_BASELINE=1 放行）";
    baselineFailing = {
      // The suites that failed, and the classes of the failing cases: a TestNG or JUnit 4 Suite
      // report is named after the suite, not the class that failed in it.
      classes: [...baseline.failingTestClasses, ...(baseline.failingCaseClasses ?? [])].map((c) => c.replace(/\$.*$/, "")),
      files: baseline.compileErrorFiles.map((f) => path.relative(REPO_ROOT, path.resolve(REPO_ROOT, f)).replace(/\\/g, "/")),
    };
    // Gradle keeps its last execution's results: a test task that did not execute this time (up to
    // date, skipped) leaves reports that are no evidence about this tree.
    if (clean && buildTool === "gradle" && !repair?.success && gradleTestTaskRan(baseline.raw) !== true) {
      greenSince = undefined;
      noGreenBaseline = "這次預檢時 Gradle 的 test task 沒有實際執行（UP-TO-DATE、SKIPPED，或 log 看不出來），build/test-results 是之前留下的";
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
      // Maven stops the reactor at the failing upstream module: the target module was never built,
      // and no round's build will get to it either. Tolerating that red is tolerating an untested run.
      if (targetModuleSkipped(baseline.raw)) {
        die(
          `預檢時上游模組的紅燈讓 Maven 停在上游，目標模組 ${mod.moduleRel} 根本沒有被建置（reactor summary 裡是 SKIPPED）。\n` +
            "UT_ALLOW_DIRTY_BASELINE 放行的是「既有的失敗」，但這裡每一輪的建置也都會停在同一個地方——writer 的測試從來不會被編譯或執行。\n" +
            `請先修好上游模組，詳見 ${path.join(runDir, "baseline.log")}`,
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

  // Classes an earlier run already passed, unchanged since and still passing (libs/resume.ts): not
  // written again. Their passes go into this run's ledger too, so the next run finds them here.
  const rubricHash = sha256(effectiveRubric);
  const passes: PassedEntry[] = [];
  const saveLedger = () => {
    try {
      writeLedger(runDir, passes);
    } catch (e) {
      log(`[WARN] 無法寫入通過紀錄（${path.join(runDir, "passed.json")}）：${String(e)}——下一次執行不會接續這些類別`);
    }
  };
  const recordPass = (classes: string[], written: Iterable<string>, verdict: ReviewVerdict | undefined, dir: string) => {
    const testTree = path.join(mod.moduleRoot, "src", "test");
    passes.push(
      ...passedEntries({
        classes,
        repoRoot: REPO_ROOT,
        testsOf: (cls) => findExistingTests(cls, REPO_ROOT),
        written: [...written].map((w) => path.relative(REPO_ROOT, path.join(testTree, w))),
        testTree: path.relative(REPO_ROOT, testTree),
        rubric: rubricHash,
        verdict: verdict ? { scores: verdict.scores, blockers: verdict.blockers } : null,
        dir,
        at: new Date().toISOString(),
      }),
    );
    saveLedger();
  };
  const resume = RESUME
    ? resumePassed({
        targetClasses,
        mod,
        buildTool,
        rubricHash,
        runDir,
        greenSince,
        greenLog,
        noGreenBaseline,
        baselineFailing,
        repairChanged: repair?.changedFiles ?? [],
      })
    : { resumed: [], redo: [] };
  if (resume.resumed.length) {
    resumedClasses = resume.resumed.map(({ cls, entry }) => ({ cls, from: entry.dir, at: entry.at }));
    passes.push(...resume.resumed.map((r) => ledgerEntry(r.entry)));
    saveLedger();
  }
  const pending = targetClasses.filter((cls) => !resume.resumed.some((r) => r.cls === cls));
  if (!pending.length) {
    banner("SUMMARY");
    log("[OK] 目標類別都已在先前的執行通過所有 gate，而且類別與測試都沒變——這次沒有要產生的測試。要重新產生請設 UT_RESUME=0");
    fs.writeFileSync(
      path.join(runDir, "summary.json"),
      JSON.stringify(
        { success: true, stopReason: "already-passed", targetClasses: [], resumed: resumedClasses, repair, toleratedFailures: tolerate ?? [] },
        stripRaw,
        2,
      ),
    );
    log(`artifacts 已寫入：${runDir}`);
    process.exit(0);
  }

  // A folder target runs as batches, each its own maker-checker loop; one batch is today's run. Decided
  // by the target, not by what resuming left of it: the last class of a folder is still a batch — set
  // aside when it fails, journaled while it runs — or a rerun would leave its failed attempt in src/test.
  const batches = chunk(pending, BATCH_SIZE);
  if (chunk(targetClasses, BATCH_SIZE).length > 1) {
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
      ranAtBaseline,
      recordPass,
    });
    log(`artifacts 已寫入：${runDir}`);
    process.exit(code);
  }

  let result;
  const trace: WriterTrace = { written: new Set<string>() };
  try {
    result = await orchestrate({
      targetClasses: pending,
      buildTool,
      runner,
      standards,
      rubric: effectiveRubric,
      skipReview: SKIP_REVIEW,
      mod,
      runDir,
      existingTests: existingTests.filter((e) => pending.includes(e.cls)),
      preExisting,
      tolerate,
      conventions,
      testStack,
      sourceEncoding,
      ranAtBaseline,
      trace,
    });
  } catch (e) {
    // A crashed run must still leave a summary — otherwise the artifacts directory
    // is indistinguishable from a run that is still going.
    fs.writeFileSync(
      path.join(runDir, "summary.json"),
      JSON.stringify({ success: false, stopReason: "crash", error: String(e), ...resumedField() }, null, 2),
    );
    throw e;
  }

  banner("SUMMARY");
  log(
    `結果：${result.success ? "[OK] 全部關卡通過" : "[FAIL] 未通過"}` +
      `（迭代 ${result.iterations} 輪，stop=${result.stopReason}）`,
  );
  for (const r of resumedClasses) log(`  [接續] ${path.basename(r.cls, ".java")}（先前的執行已通過，見 ${r.from}）`);
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
  if (result.flakyTests?.length) {
    log(`[WARN] 需要人工處理：這些測試不穩定（建置失敗、重跑通過）：${result.flakyTests.join("、")}`);
  }
  if (result.success) recordPass(pending, trace.written, result.finalVerdict, runDir);
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify({ ...result, repair, toleratedFailures: tolerate ?? [], ...resumedField() }, stripRaw, 2),
  );
  log(`artifacts 已寫入：${runDir}`);
  process.exit(result.success ? 0 : 2);
}

// ─── Resume ──────────────────────────────────────────────────────────────────
//
// See libs/resume.ts: which of the targets an earlier run already passed, and whether that pass
// still holds. The ledger says what the class and its tests were; the gates here say whether they
// still pass — the baseline's build and reports, today's coverage and review thresholds.

interface ResumedClass {
  cls: string;
  /** The artifacts of the batch (or run) that passed it. */
  from: string;
  at: string;
}

// For the summaries: every one of them, interrupted and crashed ones included, says what was carried over.
let resumedClasses: ResumedClass[] = [];
const resumedField = () => (resumedClasses.length ? { resumed: resumedClasses } : {});

function resumePassed(o: {
  targetClasses: string[];
  mod: ModuleInfo;
  buildTool: BuildTool;
  rubricHash: string;
  runDir: string;
  greenSince?: number;
  greenLog: string;
  noGreenBaseline: string;
  baselineFailing: { classes: string[]; files: string[] };
  /** What the repair changed, as the writer's changes are named (java/… relative to src/test/java, resources/…). */
  repairChanged: string[];
}): { resumed: Array<{ cls: string; entry: PassedEntry }>; redo: Array<{ cls: string; why: string }> } {
  const ledger = readLedgers(RUNS_DIR, o.runDir);
  const slash = (p: string) => p.replace(/\\/g, "/");
  const known = o.targetClasses.filter((cls) => ledger.some((e) => e.cls === slash(cls)));
  if (!known.length) return { resumed: [], redo: [] };
  if (o.greenSince === undefined) {
    log(
      `[接續] ${known.length} 個目標類別在先前的執行通過過，但${o.noGreenBaseline}——` +
        "無法確認它們的測試現在仍然通過，全部重新產生",
    );
    return { resumed: [], redo: [] };
  }
  const hashes = new Map<string, string | null>();
  const hashOf = (rel: string) => {
    if (!hashes.has(rel)) hashes.set(rel, hashFile(path.join(REPO_ROOT, rel)));
    return hashes.get(rel) ?? null;
  };
  const testRootRel = path.relative(REPO_ROOT, path.join(o.mod.moduleRoot, "src", "test", "java"));
  const failing = new Set(o.baselineFailing.classes);
  const failingFiles = new Set(o.baselineFailing.files);
  // A test resource a repair changed is reached through profiles, classpath scanning and string
  // paths — any test may read it: no pass holds on the verdict of a reviewer who never saw it.
  const repairedResources = o.repairChanged.filter((c) => !c.endsWith(".java"));
  const redo: Array<{ cls: string; why: string }> = [];
  const candidates: Array<{ cls: string; entry: PassedEntry }> = [];
  for (const cls of known) {
    const { entry, mismatch } = findPass(cls, ledger, hashOf, findExistingTests(cls, REPO_ROOT));
    if (!entry) {
      redo.push({ cls, why: mismatch ?? "沒有相符的通過紀錄" });
      continue;
    }
    // The verdict the reviewer gave, judged again by today's gate: a threshold raised since fails it.
    if (!SKIP_REVIEW) {
      if (!entry.verdict) {
        redo.push({ cls, why: "上次通過時 review gate 是關閉的（UT_SKIP_REVIEW=1），它的測試沒有審查過" });
        continue;
      }
      if (entry.rubric !== o.rubricHash) {
        redo.push({ cls, why: "review 的 rubric 在上次通過之後改過" });
        continue;
      }
      const v = parseVerdict(JSON.stringify({ scores: entry.verdict.scores, blockers: entry.verdict.blockers, advisories: [] }));
      if (!v.passed) {
        const why = [...v.belowThreshold, ...v.blockers].join("、");
        redo.push({ cls, why: `上次的 review 判決以現在的門檻不通過（${why}）` });
        continue;
      }
    }
    // Its tests are the test classes among the files it passed with — a test the writer named its own
    // way is one of them, and so is another test its batch's writer changed; what they only reach
    // (entry.refs: a base class, a helper) is fingerprinted above, not a test it passed by. Failed
    // before any writer this time, it passed with tests that do not pass as they are: green again only
    // after a rebuild or a repair. And every one of them ran in this run's green build, and not with
    // every test skipped (the build gate's own check, checkTestsRan).
    const refs = new Set(entry.refs ?? []);
    const tests = Object.keys(entry.files)
      .filter((f) => testClassOf(f, testRootRel) && !refs.has(f))
      .map((f) => {
        const abs = path.join(REPO_ROOT, f);
        let declared: ExpectedTest | undefined;
        try {
          declared = expectedTestOf(fs.readFileSync(abs, "latin1"), abs, "created");
        } catch {
          declared = undefined;
        }
        return { file: f, byPath: testClassOf(f, testRootRel)!, declared };
      });
    // By its path and by the package it declares: they differ when a test sits in another folder.
    const failed = tests.filter((t) => failing.has(t.byPath) || (t.declared && failing.has(t.declared.fqcn)) || failingFiles.has(t.file));
    if (failed.length) {
      redo.push({ cls, why: `它的測試（${failed.map((t) => path.posix.basename(t.file, ".java")).join("、")}）在這次的預檢建置中失敗過` });
      continue;
    }
    if (repairedResources.length) {
      redo.push({ cls, why: `修復迴圈改過測試資源（${repairedResources.join("、")}），任何測試都可能讀到它` });
      continue;
    }
    const expected = tests.map((t) => t.declared).filter((t): t is ExpectedTest => !!t && !t.disabled);
    if (!expected.length) {
      redo.push({ cls, why: "上次通過時的檔案裡找不到會被執行的測試類別" });
      continue;
    }
    const ranCheck = checkTestsRan(o.buildTool, o.mod, o.greenSince, o.greenLog, expected, [], true);
    if (!ranCheck) {
      redo.push({ cls, why: "這次的預檢建置認不出執行了哪些測試類別（報告關了或寫到別處），無法確認它的測試有執行" });
      continue;
    }
    const unrun = [...ranCheck.notRun.map((t) => t.fqcn), ...ranCheck.allSkipped.map((a) => `${a.test.fqcn}（全部被略過）`)];
    if (unrun.length) {
      redo.push({ cls, why: `它的測試（${unrun.join("、")}）沒有在這次的預檢建置中執行` });
      continue;
    }
    candidates.push({ cls, entry });
  }
  // Coverage, measured again from the green build's report: once for all of them, and class by
  // class only when some fall short. greenSince is the baseline's start even when a repair made it
  // green: a red build stops before the report goal, so the newest report is the green build's.
  const xml = locateJacocoXml(o.mod);
  const measured = !!xml && !reportIsStale(xml, o.greenSince);
  let resumed = candidates;
  if (candidates.length && !checkCoverage(candidates.map((c) => c.cls), o.mod, o.greenSince).passed) {
    resumed = [];
    for (const c of candidates) {
      const cov = checkCoverage([c.cls], o.mod, o.greenSince);
      if (cov.passed) resumed.push(c);
      else {
        const detail = cov.report.split("\n").filter((l) => l.startsWith("- ")).join("；") || cov.report;
        redo.push({ cls: c.cls, why: `覆蓋率重新量測沒有通過：${detail}` });
      }
    }
  }
  if (resumed.length) {
    log(
      `[接續] ${resumed.length} 個類別在先前的執行已通過所有 gate，這次不再產生——類別與它的測試檔都和當時一樣，` +
        `這次的預檢建置照樣跑過它們的測試，` +
        (measured ? "覆蓋率從它的 JaCoCo 報告重新量過" : "（沒有這次建置的 JaCoCo 報告，覆蓋率 gate 本來就不檢查）") +
        `${SKIP_REVIEW ? "" : "，review 分數以現在的門檻重新判定"}：`,
    );
    resumed.forEach((r) => log(`  - ${r.cls}（${r.entry.at} 通過，見 ${r.entry.dir}）`));
  }
  if (redo.length) {
    log("[接續] 先前通過過、但這次要重新產生的類別：");
    redo.forEach((r) => log(`  - ${r.cls}：${r.why}`));
  }
  if (resumed.length) log("（要全部重新產生請設 UT_RESUME=0）");
  return { resumed, redo };
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
  /** Each round's gate and outcome: where the batch's rounds went. */
  funnel: IterationRecord[];
  totalOutputTokens?: number;
  coverageReport?: string;
  finalFeedback?: string;
  finalVerdict?: ReviewVerdict;
  rolledBack?: SetAside;
  /** Tests the writer never touched that failed a build and passed its rebuild. */
  flakyTests?: string[];
}

type SetAside = RollbackReport & { rejectedDir: string; outputsRemoved: number };

// The batch run as the interrupt and crash handlers see it: which batches finished, and the one in
// flight — whose tests never passed the gates, so it is set aside like a failed batch.
interface BatchRun {
  batches: string[][];
  records: BatchRecord[];
  treeRel: string;
  inFlight?: { index: number; dir: string; start: TreeCapture; outputs: OutputCapture; trace: WriterTrace; journal?: JournalHandle };
}
let batchRun: BatchRun | undefined;

// Stop reasons that belong to the environment rather than the batch: the next batch would meet them
// too. A scope violation also leaves files outside src/test changed on disk for a human to look at,
// and every later batch would be built against them; another module's test that keeps failing is in
// every later batch's build.
const RUN_STOPS = new Set(["runner-spawn-error", "scope-violation", "out-of-scope-failure"]);
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
  ranAtBaseline?: string[];
  /** A batch passed: what it passed with goes into this run's ledger (libs/resume.ts). */
  recordPass: (classes: string[], written: Iterable<string>, verdict: ReviewVerdict | undefined, dir: string) => void;
}

const lastGate = (funnel: IterationRecord[]) => funnel[funnel.length - 1]?.gate;

async function runBatches(o: BatchRunInput): Promise<number> {
  const total = o.batches.reduce((n, b) => n + b.length, 0);
  const width = String(o.batches.length).length;
  const testTree = path.join(o.mod.moduleRoot, "src", "test");
  const treeRel = path.relative(REPO_ROOT, testTree).replace(/\\/g, "/");
  const run: BatchRun = { batches: o.batches, records: [], treeRel };
  batchRun = run;
  const records = run.records;
  let stopped: { reason: string; message: string } | undefined;
  let stack = o.testStack;
  // What every batch's green build must still run: the baseline's classes, then each passed batch's.
  let ranBefore = o.ranAtBaseline;
  let prevFailure = "";
  let prevEnv = "";
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
    stack = mergeTestStack(stack, measureTestStack(o.mod, REPO_ROOT));
    const start = captureTree(testTree);
    const outputs = captureOutputs(testOutputDirs(o.mod.moduleRoot, o.buildTool));
    const trace: WriterTrace = { written: new Set<string>() };
    const journal = openBatchJournal({ runDir: o.runDir, batch: i + 1, dir, targetClasses: batch, testTree, treeRel }, start, outputs, trace);
    run.inFlight = { index: i, dir, start, outputs, trace, journal };
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
      ranAtBaseline: ranBefore,
      trace,
    });
    // A batch that passed is done with its journal before its pass is recorded: killed in between,
    // the next run finds neither, and the class is written again on top of its tests. The other
    // order had the next run set aside tests that passed every gate.
    if (r.success) {
      closeBatchJournal(journal);
      // Passed: nothing of it is for the interrupt or crash path to set aside from here on — not even
      // when recording the pass throws (a file it hashes removed by an IDE or git meanwhile).
      run.inFlight = undefined;
    }
    if (r.success && r.ranTests) ranBefore = [...new Set([...(ranBefore ?? []), ...r.ranTests])].sort();
    if (r.success) o.recordPass(batch, trace.written, r.finalVerdict, dir);
    const rec: BatchRecord = {
      batch: i + 1,
      targetClasses: batch,
      dir,
      success: r.success,
      stopReason: r.stopReason,
      iterations: r.iterations,
      funnel: r.funnel,
      totalOutputTokens: r.totalOutputTokens,
      coverageReport: r.coverageReport,
      finalFeedback: r.finalFeedback,
      finalVerdict: r.finalVerdict,
      ...(r.flakyTests?.length ? { flakyTests: r.flakyTests } : {}),
    };
    // A scope violation is left exactly as it is: the changes outside src/test are the reason the
    // run stops, and the test files beside them are part of what a human has to look at.
    if (!r.success) {
      if (r.stopReason !== "scope-violation") rec.rolledBack = setAside(dir, start, outputs, treeRel, trace.written);
      // Set aside — or, a scope violation, left for a human to look at: nothing for a later run to finish.
      closeBatchJournal(journal);
    }
    run.inFlight = undefined;
    records.push(rec);
    fs.writeFileSync(path.join(o.runDir, "batches.json"), JSON.stringify(records, stripRaw, 2));
    log(
      r.success
        ? `[OK] 第 ${i + 1}/${o.batches.length} 批通過（${r.iterations} 輪）`
        : `[FAIL] 第 ${i + 1}/${o.batches.length} 批未通過（${r.stopReason}，${r.iterations} 輪）`,
    );

    if (rec.rolledBack?.failed.length) {
      stopped = {
        reason: "rollback-failed",
        message:
          "這批有檔案無法還原（常見原因是防毒軟體或 IDE 鎖住了檔案）——src/test 已不是這批開始前的狀態，後面的批次會建在它上面",
      };
      break;
    }
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
    // A build that fails the same way for two different classes — once each batch's own names and
    // numbers are taken out — fails on something neither wrote: the module, a dependency, the
    // environment. Every later batch would spend its rounds and builds on it too.
    // Only a failure that names nothing of the batch's own: two writers' tests failing the same way
    // (a fork their own System.exit took down, the same assertion) are two batches' own failures.
    const fingerprint = !r.success && lastGate(r.funnel) === "build" ? batchFailureFingerprint(r.lastReport, batch) : "";
    const failure = fingerprint.includes("<target>") ? "" : fingerprint;
    if (failure && failure === prevFailure) {
      stopped = {
        reason: "repeated-build-failure",
        message:
          "連續兩批的建置以同樣的原因失敗（去掉各自的類別名稱與數字後一字不差）——問題在這兩批之外（模組、相依或環境），後面的批次也會一樣",
      };
      break;
    }
    prevFailure = failure;
    // An environment failure shows through the batch's own tests — a Spring context that will not
    // start fails whatever test starts it — so it is compared by what it is, not by its text.
    const env = !r.success && lastGate(r.funnel) === "build" ? detectEnvFailures(r.lastReport ?? "").join("、") : "";
    if (env && env === prevEnv) {
      stopped = {
        reason: "repeated-env-failure",
        message: `連續兩批的建置都因為同樣的環境/設定問題失敗（${env}）——改測試碼修不好，後面的批次也會一樣`,
      };
      break;
    }
    prevEnv = env;
  }

  const passed = records.filter((r) => r.success).length;
  const notRun = o.batches.slice(records.length).flat();
  const success = passed === o.batches.length;
  // "stopped:" means classes were left untried; a stop on the last batch left nothing behind it.
  const stopReason = success ? "gates-passed" : stopped && notRun.length ? `stopped:${stopped.reason}` : "some-batches-failed";
  const attention = attentionOf(records);
  const tokens = records.reduce<number | undefined>(
    (n, r) => (r.totalOutputTokens === undefined ? n : (n ?? 0) + r.totalOutputTokens),
    undefined,
  );

  banner("SUMMARY");
  log(`結果：${passed}/${o.batches.length} 批通過（stop=${stopReason}）`);
  for (const r of resumedClasses) log(`  [接續] ${path.basename(r.cls, ".java")}（先前的執行已通過，見 ${r.from}）`);
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
  attention.forEach((a) => log(`[WARN] 需要人工處理：${a}`));
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
        ...(stopped ? { stopMessage: stopped.message } : {}),
        ...(attention.length ? { attention } : {}),
        batchSize: BATCH_SIZE,
        batches: records,
        notRun,
        targetClasses: o.batches.flat(),
        ...resumedField(),
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

// Changes the run left in place, which a human has to look at before anything else.
function attentionOf(records: Array<Pick<BatchRecord, "batch" | "stopReason" | "dir" | "rolledBack" | "flakyTests">>): string[] {
  return records.flatMap((r) => [
    ...(r.flakyTests?.length ? [`第 ${r.batch} 批遇到不穩定的測試（建置失敗、重跑通過）：${r.flakyTests.join("、")}`] : []),
    ...(r.stopReason === "scope-violation" ? [`第 ${r.batch} 批的 writer 改了測試範圍以外的檔案，變更未還原（清單在 ${r.dir}）`] : []),
    ...(r.rolledBack?.failed.length ? [`第 ${r.batch} 批有檔案無法還原：${r.rolledBack.failed.join("、")}`] : []),
    ...(r.rolledBack?.unrestorable.length
      ? [`第 ${r.batch} 批改過的檔案過大、沒有備份，維持它留下的狀態：${r.rolledBack.unrestorable.join("、")}`]
      : []),
    ...(r.rolledBack?.foreign.length
      ? [`第 ${r.batch} 批執行期間有不是 writer 做的變更，沒有撤回：${r.rolledBack.foreign.join("、")}`]
      : []),
  ]);
}

/**
 * A failed batch's changes to the test tree, undone: what its writer changed put back as captured,
 * the attempt kept under <batch>/rejected, and the build outputs it left behind removed
 * (libs/batch.ts). undefined when the batch changed nothing.
 */
function setAside(
  dir: string,
  start: TreeCapture,
  outputs: OutputCapture,
  treeRel: string,
  written: Set<string>,
  // Set aside by a later run, for a run that was killed: what it leaves was changed after the kill.
  killed = false,
  // Paths the caller accounts for its own way (a killed batch's undecided deletions and later moves).
  leave?: Set<string>,
): SetAside | undefined {
  const rejectedDir = path.join(dir, "rejected");
  const rb = rollbackTree(start, rejectedDir, treeRel, written, leave);
  const putBack = [...rb.created, ...rb.restored, ...rb.undeleted];
  const removed = putBack.length ? removeBatchOutputs(outputs, putBack) : [];
  if (!putBack.length && !rb.unrestorable.length && !rb.failed.length && !rb.foreign.length) return undefined;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rollback.md"), renderRollback(rb, rejectedDir, treeRel, removed.length, killed));
  log(
    `這批的測試變更已移出 ${treeRel}（新增 ${rb.created.length}、還原 ${rb.restored.length + rb.undeleted.length} 個檔` +
      (removed.length ? `，清掉它留在建置輸出的 ${removed.length} 個檔` : "") +
      `），嘗試的版本保留在 ${rejectedDir}`,
  );
  if (rb.unrestorable.length) log(`[WARN] 以下檔案過大、沒有備份，維持這批留下的狀態：${rb.unrestorable.join("、")}`);
  if (rb.notKept.length) log(`[WARN] 以下檔案的嘗試版本沒能保留（已照樣還原）：${rb.notKept.join("、")}`);
  if (rb.failed.length) log(`[FAIL] 以下檔案無法還原：${rb.failed.join("、")}`);
  if (rb.foreign.length) log(`[WARN] 以下檔案${foreignWhy(killed)}，沒有撤回：${rb.foreign.join("、")}`);
  return { ...rb, rejectedDir, outputsRemoved: removed.length };
}

// ─── Runs killed outright ────────────────────────────────────────────────────
//
// A batch's journal (libs/batch.ts): written as it starts, gone once it ends in any way the process
// lives through. One still there belongs to a run that was killed in the middle of that batch, and
// the next run on the repo — under the repo lock, and once the encoding views are back — sets the
// batch aside from it, as the killed run would have.

/** The journal of a batch starting; undefined, with a warning, when it cannot be written. */
function openBatchJournal(
  j: { runDir: string; batch: number; dir: string; targetClasses: string[]; testTree: string; treeRel: string },
  start: TreeCapture,
  outputs: OutputCapture,
  trace: WriterTrace,
): JournalHandle | undefined {
  let journal: JournalHandle;
  try {
    journal = openJournal(
      {
        ...j,
        repoRoot: canonicalRoot(REPO_ROOT),
        rootId: dirIdentity(REPO_ROOT),
        treeId: dirIdentity(j.testTree),
        pid: process.pid,
        start: processStart(process.pid) ?? "",
        ...thisHost(),
      },
      start,
      outputs,
      LOCK_HEARTBEAT_MS,
    );
  } catch (e) {
    log(`[WARN] 無法寫入這批的復原日誌（${String(e)}）——程序若被強制終止，下一次執行無法替這批撤回`);
    return undefined;
  }
  trace.onChange = () => {
    try {
      traceJournal(journal, { written: [...trace.written], ...(trace.inSession ? { session: trace.inSession.before } : {}) });
    } catch {
      /* the journal keeps what it last had: the next run undoes at least that */
    }
  };
  return journal;
}

function closeBatchJournal(journal: JournalHandle | string | undefined): void {
  if (!journal) return;
  try {
    closeJournal(journal);
  } catch {
    /* a later run finds it with its run's summary.json, and throws it away */
  }
}

const pidExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const mtimeOf = (p: string): number | undefined => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * The children an earlier run of this repo, killed outright, left running (libs/shell.ts). A child
 * that is still the same process — its start time the recorded one — is taken down with its process
 * group; of a group whose leader is gone, only the members that started while that run was alive
 * (orphanAction). Only records written on this host, since this boot, for this repo; a pid given to
 * another process since is left alone. On Windows, node's own children die with it (libuv's job
 * object) and what outlives it — java.exe under the cmd.exe that ran mvn — was never recorded: the
 * commands are named for a human to look for. Each record is acted on once, then removed: later, its
 * pids may be anyone's. Returns, per run, when its children were stopped: they were alive until then.
 */
function stopOrphans(runDir: string): Map<string, number> {
  const stoppedAt = new Map<string, number>();
  const here = thisHost();
  const root = canonicalRoot(REPO_ROOT);
  let runs: string[] = [];
  try {
    runs = fs.readdirSync(RUNS_DIR);
  } catch {
    return stoppedAt;
  }
  const stopped: string[] = [];
  const unsure: string[] = [];
  const named: string[] = [];
  for (const id of runs) {
    const dir = path.join(RUNS_DIR, id);
    if (path.resolve(dir) === path.resolve(runDir)) continue;
    const file = path.join(dir, "children.json");
    let doc: ChildrenJournal;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const children = Array.isArray(doc?.children)
      ? doc.children.filter((c) => !!c && Number.isInteger(c.pid) && c.pid > 0 && typeof c.start === "string")
      : [];
    // Another checkout's, another machine's or container's, or from before a reboot: nothing of it
    // runs here to stop — its pids name nobody here, or someone else.
    if (!doc || doc.repoRoot !== root || !samePids(doc, here)) continue;
    // The run itself still going — only possible when the repo lock was bypassed: its children are its own.
    if (doc.pid !== process.pid && doc.start && processStart(doc.pid) === doc.start) continue;
    const lastAlive = mtimeOf(file) ?? 0;
    for (const c of children) {
      const what = `pid ${c.pid}（${String(c.cmd ?? "").slice(0, 200)}）`;
      if (process.platform === "win32") {
        named.push(String(c.cmd ?? "").slice(0, 200));
        continue;
      }
      const start = processStart(c.pid);
      const a = orphanAction(
        c,
        { start, groupAlive: start === undefined && groupAlive(c.pid), members: start === undefined ? groupMembers(c.pid) : undefined },
        { from: c.start && process.platform === "linux" ? startMsOf(c.start) : undefined, to: lastAlive + LOCK_HEARTBEAT_MS },
      );
      // Alive until now, and maybe writing src/test: an agent session. A build writes target/ only —
      // stopping one says nothing about the test tree, and taking it as a sign of life would make the
      // developer's own fixes since the crash the killed writer's, and undo them.
      const alive = () => {
        if (c.kind !== "build") stoppedAt.set(path.resolve(dir), Date.now());
      };
      if (a.kind === "stop-group") {
        try {
          process.kill(-c.pid, "SIGKILL");
          stopped.push(what);
          alive();
        } catch {
          /* gone meanwhile */
        }
      } else if (a.kind === "stop-members") {
        for (const pid of a.pids) {
          try {
            process.kill(pid, "SIGKILL");
            stopped.push(`pid ${pid}（${what} 的程序群組裡）`);
            alive();
          } catch {
            /* gone meanwhile */
          }
        }
        for (const pid of a.left) unsure.push(`pid ${pid}（程序群組 ${c.pid}，在那次執行結束之後才啟動，可能是別人的）`);
      } else if (a.kind === "report") {
        unsure.push(`程序群組 ${c.pid}（${what} 已經不在，群組裡還有程序；這個平台看不出它們是不是它的）`);
      }
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* read-only artifacts: the start times keep a later run from mistaking a reused pid */
    }
  }
  if (stopped.length) {
    log(`[WARN] 上一次執行被強制終止時留下 ${stopped.length} 個還在跑的子程序（建置或 agent session），已結束它們：`);
    stopped.forEach((p) => log(`  - ${p}`));
  }
  if (unsure.length) {
    log("[WARN] 以下程序可能是上一次被強制終止的執行留下的，但無法確定，沒有結束——請確認後自行處理：");
    unsure.forEach((p) => log(`  - ${p}`));
  }
  if (named.length) {
    log(
      `[WARN] 上一次執行被強制終止時有 ${named.length} 個子程序在跑。Windows 上 node 結束時只會帶走它直接啟動的程序，` +
        "它們再啟動的（例如 mvn 底下的 java.exe、opencode）可能還在跑、還在寫 target/ 或 src/test——請在工作管理員確認後結束：",
    );
    named.forEach((p) => log(`  - ${p}`));
  }
  return stoppedAt;
}

function recordedBatches(runDir: string): Array<{ batch: number; success: boolean }> {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(runDir, "batches.json"), "utf8"));
    return Array.isArray(b) ? b.filter((r) => !!r && typeof r === "object") : [];
  } catch {
    return [];
  }
}

/**
 * Sets aside the batch each killed run of this repo was in the middle of (libs/batch.ts journals),
 * as that run would have. `stoppedAt`: runs whose agent sessions were only just stopped
 * (stopOrphans) — alive, and possibly writing, until then. A batch that cannot be put back stops this
 * run: the test tree still holds what a killed writer left, and every batch would be built on it.
 * So does a batch of this checkout whose run may still be going, once waiting has not seen it stop.
 */
async function recoverKilledBatches(runDir: string, stoppedAt: Map<string, number>): Promise<void> {
  const checkout = { repoRoot: canonicalRoot(REPO_ROOT), rootId: dirIdentity(REPO_ROOT) };
  const find = () => findJournals(RUNS_DIR, checkout, { alive: pidExists, start: (pid) => processStart(pid) });
  let found = find();
  // Starting on top of a batch that may still be going would build on its half-written tests — or
  // race its writer. A container restarted within the heartbeat's window is the usual case: its
  // pids name nobody here, so only the heartbeat going quiet says it died. Waiting that out is all it takes.
  if (found.busy.length) {
    log(
      `[WARN] 這個 checkout 有 ${found.busy.length} 份復原日誌屬於可能還在執行的 testgen（同一台機器上的另一個容器、` +
        `剛被重啟的容器，或繞過了 repo 鎖的執行）——在它之上開始會和它搶同一個 src/test。等它停止` +
        `（心跳超過 ${JOURNAL_STALE_MS / 60_000} 分鐘沒有更新就算停止）再替它收尾：`,
    );
    found.busy.forEach((d) => log(`  - ${d}`));
    const still = await waitWhileBusy(() => (found = find()).busy, OTHER_RUN_WAIT_MS, 3_000);
    if (still.length) stopBusy(runDir, still);
    log("  它已經停止，接著替它收尾");
  }
  for (const j of found.stale) {
    if (j.why !== "那次執行有收尾") log(`[WARN] 丟掉一份用不到的復原日誌（${j.why}）：${j.dir}`);
    closeBatchJournal(j.dir);
  }
  if (found.elsewhere) {
    log(`（有 ${found.elsewhere} 份復原日誌是別台機器或別的容器留下的——共用這個 runs 目錄，但描述的是它自己的 checkout，不處理）`);
  }
  for (const d of found.dead) {
    const j = d.journal;
    const records = recordedBatches(j.runDir);
    let rolledBack: SetAside | undefined;
    // In its run's record: it passed, or was set aside, before the run was killed — only the journal was left.
    const recorded = records.some((b) => b.batch === j.batch);
    if (!recorded) {
      const names = j.targetClasses.map((c) => path.basename(c, ".java")).join("、");
      const lastSeen = Math.max(d.lastSeen, stoppedAt.get(path.resolve(j.runDir)) ?? 0);
      log(
        `[WARN] 上一次執行（${j.runDir}）在第 ${j.batch} 批（${names}）被強制終止，沒來得及撤回這批沒通過 gate 的變更` +
          `（${new Date(lastSeen).toISOString()} 之後就沒有動靜）——這次替它撤回：`,
      );
      let decision: RecoveryDecision | undefined;
      try {
        const capture = journalCapture(d);
        decision = decideKilledBatch(d, capture, lastSeen);
        const accounted = new Set([...decision.undecided, ...decision.moves.flatMap((m) => [m.from, m.to])]);
        rolledBack = setAside(j.dir, capture, journalOutputs(d), j.treeRel, new Set(decision.only), true, accounted);
        keepDeletedOriginals(j.dir, j.treeRel, capture, decision.undecided);
        if (decision.moves.length) {
          log("[WARN] 以下檔案在那次執行被終止之後被移動過（內容和那批開始時的原檔一模一樣），不是那批的變更，原樣留著：");
          decision.moves.forEach((m) => log(`  - ${j.treeRel}/${m.from} → ${j.treeRel}/${m.to}`));
        }
      } catch (e) {
        stopUnrestored(runDir, d.path, `撤回沒有完成：${String(e)}`);
      }
      if (rolledBack?.failed.length) {
        stopUnrestored(runDir, d.path, `有檔案放不回去：${rolledBack.failed.join("、")}`);
      }
      if (!rolledBack && !decision?.undecided.length && !decision?.moves.length) log("  （這批沒有留下要撤回的變更）");
    }
    // Its run left no summary: without one, its artifacts look like a run still going.
    try {
      fs.writeFileSync(
        path.join(j.runDir, "summary.json"),
        JSON.stringify(
          {
            success: false,
            stopReason: "killed",
            recoveredBy: runDir,
            batches: records,
            ...(recorded ? {} : { inProgress: { batch: j.batch, targetClasses: j.targetClasses, dir: j.dir, rolledBack: rolledBack ?? null } }),
          },
          stripRaw,
          2,
        ),
      );
    } catch {
      /* its artifacts are gone or read-only: the rollback is what mattered */
    }
    closeBatchJournal(d.path);
  }
}

/** libs/batch.ts decideRecovery on the killed batch's test tree, said in the log. */
function decideKilledBatch(d: DeadBatch, capture: TreeCapture, lastSeen: number): RecoveryDecision {
  const tree = d.journal.testTree;
  const { decision, reused } = decideRecovery(d, capture, lastSeen, 2 * LOCK_HEARTBEAT_MS, {
    snapshot: () => snapshotTree(tree),
    mtimeOf: (rel) => mtimeOf(path.join(tree, rel)),
    read: (rel) => {
      try {
        return fs.readFileSync(path.join(tree, rel));
      } catch {
        return undefined;
      }
    },
  });
  if (reused) log(`  （沿用上一次嘗試撤回時的判斷，${new Date(decision.at).toISOString()}）`);
  else if (d.traceLost) {
    log("[WARN] 它的 trace.json 讀不了（損毀）：不知道 writer 改了哪些檔，那批開始之後、那次執行死掉之前的所有變更都當成那批的撤回");
  }
  return decision;
}

/**
 * Files a killed batch started with that are gone now, where nothing tells whether the batch's writer
 * deleted them or someone did after the run died: not put back, but their original content is kept
 * in the batch's artifacts, and said so.
 */
function keepDeletedOriginals(dir: string, treeRel: string, capture: TreeCapture, undecided: string[]): void {
  const kept: string[] = [];
  for (const rel of undecided) {
    const original = capture.files.get(rel);
    if (!original) continue;
    try {
      const dest = path.join(dir, "deleted", treeRel, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, original);
      kept.push(rel);
    } catch {
      /* the artifacts cannot hold it: it is still named below */
    }
  }
  if (!undecided.length) return;
  log(
    `[WARN] 以下檔案在那批開始時存在、現在不見了；它所在的目錄在那次執行結束之後又被改過，無法判斷是被終止的 writer ` +
      `還是之後的人刪的，所以沒有放回${kept.length ? `（原本的內容保留在 ${path.join(dir, "deleted")}）` : ""}：`,
  );
  undecided.forEach((rel) => log(`  - ${treeRel}/${rel}`));
}

/** A batch of this checkout that another testgen may still be running: this run does not start on it. */
function stopBusy(runDir: string, journals: string[]): never {
  try {
    fs.writeFileSync(
      path.join(runDir, "summary.json"),
      JSON.stringify({ success: false, stopReason: "checkout-busy", journals }, null, 2),
    );
  } catch {
    /* the message below is what matters */
  }
  die(
    `這個 checkout 上可能還有另一個 testgen 在執行：以下復原日誌的執行在等待的 ${Math.round(OTHER_RUN_WAIT_MS / 1000)} 秒內` +
      `一直有動靜（心跳還在更新，或它的程序還在）。\n${journals.map((d) => `  - ${d}`).join("\n")}\n` +
      `等它結束再重跑（UT_OTHER_RUN_WAIT_MS 可以調整等多久）。確定它已經不在（例如那個容器已經刪除）的話，` +
      `刪掉上面的目錄再重跑——那批寫到一半的測試就不會被撤回。`,
  );
}

/** A killed batch that cannot be put back: this run stops, and the journal stays for the next one to try again. */
function stopUnrestored(runDir: string, journal: string, why: string): never {
  try {
    fs.writeFileSync(
      path.join(runDir, "summary.json"),
      JSON.stringify({ success: false, stopReason: "killed-batch-not-restored", error: why, journal }, null, 2),
    );
  } catch {
    /* the message below is what matters */
  }
  die(
    `上一次被強制終止的那批沒辦法完整撤回（${why}）。src/test 裡可能還留著那批 writer 寫到一半、沒通過任何 gate 的測試，` +
      `在它上面產生新的測試會把它們當成既有測試保護起來，所以這次先停下。\n` +
      `常見原因是檔案被 IDE 或防毒軟體鎖住：關掉它們後重跑即可，復原日誌還在（${journal}）。\n` +
      `確定要保留現況的話，刪掉那個目錄再重跑。`,
  );
}

// The interrupt and crash paths: the batch that was cut short is set aside like a failed one — its
// tests never passed the gates — and the summary says which batches finished, which one was cut
// short, and which never ran.
function batchShutdownState(): Record<string, unknown> {
  const run = batchRun;
  if (!run) return {};
  const f = run.inFlight;
  run.inFlight = undefined;
  const attention = attentionOf(run.records);
  let inProgress: Record<string, unknown> | undefined;
  if (f) {
    let rolledBack: SetAside | { error: string } | null;
    try {
      // A writer session the interrupt or the crash cut short: what it wrote so far is its too.
      rolledBack = setAside(f.dir, f.start, f.outputs, run.treeRel, writerChangesSoFar(f.trace)) ?? null;
      if (rolledBack) attention.push(...attentionOf([{ batch: f.index + 1, stopReason: "interrupted", dir: f.dir, rolledBack }]));
      // Kept when the rollback did not finish: the next run on the repo finishes it from the journal.
      closeBatchJournal(f.journal);
    } catch (e) {
      rolledBack = { error: String(e) };
      attention.push(`第 ${f.index + 1} 批的撤回沒有完成：${String(e)}`);
    }
    inProgress = { batch: f.index + 1, targetClasses: run.batches[f.index], dir: f.dir, rolledBack };
  }
  const started = run.records.length + (f ? 1 : 0);
  return {
    batches: run.records,
    ...(inProgress ? { inProgress } : {}),
    notRun: run.batches.slice(started).flat(),
    ...(attention.length ? { attention } : {}),
  };
}

const foreignWhy = (killed: boolean) =>
  killed ? "在那次執行被終止之後才改過（不是那批的 writer 改的）" : "在這批執行期間被 writer 以外的東西改過";

function renderRollback(rb: RollbackReport, rejectedDir: string, treeRel: string, outputsRemoved: number, killed = false): string {
  const list = (title: string, files: string[]) =>
    files.length ? [`${title}：`, ...files.map((f) => `  - ${treeRel}/${f}`)] : [];
  return [
    killed
      ? `這批在執行途中被強制終止，沒來得及撤回；下一次執行依它的復原日誌撤回了它對 ${treeRel} 的變更，嘗試的版本保留在：`
      : `這批沒有通過所有 gate，它對 ${treeRel} 的變更已撤回，嘗試的版本保留在：`,
    `  ${rejectedDir}`,
    "（依原本的 repo 相對路徑存放，要採用時整個複製回 repo 即可）",
    "",
    ...list("這批新增、已移出的檔案", rb.created),
    ...list("這批修改過、已還原為原本內容的檔案", rb.restored),
    ...list("這批刪掉、已放回的檔案", rb.undeleted),
    ...list("過大沒有備份、維持這批留下狀態的檔案", rb.unrestorable),
    ...list("嘗試版本沒能保留（已照樣還原）的檔案", rb.notKept),
    ...list("無法還原的檔案（run 因此停止）", rb.failed),
    ...list(`${foreignWhy(killed)}、沒有撤回的檔案`, rb.foreign),
    ...(outputsRemoved
      ? ["", `另清掉這批留在建置輸出（test-classes）的 ${outputsRemoved} 個檔——下一次建置會從還原後的原始碼重新產生。`]
      : []),
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

// A crash, from the promise chain or from a callback outside it: the children go first — a writer
// still writing or a build still compiling would change the tree under the rollback — then a test
// tree left in its ASCII view (libs/encoding.ts) is written back, as at any session's end, and the
// batch rollback after it compares against what the batch started with.
// Every step is guarded, and a second failure while crashing still ends the process with an error:
// an unguarded throw in here came back through uncaughtException, found the crash already under
// way, and the process ended with exit code 0 — no FATAL line, no summary, nothing rolled back.
let crashing = false;
function crash(e: unknown): void {
  const text = String((e as { stack?: string } | undefined)?.stack ?? e);
  if (crashing) {
    try {
      process.stderr.write(`FATAL（收尾時又出錯）: ${text}\n`);
    } finally {
      process.exit(1);
    }
  }
  crashing = true;
  const step = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (x) {
      try {
        process.stderr.write(`[WARN] crash 收尾時${what}失敗：${String(x)}\n`);
      } catch {
        /* nothing left to report with */
      }
    }
  };
  step("結束子行程", killAll);
  step("還原編碼視圖", () => finishOpenViews());
  step("寫 summary", () => {
    if (!crashRunDir || fs.existsSync(path.join(crashRunDir, "summary.json"))) return;
    fs.writeFileSync(
      path.join(crashRunDir, "summary.json"),
      JSON.stringify({ success: false, stopReason: "crash", error: text, ...resumedField(), ...batchShutdownState() }, stripRaw, 2),
    );
  });
  die(text);
}
process.on("uncaughtException", crash);
main().catch(crash);
