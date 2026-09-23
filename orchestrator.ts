// Iteration orchestrator: the single deterministic control loop.
// Zero SDK imports — all agent interaction goes through the AgentRunner interface.
// Each iteration's artifacts land in runs/<ts>/iter-N/ (state in artifacts, not context).
// Review passes when blockers are empty and all six dims meet threshold; feedback carries
// only blockers + below-threshold dims (advisories stay out of the loop to avoid thrash).
//
// Early-abort rules (all fail-closed, none burn remaining rounds):
// - runner spawn-error (writer or reviewer): the agent cannot run; retrying cannot help, and a
//   reviewer that cannot run is not something the writer can fix by rewriting tests.
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
  REPAIR_NO_PROGRESS_ROUNDS,
  REVIEW_MAX_RETRIES,
  TEST_SCOPE,
  RUNNER_KIND,
  RUNS_DIR,
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
  splitForeignChanges,
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
import { collectTestMetrics, findShrunk, MetricsSnapshot } from "./libs/testmetrics";
import { runBuildAndTests, runBaseline, summarizeBuildErrors, BaselineResult, ExpectedTest, expectedTestOf } from "./gates/build";
import { checkCoverage } from "./gates/coverage";
import { runReviewGate, isUnparseable, REVIEWER_SPAWN_ERROR } from "./gates/review";
import { measureTestStack, mergeTestStack, TestStack } from "./libs/teststack";
import {
  closeEncodingView,
  describeSourceEncoding,
  EncodingView,
  measureSourceEncoding,
  openEncodingView,
  refineSourceEncoding,
  SourceEncoding,
  sourceViews,
} from "./libs/encoding";

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
  // The baseline's failing identities, passed only under UT_ALLOW_DIRTY_BASELINE. Both gate
  // call sites below get it: a final verification that did not subtract would reject a run
  // the per-round gate had already accepted, for failures neither of them caused.
  tolerate?: string[];
  conventions?: TestConventions;
  // Measured by loop.ts from the baseline; see libs/teststack.ts.
  testStack?: TestStack;
  // The encoding javac reads the module's sources in; see libs/encoding.ts.
  sourceEncoding?: SourceEncoding;
  // The test classes the module's build ran before any writer: from the baseline, or from the
  // repair that made it green. What a green round must still run; see testsThatMustRun.
  ranAtBaseline?: string[];
}

/**
 * The test classes a green build must have run (gates/build.ts checkTestsRan): each one the writer
 * created, and each one it changed that ran before it started. When the build runs the whole
 * module, also every class that ran before the writer started, touched or not: a round that gets
 * its green by making other tests stop running — a framework switch, a discovery filter among the
 * test resources — is seen there, whatever it edited. A class that ran before is required only
 * while its source is there: a stale compiled class ran too, and the next compile may drop it.
 */
function testsThatMustRun(
  testRoot: string,
  written: Iterable<string>,
  preexisting: MetricsSnapshot,
  ranBefore: string[] | undefined,
  wholeModule: boolean,
): ExpectedTest[] {
  const before = new Set(ranBefore ?? []);
  const out = new Map<string, ExpectedTest>();
  for (const rel of written) {
    if (!rel.endsWith(".java") || rel.startsWith("resources/")) continue;
    const file = path.join(testRoot, rel);
    let src: string;
    try {
      src = fs.readFileSync(file, "latin1");
    } catch {
      continue; // deleted
    }
    const t = expectedTestOf(src, file, rel in preexisting ? "changed" : "created");
    if (t && (t.origin === "created" || before.has(t.fqcn))) out.set(t.fqcn, t);
  }
  if (wholeModule) {
    for (const fqcn of before) {
      const file = path.join(testRoot, ...fqcn.split(".")) + ".java";
      if (!out.has(fqcn) && fs.existsSync(file)) out.set(fqcn, { file, fqcn, disabled: false, origin: "untouched" });
    }
  }
  return [...out.values()];
}

// Measured again after every build: a stack read off the pom is a guess about what is declared,
// and the first build that runs a test records the real classpath — which every prompt after it
// states instead. Only this build's reports count as current (`since`); see measureTestStack.
function refineTestStack(stack: TestStack | undefined, mod: ModuleInfo, buildLog: string, since: number): TestStack | undefined {
  const merged = mergeTestStack(stack, measureTestStack(mod, REPO_ROOT, buildLog, since));
  if (merged?.source === "surefire" && stack?.source !== "surefire") {
    log("測試相依：已從這次建置的測試 classpath 量得實際的相依，之後的 prompt 以此為準");
  }
  return merged;
}

// Around each agent session in a module whose sources are not UTF-8 (libs/encoding.ts): the test
// sources are shown as their ASCII view, and afterwards written back in the module's encoding.

const relToRepo = (p: string) => path.relative(REPO_ROOT, p).replace(/\\/g, "/");

/** Repo-relative, for the prompt: the files the session must leave alone. */
function protectedList(view: EncodingView | undefined): string[] {
  return view ? [...view.protectedFiles.keys()].map(relToRepo).sort() : [];
}

// The files the writer has written this run, as the view wants them: absolute test sources.
// writerChanges() keeps .java paths relative to src/test/java and everything else under resources/.
function agentSources(testRoot: string, written: Iterable<string>): string[] {
  return [...written].filter((f) => f.endsWith(".java") && !f.startsWith("resources/")).map((f) => path.join(testRoot, f));
}

// The target classes as the module's encoding reads them, for the prompt: production code is never
// put in a view on disk, and an agent tool reads MS950 as mojibake.
function targetSourceViews(enc: SourceEncoding | undefined, targetClasses: string[]): Array<{ file: string; view: string }> {
  return sourceViews(enc, targetClasses.map((c) => path.join(REPO_ROOT, c))).map((v) => ({ file: relToRepo(v.file), view: v.view }));
}

const listFiles = (files: string[]) =>
  [...files.slice(0, 20).map((f) => `  - ${relToRepo(f)}`), ...(files.length > 20 ? [`  …另 ${files.length - 20} 個`] : [])].join("\n");

/**
 * Closes the view after a writer session. A failure report when something could not be written
 * back safely — the round then fails before any build — null otherwise.
 */
function encodingViewAfter(view: EncodingView | undefined, save: (name: string, content: string) => void): string | null {
  if (!view) return null;
  const r = closeEncodingView(view);
  const name = view.encoding.name;
  if (r.converted.length) {
    log(
      view.mode === "transcode"
        ? `[${name}] writer 改寫的 ${r.converted.length} 個測試檔已以 ${name} 存檔（沒改到的行維持原本的內容）`
        : `[${name}] 無法轉換編碼：writer 寫的 ${r.converted.length} 個測試檔裡的非 ASCII 字元已轉成 \\uXXXX`,
    );
    save("encoding-converted.txt", r.converted.map(relToRepo).join("\n"));
  }
  const problems: string[] = [];
  if (r.restored.length) {
    problems.push(
      (view.mode === "transcode"
        ? `以下測試檔不是有效的 ${name}，pipeline 無法安全轉換，`
        : `以下測試檔含非 ASCII 字元，而 pipeline 無法轉換這個模組的編碼（${name}），`) +
        `你的工具改它們會破壞裡面的字元，所以已還原成原本的內容。這些檔案不能修改；要補測試時，在同一個 package 另建新的測試類別：\n${listFiles(r.restored)}`,
    );
  }
  if (r.replacement.length) {
    problems.push(
      `以下測試檔含有 U+FFFD（在你讀到的檔案裡顯示為 \\ufffd）——那是某個工具用錯的編碼讀檔時就已經遺失的字元，` +
        `存進測試裡永遠是錯的（pipeline 只以 \\ufffd 存，不會當成原本的字）。請換回實際的字；production 的中文字串以 prompt 裡` +
        `「目標類別的原始碼」或失敗報告裡的實際值為準：\n${listFiles(r.replacement)}`,
    );
  }
  if (r.failed.length) problems.push(`以下測試檔無法以 ${name} 寫回（既有的已還原，新的保留原樣）：\n${listFiles(r.failed)}`);
  if (!problems.length) return null;
  const report = problems.join("\n\n");
  save("encoding-report.txt", report);
  log(`[FAIL] writer 的輸出有無法以 ${name} 安全存檔的內容——本輪判 FAIL，不進建置`);
  return report;
}

// Measured again after every build: the build log is what says which encoding Maven fell back to.
function refineEncoding(prev: SourceEncoding | undefined, next: SourceEncoding | undefined): SourceEncoding | undefined {
  const merged = refineSourceEncoding(prev, next);
  if (merged && prev?.name !== merged.name) log(`原始碼編碼：${describeSourceEncoding(merged)}`);
  return merged;
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
  /** The last failed round's gate report as the writer got it, without the stop's own explanation. */
  lastReport?: string;
  finalVerdict?: ReviewVerdict;
}

// What "the agent could not run" means depends on the runner, and so does the fix. Telling an api
// runner user to install opencode sent them looking in the wrong place; the runner has already
// logged the real cause (the HTTP status and body) on its [FAIL] line.
export function runnerCannotRunHint(runner: string = RUNNER_KIND): string {
  if (runner === "api") {
    return "api runner 無法使用端點：網址、金鑰或模型名稱有誤，或端點從未回應過——實際的 HTTP 錯誤見上方 [FAIL] 那一行。";
  }
  if (runner === "qwen") return "qwen runner 無法啟動：請確認已安裝 @qwen-code/sdk 並設定 OPENAI_API_KEY / OPENAI_BASE_URL。";
  return "請確認 opencode CLI 可用，或以 UT_OPENCODE_BIN 指定路徑。";
}

// A writer that changed nothing is only "no-op" when it finished. One that was cut short (its
// deadline, a request that kept failing, a context it could not shrink) never got to write, and
// the runner's [WARN] line says which — pointing at permissions instead hid that line's cause.
function noOpReason(status: string, rel: string, repair: boolean): string {
  const who = repair ? "修復輪 writer" : "上一輪 gate 失敗後，writer";
  if (status !== "ok") {
    return (
      `${who} 的 session 沒有正常完成（status=${status}：逾時、請求持續失敗、context 已滿或回覆一直被截斷，原因見上方 ` +
      `[WARN] [writer] 那一行），${rel} 下沒有任何檔案被變更。`
    );
  }
  return (
    `${who} 未變更 ${rel} 下任何檔案。常見原因：模型 context 耗盡、非互動模式寫檔被 permission 擋下` +
    "（見 README Troubleshooting）。"
  );
}

// What the writer session changed outside its scope, minus what something else changed: see
// splitForeignChanges. The foreign part is logged, never silently dropped.
function outOfScopeChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const { kept, foreign } = splitForeignChanges(REPO_ROOT, diffSnapshots(before, after));
  if (foreign.length) {
    log(
      `[WARN] writer session 期間有 ${foreign.length} 個 git-ignored、不在 src/ 下的檔案變動` +
        `（多半是執行中的應用程式或 IDE），不計為 writer 越界：`,
    );
    foreign.slice(0, 10).forEach((f) => log(`  - ${f}`));
    if (foreign.length > 10) log(`  …另 ${foreign.length - 10} 個`);
  }
  return kept;
}

// What the writer changed in its writable tree — all of <module>/src/test, the tree write_file
// and the scope guard both allow. Watching only src/test/java made a fix that was a resource
// file (an expected-output fixture under src/test/resources) read as "changed nothing", and the
// round ended the run as writer-no-op. Paths come back relative to src/test/java for the .java
// ones, as every artifact and -Dtest derivation expects, and as resources/… otherwise.
function writerChanges(rawChanged: string[]): string[] {
  return rawChanged.map((c) => (c.startsWith("java/") ? c.slice("java/".length) : c));
}

// A violation list can be hundreds of paths long when something regenerates a directory; the
// report names the first ones and the count, and the full list goes to scope-violations.txt.
function listViolations(paths: string[]): string {
  const shown = paths.slice(0, 20).map((f) => `  - ${f}`);
  if (paths.length > 20) shown.push(`  …另 ${paths.length - 20} 個（完整清單見 scope-violations.txt）`);
  return shown.join("\n");
}

export async function orchestrate(cfg: OrchestratorConfig): Promise<OrchestratorResult> {
  let feedback: string | null = null;
  // Previous round's report, normalized — see feedbackFingerprint for why the raw strings
  // cannot be compared directly. null until a round has failed; a string never equals it.
  let prevFingerprint: string | null = null;
  let lastVerdict: ReviewVerdict | undefined;
  let lastCov = "（尚未執行覆蓋率檢查）";
  let testStack = cfg.testStack;
  let sourceEncoding = cfg.sourceEncoding;
  // The last gate's report. A round that fails on the encoding never reaches a gate, and what the
  // gate said before still has to be fixed: it goes along with the encoding report.
  let gateFeedback: string | null = null;
  const funnel: IterationRecord[] = [];
  let totalOutputTokens: number | undefined;
  const testRoot = path.join(cfg.mod.moduleRoot, "src", "test", "java");
  const writableTree = path.join(cfg.mod.moduleRoot, "src", "test");
  // Every file the writer has written this run. Scoped rounds build -Dtest from it, not from the
  // last round's changes: a round that fixed only a helper left the writer's own test class out of
  // -Dtest, ran zero tests, and got told to create <Class>Test.java — a duplicate.
  const everWritten = new Set<string>();
  // Everything in the repo outside the module's test source set is read-only for the writer.
  const scopeSkip = writerScopeSkip(REPO_ROOT, cfg.mod.moduleRoot, [RUNS_DIR]);
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
    lastReport: feedback ?? undefined,
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
    const failRound = (report: string, stuckMsg: string, fromGate = true): OrchestratorResult | null => {
      if (fromGate) gateFeedback = report;
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
    // Taken before the view opens and after it closes: what the round changed, net of the view.
    const before = snapshotTree(writableTree);
    const protectedBefore = snapshotProtected();
    const encView = openEncodingView(sourceEncoding, testRoot, { agentFiles: agentSources(testRoot, everWritten) });
    const targetSources = targetSourceViews(sourceEncoding, cfg.targetClasses);
    const prompt = feedback
      ? buildFixPrompt({
          gateReport: feedback,
          standards: cfg.standards,
          mod: cfg.mod,
          targetClasses: cfg.targetClasses,
          preExisting: cfg.preExisting,
          conventions: cfg.conventions,
          testStack,
          sourceEncoding,
          encodingMode: encView?.mode,
          lockedFiles: protectedList(encView),
          targetSources,
        })
      : buildGeneratePrompt({
          targetClasses: cfg.targetClasses,
          standards: cfg.standards,
          mod: cfg.mod,
          existingTests: cfg.existingTests,
          conventions: cfg.conventions,
          testStack,
          sourceEncoding,
          encodingMode: encView?.mode,
          lockedFiles: protectedList(encView),
          targetSources,
        });
    save("prompt.md", prompt);

    const writer = await cfg.runner.runWriter(prompt);
    const encodingReport = encodingViewAfter(encView, save);
    const rawChanged = diffSnapshots(before, snapshotTree(writableTree));
    if (writer.outputTokens !== undefined) {
      totalOutputTokens = (totalOutputTokens ?? 0) + writer.outputTokens;
    }
    save("writer-summary.md", writer.text || "（writer 未回傳文字）");
    log(`[writer 總結] ${tail(writer.text, 1500)}`);

    if (writer.status === "spawn-error") {
      record({ gate: "writer", outcome: "spawn-error", changedFiles: 0 });
      return fail(
        "runner-spawn-error",
        `writer 無法執行（spawn-error）。這是環境問題，重試不會改善：${runnerCannotRunHint()}`,
        iter,
      );
    }

    const changed = writerChanges(rawChanged);
    changed.forEach((f) => everWritten.add(f));
    const outOfScope = outOfScopeChanges(protectedBefore, snapshotProtected());
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
          listViolations(outOfScope) +
          `\n這些變更「未被還原」——請以 git diff 檢視並自行還原後重跑。` +
          `\n（若這些檔案不是 writer 改的——例如同時有別的程序在寫 repo——請讓那個程序停下，或把該目錄加進 .gitignore。）` +
          `\n（writer 的可寫範圍只有目標模組的 src/test/；production code、建置檔與其他模組一律唯讀。）`,
        iter,
      );
    }

    // Before the no-op check and the shrink guard: putting a file back can undo the round's only
    // change, and a restored file has its original counts again.
    if (encodingReport) {
      record({ gate: "writer", outcome: "encoding", changedFiles: changed.length, writerOutputTokens: writer.outputTokens });
      const stop = failRound(
        gateFeedback ? `${encodingReport}\n\n上一輪 gate 的失敗報告（仍待處理）：\n${gateFeedback}` : encodingReport,
        "連續兩輪得到相同的編碼問題，判定迴圈卡住，提前結束。",
        false,
      );
      if (stop) return stop;
      log("→ 帶著編碼報告進入下一輪");
      continue;
    }

    if (changed.length === 0) {
      if (feedback) {
        // A failed gate demanded changes and none arrived — the same gates would fail
        // identically. Common causes: context exhausted, permission-blocked writes.
        record({ gate: "writer", outcome: "no-op", changedFiles: 0 });
        return fail("writer-no-op", noOpReason(writer.status, testRootRel(cfg.mod), false), iter);
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
    const onlyTests = scoped ? testClassNames([...scopeSeed, ...everWritten]) : undefined;
    if (onlyTests) log(`  範圍限縮：-Dtest=${onlyTests.join(",")}`);
    const build = await runBuildAndTests(cfg.buildTool, cfg.mod, {
      onlyTests,
      tolerate: cfg.tolerate,
      mustRun: testsThatMustRun(testRoot, everWritten, originalMetrics, cfg.ranAtBaseline, !scoped),
      ranBefore: cfg.ranAtBaseline,
    });
    save("build.log", build.raw ?? build.report);
    testStack = refineTestStack(testStack, cfg.mod, build.raw ?? "", buildStartedAt);
    sourceEncoding = refineEncoding(sourceEncoding, measureSourceEncoding(cfg.mod, REPO_ROOT, build.raw ?? ""));
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
      // The reviewer reads through the same view: raw MS950 through a UTF-8 tool is mojibake.
      const reviewView = openEncodingView(sourceEncoding, testRoot, { agentFiles: agentSources(testRoot, everWritten) });
      const reviewPrompt = buildReviewPrompt({
        targetClasses: cfg.targetClasses,
        rubric: cfg.rubric,
        mod: cfg.mod,
        sourceEncoding,
        encodingMode: reviewView?.mode,
        targetSources: targetSourceViews(sourceEncoding, cfg.targetClasses),
      });
      save("review-prompt.md", reviewPrompt);

      // A verdict that will not parse is the reviewer malfunctioning, and the writer cannot fix
      // it: no rewrite of the tests makes a model emit valid JSON. Feeding it back as a blocker
      // spends a writer round, produces the identical report next time, and ends in stuck —
      // which is exactly how one reported run burned four rounds and 52 minutes of model time.
      // So the retries land on the reviewer, and an exhausted retry budget ends the run naming
      // the reviewer rather than blaming the tests.
      try {
        for (let attempt = 1; attempt <= 1 + REVIEW_MAX_RETRIES; attempt++) {
          verdict = await runReviewGate(cfg.runner, reviewPrompt);
          save(attempt === 1 ? "verdict.json" : `verdict-attempt-${attempt}.json`, JSON.stringify(verdict, stripRaw, 2));
          if (verdict.raw) save(attempt === 1 ? "review-raw.txt" : `review-raw-${attempt}.txt`, verdict.raw);
          if (!isUnparseable(verdict)) break;
          log(
            `[WARN] reviewer 輸出無法解析（${verdict.parseError}）——第 ${attempt}/${1 + REVIEW_MAX_RETRIES} 次嘗試`,
          );
        }
      } finally {
        if (reviewView) closeEncodingView(reviewView);
      }
      lastVerdict = verdict;
      // A reviewer that cannot run at all is the environment, exactly like a writer that cannot:
      // fed back as a blocker it cost a whole writer round and a build, and came back identical.
      if (verdict?.parseError === REVIEWER_SPAWN_ERROR) {
        record({
          gate: "review",
          outcome: "spawn-error",
          changedFiles: changed.length,
          writerOutputTokens: writer.outputTokens,
        });
        return fail(
          "runner-spawn-error",
          `reviewer 無法執行（spawn-error）。這是環境問題，writer 改測試碼不會改善：${runnerCannotRunHint()}`,
          iter,
        );
      }
      if (verdict && isUnparseable(verdict)) {
        record({
          gate: "review",
          outcome: "reviewer-unparseable",
          changedFiles: changed.length,
          writerOutputTokens: writer.outputTokens,
        });
        return fail(
          "reviewer-unparseable",
          `reviewer 連續 ${1 + REVIEW_MAX_RETRIES} 次輸出無法解析成判決（${verdict.parseError}）。\n` +
            "這是 reviewer 端的問題，不是測試的問題——writer 再怎麼改測試碼都不會讓它吐出合法 JSON，\n" +
            "所以不把它當成 blocker 餵回下一輪。\n" +
            "常見原因：模型把答案放在 reasoning_content、回合或 token 預算用盡、或模型不遵循 JSON schema。\n" +
            `檢查 ${path.join(cfg.runDir, `iter-${iter}`)} 的 review-raw*.txt；` +
            "可調 UT_REVIEW_MAX_RETRIES、UT_API_MAX_TURNS、UT_API_MAX_TOKENS，或換一個 reviewer 模型。",
          iter,
        );
      }
    }

    if (!verdict || verdict.passed) {
      if (verdict) log("[OK] 品質 review gate：PASS");
      // Every gate is satisfied for the target classes. Under a scoped run that is only half
      // the build gate's promise — the other half, "and nothing else broke", needs the module
      // -wide run. Deferring it to here costs one build per run instead of one per round;
      // skipping it would trade the promise away for the same saving.
      if (scoped) {
        log("最終驗收：以完整模組範圍重跑，確認新測試沒有打壞既有測試");
        const full = await runBuildAndTests(cfg.buildTool, cfg.mod, {
          tolerate: cfg.tolerate,
          mustRun: testsThatMustRun(testRoot, everWritten, originalMetrics, cfg.ranAtBaseline, true),
          ranBefore: cfg.ranAtBaseline,
        });
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
  testStack?: TestStack;
  sourceEncoding?: SourceEncoding;
}

export interface RepairResult {
  success: boolean;
  rounds: number;
  // "repaired" | "repair-max-iterations" | "runner-spawn-error" | "writer-no-op" | "stuck"
  // | "scope-violation" | "unlocatable-failure" | "repair-no-progress" | "build-aborted"
  // | "flaky-baseline" (success: the red did not reproduce on a rebuild)
  stopReason: string;
  // Still red when repair gave up; empty on success.
  remaining: PreExistingFailures;
  report: string;
  // Every test file the repair rounds touched — the diff a human should read before committing.
  changedFiles: string[];
  // On success: the test classes the green build ran — what every later round must keep running.
  ranTests?: string[];
}

// A writer-changed path (relative to src/test/java, or resources/…) as a repo-relative path.
function repoRelTest(mod: ModuleInfo, changed: string): string {
  const base = changed.startsWith("resources/") ? path.join(mod.moduleRoot, "src", "test") : path.join(mod.moduleRoot, "src", "test", "java");
  return path.relative(REPO_ROOT, path.join(base, changed)).replace(/\\/g, "/");
}

// The test source a broken item lives in: compile errors name the file, failing tests the class
// (an inner class lives in its outer class's file).
function brokenItemFile(mod: ModuleInfo, item: string): string {
  if (item.endsWith(".java")) return (path.isAbsolute(item) ? path.relative(REPO_ROOT, item) : item).replace(/\\/g, "/");
  return repoRelTest(mod, `${item.replace(/\$.*$/, "").replace(/\./g, "/")}.java`);
}

// Could this round's edits have broken `file` without touching it? Yes when it names a class
// the writer edited (a shared helper, a base class), and always when a test resource was edited:
// resources are reached through profiles, classpath scanning and string paths, not names.
// Unreadable counts as yes — the answer only ever decides whether a round earns progress.
function couldBeBrokenBy(file: string, changed: string[]): boolean {
  if (changed.some((c) => !c.endsWith(".java"))) return true;
  let src: string;
  try {
    src = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
  } catch {
    return true;
  }
  return changed.some((c) => new RegExp(`\\b${path.basename(c, ".java").replace(/[^\w$]/g, "")}\\b`).test(src));
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
  const writableTree = path.join(cfg.mod.moduleRoot, "src", "test");
  const scopeSkip = writerScopeSkip(REPO_ROOT, cfg.mod.moduleRoot, [RUNS_DIR]);
  const snapshotProtected = () => snapshotTree(REPO_ROOT, { skipDir: scopeSkip });
  const originalMetrics = collectTestMetrics(testRoot);
  const touched = new Set<string>();
  let current = cfg.baseline;
  // What ran before the repair — the failing classes included — has to be running when it is green.
  const ranBefore = [...new Set([...(cfg.baseline.ranTests ?? []), ...cfg.baseline.failingTestClasses.map((c) => c.replace(/\$.*$/, ""))])];
  let testStack = cfg.testStack;
  let sourceEncoding = cfg.sourceEncoding;
  const testRootForEncoding = path.join(cfg.mod.moduleRoot, "src", "test", "java");
  let prevFingerprint: string | null = null;

  const brokenList = (b: BaselineResult) => [
    ...b.compileErrorFiles.map((f) =>
      (path.isAbsolute(f) ? path.relative(REPO_ROOT, f) : f).replace(/\\/g, "/"),
    ),
    ...b.failingTestClasses,
  ];
  // Classification plus the error lines: the summary says which files, the extract says why.
  // When runBaseline could name no file its summary already carries the extract, so appending
  // a second copy would spend the feedback budget on the same text twice.
  // The surefire detail leads: clampText keeps the head, and for a failing test the assertion
  // message is the actionable half while the [ERROR] extract is mostly surefire's own summary
  // of it. For a compile error the detail is empty and the extract is everything, so the same
  // order serves both.
  const describe = (b: BaselineResult) =>
    clampText(
      brokenList(b).length === 0 || b.notRun
        ? b.summary
        : `${b.summary}` +
            (b.failureDetail ? `\n失敗明細：${b.failureDetail}` : "") +
            `\n錯誤節錄：\n${summarizeBuildErrors(b.raw)}`,
      MAX_FEEDBACK_CHARS,
    );
  let report = describe(current);
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

  // Progress is measured, not inferred from the report text: a round that fixes one file and
  // breaks another writes a brand-new report every time, so the fingerprint never repeats and
  // the stuck check never fires, while the module is no closer to green than when it started.
  // Seeded from the baseline, so a first round that reduces nothing already counts.
  let prevBrokenCount = brokenList(current).length;
  let prevBroken = brokenList(current);
  let noProgressRounds = 0;
  let prevCompileErrors = current.compileErrorFiles.length > 0;

  for (let round = 1; round <= REPAIR_MAX_ITER; round++) {
    // A red build the classifier could pin to no file at all leaves buildRepairPrompt listing
    // nothing: the writer is handed an empty "需要修復的既有測試" and spends the round reading
    // around for a target it was never given, then no-ops. That is the same "impossible, not
    // slow" case as outOfScope, so it ends the loop here rather than burning the budget — and
    // the message carries the extract, which is the only thing that can actually be acted on.
    if (brokenList(current).length === 0) {
      return giveUp(
        "unlocatable-failure",
        "建置失敗，但無法從輸出定位到任何檔案或測試類別，writer 沒有可下手的目標。\n" +
          "請直接檢視建置 log（baseline.log 或 repair-*/build.log）。\n" +
          report,
        round - 1,
      );
    }
    const dir = path.join(cfg.runDir, `repair-${round}`);
    fs.mkdirSync(dir, { recursive: true });
    const save = (name: string, content: string) =>
      fs.writeFileSync(path.join(dir, name), content);
    banner(`修復既有紅燈 第 ${round}/${REPAIR_MAX_ITER} 輪`);

    const before = snapshotTree(writableTree);
    const protectedBefore = snapshotProtected();
    const encView = openEncodingView(sourceEncoding, testRootForEncoding, { agentFiles: agentSources(testRootForEncoding, touched) });
    const prompt = buildRepairPrompt({
      brokenFiles: brokenList(current),
      report,
      standards: cfg.standards,
      mod: cfg.mod,
      round,
      testStack,
      sourceEncoding,
      encodingMode: encView?.mode,
      lockedFiles: protectedList(encView),
    });
    save("prompt.md", prompt);

    const writer = await cfg.runner.runWriter(prompt);
    const encodingReport = encodingViewAfter(encView, save);
    const rawChanged = diffSnapshots(before, snapshotTree(writableTree));
    save("writer-summary.md", writer.text || "（writer 未回傳文字）");
    log(`[writer 總結] ${tail(writer.text, 1500)}`);
    if (writer.status === "spawn-error") {
      return giveUp(
        "runner-spawn-error",
        `writer 無法執行（spawn-error）。這是環境問題，重試不會改善：${runnerCannotRunHint()}`,
        round,
      );
    }

    const changed = writerChanges(rawChanged);
    const outOfScope = outOfScopeChanges(protectedBefore, snapshotProtected());
    changed.forEach((f) => touched.add(f));
    save("changed-files.txt", changed.length ? changed.join("\n") : "（本輪未變更任何測試檔）");
    log(`writer 變更了 ${changed.length} 個測試檔`);
    if (outOfScope.length) {
      save("scope-violations.txt", outOfScope.join("\n"));
      return giveUp(
        "scope-violation",
        `修復輪 writer 修改了測試範圍以外的檔案：\n${listViolations(outOfScope)}\n` +
          "這些變更「未被還原」——請以 git diff 檢視並自行還原後重跑。",
        round,
      );
    }
    if (encodingReport) {
      // The build did not run: its last report still stands, and goes along.
      report = clampText(`${encodingReport}\n\n上一次建置的失敗報告（仍待處理）：\n${describe(current)}`, MAX_FEEDBACK_CHARS);
      save("feedback.md", report);
      const fingerprint = feedbackFingerprint(report);
      if (prevFingerprint === fingerprint) {
        return giveUp("stuck", `連續兩輪得到相同的編碼問題，判定迴圈卡住。\n${report}`, round);
      }
      prevFingerprint = fingerprint;
      continue;
    }
    if (changed.length === 0) {
      // A writer that looked and found nothing to fix may be right: a test that failed once at the
      // baseline and passes on a rerun is flaky, not red. When nothing but tests failed, one more
      // build tells the two apart before the run is ended over a failure that is not there. (A
      // real LLM facing a flaky test is more likely to "fix" it with a retry or a looser assertion,
      // which the shrink guard and the reviewer see; this covers the writer that declined.)
      if (writer.status === "ok" && current.compileErrorFiles.length === 0 && current.failingTestClasses.length > 0) {
        log("writer 沒有改任何檔案——重跑一次建置，確認紅燈是否穩定重現（flaky 測試會在這裡消失）");
        const recheck = await runBaseline(cfg.buildTool, cfg.mod, "repair");
        save("recheck-build.log", recheck.raw);
        if (recheck.clean) {
          log(`[WARN] 預檢的紅燈重跑後消失，判定為不穩定的測試（flaky）：${current.failingTestClasses.join("、")}——這些測試需要人檢視`);
          return {
            success: true,
            rounds: round,
            stopReason: "flaky-baseline",
            remaining: { compileErrorFiles: [], failingTestClasses: [] },
            report: `預檢時失敗、重跑後通過的測試（flaky）：${current.failingTestClasses.join("、")}`,
            changedFiles: [...touched].sort(),
            ranTests: recheck.ranTests,
          };
        }
      }
      return giveUp("writer-no-op", noOpReason(writer.status, testRootRel(cfg.mod), true), round);
    }

    const shrunk = findShrunk(originalMetrics, collectTestMetrics(testRoot));
    if (shrunk.length) {
      const shrinkReport = renderShrinkFeedback(shrunk);
      save("test-shrink.txt", shrinkReport);
      if (!ALLOW_TEST_SHRINK) {
        log(`[FAIL] 修復輪刪減了既有測試（${shrunk.length} 檔）——本輪判 FAIL，不進建置`);
        report = clampText(`${shrinkReport}\n\n上一次建置的失敗報告（仍待處理）：\n${describe(current)}`, MAX_FEEDBACK_CHARS);
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

    const rebuildStartedAt = Date.now();
    current = await runBaseline(
      cfg.buildTool,
      cfg.mod,
      "repair",
      testsThatMustRun(testRoot, touched, originalMetrics, ranBefore, true),
      ranBefore,
    );
    save("build.log", current.raw);
    testStack = refineTestStack(testStack, cfg.mod, current.raw, rebuildStartedAt);
    sourceEncoding = refineEncoding(sourceEncoding, measureSourceEncoding(cfg.mod, REPO_ROOT, current.raw));
    save("build-summary.md", current.summary);
    console.log(current.summary);
    // A build that never finished locates nothing; carried on, it became "unlocatable" next round.
    if (current.aborted) return giveUp("build-aborted", `修復後的建置沒有跑完：${current.aborted}`, round);
    if (current.clean) {
      return {
        success: true,
        rounds: round,
        stopReason: "repaired",
        remaining: { compileErrorFiles: [], failingTestClasses: [] },
        report: current.summary,
        changedFiles: [...touched].sort(),
        ranTests: current.ranTests,
      };
    }
    report = describe(current);
    save("feedback.md", report);
    const fingerprint = feedbackFingerprint(report);
    if (prevFingerprint === fingerprint) {
      return giveUp("stuck", `連續兩輪修復後得到相同的紅燈，判定迴圈卡住。\n${report}`, round);
    }
    prevFingerprint = fingerprint;

    // Progress is fewer red items — or, with the count unchanged or higher, a round that fixed
    // something while the previous build had compile errors, and whose newly red items the edits
    // cannot have caused. Compile errors are the only thing that hides red: javac reports flow
    // errors only once attribution succeeds, tests fail only once the module compiles. Counting
    // that as "no progress" aborted repairs one round from green. "Fixed A by breaking B" is
    // still no progress — B edited this round, or B using a helper or base class edited this
    // round, or any test resource edited: that is the thrash this cut-off exists for.
    const curItems = brokenList(current);
    const brokenCount = curItems.length;
    const editedNow = new Set(changed.map((c) => repoRelTest(cfg.mod, c)));
    const fixedSome = prevBroken.some((b) => !curItems.includes(b));
    const newlyBroken = curItems.filter((b) => !prevBroken.includes(b));
    const revealedOnly =
      prevCompileErrors &&
      fixedSome &&
      newlyBroken.every((b) => {
        const file = brokenItemFile(cfg.mod, b);
        return !editedNow.has(file) && !couldBeBrokenBy(file, changed);
      });
    prevCompileErrors = current.compileErrorFiles.length > 0;
    noProgressRounds = brokenCount >= prevBrokenCount && !revealedOnly ? noProgressRounds + 1 : 0;
    prevBrokenCount = brokenCount;
    prevBroken = curItems;
    if (noProgressRounds >= REPAIR_NO_PROGRESS_ROUNDS) {
      return giveUp(
        "repair-no-progress",
        `連續 ${noProgressRounds} 輪紅燈數沒有下降（仍有 ${brokenCount} 項），判定修不動。\n` +
          `（可用 UT_REPAIR_NO_PROGRESS_ROUNDS 調整容忍輪數）\n${report}`,
        round,
      );
    }
    if (brokenCount > 0) log(`→ 仍有 ${brokenCount} 項紅燈，帶著報告進入下一輪修復`);
  }
  return giveUp(
    "repair-max-iterations",
    `修復 ${REPAIR_MAX_ITER} 輪後模組仍是紅的。\n${report}`,
    REPAIR_MAX_ITER,
  );
}
