// Iteration orchestrator: the single deterministic control loop.
// Zero SDK imports — all agent interaction goes through the AgentRunner interface.
// Each iteration's artifacts land in runs/<ts>/iter-N/ (state in artifacts, not context).
// Review passes when blockers are empty and all six dims meet threshold; feedback carries
// only blockers + below-threshold dims (advisories stay out of the loop to avoid thrash).
//
// Early-abort rules (all fail-closed, none burn remaining rounds):
// - runner spawn-error: the agent never ran; retrying cannot help.
// - writer no-op after a failed round: nothing changed, the same gates would fail identically.
// - identical feedback twice in a row: the loop is stuck, more rounds add cost, not progress.
// - writer touched a file outside its test tree: every later gate would judge tests against
//   production code the writer rewrote, and the loop cannot safely undo it.
// Round-failing (not aborting) guard:
// - writer shrank a pre-existing test file: "fixed" and "deleted" look the same to the build
//   gate; the round fails with the numbers and the writer restores what it removed.
//
// repairBaseline() below is the second loop in this file: same writer, same guards, same build
// command, run before any generation when the module is already red.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_ITER,
  MAX_FEEDBACK_CHARS,
  REPO_ROOT,
  ALLOW_TEST_SHRINK,
  REPAIR_MAX_ITER,
  TEST_SCOPE,
} from "./config";
import { log, banner, tail } from "./libs/log";
import { AgentRunner, BuildTool, ModuleInfo, ReviewVerdict } from "./libs/types";
import {
  clampText,
  diffSnapshots,
  expectedTestPath,
  feedbackFingerprint,
  snapshotTree,
  stripRaw,
  testClassNames,
  writerScopeSkip,
} from "./libs/utils";
import {
  buildGeneratePrompt,
  buildFixPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
  renderShrinkFeedback,
  testRootRel,
  ExistingTests,
  PreExistingFailures,
} from "./prompts";
import { TestConventions } from "./libs/conventions";
import { collectTestMetrics, findShrunk } from "./libs/testmetrics";
import { runBuildAndTests, runBaseline, summarizeBuildErrors, BaselineResult } from "./gates/build";
import { checkCoverage } from "./gates/coverage";
import { runReviewGate } from "./gates/review";

export interface OrchestratorConfig {
  targetClasses: string[];
  buildTool: BuildTool;
  runner: AgentRunner;
  standards: string;
  rubric: string;
  skipReview: boolean;
  mod: ModuleInfo;
  runDir: string;
  // Resolved by loop.ts before round 1: existing tests per target class, and the failures
  // the module already had. Both exist to keep the writer inside its own scope.
  existingTests: ExistingTests[];
  preExisting?: PreExistingFailures;
  conventions?: TestConventions;
}

// One row per iteration: which gate the round reached and how it ended.
// This is the run's funnel — it shows where rounds die, which is the first thing
// to look at when tuning the loop.
export interface IterationRecord {
  iter: number;
  gate: "writer" | "build" | "coverage" | "review" | "pass";
  outcome: string;
  changedFiles: number;
  writerOutputTokens?: number;
}

export interface OrchestratorResult {
  success: boolean;
  iterations: number;
  // "gates-passed" | "max-iterations" | "runner-spawn-error" | "writer-no-op" | "stuck"
  // | "scope-violation"
  stopReason: string;
  targetClasses: string[];
  coverageReport: string;
  funnel: IterationRecord[];
  totalOutputTokens?: number;
  finalFeedback?: string;
  finalVerdict?: ReviewVerdict;
}

export async function orchestrate(cfg: OrchestratorConfig): Promise<OrchestratorResult> {
  let feedback: string | null = null;
  // Previous round's report, normalized — see feedbackFingerprint for why the raw strings
  // cannot be compared directly. null until a round has failed; a string never equals it.
  let prevFingerprint: string | null = null;
  let lastVerdict: ReviewVerdict | undefined;
  let lastCov = "（尚未執行覆蓋率檢查）";
  const funnel: IterationRecord[] = [];
  let totalOutputTokens: number | undefined;
  const testRoot = path.join(cfg.mod.moduleRoot, "src", "test", "java");
  // Everything in the repo outside the module's test source set is read-only for the writer.
  const scopeSkip = writerScopeSkip(REPO_ROOT, cfg.mod.moduleRoot);
  const snapshotProtected = () => snapshotTree(REPO_ROOT, { skipDir: scopeSkip });
  // What every pre-existing test file had before round 1. The writer may reshape the files it
  // creates, but may not take anything away from these — see libs/testmetrics.ts.
  const originalMetrics = collectTestMetrics(testRoot);

  // Scoped iterations: surefire runs only the target classes' tests, and the module-wide run
  // is deferred to a single verification before success rather than skipped. Maven only —
  // -Dtest is a surefire property, and gradle's --tests is a different shape.
  const scoped = TEST_SCOPE === "generated" && cfg.buildTool === "maven";
  if (TEST_SCOPE === "generated" && !scoped) {
    log("[WARN] UT_TEST_SCOPE=generated 目前只支援 maven，本次退回完整模組範圍");
  }
  if (scoped) {
    log("測試範圍：迭代期間只跑目標類別的測試，通過前會以完整模組範圍重跑一次驗收");
  }
  // Fixed part of the scope: where the tests for the target classes are expected to live, plus
  // any existing test files already found for them.
  const scopeSeed = [
    ...cfg.targetClasses.map(expectedTestPath),
    ...cfg.existingTests.flatMap((e) => e.tests),
  ];

  const fail = (stopReason: string, finalFeedback: string, iter: number): OrchestratorResult => ({
    success: false,
    iterations: iter,
    stopReason,
    targetClasses: cfg.targetClasses,
    coverageReport: lastCov,
    funnel,
    totalOutputTokens,
    finalFeedback,
    finalVerdict: lastVerdict,
  });

  for (let iter = 1; iter <= MAX_ITER; iter++) {
    const iterDir = path.join(cfg.runDir, `iter-${iter}`);
    fs.mkdirSync(iterDir, { recursive: true });
    const save = (name: string, content: string) =>
      fs.writeFileSync(path.join(iterDir, name), content);
    const record = (rec: Omit<IterationRecord, "iter">) => funnel.push({ iter, ...rec });
    // A failed round: bound the report, persist it, and stop if it is the same failure as last
    // round (see feedbackFingerprint). Returns the abort result, or null to go on.
    const failRound = (report: string, stuckMsg: string): OrchestratorResult | null => {
      // Bounded here as well as at the source, so the invariant holds whichever gate wrote
      // the report: the writer never receives more than MAX_FEEDBACK_CHARS *of report*, plus
      // clampText's short truncation notice when it had to cut. The notice is deliberate —
      // a silently shortened report reads as a complete one — so the string is a few dozen
      // characters over the number, not under it.
      feedback = clampText(report, MAX_FEEDBACK_CHARS);
      save("feedback.md", feedback);
      const fingerprint = feedbackFingerprint(feedback);
      if (prevFingerprint === fingerprint) return fail("stuck", `${stuckMsg}\n${feedback}`, iter);
      prevFingerprint = fingerprint;
      return null;
    };

    banner(`第 ${iter}/${MAX_ITER} 輪迭代`);

    // Step 1: generate or fix
    log(`Step 1/4：${feedback ? "依上輪失敗報告修正" : "首次產生"}測試`);
    const prompt = feedback
      ? buildFixPrompt({
          gateReport: feedback,
          standards: cfg.standards,
          mod: cfg.mod,
          targetClasses: cfg.targetClasses,
          preExisting: cfg.preExisting,
          conventions: cfg.conventions,
        })
      : buildGeneratePrompt({
          targetClasses: cfg.targetClasses,
          standards: cfg.standards,
          mod: cfg.mod,
          existingTests: cfg.existingTests,
          conventions: cfg.conventions,
        });
    save("prompt.md", prompt);

    const before = snapshotTree(testRoot);
    const protectedBefore = snapshotProtected();
    const writer = await cfg.runner.runWriter(prompt);
    if (writer.outputTokens !== undefined) {
      totalOutputTokens = (totalOutputTokens ?? 0) + writer.outputTokens;
    }
    save("writer-summary.md", writer.text || "（writer 未回傳文字）");
    log(`[writer 總結] ${tail(writer.text, 1500)}`);

    if (writer.status === "spawn-error") {
      record({ gate: "writer", outcome: "spawn-error", changedFiles: 0 });
      return fail(
        "runner-spawn-error",
        "writer 程序未能啟動（spawn 失敗）。這是環境問題，重試不會改善：" +
          "請確認 opencode CLI 可用，或以 UT_OPENCODE_BIN 指定路徑。",
        iter,
      );
    }

    const changed = diffSnapshots(before, snapshotTree(testRoot));
    const outOfScope = diffSnapshots(protectedBefore, snapshotProtected());
    save("changed-files.txt", changed.length ? changed.join("\n") : "（本輪未變更任何測試檔）");
    log(`writer 變更了 ${changed.length} 個測試檔`);

    // Scope check comes before any gate: a modified production file would have the build
    // gate validate the tests against code the writer rewrote to make them pass. The loop
    // cannot safely undo it — there is no content snapshot, and a git checkout would also
    // discard the operator's own uncommitted work — so it stops and hands the diff to a human.
    if (outOfScope.length) {
      save("scope-violations.txt", outOfScope.join("\n"));
      record({ gate: "writer", outcome: "scope-violation", changedFiles: changed.length });
      return fail(
        "scope-violation",
        `writer 修改了測試範圍以外的檔案，本次執行中止：\n` +
          outOfScope.map((f) => `  - ${f}`).join("\n") +
          `\n這些變更「未被還原」——請以 git diff 檢視並自行還原後重跑。` +
          `\n（writer 的可寫範圍只有目標模組的 src/test/；production code、建置檔與其他模組一律唯讀。）`,
        iter,
      );
    }

    if (changed.length === 0) {
      if (feedback) {
        // A failed gate demanded changes and none arrived — the same gates would fail
        // identically. Common causes: context exhausted, permission-blocked writes.
        record({ gate: "writer", outcome: "no-op", changedFiles: 0 });
        return fail(
          "writer-no-op",
          `上一輪 gate 失敗後，writer 未變更 ${testRootRel(cfg.mod)} 下任何檔案。` +
            "常見原因：模型 context 耗盡、非互動模式寫檔被 permission 擋下（見 README Troubleshooting）。",
          iter,
        );
      }
      // Round 1 with no changes can be legitimate (tests already exist); the gates still
      // judge, but the summary must say the tool generated nothing this run.
      log("[WARN] writer 首輪未變更任何測試檔——gate 仍會執行，但本次執行未新增測試");
    }

    // Shrink guard: to the build gate, "fixed the failing test" and "deleted the failing test"
    // are the same green. The round fails before any build, with the numbers, so the writer
    // puts back what it removed instead of the loop validating a hollowed-out suite.
    const shrunk = findShrunk(originalMetrics, collectTestMetrics(testRoot));
    if (shrunk.length) {
      const report = renderShrinkFeedback(shrunk);
      save("test-shrink.txt", report);
      if (ALLOW_TEST_SHRINK) {
        log(`[WARN] UT_ALLOW_TEST_SHRINK=1：既有測試被刪減（${shrunk.length} 檔），依設定放行`);
      } else {
        log(`[FAIL] 既有測試被刪減（${shrunk.length} 檔）——本輪判 FAIL，不進 build gate`);
        record({
          gate: "writer",
          outcome: "test-shrink",
          changedFiles: changed.length,
          writerOutputTokens: writer.outputTokens,
        });
        const stop = failRound(report, "連續兩輪刪減相同的既有測試，判定迴圈卡住，提前結束。");
        if (stop) return stop;
        log("→ 帶著刪減報告進入下一輪");
        continue;
      }
    }

    // Step 2: hard gate — compile & test
    log("Step 2/4：執行編譯與測試 gate");
    // The coverage gate only trusts a report written after this instant.
    const buildStartedAt = Date.now();
    // Whatever the writer just touched counts too: it may have named its file something the
    // expected-path derivation does not predict, and a test that is not in -Dtest never runs.
    const onlyTests = scoped ? testClassNames([...scopeSeed, ...changed]) : undefined;
    if (onlyTests) log(`  範圍限縮：-Dtest=${onlyTests.join(",")}`);
    const build = await runBuildAndTests(cfg.buildTool, cfg.mod, { onlyTests });
    save("build.log", build.raw ?? build.report);
    log(build.passed ? "[OK] 編譯與測試 gate：PASS" : "[FAIL] 編譯與測試 gate：FAIL");
    if (!build.passed) {
      record({
        gate: "build",
        outcome: "fail",
        changedFiles: changed.length,
        writerOutputTokens: writer.outputTokens,
      });
      const stop = failRound(build.report, "連續兩輪得到完全相同的失敗報告，判定迴圈卡住，提前結束。");
      if (stop) return stop;
      log("→ 帶著失敗報告進入下一輪");
      continue;
    }

    // Step 3: hard gate — coverage
    log("Step 3/4：檢查覆蓋率 gate");
    const cov = checkCoverage(cfg.targetClasses, cfg.mod, buildStartedAt);
    lastCov = cov.report;
    save("coverage.txt", cov.report);
    log(cov.passed ? "[OK] 覆蓋率 gate：PASS" : "[FAIL] 覆蓋率 gate：FAIL");
    if (!cov.passed) {
      record({
        gate: "coverage",
        outcome: "fail",
        changedFiles: changed.length,
        writerOutputTokens: writer.outputTokens,
      });
      const stop = failRound(
        `測試全數通過，但覆蓋率未達門檻，請補強缺漏情境的測試。\n${cov.report}`,
        "連續兩輪得到完全相同的覆蓋率缺口，判定迴圈卡住，提前結束。",
      );
      if (stop) return stop;
      log("→ 帶著覆蓋率缺口進入下一輪");
      continue;
    }

    // Step 4: review gate
    let verdict: ReviewVerdict | undefined;
    if (cfg.skipReview) {
      log("Step 4/4：依設定跳過 review gate");
    } else {
      log("Step 4/4：執行品質 review gate");
      const reviewPrompt = buildReviewPrompt({
        targetClasses: cfg.targetClasses,
        rubric: cfg.rubric,
        mod: cfg.mod,
      });
      save("review-prompt.md", reviewPrompt);
      verdict = await runReviewGate(cfg.runner, reviewPrompt);
      lastVerdict = verdict;
      save("verdict.json", JSON.stringify(verdict, stripRaw, 2));
      if (verdict.raw) save("review-raw.txt", verdict.raw);
    }

    if (!verdict || verdict.passed) {
      if (verdict) log("[OK] 品質 review gate：PASS");
      // Every gate is satisfied for the target classes. Under a scoped run that is only half
      // the build gate's promise — the other half, "and nothing else broke", needs the module
      // -wide run. Deferring it to here costs one build per run instead of one per round;
      // skipping it would trade the promise away for the same saving.
      if (scoped) {
        log("最終驗收：以完整模組範圍重跑，確認新測試沒有打壞既有測試");
        const full = await runBuildAndTests(cfg.buildTool, cfg.mod);
        save("final-verify.log", full.raw ?? full.report);
        if (!full.passed) {
          log("[FAIL] 最終驗收：模組其他測試被打壞");
          record({
            gate: "build",
            outcome: "final-verify-fail",
            changedFiles: changed.length,
            writerOutputTokens: writer.outputTokens,
          });
          const stop = failRound(
            "目標類別的測試本身全部通過，但以完整模組範圍重跑時有其他測試失敗——" +
              `新測試打壞了既有測試，請修正。\n${full.report}`,
            "連續兩輪最終驗收失敗於相同原因，判定迴圈卡住，提前結束。",
          );
          if (stop) return stop;
          log("→ 帶著最終驗收失敗進入下一輪");
          continue;
        }
        log("[OK] 最終驗收：PASS");
      }
      log(verdict ? "所有關卡通過（編譯 / 測試 / 覆蓋率 / 品質審查）" : "[OK] 全部 hard gate 通過");
      record({
        gate: "pass",
        outcome: verdict ? "all-gates-passed" : "hard-gates-passed",
        changedFiles: changed.length,
        writerOutputTokens: writer.outputTokens,
      });
      return {
        success: true,
        iterations: iter,
        stopReason: "gates-passed",
        targetClasses: cfg.targetClasses,
        coverageReport: cov.report,
        funnel,
        totalOutputTokens,
        finalVerdict: verdict,
      };
    }

    log(
      `[FAIL] 品質 review gate：REJECT（blockers ${verdict.blockers.length}、` +
        `低於門檻維度 ${verdict.belowThreshold.length}）`,
    );
    verdict.blockers.forEach((b, i) => log(`  blocker ${i + 1}. ${b}`));
    verdict.belowThreshold.forEach((d) => log(`  低分維度：${d}`));
    record({
      gate: "review",
      outcome: "reject",
      changedFiles: changed.length,
      writerOutputTokens: writer.outputTokens,
    });

    const fb: string[] = [
      "編譯、測試與覆蓋率皆通過，但品質審查未過，請修正以下問題（僅修改測試碼）：",
    ];
    if (verdict.blockers.length) {
      fb.push("Blockers（必須全部修正）：");
      verdict.blockers.forEach((b, i) => fb.push(`${i + 1}. ${b}`));
    }
    if (verdict.belowThreshold.length) {
      fb.push(`低於門檻的維度：${verdict.belowThreshold.join("、")}。請針對該維度定義補強。`);
    }
    fb.push("（advisories 為建議級，本輪不需處理。）");
    const stop = failRound(fb.join("\n"), "連續兩輪得到完全相同的審查意見，判定迴圈卡住，提前結束。");
    if (stop) return stop;
    log("→ 帶著審查意見進入下一輪");
  }

  return fail("max-iterations", feedback ?? "達到最大迭代次數", MAX_ITER);
}

// ─── Baseline repair ─────────────────────────────────────────────────────────

export interface RepairConfig {
  runner: AgentRunner;
  buildTool: BuildTool;
  standards: string;
  mod: ModuleInfo;
  runDir: string;
  baseline: BaselineResult;
}

export interface RepairResult {
  success: boolean;
  rounds: number;
  // "repaired" | "repair-max-iterations" | "runner-spawn-error" | "writer-no-op" | "stuck"
  // | "scope-violation"
  stopReason: string;
  // Still red when repair gave up; empty on success.
  remaining: PreExistingFailures;
  report: string;
  // Every test file the repair rounds touched — the diff a human should read before committing.
  changedFiles: string[];
}

/**
 * Repair a red baseline before generating anything: the same writer, the same scope and shrink
 * guards, and the same build command as the gate, looped until the module is green.
 *
 * No coverage or review gate here — both are scoped to the target classes. What repair has to
 * prove is narrower: the module builds, its tests pass, and nothing was gutted to get there.
 * Success is defined as "runBaseline would now report clean", by construction.
 */
export async function repairBaseline(cfg: RepairConfig): Promise<RepairResult> {
  const testRoot = path.join(cfg.mod.moduleRoot, "src", "test", "java");
  const scopeSkip = writerScopeSkip(REPO_ROOT, cfg.mod.moduleRoot);
  const snapshotProtected = () => snapshotTree(REPO_ROOT, { skipDir: scopeSkip });
  const originalMetrics = collectTestMetrics(testRoot);
  const touched = new Set<string>();
  let current = cfg.baseline;
  let prevFingerprint: string | null = null;

  // Classification plus the error lines: the summary says which files, the extract says why.
  const describe = (b: BaselineResult) =>
    clampText(`${b.summary}\n錯誤節錄：\n${summarizeBuildErrors(b.raw)}`, MAX_FEEDBACK_CHARS);
  let report = describe(current);

  const brokenList = (b: BaselineResult) => [
    ...b.compileErrorFiles.map((f) =>
      (path.isAbsolute(f) ? path.relative(REPO_ROOT, f) : f).replace(/\\/g, "/"),
    ),
    ...b.failingTestClasses,
  ];
  const remaining = (b: BaselineResult): PreExistingFailures => ({
    compileErrorFiles: b.compileErrorFiles,
    failingTestClasses: b.failingTestClasses,
  });
  const giveUp = (stopReason: string, why: string, rounds: number): RepairResult => ({
    success: false,
    rounds,
    stopReason,
    remaining: remaining(current),
    report: why,
    changedFiles: [...touched].sort(),
  });

  for (let round = 1; round <= REPAIR_MAX_ITER; round++) {
    const dir = path.join(cfg.runDir, `repair-${round}`);
    fs.mkdirSync(dir, { recursive: true });
    const save = (name: string, content: string) =>
      fs.writeFileSync(path.join(dir, name), content);
    banner(`修復既有紅燈 第 ${round}/${REPAIR_MAX_ITER} 輪`);

    const prompt = buildRepairPrompt({
      brokenFiles: brokenList(current),
      report,
      standards: cfg.standards,
      mod: cfg.mod,
      round,
    });
    save("prompt.md", prompt);

    const before = snapshotTree(testRoot);
    const protectedBefore = snapshotProtected();
    const writer = await cfg.runner.runWriter(prompt);
    save("writer-summary.md", writer.text || "（writer 未回傳文字）");
    log(`[writer 總結] ${tail(writer.text, 1500)}`);
    if (writer.status === "spawn-error") {
      return giveUp(
        "runner-spawn-error",
        "writer 程序未能啟動（spawn 失敗）。這是環境問題，重試不會改善：請確認 opencode CLI 可用，或以 UT_OPENCODE_BIN 指定路徑。",
        round,
      );
    }

    const changed = diffSnapshots(before, snapshotTree(testRoot));
    const outOfScope = diffSnapshots(protectedBefore, snapshotProtected());
    changed.forEach((f) => touched.add(f));
    save("changed-files.txt", changed.length ? changed.join("\n") : "（本輪未變更任何測試檔）");
    log(`writer 變更了 ${changed.length} 個測試檔`);
    if (outOfScope.length) {
      save("scope-violations.txt", outOfScope.join("\n"));
      return giveUp(
        "scope-violation",
        `修復輪 writer 修改了測試範圍以外的檔案：\n${outOfScope.map((f) => `  - ${f}`).join("\n")}\n` +
          "這些變更「未被還原」——請以 git diff 檢視並自行還原後重跑。",
        round,
      );
    }
    if (changed.length === 0) {
      return giveUp(
        "writer-no-op",
        `修復輪 writer 未變更 ${testRootRel(cfg.mod)} 下任何檔案。常見原因：模型 context 耗盡、` +
          "非互動模式寫檔被 permission 擋下（見 README Troubleshooting）。",
        round,
      );
    }

    const shrunk = findShrunk(originalMetrics, collectTestMetrics(testRoot));
    if (shrunk.length) {
      const shrinkReport = renderShrinkFeedback(shrunk);
      save("test-shrink.txt", shrinkReport);
      if (!ALLOW_TEST_SHRINK) {
        log(`[FAIL] 修復輪刪減了既有測試（${shrunk.length} 檔）——本輪判 FAIL，不進建置`);
        report = clampText(shrinkReport, MAX_FEEDBACK_CHARS);
        save("feedback.md", report);
        const fingerprint = feedbackFingerprint(report);
        if (prevFingerprint === fingerprint) {
          return giveUp("stuck", `連續兩輪刪減相同的既有測試，判定迴圈卡住。\n${report}`, round);
        }
        prevFingerprint = fingerprint;
        continue;
      }
      log(`[WARN] UT_ALLOW_TEST_SHRINK=1：修復輪刪減了既有測試（${shrunk.length} 檔），依設定放行`);
    }

    current = await runBaseline(cfg.buildTool, cfg.mod, "repair");
    save("build.log", current.raw);
    save("build-summary.md", current.summary);
    console.log(current.summary);
    if (current.clean) {
      return {
        success: true,
        rounds: round,
        stopReason: "repaired",
        remaining: { compileErrorFiles: [], failingTestClasses: [] },
        report: current.summary,
        changedFiles: [...touched].sort(),
      };
    }
    report = describe(current);
    save("feedback.md", report);
    const fingerprint = feedbackFingerprint(report);
    if (prevFingerprint === fingerprint) {
      return giveUp("stuck", `連續兩輪修復後得到相同的紅燈，判定迴圈卡住。\n${report}`, round);
    }
    prevFingerprint = fingerprint;
    log("→ 仍有紅燈，帶著報告進入下一輪修復");
  }
  return giveUp(
    "repair-max-iterations",
    `修復 ${REPAIR_MAX_ITER} 輪後模組仍是紅的。\n${report}`,
    REPAIR_MAX_ITER,
  );
}
