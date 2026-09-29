// Selftest: pure-logic checks, no opencode / mvn / LLM.
// Covers: module detection, test-path derivation, JaCoCo parsing (incl. the "first counter"
// regression), verdict fail-closed (0-10 + deterministic weighted/grade), the rubric
// loader (references/rubric.md first, never injects SKILL.md), and Windows spawn planning
// (asserted with an explicit platform, so it runs identically on Linux/macOS/Windows).
// Run: npx tsx scripts/selftest.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findModuleInfo,
  listJavaClasses,
  expectedTestPath,
  skillDirCandidates,
  runsDirFor,
  snapshotTree,
  diffSnapshots,
  matchesTestNaming,
  findExistingTests,
  clampText,
  feedbackFingerprint,
  writerScopeSkip,
  testClassNames,
  stripAnsi,
  codelessTypeReason,
  splitForeignChanges,
  portablePathOrder,
} from "../libs/utils";
import {
  resolveAgentPath,
  contractViolations,
  parseToolsBlock,
  WRITER_RULES,
  REVIEWER_RULES,
} from "../libs/guard";
import { parseJacocoReport, toRanges, missedLines, reportIsStale } from "../gates/coverage";
import { parseVerdict, runReviewGate, jsonObjectCandidates } from "../gates/review";
import {
  buildFixPrompt,
  buildGeneratePrompt,
  buildRepairPrompt,
  renderExistingTests,
  renderPreExisting,
  renderConventions,
  renderShrinkFeedback,
  renderTestStack,
  frameworkOf,
  renderSourceEncoding,
  renderReviewEncoding,
} from "../prompts";
import { testMetrics, findShrunk, collectTestMetrics, runnableTests } from "../libs/testmetrics";
import {
  entryMismatch,
  findPass,
  hashFile,
  LEDGER_FILE,
  ledgerEntry,
  passedEntries,
  PassedEntry,
  readLedgers,
  MAX_REFERENCED_CLASSES,
  MAX_REFERENCED_RESOURCES,
  referencedTestFiles,
  resourcesNamed,
  safeLedgerPath,
  springLoaded,
  declaredTypes,
  stringLiterals,
  sha256,
  testClassOf,
  voidEntry,
  writeLedger,
} from "../libs/resume";
import {
  countTestsRun,
  detectEnvFailures,
  failingTestIds,
  subtractTolerated,
  SurefireSuite,
  extractCompileErrorFiles,
  parseSurefireXml,
  renderSurefireSuite,
  summarizeBuildErrors,
  surefireHasFailure,
  suiteRecordsFailure,
} from "../gates/build";
import { classVisibility, isClassRefSuite, scanTestConventions } from "../libs/conventions";
import { loadRubric } from "../libs/rubric";
import { isUnparseable, zeroToolCallVerdict, spawnErrorVerdict } from "../gates/review";
import { ScoreThresholds } from "../config";
import { AgentRunner } from "../libs/types";
import { traceEvent, buildInvocation, OpencodeRunner } from "../runners/opencode";
import {
  ApiRunner,
  classifyHttpFailure,
  compactHistory,
  looksLikeToolCallText,
  completionFromSse,
  normalizeToolName,
  textOf,
  unusableCompletion,
  parseContextOverflow,
  retryAfterMs,
} from "../runners/api";
import { runnerCannotRunHint } from "../orchestrator";
import { execTool, resolveInside, toOpenAiTools, toolsFor } from "../runners/api-tools";
import { acquireRepoLock, holderAlive, repoLockFile } from "../libs/lock";
import {
  batchFailureFingerprint,
  captureOutputs,
  captureTree,
  chunk,
  BatchJournal,
  closeJournal,
  decideRecovery,
  dirIdentity,
  findJournals,
  isJournal,
  JOURNAL_DIR,
  journalCapture,
  journalOutputs,
  killedWriterChanges,
  mayBeRunning,
  movesAfterDeath,
  openJournal,
  provenSameDirectory,
  readDecision,
  removeBatchOutputs,
  rollbackTree,
  sameBoot,
  sameDirectory,
  samePids,
  testOutputDirs,
  thisHost,
  traceJournal,
  TreeCapture,
  waitWhileBusy,
  writeDecision,
} from "../libs/batch";
import {
  closeEncodingView,
  escapeNonAscii,
  findJdk,
  finishOpenViews,
  gradleDaemonEncoding,
  gradleEncoding,
  isUtf8Name,
  jdkCheckCharset,
  recoverEncodingViews,
  sourceViews,
  jdkDecode,
  jdkEncode,
  measureSourceEncoding,
  mergeEdited,
  openEncodingView,
  platformEncodingFromLog,
  refineSourceEncoding,
  resetJdkForTests,
  restoreOpenViews,
  sourceEncodingFrom,
  unescapeNonAscii,
} from "../libs/encoding";
import {
  canMockStatic,
  classpathFromSurefireXml,
  javaReleaseFromLog,
  jupiterRuns,
  measureTestStack,
  mergeTestStack,
  pomFactsFromChain,
  stackFromClasspath,
  stackFromPom,
  surefireResolvesEngine,
  surefireVersionFromLog,
  surefireProviderFromLog,
} from "../libs/teststack";
import { codeOnly, declarationOnlyLines, decodeJavaSource, decodeUnicodeEscapes, javaStringValue } from "../libs/javasrc";
import {
  planSpawn,
  resolveWindowsCommand,
  findOnPath,
  explainSpawnError,
  planKill,
  killTree,
  shLive,
  assembleCapture,
  DETACH_CHILDREN,
  groupAlive,
  groupMembers,
  journalChildren,
  orphanAction,
  parseStat,
  processStart,
  startMsOf,
  trackForShutdown,
} from "../libs/shell";
import { runnerConfigProblems } from "../runners/runner";
import {
  appendingJacocoExecFiles,
  ownedExecFiles,
  checkTestsRan,
  ranTestClasses,
  targetModuleSkipped,
  mavenRedDespiteExit0,
  gradleRedDespiteExit0,
  gradleTestTaskRan,
  testsSkippedInLog,
  classesRunInLog,
  classesRunInModuleLog,
  flakyClassesInLog,
  flakyClassesInReport,
  flakyTestClasses,
  lossyFileNameOf,
  outerClassName,
  testCountsInLog,
  testOnlyFailures,
  reportContents,
  surefireSections,
  classifyEnvFailures,
  crashedTestClasses,
  expectedTestOf,
  includedByDefault,
  isSurefireSummary,
  readSurefireXml,
  renderRanCheck,
  testFrameworkOf,
  unfinishedTestClasses,
} from "../gates/build";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { envKnobsInSource, TESTGEN_ROOT } from "./itest-lib";
import { bypassesProxy, redactProxy } from "../libs/proxy";
import { bundleFrom, caSummary, load, sourcePaths } from "../libs/tls";

let passCount = 0;
let failCount = 0;
// Repeated at the end: some checks print tens of thousands of lines of build output, and a CI log
// viewer that shows only the tail would otherwise never show which check failed.
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passCount++;
    console.log(`  [OK] ${name}`);
  } else {
    failCount++;
    const line = `  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`;
    failures.push(line);
    console.log(line);
  }
}

// ---------------------------------------------------------------------------
// 1. module detection / file walk / test-path derivation
// ---------------------------------------------------------------------------
console.log("\n[1] findModuleInfo / listJavaClasses / expectedTestPath");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-"));
  const repo = path.join(tmp, "repo");
  const pkgDir = path.join(repo, "modA", "src", "main", "java", "com", "x");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(repo, "pom.xml"), "<project/>");
  fs.writeFileSync(path.join(repo, "modA", "pom.xml"), "<project/>");
  fs.writeFileSync(path.join(pkgDir, "Foo.java"), "class Foo {}");
  fs.writeFileSync(path.join(pkgDir, "package-info.java"), "");

  const mod = findModuleInfo(pkgDir, repo);
  check("多模組：moduleRel = modA", mod.moduleRel === "modA", `got ${mod.moduleRel}`);
  check("多模組：multiModule = true", mod.multiModule === true);
  check("多模組：moduleRoot 絕對路徑正確", mod.moduleRoot === path.join(repo, "modA"));

  const classes = listJavaClasses(pkgDir, repo);
  check(
    "listJavaClasses：只列 Foo.java（排除 package-info）",
    classes.length === 1 &&
      classes[0].replace(/\\/g, "/") === "modA/src/main/java/com/x/Foo.java",
    JSON.stringify(classes),
  );

  check(
    "expectedTestPath：main→test + Foo→FooTest",
    expectedTestPath("modA/src/main/java/com/x/Foo.java") ===
      "modA/src/test/java/com/x/FooTest.java",
  );

  const repo2 = path.join(tmp, "repo2");
  const src2 = path.join(repo2, "src", "main", "java", "com", "y");
  fs.mkdirSync(src2, { recursive: true });
  fs.writeFileSync(path.join(repo2, "pom.xml"), "<project/>");
  fs.writeFileSync(path.join(src2, "Bar.java"), "class Bar {}");
  const mod2 = findModuleInfo(src2, repo2);
  check("單一模組：moduleRel 為空", mod2.moduleRel === "" && !mod2.multiModule);
  check("單一模組：moduleRoot = repoRoot", mod2.moduleRoot === repo2);
}

// ---------------------------------------------------------------------------
// 2. JaCoCo parsing
// ---------------------------------------------------------------------------
console.log("\n[2] parseJacocoReport");
{
  const MIN = { line: 80, branch: 70 };
  const cls = ["modA/src/main/java/com/x/Foo.java"];

  const fullXml =
    `<report><package name="com/x">` +
    `<class name="com/x/Foo" sourcefilename="Foo.java">` +
    `<method name="a" desc="()V"><counter type="LINE" missed="5" covered="1"/></method>` +
    `<counter type="LINE" missed="1" covered="9"/>` +
    `<counter type="BRANCH" missed="2" covered="8"/>` +
    `</class>` +
    `<sourcefile name="Foo.java">` +
    `<counter type="LINE" missed="1" covered="9"/>` +
    `<counter type="BRANCH" missed="2" covered="8"/>` +
    `</sourcefile>` +
    `</package></report>`;
  const r1 = parseJacocoReport(fullXml, cls, MIN);
  check("sourcefile 彙總優先：90/80 通過 80/70 門檻", r1.passed === true, r1.lines.join(" | "));

  const noSourcefileXml =
    `<report><package name="com/x">` +
    `<class name="com/x/Foo" sourcefilename="Foo.java">` +
    `<method name="a" desc="()V"><counter type="LINE" missed="5" covered="1"/></method>` +
    `<counter type="LINE" missed="1" covered="9"/>` +
    `<counter type="BRANCH" missed="2" covered="8"/>` +
    `</class>` +
    `</package></report>`;
  const r2 = parseJacocoReport(noSourcefileXml, cls, MIN);
  check(
    "regression：class block 取「最後一個」counter（原版取第一個會誤判）",
    r2.passed === true,
    r2.lines.join(" | "),
  );

  const r3 = parseJacocoReport(fullXml, cls, { line: 95, branch: 70 });
  check("門檻 95 → FAIL", r3.passed === false);

  const r4 = parseJacocoReport(fullXml, ["modA/src/main/java/com/x/Bar.java"], MIN);
  check(
    "找不到類別 → FAIL 且訊息標明",
    r4.passed === false && r4.lines[0].includes("找不到"),
    r4.lines.join(" | "),
  );
}

// ---------------------------------------------------------------------------
// 3. Verdict (0-10 + deterministic weighted/grade + fail-closed)
// ---------------------------------------------------------------------------
console.log("\n[3] parseVerdict（0-10 + weighted/grade + fail-closed）");
{
  const TH: ScoreThresholds = {
    effectiveness: 7,
    coverage: 7,
    independence: 7,
    readability: 6,
    fast_reliable: 7,
    mock_appropriateness: 6,
  };
  const good =
    '{"scores":{"effectiveness":9,"coverage":8,"independence":9,"readability":8,' +
    '"fast_reliable":9,"mock_appropriateness":8},"blockers":[],"advisories":["可再精簡 helper"]}';

  const v1 = parseVerdict(good, TH);
  // 9*.25+8*.2+9*.15+8*.15+9*.15+8*.10 = 8.55 -> x10 = 85.5 -> A
  check("合法 JSON 且全達門檻 → passed", v1.passed === true && v1.advisories.length === 1);
  check(
    "weighted_score 確定性計算 = 85.5",
    v1.weightedScore === 85.5,
    `got ${v1.weightedScore}`,
  );
  check('grade band：85.5 → "A"', v1.grade === "A", `got ${v1.grade}`);

  const all7 = good.replace(/:9|:8/g, ":7");
  const v1b = parseVerdict(all7, TH);
  check(
    "全 7 分 → weighted 70 → B 且通過（門檻 7/7/7/6/7/6）",
    v1b.passed === true && v1b.weightedScore === 70 && v1b.grade === "B",
    `got ${v1b.weightedScore}/${v1b.grade}`,
  );

  const v2 = parseVerdict(
    good.replace('"blockers":[]', '"blockers":["FooTest.foo_x 無意義斷言"]'),
    TH,
  );
  check("blockers 非空 → 不通過（grade 再高也一樣）", v2.passed === false && v2.grade === "A");

  const v3 = parseVerdict(good.replace('"coverage":8', '"coverage":6'), TH);
  check(
    "coverage 6 < 門檻 7 → belowThreshold",
    v3.passed === false &&
      v3.belowThreshold.length === 1 &&
      v3.belowThreshold[0].includes("coverage"),
  );

  const v4 = parseVerdict("這不是 JSON，只是一段文字", TH);
  check("垃圾輸出 → fail-closed（parseError）", v4.passed === false && !!v4.parseError);

  const v5 = parseVerdict("好的，以下是審查結果：\n```json\n" + good + "\n```\n以上。", TH);
  check("含前言 + markdown 圍欄 → 仍可解析", v5.passed === true);

  const v6 = parseVerdict(good.replace('"readability":8,', ""), TH);
  check("缺維度 → fail-closed", v6.passed === false && !!v6.parseError);

  const v7 = parseVerdict(good.replace('"coverage":8', '"coverage":11'), TH);
  check("分數超出 0-10 → fail-closed", v7.passed === false && !!v7.parseError);

  const v7b = parseVerdict(good.replace('"coverage":8', '"coverage":7.5'), TH);
  check("非整數分數 → fail-closed", v7b.passed === false && !!v7b.parseError);

  const v8 = parseVerdict(good.replace('["可再精簡 helper"]', '["a","b","c","d","e"]'), TH);
  check("advisories 再多也不擋關", v8.passed === true && v8.advisories.length === 5);
}

// ---------------------------------------------------------------------------
// 4. Rubric loader (references/rubric.md first; never injects SKILL.md)
// ---------------------------------------------------------------------------
console.log("\n[4] loadRubric");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-rubric-"));

  const skillA = path.join(tmp, "skillA");
  fs.mkdirSync(path.join(skillA, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillA, "SKILL.md"), "WORKFLOW-DOC-SHOULD-NOT-BE-INJECTED");
  fs.writeFileSync(path.join(skillA, "references", "rubric.md"), "RUBRIC-CONTENT-A");
  const a = loadRubric([skillA]);
  check(
    "references/rubric.md 被載入",
    a.rubric === "RUBRIC-CONTENT-A" && a.source.includes("references"),
    a.source,
  );
  check("SKILL.md 全文絕不注入", !a.rubric.includes("WORKFLOW-DOC"), a.rubric.slice(0, 50));

  const skillB = path.join(tmp, "skillB", "rubric");
  fs.mkdirSync(skillB, { recursive: true });
  fs.writeFileSync(path.join(skillB, "a.md"), "PART-A");
  fs.writeFileSync(path.join(skillB, "b.md"), "PART-B");
  const b = loadRubric([path.join(tmp, "skillB")]);
  check("rubric/*.md fallback：多檔合併且排序", b.rubric === "PART-A\n\n---\n\nPART-B");

  const c = loadRubric([path.join(tmp, "nonexistent"), skillA]);
  check("候選順序：跳過不存在的目錄", c.rubric === "RUBRIC-CONTENT-A");

  const onlySkillMd = path.join(tmp, "skillC");
  fs.mkdirSync(onlySkillMd, { recursive: true });
  fs.writeFileSync(path.join(onlySkillMd, "SKILL.md"), "ONLY-SKILL-MD");
  const d = loadRubric([onlySkillMd]);
  check("只有 SKILL.md 的目錄 → 視為無 rubric（觸發 standards fallback）", d.rubric === "");
}

// ---------------------------------------------------------------------------
// 5. opencode JSONL event parsing (regression: trust the hyphenated part.type)
//    (the [t] event echoes in this block are expected noise)
// ---------------------------------------------------------------------------
console.log("\n[5] traceEvent（opencode --format json 事件解析）");
{
  const verdictJson =
    '{"scores":{"effectiveness":8,"coverage":7,"independence":9,"readability":8,' +
    '"fast_reliable":9,"mock_appropriateness":7},"blockers":[],"advisories":[]}';

  // (a) observed structure: ev.type is unreliable, the real type is in part.type (hyphenated)
  const acc1 = { text: "", lastText: "" };
  const realEvents = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", part: { type: "text", text: "\n\n" } }),
    JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "glob", state: { status: "completed", input: { pattern: "x" }, output: "No files found" } },
    }),
    JSON.stringify({ type: "text", part: { type: "text", text: verdictJson } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { output: 65 } } }),
  ];
  for (const e of realEvents) traceEvent(e, "[t]", acc1);
  check("連字號 part.type：text 正確累積", acc1.text.includes('"effectiveness":8'));
  check("lastText 保險：最後一個 text part 為完整 JSON", acc1.lastText === verdictJson);
  check("tool 事件不污染 text 累積", !acc1.text.includes("No files found"));

  // (b) fall back to ev.type when part.type is missing
  const acc2 = { text: "", lastText: "" };
  traceEvent(JSON.stringify({ type: "text", part: { text: "FALLBACK" } }), "[t]", acc2);
  check("part.type 缺漏 → 退回 ev.type", acc2.text === "FALLBACK");

  // (c) underscore type compatibility
  const acc3 = { text: "", lastText: "" };
  traceEvent(JSON.stringify({ type: "x", part: { type: "step_start" } }), "[t]", acc3);
  check("底線 step_start 相容不 crash 且不累積", acc3.text === "");

  // (d) non-JSON lines are silently skipped
  const acc4 = { text: "", lastText: "" };
  traceEvent("not-json-noise", "[t]", acc4);
  check("非 JSON 行略過", acc4.text === "");

  // (e) completed tool calls counted + deduped by callID when acc.toolCalls provided
  const acc5 = { text: "", lastText: "", toolCalls: new Set<string>() };
  const toolEv = (callID: string, status: string) =>
    JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "read", callID, state: { status, input: {} } },
    });
  traceEvent(toolEv("c1", "running"), "[t]", acc5);
  traceEvent(toolEv("c1", "completed"), "[t]", acc5);
  traceEvent(toolEv("c1", "completed"), "[t]", acc5);
  traceEvent(toolEv("c2", "completed"), "[t]", acc5);
  check("tool 計數：只算 completed、callID 去重 = 2", acc5.toolCalls.size === 2);
}

// ---------------------------------------------------------------------------
// 6. central-clone resolution (agent repo->global, skill candidates, runs namespace)
// ---------------------------------------------------------------------------
console.log("\n[6] resolveAgentPath / contractViolations / skillDirCandidates / runsDirFor");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-central-"));
  const repo = path.join(tmp, "repo");
  const globalDir = path.join(tmp, "global-opencode");
  fs.mkdirSync(path.join(repo, ".opencode", "agent"), { recursive: true });
  fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
  const writerFm =
    "---\ntools:\n  write: true\n  edit: true\n  bash: false\n  webfetch: false\n  task: false\n---\nbody";
  fs.writeFileSync(path.join(repo, ".opencode", "agent", "ut-writer.md"), writerFm);
  fs.writeFileSync(path.join(globalDir, "agent", "ut-writer.md"), writerFm);
  fs.writeFileSync(
    path.join(globalDir, "agent", "ut-reviewer.md"),
    "---\ntools:\n  write: false\n  edit: false\n  bash: false\n---\nbody",
  );

  const both = resolveAgentPath("ut-writer", repo, globalDir);
  check("repo-local agent 優先於 global", both?.source === "repo" && !!both?.path.startsWith(repo));
  const globalOnly = resolveAgentPath("ut-reviewer", repo, globalDir);
  check("repo 無此 agent → global fallback", globalOnly?.source === "global");
  check("兩處皆無 → null", resolveAgentPath("nope", repo, globalDir) === null);

  check(
    "writer 契約合規 → 無違規",
    contractViolations(path.join(globalDir, "agent", "ut-writer.md"), WRITER_RULES).length === 0,
  );
  const badWriter = path.join(tmp, "bad-writer.md");
  fs.writeFileSync(
    badWriter,
    "---\ntools:\n  write: true\n  edit: true\n  bash: true\n  webfetch: false\n  task: false\n---\n",
  );
  const errs = contractViolations(badWriter, WRITER_RULES);
  check("writer 拿到 bash → 違規", errs.length === 1 && errs[0].includes("bash"));
  const taskOpen = path.join(tmp, "task-writer.md");
  fs.writeFileSync(taskOpen, "---\ntools:\n  write: true\n  edit: true\n  bash: false\n  webfetch: false\n---\n");
  const taskErrs = contractViolations(taskOpen, WRITER_RULES);
  check(
    "writer 沒有關掉 task → 違規（subagent 拿得到 bash，等於繞過 bash: false）",
    taskErrs.length === 1 && taskErrs[0].includes("tools.task"),
    JSON.stringify(taskErrs),
  );
  const reviewerTask = path.join(tmp, "task-reviewer.md");
  fs.writeFileSync(reviewerTask, "---\ntools:\n  write: false\n  edit: false\n  bash: false\n  webfetch: false\n  task: true\n---\n");
  check("reviewer 開著 task → 違規（subagent 可寫檔，不是唯讀）", contractViolations(reviewerTask, REVIEWER_RULES).some((e) => e.includes("tools.task")));

  const cands = skillDirCandidates("/repo", "/tool", undefined);
  check(
    "skill 候選順序：repo .opencode → repo .claude → 工具內建",
    cands.length === 3 &&
      cands[0] === path.join("/repo", ".opencode", "skills", "test-quality-evaluator") &&
      cands[1] === path.join("/repo", ".claude", "skills", "test-quality-evaluator") &&
      cands[2] === path.join("/tool", ".opencode", "skills", "test-quality-evaluator"),
    JSON.stringify(cands),
  );
  const withEnv = skillDirCandidates("/repo", "/tool", "/env/dir");
  check("UT_SKILL_DIR 排最前", withEnv.length === 4 && withEnv[0] === "/env/dir");

  check(
    "runsDirFor：runs/<repo basename>",
    runsDirFor("/tool", "/w/myrepo") === path.join("/tool", "runs", "myrepo"),
  );
}

// ---------------------------------------------------------------------------
// 7. build gate zero-test detection (maven stdout parsing)
// ---------------------------------------------------------------------------
console.log("\n[7] countTestsRun（0 測試 fail-closed）");
{
  const success =
    "[INFO] Running com.example.FooTest\n" +
    "[INFO] Tests run: 16, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.042 s -- in FooTest\n" +
    "[INFO] Results:\n" +
    "[INFO] Tests run: 46, Failures: 0, Errors: 0, Skipped: 0\n" +
    "[INFO] BUILD SUCCESS";
  check("取最後一個 Tests run（Results 彙總）= 46", countTestsRun(success) === 46);
  check(
    "無任何 Tests run 行（No tests to run）→ null",
    countTestsRun("[INFO] No tests to run.\n[INFO] BUILD SUCCESS") === null,
  );
  check("Tests run: 0 → 0", countTestsRun("[INFO] Tests run: 0, Failures: 0") === 0);
}

// ---------------------------------------------------------------------------
// 8. review gate: reviewer must-read guard (0 tool calls -> fail-closed)
// ---------------------------------------------------------------------------
console.log("\n[8] runReviewGate（reviewer 0 tool call → fail-closed）");
{
  const goodVerdict =
    '{"scores":{"effectiveness":9,"coverage":8,"independence":9,"readability":8,' +
    '"fast_reliable":9,"mock_appropriateness":8},"blockers":[],"advisories":[]}';
  const fake = (toolCallCount?: number): AgentRunner => ({
    runWriter: async () => ({ text: "", status: "ok" as const }),
    runReview: async () => ({ text: goodVerdict, status: "ok" as const, toolCallCount }),
  });

  const z = await runReviewGate(fake(0), "p");
  check(
    "0 tool calls → REJECT（即使 verdict JSON 合法高分）",
    z.passed === false && z.blockers[0].includes("未呼叫任何工具"),
  );
  const ok = await runReviewGate(fake(5), "p");
  check("有 tool calls → 正常解析並通過", ok.passed === true);
  const unknown = await runReviewGate(fake(undefined), "p");
  check("無法觀測（undefined）→ 不觸發 guard", unknown.passed === true);

  // spawn-error must be diagnosed as an environment problem, not model misbehaviour
  const broken: AgentRunner = {
    runWriter: async () => ({ text: "", status: "spawn-error" as const }),
    runReview: async () => ({ text: "", status: "spawn-error" as const }),
  };
  const se = await runReviewGate(broken, "p");
  check(
    "spawn-error → REJECT 且訊息指向環境而非模型",
    se.passed === false && se.blockers[0].includes("環境問題"),
    se.blockers[0] ?? "",
  );
}

// ---------------------------------------------------------------------------
// 9. Windows spawn planning (the three failures behind "spawn opencode failed")
// ---------------------------------------------------------------------------
console.log("\n[9] planSpawn / resolveWindowsCommand / buildInvocation（Windows spawn）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-win-"));
  const shim = path.join(tmp, "opencode.cmd");
  fs.writeFileSync(shim, "@echo off");
  fs.writeFileSync(path.join(tmp, "opencode"), "#!/bin/sh"); // the extensionless bash shim npm also drops
  const env = { PATH: tmp, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;

  // ENOENT: a bare name only resolves if PATHEXT is applied — Node's spawn does not.
  check(
    "resolveWindowsCommand：裸名 opencode → opencode.cmd（不是無副檔名的 bash shim）",
    resolveWindowsCommand("opencode", env) === shim,
    String(resolveWindowsCommand("opencode", env)),
  );
  check(
    "resolveWindowsCommand：不存在的指令 → undefined",
    resolveWindowsCommand("definitely-not-installed", env) === undefined,
  );

  // findOnPath: the same answer as the spawn, without the spawn (runnerConfigProblems asks it before the
  // baseline build whether the opencode CLI is there at all).
  check(
    "findOnPath（win32）：照 PATHEXT 找，跟 planSpawn 一樣找到 .cmd",
    findOnPath("opencode", env, "win32") === shim,
    String(findOnPath("opencode", env, "win32")),
  );
  {
    // What libuv finds when planSpawn falls back to the bare name: a quoted PATH entry, the current
    // directory's .exe. A preflight that refuses those refuses a run that would have started.
    const exeDir = path.join(tmp, "with space");
    fs.mkdirSync(exeDir, { recursive: true });
    fs.writeFileSync(path.join(exeDir, "oc.exe"), "MZ");
    const cwdDir = path.join(tmp, "cwd");
    fs.mkdirSync(cwdDir, { recursive: true });
    fs.writeFileSync(path.join(cwdDir, "local.exe"), "MZ");
    const quoted = { PATH: `${path.join(tmp, "nope")};"${exeDir}"`, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
    check(
      "findOnPath（win32）：PATH 裡加了引號的目錄照找；目前目錄的 .exe 也算（libuv 先找那裡）；哪裡都沒有 → undefined",
      findOnPath("oc", quoted, "win32", cwdDir) === path.join(exeDir, "oc.exe") &&
        findOnPath("local", quoted, "win32", cwdDir) === path.join(cwdDir, "local.exe") &&
        findOnPath("nowhere", quoted, "win32", cwdDir) === undefined,
      String(findOnPath("oc", quoted, "win32", cwdDir)),
    );
  }
  if (process.platform !== "win32") {
    const bin = path.join(tmp, "posix-bin");
    fs.mkdirSync(path.join(bin, "dir-named-oc"), { recursive: true });
    fs.writeFileSync(path.join(bin, "oc"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "not-exec"), "#!/bin/sh\n", { mode: 0o644 });
    const penv = { PATH: `${path.join(tmp, "missing")}:${bin}` } as NodeJS.ProcessEnv;
    check(
      "findOnPath（POSIX）：PATH 上第一個可執行檔；沒有執行權限的檔、目錄、不存在的都不算；路徑照原樣檢查",
      findOnPath("oc", penv, "linux") === path.join(bin, "oc") &&
        findOnPath("not-exec", penv, "linux") === undefined &&
        findOnPath("dir-named-oc", penv, "linux") === undefined &&
        findOnPath("nope", penv, "linux") === undefined &&
        findOnPath(path.join(bin, "oc"), { PATH: "" } as NodeJS.ProcessEnv, "linux") === path.join(bin, "oc") &&
        findOnPath(path.join(bin, "not-exec"), penv, "linux") === undefined,
    );
    check(
      "findOnPath（POSIX）：沒有 PATH → 不猜（exec 會用看不到的預設路徑），回傳原名",
      findOnPath("oc", {} as NodeJS.ProcessEnv, "linux") === "oc",
    );
  }

  // Non-Windows must stay byte-identical to the old behaviour.
  const posix = planSpawn("opencode", ["run", "--agent", "ut-writer", "hi"], "linux");
  check(
    "planSpawn（linux）：原樣傳遞，不繞 shell",
    posix.file === "opencode" &&
      posix.args.length === 4 &&
      posix.windowsVerbatimArguments === undefined &&
      posix.error === undefined,
  );

  // EINVAL: a .cmd must be routed through cmd.exe, never spawned directly.
  const win = planSpawn(shim, ["run", "hi"], "win32");
  check(
    "planSpawn（win32 + .cmd）：改由 cmd.exe /d /s /c 執行",
    /cmd\.exe$/i.test(win.file) &&
      win.args[0] === "/d" &&
      win.args[1] === "/s" &&
      win.args[2] === "/c" &&
      win.windowsVerbatimArguments === true,
    `${win.file} ${JSON.stringify(win.args.slice(0, 3))}`,
  );
  check("planSpawn（win32 + .cmd）：命令列未超限時無 error", win.error === undefined);

  // E2BIG: 8191 through cmd.exe. The runner no longer puts a prompt on the command line, so
  // this is a backstop for other callers — it must still report the limit, not throw an errno.
  const huge = planSpawn(shim, ["run", "x".repeat(9000)], "win32");
  check(
    "planSpawn（win32 + .cmd + 超長引數）：回報 8191 上限而非丟 errno",
    huge.error !== undefined && huge.error.includes("8191"),
    huge.error,
  );

  // buildInvocation: flags only. The prompt goes to stdin, so nothing about it may appear in
  // argv — that is what stops cmd.exe re-parsing the quotes/newlines out of a writer prompt,
  // and what puts the 8191-char limit out of reach.
  const bare = buildInvocation("ut-writer", "", { jsonEvents: true, skipPerms: false });
  check(
    "buildInvocation：只產生旗標，prompt 不進 argv（無 positional、無 --file）",
    JSON.stringify(bare) === JSON.stringify(["run", "--agent", "ut-writer", "--format", "json"]),
    JSON.stringify(bare),
  );

  const full = buildInvocation("ut-writer", "qwen3.6:27b", { jsonEvents: true, skipPerms: true });
  check(
    "buildInvocation：帶 model 與 skip-perms 時仍只有旗標",
    full.includes("--model") &&
      full.includes("qwen3.6:27b") &&
      full.includes("--dangerously-skip-permissions") &&
      !full.includes("--file"),
    JSON.stringify(full),
  );
  check(
    "buildInvocation：UT_OPENCODE_JSON=0 時不帶 --format",
    !buildInvocation("ut-writer", "", { jsonEvents: false, skipPerms: false }).includes("--format"),
  );

  // A flags-only argv is short enough that a .cmd shim can never hit the cmd.exe limit,
  // however large the prompt is.
  check(
    "buildInvocation + planSpawn（win32 + .cmd）：命令列不再有長度風險",
    planSpawn(shim, full, "win32").error === undefined,
  );

  // The old handler blamed a missing install for every errno; these two need different fixes.
  const enoent = explainSpawnError({ code: "ENOENT", message: "x" } as NodeJS.ErrnoException, "opencode");
  const einval = explainSpawnError({ code: "EINVAL", message: "x" } as NodeJS.ErrnoException, "opencode");
  check(
    "explainSpawnError：ENOENT 與 EINVAL 給出不同診斷",
    enoent !== einval && enoent.includes("找不到") && einval.includes("cmd.exe"),
    `${enoent} / ${einval}`,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 10. Killing the process tree on timeout (the Windows hang)
// ---------------------------------------------------------------------------
console.log("\n[10] planKill / killTree（逾時終止整棵程序樹）");
{
  // Windows: signals do not exist, so the only reachable mechanism is taskkill /T /F.
  const win = planKill(4242, "SIGTERM", "win32");
  check(
    "planKill（win32）：taskkill /T /F，帶樹且強制",
    win.via === "taskkill" &&
      win.file === "taskkill" &&
      win.args.join(" ") === "/pid 4242 /T /F",
    JSON.stringify(win),
  );
  check(
    "planKill（win32）：SIGKILL 與 SIGTERM 產生相同計畫（Windows 無優雅終止可言）",
    JSON.stringify(planKill(4242, "SIGKILL", "win32")) === JSON.stringify(win),
  );

  // POSIX: signal the group (negative pid), and keep the requested signal meaningful.
  const posixTerm = planKill(4242, "SIGTERM", "linux");
  check(
    "planKill（linux）：送給 process group（負 pid），而非單一程序",
    posixTerm.via === "signal" && posixTerm.target === -4242 && posixTerm.signal === "SIGTERM",
    JSON.stringify(posixTerm),
  );
  const posixKill = planKill(4242, "SIGKILL", "linux");
  check(
    "planKill（linux）：SIGKILL 升級會保留下來",
    posixKill.via === "signal" && posixKill.signal === "SIGKILL",
  );

  // The regression itself, end to end: a wrapper process with a longer-lived child, exactly
  // the shape cmd.exe + opencode makes on Windows. killTree must take the grandchild with it.
  if (process.platform !== "win32") {
    const wrapper = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true, // what the runner now does; planKill's group signal depends on it
    });
    const grandchildPid = await new Promise<number>((res) => {
      wrapper.stdout.setEncoding("utf8");
      wrapper.stdout.once("data", (d: string) => res(Number(d.trim())));
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      // A killed grandchild is re-parented to PID 1 and stays a zombie until PID 1 reaps it, and
      // signal 0 still succeeds on a zombie. A container whose init reaps lazily (measured: 1-3s)
      // made this report a dead process as alive. Linux only; elsewhere signal 0 has the last word.
      try {
        return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch {
        return true;
      }
    };
    check("killTree 前置：孫程序確實活著", alive(grandchildPid), `pid ${grandchildPid}`);

    killTree(wrapper, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    check(
      "killTree：連孫程序一起收掉（舊 child.kill 只殺得到外層）",
      !alive(grandchildPid),
      `pid ${grandchildPid} 仍在`,
    );
    check("killTree：外層本身也結束", wrapper.exitCode !== null || wrapper.signalCode !== null);
    check("killTree：對已結束的程序再呼叫不丟例外", (() => {
      try {
        killTree(wrapper, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    })());
  }
}

// ---------------------------------------------------------------------------
// 10b. The parent process must outlive its console and its terminal
// ---------------------------------------------------------------------------
console.log("\n[10b] 行程生命週期（管線關閉、終端斷線、殘留程序占住輸出、被 signal 終止）");
if (process.platform !== "win32") {
  const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const logTs = new URL("../libs/log.ts", import.meta.url).href;
  const shellTs = new URL("../libs/shell.ts", import.meta.url).href;
  const runNode = (code: string, shellCmd: (node: string) => string) =>
    new Promise<{ code: number | null; signal: string | null; err: string }>((res) => {
      const node = `${JSON.stringify(process.execPath)} --import ${loader} --input-type=module -e ${JSON.stringify(code)}`;
      const c = spawn("sh", ["-c", shellCmd(node)], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      c.stderr.setEncoding("utf8");
      c.stderr.on("data", (d: string) => (err += d));
      c.on("close", (code, signal) => res({ code, signal, err }));
    });

  // The reader of `| tee` goes away mid-run: the next log line must not kill the run. The node
  // side reports through a file, since its stdout is the dead pipe.
  const st = path.join(os.tmpdir(), `testgen-epipe-${process.pid}`);
  await runNode(
    `const { log } = await import(${JSON.stringify(logTs)});` +
      `await new Promise(r => setTimeout(r, 300));` +
      `for (let i = 0; i < 200; i++) log("x".repeat(200));` +
      `await new Promise(r => setTimeout(r, 100));` +
      `(await import("node:fs")).writeFileSync(${JSON.stringify(st)}, "survived");`,
    (node) => `${node} | head -c 1 >/dev/null`,
  );
  check("log()：stdout 的讀取端消失（EPIPE）後 run 繼續，不以未捕捉例外結束", fs.existsSync(st) && fs.readFileSync(st, "utf8") === "survived");
  fs.rmSync(st, { force: true });

  // SIGHUP without a terminal on stdin (nohup / setsid / CI) is not a request to stop — node
  // resets nohup's SIG_IGN, so this handler is the only thing that keeps such a run alive.
  const hup = await runNode(
    `const { installShutdownHandlers } = await import(${JSON.stringify(shellTs)});` +
      `installShutdownHandlers();` +
      `setTimeout(() => process.exit(0), 1500);` +
      `setTimeout(() => process.kill(process.pid, "SIGHUP"), 200);`,
    (node) => `${node} </dev/null`,
  );
  check("SIGHUP（stdin 不是終端機，nohup / CI）：run 不中斷", hup.code === 0 && hup.signal === null, JSON.stringify(hup));
  const term = await runNode(
    `const { installShutdownHandlers, onShutdown } = await import(${JSON.stringify(shellTs)});` +
      `installShutdownHandlers();` +
      `onShutdown((r) => process.stderr.write("hook:" + r));` +
      `setTimeout(() => process.exit(0), 1500);` +
      `setTimeout(() => process.kill(process.pid, "SIGTERM"), 200);`,
    (node) => `${node} </dev/null`,
  );
  check("SIGTERM：以 143 結束，結束前跑 onShutdown（寫 summary 用）", term.code === 143 && term.err.includes("hook:SIGTERM"), JSON.stringify(term));

  // A build that exits but leaves a process holding its stdout must not hold the gate forever.
  if (spawnSync("sh", ["-c", "command -v setsid"]).status === 0) {
    const t0 = Date.now();
    const r = await shLive("sh", ["-c", "setsid sleep 20 & echo built; exit 0"], "[t]", os.tmpdir(), 0);
    check("shLive：建置結束後有殘留程序占住輸出，數秒內仍會返回", r.code === 0 && r.out.includes("built") && Date.now() - t0 < 10_000, `${Date.now() - t0}ms code=${r.code}`);
  }
  const sig = await shLive("sh", ["-c", "kill -9 $$"], "[t]", os.tmpdir(), 0);
  check("shLive：被 signal 終止時回報是哪個 signal（OOM killer 不是測試失敗）", sig.signal === "SIGKILL", JSON.stringify(sig));
}

// ---------------------------------------------------------------------------
// 11. loop hardening: snapshots, coverage ranges, fix-prompt scope, guard parsing
// ---------------------------------------------------------------------------
console.log("\n[11] 迴圈強化（writer 變更偵測 / 未覆蓋行 / fix prompt 範圍 / guard 解析）");
{
  // snapshot diff: add / modify / delete all show up
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-snap-"));
  fs.mkdirSync(path.join(tmp, "com"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "com", "AT.java"), "a");
  fs.writeFileSync(path.join(tmp, "BT.java"), "b");
  const s1 = snapshotTree(tmp);
  fs.writeFileSync(path.join(tmp, "com", "AT.java"), "aa"); // modify
  fs.writeFileSync(path.join(tmp, "CT.java"), "c"); // add
  fs.rmSync(path.join(tmp, "BT.java")); // delete
  const changed = diffSnapshots(s1, snapshotTree(tmp));
  check(
    "diffSnapshots：新增/修改/刪除皆被偵測",
    JSON.stringify(changed) === JSON.stringify(["BT.java", "CT.java", "com/AT.java"]),
    JSON.stringify(changed),
  );
  check("diffSnapshots：無變更 → 空陣列", diffSnapshots(s1, s1).length === 0);
  check("snapshotTree：不存在的目錄 → 空快照", Object.keys(snapshotTree(path.join(tmp, "nope"))).length === 0);
  // A time put back through a Date (as the encoding view restores a file it did not change) has
  // whole milliseconds; the file's own had a fraction. Still the same file.
  const precise = path.join(tmp, "com", "AT.java");
  fs.utimesSync(precise, 1790203350.5842844, 1790203350.5842844);
  const s2 = snapshotTree(tmp);
  const st2 = fs.statSync(precise);
  fs.utimesSync(precise, new Date(st2.atimeMs), new Date(st2.mtimeMs));
  check(
    "snapshotTree：修改時間被以 Date 放回（少了不到 1 毫秒的部分）→ 不算變更",
    diffSnapshots(s2, snapshotTree(tmp)).length === 0,
    `${st2.mtimeMs} → ${fs.statSync(precise).mtimeMs}`,
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  // coverage: missed lines and range compression
  check("toRanges：連續與單點壓縮", toRanges([1, 2, 3, 7, 9, 10]) === "1-3, 7, 9-10");
  check("toRanges：空陣列", toRanges([]) === "");
  const block =
    '<sourcefile name="Foo.java"><line nr="5" mi="2" ci="0"/><line nr="6" mi="0" ci="3"/>' +
    '<line nr="7" mi="1" ci="1"/></sourcefile>';
  check(
    "missedLines：只取 mi>0 的行",
    JSON.stringify(missedLines(block)) === JSON.stringify([5, 7]),
  );

  // fix prompt now carries the target classes (round 2+ scope was previously lost)
  const fix = buildFixPrompt({
    gateReport: "r",
    standards: "s",
    mod: { moduleRoot: "/x", moduleRel: "", multiModule: false },
    targetClasses: ["src/main/java/com/x/Foo.java"],
  });
  check("buildFixPrompt：包含目標類別清單", fix.includes("com/x/Foo.java"));

  // guard: the tools block is parsed, not regex-matched anywhere in the frontmatter
  const fm = 'description: 提到 bash: false 不算數\nmode: all\ntools:\n  write: true\n  bash: true\n';
  const tools = parseToolsBlock(fm);
  check("parseToolsBlock：讀 tools 區塊的值", tools.bash === "true" && tools.write === "true");
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-guard-"));
  const deceptive = path.join(tmp2, "agent.md");
  fs.writeFileSync(
    deceptive,
    "---\ndescription: bash: false 只是描述\ntools:\n  write: true\n  edit: true\n  bash: true\n  webfetch: false\n  task: false\n---\nbody",
  );
  const errs = contractViolations(deceptive, WRITER_RULES);
  check(
    "contractViolations：description 提及不能滿足 guard（實際 bash: true 被抓）",
    errs.length === 1 && errs[0].includes("tools.bash"),
    JSON.stringify(errs),
  );
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 12. Scope containment: baseline pre-check + existing-test detection
//     (build gate covers the whole module, so the writer must be told what is not its work)
// ---------------------------------------------------------------------------
console.log("\n[12] extractCompileErrorFiles / findExistingTests / prompt 範圍限縮");
{
  // (a) maven and javac error shapes, deduped, first-seen order
  const mavenOut =
    "[INFO] Compiling 42 source files\n" +
    "[ERROR] /w/repo/modA/src/test/java/com/x/CacheServiceImplTest.java:[7,26] cannot find symbol\n" +
    "[ERROR] /w/repo/modA/src/test/java/com/x/CacheServiceImplTest.java:[9,3] cannot find symbol\n" +
    "[ERROR] /w/repo/modA/src/test/java/com/x/SamlServiceImplTest.java:[3,1] package does not exist\n" +
    "[ERROR] Failed to execute goal ... on project modA\n";
  const mavenFiles = extractCompileErrorFiles(mavenOut);
  check(
    "extractCompileErrorFiles：maven 格式，同檔多錯只列一次",
    mavenFiles.length === 2 &&
      mavenFiles[0].endsWith("CacheServiceImplTest.java") &&
      mavenFiles[1].endsWith("SamlServiceImplTest.java"),
    JSON.stringify(mavenFiles),
  );
  const javacFiles = extractCompileErrorFiles(
    "/w/repo/src/test/java/com/x/ConfigUtilTest.java:12: error: cannot find symbol\n",
  );
  check(
    "extractCompileErrorFiles：javac/gradle 格式也認得",
    javacFiles.length === 1 && javacFiles[0].endsWith("ConfigUtilTest.java"),
    JSON.stringify(javacFiles),
  );
  check(
    "extractCompileErrorFiles：乾淨輸出 → 空陣列",
    extractCompileErrorFiles("[INFO] BUILD SUCCESS").length === 0,
  );

  // (a2) Regression, from a real corporate Maven 3.9 run: jansi colours the level WORD, so the
  // bytes are `[<ESC>[1;31mERROR<ESC>[m]` — the literal "[ERROR]" does not occur anywhere in the
  // log, not even unanchored. Every classifier reported "no files", the repair prompt listed
  // nothing, and the writer burned four rounds looking for a target it was never given.
  const ESC = String.fromCharCode(27);
  const paint = (out: string) =>
    out.replace(/\[(ERROR|INFO)\]/g, (_m, lvl: string) => `[${ESC}[1;31m${lvl}${ESC}[m]`);
  check(
    "stripAnsi：色碼夾在中括號內也剝得掉",
    stripAnsi(`[${ESC}[1;31mERROR${ESC}[m] boom`) === "[ERROR] boom",
    stripAnsi(`[${ESC}[1;31mERROR${ESC}[m] boom`),
  );
  const colouredFiles = extractCompileErrorFiles(paint(mavenOut));
  check(
    "regression：maven 上色時仍定位得到檔案（否則 writer 收到空清單）",
    colouredFiles.length === 2 && colouredFiles[0].endsWith("CacheServiceImplTest.java"),
    JSON.stringify(colouredFiles),
  );

  // (a3) Environment failures: red the writer cannot fix by editing the test body, even though
  // the file is well inside its scope. The false-positive check matters more than the hits —
  // classifying a repairable failure as environmental refuses to repair something repairable.
  const ctxOut =
    "[ERROR] com.x.OrderServiceTest -- Time elapsed: 2.1 s <<< ERROR!\n" +
    "[ERROR] java.lang.IllegalStateException: Failed to load ApplicationContext for [Web...]\n" +
    "[ERROR] Caused by: org.apache.commons.codec.DecoderException: Odd number of characters.\n";
  const envWhy = detectEnvFailures(ctxOut);
  check(
    "detectEnvFailures：context 起不來 + 解密失敗都認得",
    envWhy.length === 2 && envWhy.some((w) => w.includes("Spring context")) && envWhy.some((w) => w.includes("解密")),
    JSON.stringify(envWhy),
  );
  check(
    "detectEnvFailures：上色時一樣認得（與其他解析共用剝除）",
    detectEnvFailures(paint(ctxOut)).length === 2,
    JSON.stringify(detectEnvFailures(paint(ctxOut))),
  );
  check(
    "detectEnvFailures：一般斷言失敗不得誤判為環境問題",
    detectEnvFailures(
      "[ERROR] com.x.CalcTest.add_twoPositives -- Time elapsed: 0.01 s <<< FAILURE!\n" +
        "org.opentest4j.AssertionFailedError: expected: <3> but was: <4>\n",
    ).length === 0,
  );
  check(
    "detectEnvFailures：編譯錯誤也不是環境問題（那是 writer 修得動的）",
    detectEnvFailures(mavenOut).length === 0,
    JSON.stringify(detectEnvFailures(mavenOut)),
  );
  check("detectEnvFailures：乾淨輸出 → 空陣列", detectEnvFailures("[INFO] BUILD SUCCESS").length === 0);

  // (a4) Dirty-baseline subtraction. The gate's promise becomes "no worse than before the
  // writer touched it", so everything here is about what still has to count as worse.
  const suite = (name: string, cases: string[]): SurefireSuite => ({
    suite: name,
    tests: 9,
    failures: cases.length,
    errors: 0,
    cases: cases.map((c) => ({ kind: "failure" as const, name: c, message: "boom", frame: "" })),
  });
  const baseSuites = [
    suite("com.x.CommonServiceImplTest", ["setUp_loadsEnum", "fetch_whenEmpty[2]"]),
    suite("com.x.CacheServiceImplTest", ["Nested.evict_expired"]),
  ];
  const P = failingTestIds(baseSuites);
  check(
    "failingTestIds：識別到方法層級，@Nested 與 @ParameterizedTest 的案例標識都留著",
    P.length === 3 &&
      P.includes("com.x.CommonServiceImplTest#fetch_whenEmpty[2]") &&
      P.includes("com.x.CacheServiceImplTest#Nested.evict_expired"),
    JSON.stringify(P),
  );
  check(
    "subtractTolerated：全部都是既有失敗 → 放行",
    subtractTolerated("[ERROR] Tests run: 9, Failures: 3", baseSuites, P).pass,
  );
  check(
    "subtractTolerated：修好一部分（子集）→ 仍放行",
    subtractTolerated("[ERROR] Tests run: 9, Failures: 1", [suite("com.x.CacheServiceImplTest", ["Nested.evict_expired"])], P).pass,
  );
  // The guardrail the whole design rests on: coarsening identity to the class would pass this.
  const sameClassNewMethod = [suite("com.x.CommonServiceImplTest", ["setUp_loadsEnum", "save_rollsBack"])];
  const v1 = subtractTolerated("[ERROR] Tests run: 9, Failures: 2", sameClassNewMethod, P);
  check(
    "subtractTolerated：同一個已失敗類別裡的另一個方法失敗 → 擋下（識別退回類別層級就會漏掉）",
    !v1.pass && v1.unexpected.length === 1 && v1.unexpected[0].endsWith("#save_rollsBack"),
    JSON.stringify(v1),
  );
  const v2 = subtractTolerated("[ERROR] Tests run: 9, Failures: 1", [suite("com.x.NewTest", ["a_b_c"])], P);
  check("subtractTolerated：全新類別的失敗 → 擋下", !v2.pass && v2.unexpected.length === 1, JSON.stringify(v2));
  const v3 = subtractTolerated(
    "[ERROR] /w/m/src/test/java/com/x/Foo.java:[9,9] cannot find symbol",
    baseSuites,
    P,
  );
  check(
    "subtractTolerated：有編譯錯誤時一律不扣除（沒有測試跑過，無從比對）",
    !v3.pass && v3.reason.includes("編譯"),
    JSON.stringify(v3),
  );
  const v4 = subtractTolerated("[ERROR] Could not resolve dependencies", [], P);
  check(
    "subtractTolerated：紅但定位不到任何失敗測試 → 擋下（空集合是任何集合的子集）",
    !v4.pass && v4.reason.includes("定位不到"),
    JSON.stringify(v4),
  );

  // (b) existing-test detection: the duplicate-file bug is <Class>UnitTest.java beside <Class>Test.java
  check("matchesTestNaming：正規名稱", matchesTestNaming("CommonServiceImpl", "CommonServiceImplTest.java"));
  check("matchesTestNaming：UnitTest 變體", matchesTestNaming("CommonServiceImpl", "CommonServiceImplUnitTest.java"));
  check("matchesTestNaming：複數 Tests", matchesTestNaming("Foo", "FooTests.java"));
  check("matchesTestNaming：Test 前綴", matchesTestNaming("Foo", "TestFoo.java"));
  check(
    "matchesTestNaming：不誤判另一個類別的測試（FooBarTest 不屬於 Foo）",
    !matchesTestNaming("Foo", "FooBarTest.java"),
  );
  check("matchesTestNaming：production 檔不算", !matchesTestNaming("Foo", "Foo.java"));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-existing-"));
  const testPkg = path.join(tmp, "modA", "src", "test", "java", "com", "x");
  fs.mkdirSync(testPkg, { recursive: true });
  fs.writeFileSync(path.join(testPkg, "CommonServiceImplUnitTest.java"), "");
  fs.writeFileSync(path.join(testPkg, "CommonServiceImplTest.java"), "");
  fs.writeFileSync(path.join(testPkg, "OtherTest.java"), "");
  const found = findExistingTests("modA/src/main/java/com/x/CommonServiceImpl.java", tmp);
  check(
    "findExistingTests：抓到重複檔，且正規檔名排最前",
    found.length === 2 &&
      found[0] === "modA/src/test/java/com/x/CommonServiceImplTest.java" &&
      found[1] === "modA/src/test/java/com/x/CommonServiceImplUnitTest.java",
    JSON.stringify(found),
  );
  check(
    "findExistingTests：測試目錄不存在 → 空陣列",
    findExistingTests("modA/src/main/java/com/nope/Absent.java", tmp).length === 0,
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  // (c) both facts must actually reach the prompts
  const mod = { moduleRoot: "/x", moduleRel: "modA", multiModule: true };
  const gen = buildGeneratePrompt({
    targetClasses: ["modA/src/main/java/com/x/Foo.java"],
    standards: "s",
    mod,
    existingTests: [
      { cls: "modA/src/main/java/com/x/Foo.java", tests: ["modA/src/test/java/com/x/FooTest.java"] },
    ],
  });
  check(
    "buildGeneratePrompt：既有測試檔被點名且禁止另建新檔",
    gen.includes("modA/src/test/java/com/x/FooTest.java") && gen.includes("嚴禁另建新檔"),
  );
  check(
    "buildGeneratePrompt：沒有既有測試時不塞空區塊",
    !buildGeneratePrompt({
      targetClasses: ["modA/src/main/java/com/x/Foo.java"],
      standards: "s",
      mod,
      existingTests: [{ cls: "modA/src/main/java/com/x/Foo.java", tests: [] }],
    }).includes("嚴禁另建新檔"),
  );
  check("renderExistingTests：全空 → 空字串", renderExistingTests([]) === "");

  const fixWithPre = buildFixPrompt({
    gateReport: "r",
    standards: "s",
    mod,
    targetClasses: ["modA/src/main/java/com/x/Foo.java"],
    preExisting: {
      compileErrorFiles: ["modA/src/test/java/com/x/CacheServiceImplTest.java"],
      failingTestClasses: ["com.x.SamlServiceImplTest"],
    },
  });
  check(
    "buildFixPrompt：既有紅燈標記為 pre-existing 並要求不要修",
    fixWithPre.includes("CacheServiceImplTest.java") &&
      fixWithPre.includes("com.x.SamlServiceImplTest") &&
      fixWithPre.includes("不要嘗試修復"),
  );
  check(
    "buildFixPrompt：無 preExisting 時不出現該區塊",
    !buildFixPrompt({
      gateReport: "r",
      standards: "s",
      mod,
      targetClasses: ["modA/src/main/java/com/x/Foo.java"],
    }).includes("pre_existing_failures"),
  );
  check(
    "renderPreExisting：兩份清單都空 → 空字串",
    renderPreExisting({ compileErrorFiles: [], failingTestClasses: [] }) === "",
  );
}

// ---------------------------------------------------------------------------
// 13. Feedback budget: extract the errors, drop maven's footer, bound the whole report
// ---------------------------------------------------------------------------
{
  // `parseError` marks three different situations and only one of them is a reviewer that
  // answered unreadably. Retrying the other two would change what their guards do: a spawn
  // error is environmental, and zero tool calls is a reviewer that answered fine but read
  // nothing. Conflating them silently broke two existing scenarios once already.
  check("isUnparseable：真正的解析失敗 → true", isUnparseable(parseVerdict("我沒有 JSON")));
  check("isUnparseable：分數缺漏也算解析失敗 → true", isUnparseable(parseVerdict('{"blockers":[]}')));
  check("isUnparseable：spawn 失敗不算（環境問題，重試無用）", !isUnparseable(spawnErrorVerdict()));
  check(
    "isUnparseable：0 tool calls 不算（reviewer 答得出來，只是沒讀檔，那道 guard 自有處置）",
    !isUnparseable(zeroToolCallVerdict('{"scores":{}}')),
  );
  check("isUnparseable：正常判決 → false", !isUnparseable(parseVerdict(JSON.stringify({
    scores: { effectiveness: 8, coverage: 8, independence: 8, readability: 8, fast_reliable: 8, mock_appropriateness: 8 },
    blockers: [],
    advisories: [],
  }))));
}

console.log("\n[13] summarizeBuildErrors / clampText（回饋預算）");
{
  const mavenFail =
    "[INFO] Compiling 42 source files\n" +
    "[INFO] -------------------------------------------------------------\n" +
    "[ERROR] COMPILATION ERROR : \n" +
    "[ERROR] /w/modA/src/test/java/com/x/CacheServiceImplTest.java:[4,27] cannot find symbol\n" +
    "  symbol:   variable log\n" +
    "  location: class com.x.CacheServiceImplTest\n" +
    "[INFO] BUILD FAILURE\n" +
    "[INFO] Total time:  6.940 s\n" +
    "[ERROR] Failed to execute goal org.apache.maven.plugins:compiler on project modA -> [Help 1]\n" +
    "[ERROR] \n" +
    "[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.\n" +
    "[ERROR] Re-run Maven using the -X switch to enable full debug logging.\n" +
    "[ERROR] \n" +
    "[ERROR] For more information about the errors and possible solutions, please read:\n" +
    "[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException\n" +
    "[ERROR] After correcting the problems, you can resume the build with the command\n" +
    "[ERROR]   mvn <args> -rf :modA\n";
  const summary = summarizeBuildErrors(mavenFail);
  check(
    "summarizeBuildErrors：保留編譯錯誤本身",
    summary.includes("CacheServiceImplTest.java:[4,27] cannot find symbol"),
    summary,
  );
  check(
    "summarizeBuildErrors：保留 javac 的無前綴接續行（symbol/location）",
    summary.includes("symbol:   variable log") && summary.includes("location: class com.x"),
  );
  check(
    "summarizeBuildErrors：丟掉 maven 樣板（Help/stack trace/Re-run/resume）",
    !/Help 1|full stack trace|Re-run Maven|For more information|After correcting|-rf :modA/.test(
      summary,
    ),
    summary,
  );
  check(
    "summarizeBuildErrors：丟掉 INFO 噪音，且不留空的 [ERROR] 行",
    !summary.includes("[INFO]") && !/^\[ERROR\]\s*$/m.test(summary),
  );
  // the regression this replaces: tail() keeps the footer and drops the error
  check(
    "regression：舊的 tail 取法會留下樣板、丟掉錯誤本身",
    mavenFail.slice(-260).includes("mvn <args>") &&
      !mavenFail.slice(-260).includes("cannot find symbol"),
  );
  check(
    "summarizeBuildErrors：完全沒有 [ERROR] 行時退回 tail（不能回空字串）",
    summarizeBuildErrors("[INFO] weird failure with no error lines").length > 0,
  );

  // The same colour regression from the other side: with the escape inside the tag, not one
  // line matched, kept stayed empty, and the whole report fell back to tail() — which is how a
  // build report ends up being maven's footer plus a word cut in half.
  const ESC13 = String.fromCharCode(27);
  const colouredFail = mavenFail.replace(
    /\[(ERROR|INFO)\]/g,
    (_m, lvl: string) => `[${ESC13}[1;31m${lvl}${ESC13}[m]`,
  );
  const colouredSummary = summarizeBuildErrors(colouredFail);
  check(
    // Not "does it contain the truncation marker": tail() only marks when the input exceeds the
    // cap, and this fixture is short, so that assertion passes even unstripped. A surviving
    // escape byte is the discriminator — the filtered path cannot emit one, tail() always does.
    "regression：maven 上色時不得退回 tail（殘留色碼即證明整份被 tail 原樣吐回）",
    colouredSummary.includes("CacheServiceImplTest.java:[4,27] cannot find symbol") &&
      !colouredSummary.includes(ESC13),
    colouredSummary.slice(0, 300),
  );
  check(
    "regression：上色時樣板一樣要被丟掉（剝除後才輪得到 boilerplate 比對）",
    !/Help 1|Re-run Maven|-rf :modA/.test(colouredSummary),
    colouredSummary.slice(0, 300),
  );
  check(
    "summarizeBuildErrors：超過上限時截斷並標明",
    summarizeBuildErrors(
      Array.from({ length: 400 }, (_, i) => `[ERROR] line ${i} of noise`).join("\n"),
      500,
    ).includes("已截斷"),
  );

  // surefire 報告：通過的報告本身就含「Failures」「Errors」字樣，子字串比對會把每一份都當失敗
  const passing =
    "Test set: com.x.FooTest\n" +
    "Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.006 s -- in com.x.FooTest";
  check(
    "regression：通過的 surefire 報告不算失敗（舊的 /FAILURE|ERROR/ 比對會誤判）",
    !surefireHasFailure(passing) && /ERROR/i.test(passing),
  );
  check(
    "surefireHasFailure：Failures 非零",
    surefireHasFailure("Tests run: 3, Failures: 1, Errors: 0, Skipped: 0"),
  );
  check(
    "surefireHasFailure：Errors 非零",
    surefireHasFailure("Tests run: 3, Failures: 0, Errors: 2, Skipped: 0"),
  );
  check(
    "surefireHasFailure：無彙總行時退回逐項標記",
    surefireHasFailure("com.x.FooTest.bar  Time elapsed: 0.01 s  <<< FAILURE!") &&
      !surefireHasFailure("完全無關的文字"),
  );

  // stuck 偵測比對的是「發生了什麼」，不是碼錶。同一個失敗重跑兩次只有耗時會變。
  const roundA =
    "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.018 s <<< FAILURE! -- in com.x.FooTest\n" +
    "[ERROR] com.x.FooTest.bar:12 expected: <1> but was: <2>";
  const roundB = roundA.replace("0.018", "0.015");
  check(
    "regression：同一個測試失敗重跑，耗時不同但 fingerprint 相同 → stuck 會觸發",
    roundA !== roundB && feedbackFingerprint(roundA) === feedbackFingerprint(roundB),
  );
  check(
    "feedbackFingerprint：JVM identity hash 正規化",
    feedbackFingerprint("expected: <com.x.Foo@1b6d3586>") ===
      feedbackFingerprint("expected: <com.x.Foo@4554617c>"),
  );
  // 誤判成 stuck 會中止一個其實還在進步的 run，比多燒幾輪更糟——這幾條是防線
  check(
    "feedbackFingerprint：不同類別的 identity hash 不會collapse 成同一個",
    feedbackFingerprint("expected: <com.x.Foo@1b6d3586>") !==
      feedbackFingerprint("expected: <com.x.Bar@1b6d3586>"),
  );
  check(
    "feedbackFingerprint：不同的斷言值不會被 collapse",
    feedbackFingerprint("expected: <1> but was: <2>") !==
      feedbackFingerprint("expected: <1> but was: <3>"),
  );
  check(
    "feedbackFingerprint：不同的失敗行號不會被 collapse",
    feedbackFingerprint("FooTest.bar:12 failed") !== feedbackFingerprint("FooTest.bar:13 failed"),
  );
  check(
    "feedbackFingerprint：沒有時間戳的報告原樣返回（review blockers 不受影響）",
    feedbackFingerprint("Blockers：\n1. FooTest.foo 無意義斷言") ===
      "Blockers：\n1. FooTest.foo 無意義斷言",
  );

  check("clampText：未超限原樣返回", clampText("abc", 10) === "abc");
  const clamped = clampText("x".repeat(100), 20);
  check(
    "clampText：超限保留開頭並標明截斷字元數",
    clamped.startsWith("x".repeat(20)) && clamped.includes("截斷 80 字元"),
    clamped,
  );
}

// ---------------------------------------------------------------------------
// 14. Test-class visibility: measured from the repo, never assumed
// ---------------------------------------------------------------------------
console.log("\n[14] classVisibility / isClassRefSuite / scanTestConventions（專案慣例）");
{
  check(
    "classVisibility：public 頂層類別",
    classVisibility("package com.x;\npublic class FooTest {}") === "public",
  );
  check(
    "classVisibility：package-private 頂層類別",
    classVisibility("package com.x;\nclass FooTest {}") === "package-private",
  );
  check(
    "classVisibility：final/abstract 修飾詞不影響判定",
    classVisibility("public final class FooTest {}") === "public" &&
      classVisibility("abstract class FooTest {}") === "package-private",
  );
  check(
    "classVisibility：內部類別（有縮排）不會蓋掉外層判定",
    classVisibility("class Outer {\n    public class Inner {}\n}") === "package-private",
  );
  check(
    "classVisibility：註解裡的宣告不算數",
    classVisibility("// public class Wrong {}\n/* public class AlsoWrong {} */\nclass Right {}") ===
      "package-private",
  );
  check("classVisibility：沒有 class 宣告 → null", classVisibility("package com.x;") === null);

  check(
    "isClassRefSuite：@SelectClasses 逐一列舉 → 需要 public",
    isClassRefSuite("@Suite\n@SelectClasses({FooTest.class})\nclass AllTests {}"),
  );
  check(
    "isClassRefSuite：JUnit 4 @SuiteClasses 同樣算",
    isClassRefSuite("@RunWith(Suite.class)\n@SuiteClasses({FooTest.class})\npublic class S {}"),
  );
  check(
    "isClassRefSuite：@SelectPackages 依 package 名解析，不強制 public",
    !isClassRefSuite('@Suite\n@SelectPackages("com.x")\nclass AllTests {}'),
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-conv-"));
  const pkg = path.join(tmp, "modA", "src", "test", "java", "com", "x");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "AlphaTest.java"), "package com.x;\npublic class AlphaTest {}");
  fs.writeFileSync(path.join(pkg, "BetaTest.java"), "package com.x;\npublic class BetaTest {}");
  fs.writeFileSync(path.join(pkg, "GammaTest.java"), "package com.x;\nclass GammaTest {}");
  const testRoot = path.join(tmp, "modA", "src", "test", "java");
  const noSuite = scanTestConventions(testRoot, tmp);
  check(
    "scanTestConventions：統計既有可見性",
    noSuite.publicCount === 2 && noSuite.packagePrivateCount === 1 && noSuite.scanned === 3,
    JSON.stringify(noSuite),
  );
  check("scanTestConventions：無套件 → classRefSuites 空", noSuite.classRefSuites.length === 0);

  fs.writeFileSync(
    path.join(pkg, "SonarTestSuite.java"),
    "package com.x.suite;\nimport com.x.*;\n@Suite\n@SelectClasses({AlphaTest.class})\npublic class SonarTestSuite {}",
  );
  const withSuite = scanTestConventions(testRoot, tmp);
  check(
    "scanTestConventions：抓到 SonarTestSuite（repo 相對路徑）",
    withSuite.classRefSuites.length === 1 &&
      withSuite.classRefSuites[0] === "modA/src/test/java/com/x/SonarTestSuite.java",
    JSON.stringify(withSuite.classRefSuites),
  );
  check(
    "scanTestConventions：套件本身不列入可見性統計",
    withSuite.publicCount === 2 && withSuite.packagePrivateCount === 1,
    JSON.stringify(withSuite),
  );
  check(
    "scanTestConventions：測試目錄不存在 → 零值而非拋錯",
    scanTestConventions(path.join(tmp, "nope"), tmp).scanned === 0,
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  // the conclusion must actually reach the writer, and say "必須" only when a suite forces it
  const suiteText = renderConventions({
    scanned: 3,
    publicCount: 0,
    packagePrivateCount: 3,
    classRefSuites: ["modA/src/test/java/com/x/SonarTestSuite.java"],
  });
  check(
    "renderConventions：有 class-symbol 套件 → 硬性要求 public",
    suiteText.includes("SonarTestSuite.java") &&
      suiteText.includes("必須") &&
      suiteText.includes("public class"),
    suiteText,
  );
  const majorityText = renderConventions({
    scanned: 12,
    publicCount: 10,
    packagePrivateCount: 2,
    classRefSuites: [],
  });
  check(
    "renderConventions：無套件 → 只回報既有多數慣例，不宣稱必須",
    majorityText.includes("public") && !majorityText.includes("必須"),
    majorityText,
  );
  check(
    "renderConventions：package-private 佔多數時如實回報",
    renderConventions({ scanned: 5, publicCount: 1, packagePrivateCount: 4, classRefSuites: [] })
      .includes("package-private"),
  );
  check(
    "renderConventions：沒有既有測試 → 空字串（不編造慣例）",
    renderConventions({ scanned: 0, publicCount: 0, packagePrivateCount: 0, classRefSuites: [] }) ===
      "" && renderConventions(undefined) === "",
  );

  const mod = { moduleRoot: "/x", moduleRel: "modA", multiModule: true };
  const conv = { scanned: 1, publicCount: 0, packagePrivateCount: 1, classRefSuites: ["S.java"] };
  check(
    "buildGeneratePrompt / buildFixPrompt：兩段 prompt 都帶到慣例結論",
    buildGeneratePrompt({
      targetClasses: ["modA/src/main/java/com/x/Foo.java"],
      standards: "s",
      mod,
      existingTests: [],
      conventions: conv,
    }).includes("必須") &&
      buildFixPrompt({
        gateReport: "cannot find symbol: class FooTest",
        standards: "s",
        mod,
        targetClasses: ["modA/src/main/java/com/x/Foo.java"],
        conventions: conv,
      }).includes("必須"),
  );
}

// ---------------------------------------------------------------------------
// 15. Writer scope: everything outside <module>/src/test is read-only, and the loop asserts it
// ---------------------------------------------------------------------------
console.log("\n[15] snapshotTree(skipDir) / writerScopeSkip（writer 可寫範圍）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-scope-"));
  const mk = (rel: string, body = "x") => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  mk("pom.xml");
  mk("modA/pom.xml");
  mk("modA/src/main/java/com/x/Foo.java", "class Foo {}");
  mk("modA/src/main/resources/application.yml");
  mk("modA/src/test/java/com/x/FooTest.java");
  mk("modA/target/classes/Foo.class");
  mk("modB/src/main/java/com/y/Bar.java");
  mk("modB/src/test/java/com/y/BarTest.java");
  mk(".git/HEAD");
  mk(".opencode/agent/ut-writer.md");
  mk("node_modules/x/index.js");

  const skip = writerScopeSkip(tmp, path.join(tmp, "modA"));
  const snap = snapshotTree(tmp, { skipDir: skip });
  const keys = Object.keys(snap);
  check(
    "受保護：pom.xml、src/main、src/main/resources 都在快照裡",
    "pom.xml" in snap &&
      "modA/pom.xml" in snap &&
      "modA/src/main/java/com/x/Foo.java" in snap &&
      "modA/src/main/resources/application.yml" in snap,
    JSON.stringify(keys),
  );
  check(
    "可寫：目標模組的 src/test 整棵不在快照裡",
    !keys.some((k) => k.startsWith("modA/src/test/")),
    JSON.stringify(keys),
  );
  check(
    "受保護：其他模組的 src/test 仍在快照裡（只有目標模組可寫）",
    "modB/src/test/java/com/y/BarTest.java" in snap && "modB/src/main/java/com/y/Bar.java" in snap,
  );
  check(
    "排除：target / node_modules / dot-dirs 不進快照",
    !keys.some((k) => k.startsWith("modA/target/") || k.startsWith("node_modules/") || k.startsWith(".")),
    JSON.stringify(keys),
  );

  // the regression itself: a writer that "helpfully" edits production code must be caught,
  // while its legitimate test writes must not be
  const before = snapshotTree(tmp, { skipDir: skip });
  mk("modA/src/main/java/com/x/Foo.java", "class Foo { String tag() { return \"x\"; } }");
  mk("modA/src/test/java/com/x/FooTest.java", "class FooTest { void t() {} }");
  mk("modA/src/test/resources/fixture.json", "{}");
  const diff = diffSnapshots(before, snapshotTree(tmp, { skipDir: skip }));
  check(
    "regression：writer 改了 production code → 被抓到，且只列出那個檔",
    JSON.stringify(diff) === JSON.stringify(["modA/src/main/java/com/x/Foo.java"]),
    JSON.stringify(diff),
  );
  const before2 = snapshotTree(tmp, { skipDir: skip });
  mk("modA/pom.xml", "<project><dependencies/></project>");
  check(
    "writer 改了 pom.xml → 被抓到",
    diffSnapshots(before2, snapshotTree(tmp, { skipDir: skip })).includes("modA/pom.xml"),
  );

  // single-module repo: module root == repo root, so the writable tree is plain src/test
  const single = writerScopeSkip(tmp, tmp);
  check("單一模組：可寫範圍是 src/test", single("src/test", "test") && !single("src/main", "main"));

  // snapshotTree without options keeps its old behaviour (the test-tree diff relies on it)
  check(
    "snapshotTree 無選項：走訪全部（含 target 與 dot-dirs）",
    "modA/target/classes/Foo.class" in snapshotTree(tmp) && ".git/HEAD" in snapshotTree(tmp),
  );

  // a dangling symlink used to throw out of the walk; now it is simply not a file to compare
  let symlinkOk = true;
  try {
    fs.symlinkSync(path.join(tmp, "does-not-exist"), path.join(tmp, "modA", "dangling"));
  } catch {
    symlinkOk = false; // symlink creation needs privileges on some Windows setups — skip
  }
  if (symlinkOk) {
    check(
      "snapshotTree：dangling symlink 不會讓走訪炸掉",
      (() => {
        try {
          snapshotTree(tmp, { skipDir: skip });
          return true;
        } catch {
          return false;
        }
      })(),
    );
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 16. Coverage report freshness: a report older than this round's build is not this round's
// ---------------------------------------------------------------------------
console.log("\n[16] reportIsStale（JaCoCo 報告新鮮度）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-fresh-"));
  const xml = path.join(tmp, "jacoco.xml");
  fs.writeFileSync(xml, "<report/>");
  const now = Date.now();
  check("建置開始前就寫好的報告 → 視為陳舊", reportIsStale(xml, now + 60_000) === true);
  check("建置開始後才寫的報告 → 新鮮", reportIsStale(xml, now - 60_000) === false);
  check("不給 since → 不檢查（相容舊呼叫）", reportIsStale(xml, undefined) === false);
  check("報告檔不存在 → 視為陳舊而非拋錯", reportIsStale(path.join(tmp, "nope.xml"), now) === true);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 17. Shrink guard + repair prompt: "fixed" must not mean "deleted"
// ---------------------------------------------------------------------------
console.log("\n[17] testMetrics / findShrunk / buildRepairPrompt（防掏空）");
{
  const src = `package com.x;
import org.junit.jupiter.api.*;
class FooTest {
    // @Test in a line comment must not count
    /* assertEquals(1, 1); in a block comment */
    @Test void a() { assertEquals(1, 1); assertThat(x).isEqualTo(2); }
    @ParameterizedTest @ValueSource(ints = {1}) void b(int i) { verify(mock).run(); }
    @Test void c() { String s = "assertTrue( inside a string"; fail("boom"); }
    @Disabled("flaky") @Test void d() { then(mock).should().go(); }
}`;
  const m = testMetrics(src);
  check(
    "testMetrics：@Test 類註解計 4（含 @ParameterizedTest；註解裡的不算）",
    m.tests === 4,
    JSON.stringify(m),
  );
  check(
    "testMetrics：斷言計 5（assert*/verify*/fail/should；註解與字串裡的不算）",
    m.assertions === 5,
    JSON.stringify(m),
  );
  check("testMetrics：@Disabled 計 1", m.disabled === 1, JSON.stringify(m));
  const skips = testMetrics(`class T {
    @Ignore @Test public void a() { assertEquals(1, 2); }
    @Test(enabled = false) public void b() { assertEquals(1, 2); }
    @EnabledOnOs(OS.WINDOWS) @Test void c() { assertEquals(1, 2); }
    @Test void d() { Assume.assumeTrue(false); assertEquals(1, 2); }
    @Test void e() { assumingThat(false, () -> {}); calc.assumeRate(1); }
}`);
  check(
    "testMetrics：JUnit 4 的 @Ignore、TestNG 的 enabled = false、條件式 @Enabled…、assumeTrue / assumingThat 都算略過標記（assumeRate 這種一般方法不算）",
    skips.disabled === 5,
    JSON.stringify(skips),
  );
  check(
    "testMetrics：TestNG 的 enabled = false 只在 @Test(…) 裡算——測試裡的 `boolean enabled = false;` 是程式碼",
    testMetrics("class T { @Test void a() { boolean enabled = false; config.enabled = false; assertFalse(enabled); } }").disabled === 0,
  );
  const silenced = testMetrics(`import static org.junit.jupiter.api.Assumptions.abort;
class T {
    @Test void a() { Assumptions.abort("later"); }
    @Test void b() { abort(); }
    @Test void c() { throw new SkipException("x"); }
    @Test void d() { throw new org.opentest4j.TestAbortedException(); }
    @Test public void e() { throw new AssumptionViolatedException("x"); }
    @Test private void f() { assertEquals(1, 2); }
    @Test static void g() { assertEquals(1, 2); }
    @Test int h() { assertEquals(1, 2); return 0; }
    @TestFactory Stream<DynamicTest> i() { return Stream.empty(); }
    @ParameterizedTest @ValueSource(ints = {1, 2}) void j(int x) { transaction.abort(); }
}`);
  check(
    "testMetrics：abort、丟 SkipException / TestAbortedException / AssumptionViolatedException、private / static / 有回傳值的 @Test 都算略過（@TestFactory 的回傳值與一般物件的 abort() 不算）",
    silenced.disabled === 8 && silenced.tests === 10,
    JSON.stringify(silenced),
  );
  check("testMetrics：沒有從 Assumptions 靜態 import 的 abort() 是一般方法", testMetrics("class T { @Test void a() { abort(); } }").disabled === 0);
  check(
    "runnableTests：abstract 類別裡的 @Test 不會自己執行；TestNG 掛在類別上的 @Test 不是測試方法；巢狀泛型的方法照樣算",
    runnableTests("abstract class B { @Test void a() {} } class C extends B { @Test void b() {} }") === 1 &&
      runnableTests("@Test public class N { public void a() {} }") === 0 &&
      runnableTests("class G { @Test <T extends Comparable<T>> void generic() {} }") === 1,
  );
  check(
    "testMetrics：把失敗的測試類別改成 abstract → @Test 一個不少，會自己執行的變 0（防掏空看得到）；在既有的 abstract 基底類別加測試不影響",
    (() => {
      const concrete = testMetrics("class FooTest { @Test void a() { assertEquals(1, 2); } }");
      const madeAbstract = testMetrics("abstract class FooTest { @Test void a() { assertEquals(1, 2); } }");
      const baseGrown = testMetrics("abstract class Base { @Test void a() {} @Test void b() {} }");
      return concrete.runnable === 1 && madeAbstract.tests === 1 && madeAbstract.runnable === 0 && baseGrown.runnable === 0 &&
        findShrunk({ "F.java": concrete }, { "F.java": madeAbstract }).length === 1 &&
        findShrunk({ "B.java": testMetrics("abstract class Base { @Test void a() {} }") }, { "B.java": baseGrown }).length === 0;
    })(),
  );
  check(
    "testMetrics：在既有測試上方插入沒關上的 /** → 編不過的是這個 /**，不是「刪掉了測試」（交給建置報錯）",
    (() => {
      const ok = testMetrics("class T {\n  @Test void a() { assertEquals(1, 1); }\n  @Test void b() { assertEquals(2, 2); }\n}");
      const broken = testMetrics("class T {\n  /** half a doc\n  @Test void a() { assertEquals(1, 1); }\n  @Test void b() { assertEquals(2, 2); }\n}");
      return findShrunk({ "T.java": ok }, { "T.java": broken }).length === 0;
    })(),
  );
  check(
    "testMetrics：在既有測試上方插入沒關上的 text block（\"\"\"）→ 同樣交給建置報錯，後面的測試照算",
    (() => {
      const ok = testMetrics("class T {\n  @Test void a() { assertEquals(1, 1); }\n  @Test void b() { assertEquals(2, 2); }\n}");
      const broken = testMetrics('class T {\n  String s = """\n  @Test void a() { assertEquals(1, 1); }\n  @Test void b() { assertEquals(2, 2); }\n}');
      return findShrunk({ "T.java": ok }, { "T.java": broken }).length === 0;
    })(),
  );
  check(
    "testMetrics：字串裡的 /*（\"**/*.java\"）不會吃掉後面到下一個註解之間的測試",
    testMetrics('class T {\n  String glob = "**/*.java";\n  @Test void a() { assertEquals(1, 1); }\n  /** doc */\n  @Test void b() { assertEquals(2, 2); }\n}').tests === 2,
  );
  check(
    "testMetrics：行尾註解裡的 assertEquals( / @Disabled 不算",
    (() => {
      const t = testMetrics("class T { @Test void a() { run(); // assertEquals(1, 1) @Disabled\n } }");
      return t.assertions === 0 && t.disabled === 0;
    })(),
  );
  check(
    "testMetrics：全限定名的 @org.junit.jupiter.api.Test / @org.junit.Ignore 照樣算",
    (() => {
      const t = testMetrics("class T { @org.junit.jupiter.api.Test void a() {} @org.junit.Ignore @org.junit.Test public void b() {} @TestInstance(PER_CLASS) class N {} }");
      return t.tests === 2 && t.disabled === 1;
    })(),
  );

  const foo = { tests: 4, assertions: 5, disabled: 1, runnable: 3 };
  const bar = { tests: 2, assertions: 2, disabled: 0, runnable: 2 };
  const before = { "com/x/FooTest.java": foo, "com/x/BarTest.java": bar };
  const with_ = (m2: Partial<typeof foo>) => ({ ...before, "com/x/FooTest.java": { ...foo, ...m2 } });
  check("findShrunk：無變化 → 空", findShrunk(before, before).length === 0);
  const fewerTests = findShrunk(before, with_({ tests: 3 }));
  check(
    "findShrunk：@Test 減少 → 違規並點名",
    fewerTests.length === 1 && fewerTests[0].file === "com/x/FooTest.java",
  );
  check("findShrunk：斷言減少 → 違規", findShrunk(before, with_({ assertions: 4 })).length === 1);
  check("findShrunk：新增 @Disabled → 違規", findShrunk(before, with_({ disabled: 2 })).length === 1);
  check("findShrunk：會自己執行的 @Test 變少（類別改成 abstract）→ 違規", findShrunk(before, with_({ runnable: 2 })).length === 1);
  const del = findShrunk(before, { "com/x/FooTest.java": foo });
  check(
    "findShrunk：檔案被刪 → 違規且 after=null",
    del.length === 1 && del[0].file === "com/x/BarTest.java" && del[0].after === null,
  );
  const grown = {
    ...before,
    "com/x/FooTest.java": { tests: 6, assertions: 9, disabled: 0, runnable: 6 },
    "com/x/NewTest.java": { tests: 3, assertions: 3, disabled: 0, runnable: 3 },
  };
  check("findShrunk：增加、或 writer 新建的檔 → 不違規", findShrunk(before, grown).length === 0);
  check(
    "findShrunk：writer 自己新建的檔之後縮水也不受約束（不在 before 裡）",
    findShrunk(before, { ...grown, "com/x/NewTest.java": { tests: 0, assertions: 0, disabled: 0, runnable: 0 } })
      .length === 0,
  );

  const fb = renderShrinkFeedback([...del, ...fewerTests]);
  check(
    "renderShrinkFeedback：點名檔案與前後數字",
    fb.includes("BarTest.java：檔案被刪除") && fb.includes("@Test 4 → 3"),
    fb,
  );

  // collectTestMetrics walks the tree and keys by test-root-relative path
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-metrics-"));
  fs.mkdirSync(path.join(tmp, "com", "x"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "com", "x", "FooTest.java"), src);
  fs.writeFileSync(path.join(tmp, "com", "x", "notes.txt"), "@Test not java");
  const snap = collectTestMetrics(tmp);
  check(
    "collectTestMetrics：只收 .java，key 為相對路徑",
    Object.keys(snap).length === 1 && snap["com/x/FooTest.java"]?.tests === 4,
    JSON.stringify(snap),
  );
  check("collectTestMetrics：不存在的目錄 → 空", Object.keys(collectTestMetrics(path.join(tmp, "nope"))).length === 0);
  // An MS950 test: 功 is 0xA5 0x5C, and read as UTF-8 that "\" escapes the closing quote.
  const ms950Test = Buffer.concat([
    Buffer.from('package com.x;\nimport org.junit.jupiter.api.*;\nclass LegacyTest {\n    @DisplayName("'),
    Buffer.from([0xb7, 0x73, 0xbc, 0x57, 0xa6, 0xa8, 0xa5, 0x5c]), // 新增成功
    Buffer.from('") @Test void add() { Assertions.assertEquals(3, 1 + 2); }\n    @DisplayName("'),
    Buffer.from([0xa7, 0x52, 0xb0, 0xa3, 0xa6, 0xa8, 0xa5, 0x5c]), // 刪除成功
    Buffer.from('") @Test void remove() { Assertions.assertEquals(1, 0 + 1); }\n}\n'),
  ]);
  fs.rmSync(path.join(tmp, "com", "x", "FooTest.java"));
  fs.writeFileSync(path.join(tmp, "com", "x", "LegacyTest.java"), ms950Test);
  const legacy = collectTestMetrics(tmp, "MS950")["com/x/LegacyTest.java"];
  check(
    "collectTestMetrics：MS950 的測試以 MS950 讀——「成功」的 \\ 不會吃掉引號，2 個 @Test、2 個斷言都數得到",
    legacy?.tests === 2 && legacy.assertions === 2,
    JSON.stringify(legacy),
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  const rp = buildRepairPrompt({
    brokenFiles: ["modA/src/test/java/com/x/CacheServiceImplTest.java", "com.x.SamlServiceImplTest"],
    report: "[ERROR] CacheServiceImplTest.java:[4,27] cannot find symbol",
    standards: "STANDARDS-HERE",
    mod: { moduleRoot: "/x", moduleRel: "modA", multiModule: true },
    round: 2,
  });
  check(
    "buildRepairPrompt：列出壞檔、帶錯誤節錄、講明不得刪減與不得碰 production、帶輪次與 standards",
    rp.includes("CacheServiceImplTest.java") &&
      rp.includes("com.x.SamlServiceImplTest") &&
      rp.includes("cannot find symbol") &&
      rp.includes("不得減少") &&
      rp.includes("production code") &&
      rp.includes("第 2 輪") &&
      rp.includes("STANDARDS-HERE"),
  );
}

// ---------------------------------------------------------------------------
// 18. api runner: the tool list is the permission model; the loop drives a scripted transport
// ---------------------------------------------------------------------------
console.log("\n[18] api runner（api-tools 權限 + 假 transport 的 tool loop）");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-api-"));
  const repo = path.join(tmp, "repo");
  const mk = (rel: string, body: string) => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  mk("pom.xml", "<project/>");
  mk("modA/src/main/java/com/x/Foo.java", "package com.x;\npublic class Foo { public int a() { return 1; } }\n");
  mk("modA/src/test/java/com/x/OldTest.java", "package com.x;\nclass OldTest { void t() { int x = 1; int y = 1; } }\n");
  mk("modA/target/classes/Foo.class", "bin");
  const writable = path.join(repo, "modA", "src", "test");
  const ctx = { repoRoot: repo, writableRoot: writable, maxResultChars: 4000 };
  const all = toolsFor(false);
  const ro = toolsFor(true);
  const prod = path.join(repo, "modA/src/main/java/com/x/Foo.java");

  check("resolveInside：repo 內 → 絕對路徑", resolveInside(repo, "modA/pom.xml") === path.join(repo, "modA", "pom.xml"));
  check("resolveInside：../ 逃逸 → null", resolveInside(repo, "../../etc/passwd") === null);
  check("resolveInside：repo 外的絕對路徑 → null", resolveInside(repo, tmp) === null);
  check("resolveInside：root 本身 → 允許", resolveInside(repo, ".") === repo);

  check("read_file：讀到內容", execTool("read_file", { path: "modA/src/main/java/com/x/Foo.java" }, ctx, all).includes("class Foo"));
  check(
    "read_file：超過上限截斷並標明",
    execTool("read_file", { path: "modA/src/main/java/com/x/Foo.java" }, { ...ctx, maxResultChars: 10 }, all).includes("已截斷"),
  );
  check("read_file：repo 外 → 錯誤字串、不拋例外", execTool("read_file", { path: "../../x" }, ctx, all).startsWith("錯誤"));
  check("read_file：不存在 → 錯誤", execTool("read_file", { path: "nope.java" }, ctx, all).startsWith("錯誤"));

  const ls = execTool("list_files", { dir: "modA", pattern: "*.java" }, ctx, all);
  check(
    "list_files：glob 過濾、略過 target",
    ls.includes("modA/src/main/java/com/x/Foo.java") && ls.includes("OldTest.java") && !ls.includes("Foo.class"),
    ls,
  );
  const sr = execTool("search", { pattern: "class \\w+", dir: "modA", glob: "*.java" }, ctx, all);
  check("search：回傳 路徑:行號: 內容", /Foo\.java:2: .*class Foo/.test(sr) && sr.includes("OldTest.java:2:"), sr);
  check("search：無效 regex → 錯誤字串", execTool("search", { pattern: "(" }, ctx, all).startsWith("錯誤"));

  const refused = execTool("write_file", { path: "modA/src/main/java/com/x/Foo.java", content: "x" }, ctx, all);
  check(
    "write_file：production 路徑被拒，檔案未動",
    refused.startsWith("錯誤：拒絕寫入") && fs.readFileSync(prod, "utf8").includes("return 1"),
    refused,
  );
  check("write_file：pom.xml 被拒", execTool("write_file", { path: "modA/pom.xml", content: "x" }, ctx, all).startsWith("錯誤：拒絕"));
  check(
    "write_file：src/test 內成功並自動建目錄",
    execTool("write_file", { path: "modA/src/test/java/com/x/FooTest.java", content: "class FooTest {}" }, ctx, all).startsWith("已寫入") &&
      fs.existsSync(path.join(writable, "java/com/x/FooTest.java")),
  );
  check(
    "write_file：沒有 writableRoot → 一律拒絕",
    execTool("write_file", { path: "modA/src/test/java/X.java", content: "" }, { ...ctx, writableRoot: undefined }, all).startsWith("錯誤"),
  );
  const oldTest = "modA/src/test/java/com/x/OldTest.java";
  check(
    "replace_in_file：唯一片段 → 替換",
    execTool("replace_in_file", { path: oldTest, old_string: "void t()", new_string: "void t2()" }, ctx, all).startsWith("已替換") &&
      fs.readFileSync(path.join(repo, oldTest), "utf8").includes("t2()"),
  );
  check("replace_in_file：找不到 → 錯誤", execTool("replace_in_file", { path: oldTest, old_string: "nope", new_string: "" }, ctx, all).startsWith("錯誤"));
  check(
    "replace_in_file：多處命中 → 錯誤（要求更長片段）",
    execTool("replace_in_file", { path: oldTest, old_string: "= 1;", new_string: "= 2;" }, ctx, all).includes("2 次"),
  );
  check("reviewer 工具集：全部唯讀、沒有 write/replace", ro.length > 0 && ro.every((t) => t.readOnly) && !ro.some((t) => /write|replace/.test(t.name)));
  check(
    "reviewer 呼叫 write_file → 未知工具（結構性唯讀）",
    execTool("write_file", { path: "modA/src/test/java/Z.java", content: "" }, ctx, ro).startsWith("錯誤：未知"),
  );
  check(
    "toOpenAiTools：OpenAI function 形狀",
    (toOpenAiTools(all) as Array<{ type: string; function: { name: string; parameters: { type: string } } }>).every(
      (t) => t.type === "function" && typeof t.function.name === "string" && t.function.parameters.type === "object",
    ),
  );

  // --- the loop over a scripted transport ---
  type Body = { model: string; temperature: number; tools: Array<{ function: { name: string } }>; messages: Array<Record<string, any>> };
  const reply = (message: Record<string, unknown>, tokens = 7) =>
    new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { completion_tokens: tokens } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const base = { repoRoot: repo, writableRoot: writable, baseUrl: "http://fake/v1", models: { writer: "m", reviewer: "m" }, retryDelayMs: 0 };

  const seen: Body[] = [];
  const scripted: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    seen.push(body);
    const n = body.messages.filter((m) => m.role === "tool").length;
    if (n === 0) return reply({ role: "assistant", content: null, tool_calls: [call("c1", "read_file", { path: "modA/src/main/java/com/x/Foo.java" })] });
    if (n === 1) {
      return reply({
        role: "assistant",
        content: "",
        tool_calls: [call("c2", "write_file", { path: "modA/src/test/java/com/x/FooTest.java", content: "class FooTest { @Test void a() {} }" })],
      });
    }
    return reply({ role: "assistant", content: "完成：FooTest.java" }, 11);
  };
  const out = await new ApiRunner({ ...base, fetchImpl: scripted }).runWriter("寫測試");
  check("ApiRunner：3 個回合跑完，回傳最終文字", out.status === "ok" && out.text === "完成：FooTest.java", JSON.stringify(out));
  check("ApiRunner：tool call 精確計數 = 2", out.toolCallCount === 2, String(out.toolCallCount));
  check("ApiRunner：output tokens 為各回合加總 = 25", out.outputTokens === 25, String(out.outputTokens));
  check("ApiRunner：write_file 真的落地", fs.readFileSync(path.join(writable, "java/com/x/FooTest.java"), "utf8").includes("@Test"));
  check(
    "ApiRunner：請求帶 tools / model / temperature / system 角色契約",
    seen[0].tools.length === all.length && seen[0].model === "m" && seen[0].temperature === 0.2 &&
      seen[0].messages[0].role === "system" && String(seen[0].messages[0].content).includes("測試"),
    JSON.stringify({ tools: seen[0].tools.length, model: seen[0].model, temperature: seen[0].temperature }),
  );
  const last1 = seen[1].messages[seen[1].messages.length - 1];
  check("ApiRunner：tool 結果以 role=tool 回送並帶 tool_call_id", last1.role === "tool" && last1.tool_call_id === "c1" && String(last1.content).includes("class Foo"));

  const seenR: Body[] = [];
  const reviewerFetch: typeof fetch = async (_u, init) => {
    seenR.push(JSON.parse(String(init?.body)) as Body);
    return reply({ role: "assistant", content: "{}" });
  };
  await new ApiRunner({ ...base, fetchImpl: reviewerFetch }).runReview("審查");
  check(
    "ApiRunner：reviewer 的 tools 只有唯讀那幾個",
    seenR[0].tools.length === ro.length && seenR[0].tools.every((t) => ro.some((s) => s.name === t.function.name)),
  );
  check("ApiRunner：reviewer temperature = 0（架構規定）", seenR[0].temperature === 0);

  const dead: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  check("ApiRunner：第一個請求就連不上 → spawn-error（環境問題）", (await new ApiRunner({ ...base, fetchImpl: dead }).runWriter("x")).status === "spawn-error");

  // --- an answer that is not in `content` -------------------------------------------------
  // Reported: the reviewer ran 193s and 38 tool calls, then the gate got an empty string and
  // blamed the writer for it. Two shapes produce that, and neither is the tests being bad.
  const reasoningFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const n = body.messages.filter((m) => m.role === "tool").length;
    if (n === 0) return reply({ role: "assistant", content: null, tool_calls: [call("c1", "read_file", { path: "modA/src/main/java/com/x/Foo.java" })] });
    // QwQ / R1 shape: the answer is in reasoning_content and content is empty.
    return reply({ role: "assistant", content: "", reasoning_content: '{"scores":{}}' });
  };
  const rOut = await new ApiRunner({ ...base, fetchImpl: reasoningFetch }).runReview("審查");
  check(
    "ApiRunner：推理型模型把答案放 reasoning_content 時也讀得到（content 空不等於沒說話）",
    rOut.status === "ok" && rOut.text.includes('"scores"'),
    JSON.stringify(rOut),
  );

  const lateEmptyFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const n = body.messages.filter((m) => m.role === "tool").length;
    if (n === 0) {
      return reply({ role: "assistant", content: '{"scores":{"x":1}}', tool_calls: [call("c1", "read_file", { path: "modA/src/main/java/com/x/Foo.java" })] });
    }
    return reply({ role: "assistant", content: "" }); // empty message closing the tool round
  };
  const lOut = await new ApiRunner({ ...base, fetchImpl: lateEmptyFetch }).runReview("審查");
  check(
    "ApiRunner：最後一則空訊息不得丟掉先前說過的話（判決已經給了就別扔）",
    lOut.status === "ok" && lOut.text.includes('"scores"'),
    JSON.stringify(lOut),
  );

  const allEmptyFetch: typeof fetch = async () => reply({ role: "assistant", content: "" });
  const eOut = await new ApiRunner({ ...base, fetchImpl: allEmptyFetch }).runReview("審查");
  check(
    "ApiRunner：從頭到尾都沒說話 → 不得報 ok（空字串不是判決）",
    eOut.status !== "ok" && eOut.text === "",
    JSON.stringify(eOut),
  );
  check("ApiRunner：未設 base URL → spawn-error", (await new ApiRunner({ ...base, baseUrl: "", fetchImpl: dead }).runWriter("x")).status === "spawn-error");
  check(
    "ApiRunner：未設模型 → spawn-error",
    (await new ApiRunner({ ...base, models: { writer: "", reviewer: "" }, fetchImpl: dead }).runWriter("x")).status === "spawn-error",
  );

  const forever: typeof fetch = async () => reply({ role: "assistant", content: null, tool_calls: [call("c", "list_files", { dir: "." })] });
  const o5 = await new ApiRunner({ ...base, fetchImpl: forever, maxTurns: 3 }).runWriter("x");
  check("ApiRunner：回合預算用盡 → status=timeout，不會無限迴圈", o5.status === "timeout" && o5.toolCallCount === 3, JSON.stringify(o5));

  let badSeen = false;
  const badArgs: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    const n = b.messages.filter((m) => m.role === "tool").length;
    if (n === 0) return reply({ role: "assistant", content: null, tool_calls: [{ id: "b1", type: "function", function: { name: "read_file", arguments: "{not json" } }] });
    badSeen = String(b.messages[b.messages.length - 1].content).includes("不是合法 JSON");
    return reply({ role: "assistant", content: "ok" });
  };
  const o6 = await new ApiRunner({ ...base, fetchImpl: badArgs }).runWriter("x");
  check("ApiRunner：arguments 非 JSON → 錯誤回送模型、loop 繼續", o6.status === "ok" && badSeen);

  // 5xx is retried, then succeeds
  let hits = 0;
  const flaky: typeof fetch = async () => {
    hits++;
    if (hits < 3) return new Response("overloaded", { status: 503 });
    return reply({ role: "assistant", content: "recovered" });
  };
  const o7 = await new ApiRunner({ ...base, fetchImpl: flaky }).runWriter("x");
  check("ApiRunner：5xx 重試後成功", o7.status === "ok" && o7.text === "recovered" && hits === 3, `hits=${hits}`);
  // 4xx is final: no retry storm against a bad key or unknown model
  hits = 0;
  const denied: typeof fetch = async () => {
    hits++;
    return new Response('{"error":"invalid api key"}', { status: 401 });
  };
  const o8 = await new ApiRunner({ ...base, fetchImpl: denied }).runWriter("x");
  check("ApiRunner：401 不重試、判 spawn-error", o8.status === "spawn-error" && hits === 1, `hits=${hits}`);

  // --- mid-run failures (reported: runs stopping half-way "for no reason") ------------------
  // One runner per run, as loop.ts creates it. `script` answers each request in order; after
  // the list runs out, every request gets the last entry.
  const sequenced = (script: Array<number | Record<string, unknown>>) => {
    let n = 0;
    const f: typeof fetch = async () => {
      const step = script[Math.min(n++, script.length - 1)];
      if (typeof step === "number") return new Response('{"error":{"message":"overloaded"}}', { status: step });
      return reply(step);
    };
    return { f, calls: () => n };
  };
  const ok = { role: "assistant", content: "done" };

  const burst = sequenced([ok, 503, 503, 503, 503, ok]);
  const rb = new ApiRunner({ ...base, fetchImpl: burst.f });
  await rb.runWriter("round 1");
  const burstOut = await rb.runWriter("round 2");
  check(
    "ApiRunner：端點回應過之後，session 開頭連續 4 次 503 → 重試到恢復，不是 spawn-error",
    burstOut.status === "ok" && burstOut.text === "done" && burst.calls() === 6,
    `${JSON.stringify(burstOut)} calls=${burst.calls()}`,
  );

  const never = sequenced([503]);
  const neverOut = await new ApiRunner({ ...base, fetchImpl: never.f }).runWriter("x");
  check(
    "ApiRunner：端點從未回應過 → 快速試 3 次就判 spawn-error（網址或 proxy 設錯要秒報）",
    neverOut.status === "spawn-error" && never.calls() === 3,
    `${neverOut.status} calls=${never.calls()}`,
  );

  const outage = sequenced([ok, 503]);
  const ro2 = new ApiRunner({ ...base, fetchImpl: outage.f, retryWindowMs: 0 });
  await ro2.runWriter("round 1");
  const outageOut = await ro2.runWriter("round 2");
  check(
    "ApiRunner：回應過之後持續失敗（超過重試窗）→ timeout 而非 spawn-error（不得中止整個 run 並叫人裝 opencode）",
    outageOut.status === "timeout",
    JSON.stringify(outageOut),
  );
  check("ApiRunner：UT_AGENT_RETRY_WINDOW_MS=0 → 回應過之後真的不重試（文件說 0 = 不重試）", outage.calls() === 2, `calls=${outage.calls()}`);
  const longOutage = sequenced([ok, ...Array(25).fill(503), ok]);
  const rLong = new ApiRunner({ ...base, fetchImpl: longOutage.f, retryWindowMs: 10 * 60 * 60 * 1000 });
  await rLong.runWriter("round 1");
  const longOut = await rLong.runWriter("round 2");
  check(
    "ApiRunner：重試窗設很長（10 小時）時不被寫死的次數上限提早結束（連續 25 次 503 後恢復）",
    longOut.status === "ok" && longOutage.calls() === 27,
    `${longOut.status} calls=${longOutage.calls()}`,
  );

  const revoked = sequenced([ok, 401]);
  const rr = new ApiRunner({ ...base, fetchImpl: revoked.f });
  await rr.runWriter("round 1");
  check("ApiRunner：回應過之後遇到 401 → 仍是 spawn-error（金鑰是設定問題）", (await rr.runWriter("round 2")).status === "spawn-error");

  const bodies: Body[] = [];
  let overflowed = false;
  const bigRead = "x".repeat(3000);
  fs.writeFileSync(path.join(repo, "modA/src/main/java/com/x/Big.java"), bigRead);
  const ctxFetch: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    bodies.push(b);
    const n = b.messages.filter((m) => m.role === "tool").length;
    if (n < 2) return reply({ role: "assistant", content: null, tool_calls: [call(`r${n}`, "read_file", { path: "modA/src/main/java/com/x/Big.java" })] });
    if (!overflowed) {
      overflowed = true;
      return new Response(
        JSON.stringify({ object: "error", message: "This model's maximum context length is 8000 tokens. However, you requested 9000 tokens (5000 in the messages, 4000 in the completion)." }),
        { status: 400 },
      );
    }
    return reply({ role: "assistant", content: "wrote it" });
  };
  const ctxOut = await new ApiRunner({ ...base, fetchImpl: ctxFetch, maxTokens: 4000 }).runWriter("x");
  const retried = bodies[bodies.length - 1];
  const toolMsgs = retried.messages.filter((m) => m.role === "tool");
  check("ApiRunner：context 滿了 → 縮短對話後繼續，session 正常完成", ctxOut.status === "ok" && ctxOut.text === "wrote it", JSON.stringify(ctxOut));
  check(
    "ApiRunner：縮短的是較早的工具結果，最近一次的結果原封不動",
    toolMsgs.length === 2 && String(toolMsgs[0].content).includes("已省略") && toolMsgs[1].content === bigRead,
    JSON.stringify(toolMsgs.map((m) => String(m.content).slice(0, 40))),
  );
  check(
    "ApiRunner：縮短後 tool_call_id 配對不變（伺服器會拒絕沒有對應呼叫的 tool 訊息）",
    toolMsgs[0].tool_call_id === "r0" && toolMsgs[1].tool_call_id === "r1",
  );
  check("ApiRunner：縮短不動 system 與任務 prompt", retried.messages[0].role === "system" && retried.messages[1].content === "x");

  const fitBodies: Body[] = [];
  let fitOverflowed = false;
  const fitFetch: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    fitBodies.push(b);
    if (!fitOverflowed) {
      fitOverflowed = true;
      return new Response(
        JSON.stringify({ message: "'max_tokens' is too large: 8192. This model's maximum context length is 16384 tokens and your request has 9000 input tokens (8192 > 16384 - 9000)." }),
        { status: 400 },
      );
    }
    return reply({ role: "assistant", content: "fits" });
  };
  const fitOut = await new ApiRunner({ ...base, fetchImpl: fitFetch, maxTokens: 8192 }).runReview("審查");
  check(
    "ApiRunner：沒有可省略的內容時，把 max_tokens 降到伺服器說得下的量（16384-9000-32）",
    fitOut.status === "ok" && (fitBodies[1] as unknown as { max_tokens: number }).max_tokens === 16384 - 9000 - 32,
    JSON.stringify({ status: fitOut.status, max: (fitBodies[1] as unknown as { max_tokens?: number })?.max_tokens }),
  );

  const hopeless: typeof fetch = async () =>
    new Response(JSON.stringify({ message: "This model's maximum context length is 4096 tokens. However, your request has 9000 input tokens." }), { status: 400 });
  const hopelessOut = await new ApiRunner({ ...base, fetchImpl: hopeless }).runWriter("x");
  check(
    "ApiRunner：prompt 本身就塞不下且無可省略 → 如實結束，不無限重送",
    hopelessOut.status !== "ok",
    JSON.stringify(hopelessOut),
  );

  // Headers arrive, the body never does: a dead connection mid-response. The deadline used to
  // be cleared at the headers, so this waited forever with the heartbeat still ticking.
  const stalled: typeof fetch = async (_u, init) => {
    const signal = init?.signal as AbortSignal;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":'));
        signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    });
    return new Response(stream, { status: 200 });
  };
  const t0 = Date.now();
  const stallOut = await new ApiRunner({ ...base, fetchImpl: stalled, timeoutMs: 400 }).runWriter("x");
  check(
    "ApiRunner：回應 body 卡住 → 在 session 期限內逾時結束，不會永遠掛著",
    stallOut.status === "timeout" && Date.now() - t0 < 5000,
    `${stallOut.status} after ${Date.now() - t0}ms`,
  );

  // max_tokens cut the write_file off mid-arguments: vLLM returns the fragment as text.
  const cutBodies: Body[] = [];
  let cutSent = 0;
  const cutFetch: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    cutBodies.push(b);
    if (cutSent++ === 0) {
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: '<tool_call>\n{"name": "write_file", "arguments": {"path": "x", "content": "' + "z".repeat(5000) }, finish_reason: "length" }] }),
        { status: 200 },
      );
    }
    return reply({ role: "assistant", content: "寫好了" });
  };
  const cutOut = await new ApiRunner({ ...base, fetchImpl: cutFetch }).runWriter("x");
  const nudge = cutBodies[1]?.messages[cutBodies[1].messages.length - 1];
  check("ApiRunner：finish_reason=length 的回覆不是答案 → 告訴模型被截斷、session 繼續", cutOut.status === "ok" && cutOut.text === "寫好了", JSON.stringify(cutOut));
  check("ApiRunner：截斷提示以 user 訊息送出並要求改小步驟", nudge?.role === "user" && String(nudge.content).includes("截斷") && String(nudge.content).includes("replace_in_file"));
  check("ApiRunner：半截內容回送前先裁短（不把 context 花在碎片上）", String(cutBodies[1]?.messages[cutBodies[1].messages.length - 2]?.content).length < 2000);

  const alwaysCut: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "<tool_call>{" }, finish_reason: "length" }] }), { status: 200 });
  const acOut = await new ApiRunner({ ...base, fetchImpl: alwaysCut }).runWriter("x");
  check("ApiRunner：一直被截斷 → 有上限，且不報 ok（writer 什麼都沒寫）", acOut.status === "timeout", JSON.stringify(acOut));

  // A gateway's 200 that carries no completion is a failed request, not an empty answer.
  let gwHits = 0;
  const gatewayFetch: typeof fetch = async () => {
    gwHits++;
    if (gwHits === 2) return new Response('{"error":{"message":"upstream request timeout","code":504}}', { status: 200 });
    if (gwHits === 3) return new Response('{"choices":[]}', { status: 200 });
    return reply({ role: "assistant", content: "after the outage" });
  };
  const rg = new ApiRunner({ ...base, fetchImpl: gatewayFetch });
  await rg.runWriter("reach");
  const gwOut = await rg.runWriter("x");
  check(
    "ApiRunner：200 但內容是閘道錯誤 / 空 choices → 重試，不是模型的空答案",
    gwOut.status === "ok" && gwOut.text === "after the outage" && gwHits === 4,
    `${JSON.stringify(gwOut)} hits=${gwHits}`,
  );

  const reasoningNew: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    if (!b.messages.some((m) => m.role === "tool")) {
      return reply({ role: "assistant", content: null, tool_calls: [call("r1", "read_file", { path: "modA/src/main/java/com/x/Foo.java" })] });
    }
    return reply({ role: "assistant", content: [{ type: "text", text: "" }], reasoning: '{"scores":{"a":1}}' });
  };
  const rnOut = await new ApiRunner({ ...base, fetchImpl: reasoningNew }).runReview("審查");
  check("ApiRunner：答案在 message.reasoning（新版 vLLM / Ollama 的欄位名）也讀得到", rnOut.status === "ok" && rnOut.text.includes('"scores"'), JSON.stringify(rnOut));

  // What goes back must be acceptable to a strict server: an id on every call, JSON-object args.
  const echoBodies: Body[] = [];
  const badEcho: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    echoBodies.push(b);
    if (echoBodies.length === 1) {
      return reply({
        role: "assistant",
        content: "",
        tool_calls: [{ type: "function", function: { name: "functions.write_file", arguments: '{"path": "modA/src/test/java/X.java", "content": "a "quoted" b"}' } }],
      });
    }
    return reply({ role: "assistant", content: "ok" });
  };
  await new ApiRunner({ ...base, fetchImpl: badEcho }).runWriter("x");
  const echoed = echoBodies[1].messages.find((m) => m.role === "assistant") as Record<string, any>;
  const answered = echoBodies[1].messages.find((m) => m.role === "tool") as Record<string, any>;
  check(
    "ApiRunner：回送的 tool call 一定有 id、arguments 一定是合法 JSON（vLLM ≤0.11 會對整段對話回 400）",
    typeof echoed.tool_calls[0].id === "string" && echoed.tool_calls[0].id.length > 0 && echoed.tool_calls[0].function.arguments === "{}",
    JSON.stringify(echoed.tool_calls),
  );
  check("ApiRunner：tool 訊息的 tool_call_id 對得上回送的 id", answered.tool_call_id === echoed.tool_calls[0].id);
  check("ApiRunner：模型沒逃脫的引號照樣回報為參數錯誤", String(answered.content).includes("不是合法 JSON"), String(answered.content));

  const alwaysCutArgs: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "write_file", arguments: '{"path":"a","content":"cut' } }] },
            finish_reason: "length",
          },
        ],
      }),
      { status: 200 },
    );
  const acaOut = await new ApiRunner({ ...base, fetchImpl: alwaysCutArgs }).runWriter("x");
  check("ApiRunner：tool call 參數一直被截斷 → 有上限（不會燒完 60 回合）", acaOut.status === "timeout" && (acaOut.toolCallCount ?? 0) <= 4, JSON.stringify(acaOut));

  // A request that fails only after running longer than the whole window still gets retried.
  let slowHits = 0;
  const slowFail: typeof fetch = async () => {
    slowHits++;
    if (slowHits === 2) {
      await new Promise((r) => setTimeout(r, 60));
      return new Response("gateway timeout", { status: 504 });
    }
    return reply({ role: "assistant", content: "fine" });
  };
  const rsf = new ApiRunner({ ...base, fetchImpl: slowFail, retryWindowMs: 10 });
  await rsf.runWriter("reach");
  const sfOut = await rsf.runWriter("x");
  check("ApiRunner：跑了比重試窗還久才 504 的請求照樣重試一次（窗從第一次失敗起算）", sfOut.status === "ok" && slowHits === 3, `${JSON.stringify(sfOut)} hits=${slowHits}`);

  // Cut off now and then, recovering each time: not a run of failures.
  let alt = 0;
  const altCut: typeof fetch = async () => {
    alt++;
    if (alt > 8) return reply({ role: "assistant", content: "all written" });
    if (alt % 2 === 1) {
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `t${alt}`, type: "function", function: { name: "write_file", arguments: '{"path":"a","content":"cut' } }] }, finish_reason: "length" }] }),
        { status: 200 },
      );
    }
    return reply({ role: "assistant", content: null, tool_calls: [call(`w${alt}`, "write_file", { path: "modA/src/test/java/com/x/Alt.java", content: "class Alt {}" })] });
  };
  const altOut = await new ApiRunner({ ...base, fetchImpl: altCut }).runWriter("x");
  check("ApiRunner：截斷與成功交替出現 → 不是「連續」截斷，session 照常完成", altOut.status === "ok" && altOut.text === "all written", JSON.stringify(altOut));

  // The reviewer's cut-off answer is asked to be shorter, not split into writes it cannot make.
  const revCutBodies: Body[] = [];
  const revCut: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    revCutBodies.push(b);
    if (revCutBodies.length === 1) return reply({ role: "assistant", content: null, tool_calls: [call("r", "read_file", { path: "modA/src/main/java/com/x/Foo.java" })] });
    if (revCutBodies.length === 2) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"scores":{"a":1}} 以下補充說明' }, finish_reason: "length" }] }), { status: 200 });
    }
    return reply({ role: "assistant", content: '{"scores":{"a":1}}' });
  };
  await new ApiRunner({ ...base, fetchImpl: revCut }).runReview("審查");
  const revNudge = String(revCutBodies[2]?.messages[revCutBodies[2].messages.length - 1]?.content ?? "");
  check("ApiRunner：reviewer 的回覆被截斷 → 要它縮短，不叫它用它沒有的 write_file", revNudge.includes("截斷") && !revNudge.includes("write_file"), revNudge);

  // The reviewer is never compacted: a verdict must rest on what it actually read.
  const revCtxBodies: Body[] = [];
  const revCtx: typeof fetch = async (_u, init) => {
    const b = JSON.parse(String(init?.body)) as Body;
    revCtxBodies.push(b);
    const n = b.messages.filter((m) => m.role === "tool").length;
    if (n < 2) return reply({ role: "assistant", content: null, tool_calls: [call(`rr${n}`, "read_file", { path: "modA/src/main/java/com/x/Big.java" })] });
    return new Response(JSON.stringify({ message: "This model's maximum context length is 4000 tokens. However, your request has 9000 input tokens." }), { status: 400 });
  };
  const revCtxOut = await new ApiRunner({ ...base, fetchImpl: revCtx }).runReview("審查");
  check(
    "ApiRunner：reviewer 的 context 滿了不省略它讀過的檔案（判決不能建立在「已省略」上）→ 未完成",
    revCtxOut.status === "timeout" && revCtxBodies.every((b) => b.messages.every((m) => !String(m.content ?? "").includes("已省略"))),
    JSON.stringify(revCtxOut),
  );

  let retryAfterHits = 0;
  const limited: typeof fetch = async () => {
    retryAfterHits++;
    if (retryAfterHits === 2) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    return reply({ role: "assistant", content: "ok" });
  };
  const rl = new ApiRunner({ ...base, fetchImpl: limited });
  await rl.runWriter("reach");
  check("ApiRunner：429 帶 Retry-After → 照等後重試成功", (await rl.runWriter("x")).status === "ok" && retryAfterHits === 3, `hits=${retryAfterHits}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 19. Scoped test runs: -Dtest values must be stable, deduped and complete
// ---------------------------------------------------------------------------
console.log("\n[19] testClassNames（UT_TEST_SCOPE=generated 的 -Dtest 組裝）");
{
  const names = testClassNames([
    "modA/src/test/java/com/x/FooTest.java",
    "modA/src/test/java/com/x/BarTest.java",
    "com/x/FooTest.java", // 同一個類別、不同相對基準 → 只算一次
    "modA\\src\\test\\java\\com\\x\\WinTest.java", // Windows 分隔符
    "modA/src/test/resources/fixture.json", // 非 .java → 排除
    ".java", // 退化輸入 → 排除
  ]);
  check(
    "去重、排序、跨基準與 Windows 路徑都取到簡單類名",
    JSON.stringify(names) === JSON.stringify(["BarTest", "FooTest", "WinTest"]),
    JSON.stringify(names),
  );
  check("空輸入 → 空陣列", testClassNames([]).length === 0);
  // 排序不只是美觀：build 指令若在相同兩輪之間變動，stuck 偵測就會失效
  check(
    "順序不同的相同輸入 → 相同結果（build 指令必須穩定）",
    JSON.stringify(testClassNames(["b/BTest.java", "a/ATest.java"])) ===
      JSON.stringify(testClassNames(["a/ATest.java", "b/BTest.java"])),
  );
  check(
    "-Dtest 字串",
    `-Dtest=${testClassNames(["x/OrderServiceTest.java", "x/CalcTest.java"]).join(",")}` ===
      "-Dtest=CalcTest,OrderServiceTest",
  );
}

// ---------------------------------------------------------------------------
// 20. parseSurefireXml / renderSurefireSuite (@Nested 的失敗只在 XML 裡)
// ---------------------------------------------------------------------------
// Shapes taken verbatim from a real surefire 3.5.6 run: the .txt for a @Nested-only class
// says "Tests run: 0, Failures: 0" while the XML for the same run records the real counts,
// the assertion message and the frame. Reading the .txt drops every reason.
console.log("\n[20] parseSurefireXml / renderSurefireSuite（@Nested 失敗明細）");
{
  const nestedXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="3.0.2" name="com.x.ProbeNestedTest" time="0.068" tests="3" errors="0" skipped="0" failures="1" flakes="0">
  <properties><property name="java.version" value="26"/></properties>
  <testcase name="deliberately_fails" classname="com.x.ProbeNestedTest$Inner" time="0.034">
    <failure message="訊息 ==&gt; expected: &lt;404&gt; but was: &lt;400&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: 訊息 ==> expected: <404> but was: <400>
\tat org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)
\tat org.assertj.core.api.Assertions.assertThat(Assertions.java:1)
\tat com.x.ProbeNestedTest$Inner.deliberately_fails(ProbeNestedTest.java:13)
\tat java.base/java.lang.reflect.Method.invoke(Method.java:565)
]]></failure>
  </testcase>
  <testcase name="passes" classname="com.x.ProbeNestedTest$Inner" time="0.001"/>
  <testcase name="ignored" classname="com.x.ProbeNestedTest$Inner" time="0"><skipped/></testcase>
</testsuite>`;
  const blindTxt =
    "Test set: com.x.ProbeNestedTest\n" +
    "Tests run: 0, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.068 s -- in com.x.ProbeNestedTest";

  // The regression itself: the old .txt-based path is blind to exactly this report.
  check("舊路徑：@Nested 的 .txt 摘要看不出有失敗", surefireHasFailure(blindTxt) === false);

  const suite = parseSurefireXml(nestedXml);
  check("XML 解析出 suite/計數", suite?.suite === "com.x.ProbeNestedTest" && suite?.tests === 3 && suite?.failures === 1, JSON.stringify(suite));
  check("類別名取自 testsuite@name，不是 case 的 classname", suite?.suite === "com.x.ProbeNestedTest");
  check("只有真正失敗的 case 進來（自閉合＝通過、skipped 不算）", suite?.cases.length === 1, JSON.stringify(suite?.cases));
  const c0 = suite!.cases[0];
  check("保留 @Nested 容器名", c0.name === "Inner.deliberately_fails", c0.name);
  check("message 的 XML entity 已還原", c0.message === "訊息 ==> expected: <404> but was: <400>", c0.message);
  check(
    "frame 取專案自己那一行，略過 junit/assertj/reflect",
    c0.frame === "at com.x.ProbeNestedTest$Inner.deliberately_fails(ProbeNestedTest.java:13)",
    c0.frame,
  );
  check("kind = failure", c0.kind === "failure");

  const rendered = renderSurefireSuite(suite!);
  check("渲染出的區塊帶真實計數", rendered.includes("測試 3、失敗 1、錯誤 0"), rendered);
  check("渲染出的區塊帶訊息與行號", rendered.includes("expected: <404>") && rendered.includes("ProbeNestedTest.java:13"), rendered);

  // surefire uses @DisplayName as classname when one is set — then it is not a type name,
  // which is why the suite name is the identifier and the classname only prefixes the method.
  const displayNameXml = `<testsuite name="com.x.HandlerTest" tests="1" errors="0" skipped="0" failures="1">
  <testcase name="returns400" classname="handleValidation" time="0.01"><failure message="boom" type="java.lang.AssertionError">stack</failure></testcase>
</testsuite>`;
  const dn = parseSurefireXml(displayNameXml);
  check("classname 是 @DisplayName 時仍當前綴用", dn?.cases[0].name === "handleValidation.returns400", dn?.cases[0].name);
  check("classname 是 display name 不影響類別識別", dn?.suite === "com.x.HandlerTest");

  // An <error> without a message must still say something; the type is all there is.
  const errXml = `<testsuite name="com.x.BoomTest" tests="1" errors="1" skipped="0" failures="0">
  <testcase name="explodes" classname="com.x.BoomTest" time="0.01"><error type="java.lang.NullPointerException">stack</error></testcase>
</testsuite>`;
  const er = parseSurefireXml(errXml);
  check("error 無 message 時退回 type", er?.cases[0].message === "java.lang.NullPointerException", er?.cases[0].message);
  check("classname 等於 suite 時不加前綴", er?.cases[0].name === "explodes", er?.cases[0].name);
  check("errors 計數讀到", er?.errors === 1 && er?.failures === 0);

  check("不是 surefire 報告 → null", parseSurefireXml("<html><body>nope</body></html>") === null);
  check("截斷的 XML 不拋錯", parseSurefireXml('<testsuite name="a" tests="1"><testcase name="x"') !== undefined);

  // One @Nested class can fail dozens of cases; quoting all of them would spend the whole
  // feedback budget on one mistake repeated.
  const many = {
    suite: "com.x.ManyTest",
    tests: 30,
    failures: 30,
    errors: 0,
    cases: Array.from({ length: 30 }, (_, i) => ({
      kind: "failure" as const,
      name: `N.case${i}`,
      message: `boom ${i}`,
      frame: `at com.x.ManyTest.case${i}(ManyTest.java:${i + 1})`,
    })),
  };
  const capped = renderSurefireSuite(many, 3);
  check("超過上限只列前 N 個", (capped.match(/✗/g) ?? []).length === 3, capped);
  check("被省略的數量據實標明，不靜默丟棄", capped.includes("另有 27 個失敗的測試未列出"), capped);
}

// ---------------------------------------------------------------------------
// 21. Corporate network: NO_PROXY matching, credential redaction, CA bundles
// ---------------------------------------------------------------------------
console.log("\n[21] bypassesProxy / redactProxy / CA bundle（公司網路）");
{
  // The case that matters most here: a self-hosted model endpoint must bypass the proxy that
  // fronts external traffic, and the obvious way to write that is host:port.
  check("host:port 完全相符 → 繞過", bypassesProxy("llm.corp", "llm.corp:8080", "8080"));
  check("host:port 但連接埠不同 → 不繞過", !bypassesProxy("llm.corp", "llm.corp:8080", "443"));
  check("host:port 但不知道連接埠 → 不繞過", !bypassesProxy("llm.corp", "llm.corp:8080"));
  check("IP 加連接埠", bypassesProxy("100.77.16.46", "100.77.16.46:8080", "8080"));

  check("裸主機名相符", bypassesProxy("api.corp", "api.corp", "443"));
  check("前綴點比對子網域", bypassesProxy("a.b.corp", ".corp", "443"));
  check("裸後綴也比對子網域", bypassesProxy("a.b.corp", "corp", "443"));
  check("不是子網域就不該相符", !bypassesProxy("evilcorp", "corp", "443"));
  check("萬用字元前綴", bypassesProxy("a.corp", "*.corp", "443"));
  check("單一 * 關閉整個 proxy", bypassesProxy("anything.example", "*", "443"));
  check("多筆以逗號分隔、容忍空白", bypassesProxy("b.corp", " a.corp , b.corp ", "443"));
  check("空字串 → 不繞過", !bypassesProxy("a.corp", "", "443"));
  check("大小寫不敏感", bypassesProxy("A.CORP", "a.corp", "443"));

  // A proxy URL goes into logs and into doctor's output; the password must not.
  check("遮蔽帳密", redactProxy("http://user:pw@proxy.corp:8080") === "http://user:***@proxy.corp:8080");
  check("只有使用者名稱也遮蔽", redactProxy("http://user@proxy.corp:8080") === "http://user:***@proxy.corp:8080");
  check("沒有帳密就原樣", redactProxy("http://proxy.corp:8080") === "http://proxy.corp:8080");
  // new URL() would normalise :80 away, which reads as "我設的連接埠不見了".
  check("預設連接埠不得被正規化掉", redactProxy("http://proxy.corp:80") === "http://proxy.corp:80");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-ca-"));
  const pem = path.join(tmp, "root.pem");
  const oneCert = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
  fs.writeFileSync(pem, `${oneCert}\n${oneCert.replace("AAAA", "BBBB")}\n`);
  const der = path.join(tmp, "corp.cer");
  fs.writeFileSync(der, "\u0000\u0001binary not pem");

  check(
    "兩個來源合併、去重、保留順序",
    JSON.stringify(sourcePaths("a.pem, b.pem", "b.pem,c.pem").map((x) => `${x.path}:${x.from}`)) ===
      JSON.stringify(["a.pem:UT_CA_CERTS", "b.pem:UT_CA_CERTS", "c.pem:NODE_EXTRA_CA_CERTS"]),
    JSON.stringify(sourcePaths("a.pem, b.pem", "b.pem,c.pem")),
  );
  const ok = load([{ path: pem, from: "UT_CA_CERTS" }]);
  check("讀得到一個檔裡的多張憑證", ok.sources[0].certs === 2 && ok.pems.length === 2, JSON.stringify(ok.sources));
  const missing = load([{ path: path.join(tmp, "nope.pem"), from: "UT_CA_CERTS" }]);
  check("檔案不存在 → 記下錯誤而不是拋例外", !!missing.sources[0].error && missing.pems.length === 0);
  const derLoad = load([{ path: der, from: "UT_CA_CERTS" }]);
  check("DER 檔給出可行動的訊息", (derLoad.sources[0].error ?? "").includes("DER"), JSON.stringify(derLoad.sources));

  // Passing `ca` REPLACES the trust store; without the built-in roots, configuring a
  // corporate CA would break every ordinary HTTPS call the tool makes.
  check("沒有設定 → undefined，不動預設信任庫", bundleFrom([]) === undefined);
  const bundle = bundleFrom(["CORP"], ["ROOT_A", "ROOT_B"]);
  check(
    "有設定 → 內建根憑證 + 自訂憑證，不是只有自訂",
    JSON.stringify(bundle) === JSON.stringify(["ROOT_A", "ROOT_B", "CORP"]),
    JSON.stringify(bundle),
  );
  check("未設定時的摘要說得清楚", caSummary([]).includes("未設定"));
  check(
    "讀取失敗的摘要點名檔案與原因",
    caSummary([{ path: "/x.pem", from: "UT_CA_CERTS", certs: 0, error: "ENOENT" }]).includes("/x.pem"),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 22. Architecture invariants: the hard rules in AGENTS.md, as asserts
// ---------------------------------------------------------------------------
// Each of these was a written rule that nothing enforced. A grep in a doc is a rule people
// remember; a grep in the selftest is a rule CI remembers.
console.log("\n[22] 架構不變式（AGENTS.md 硬規則的可執行版本）");
{
  const sources: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(TESTGEN_ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", "runs", ".git"].includes(e.name) && !e.name.startsWith(".")) walk(rel);
      } else if (e.name.endsWith(".ts")) {
        sources.push(rel);
      }
    }
  };
  walk(".");
  const read = (rel: string) => fs.readFileSync(path.join(TESTGEN_ROOT, rel), "utf8");
  const outsideRunners = sources.filter((f) => !f.startsWith(`runners${path.sep}`));

  // 硬規則 6：SDK 只能出現在 runners/ 裡，否則核心就綁死在某個 runtime 上。
  const sdkLeaks = outsideRunners.filter((f) =>
    /from\s+["'](@qwen-code\/sdk|@opencode-ai)/.test(read(f)),
  );
  check("runners/ 以外沒有 import 任何 agent SDK", sdkLeaks.length === 0, sdkLeaks.join(", "));

  // 同一條規則的另一半：gate 或 orchestrator 不得自己去叫 agent CLI。比對的是「把 CLI 路徑
  // 當成識別字拿來用」，不是字面出現——每道 gate 的錯誤訊息裡都寫著 UT_OPENCODE_BIN，那是
  // 給操作者看的文字。doctor 的 --version 探測是刻意的例外，它不執行 agent。
  const usesCliPath = (src: string) =>
    /import\s*\{[^}]*\bOPENCODE_BIN\b[^}]*\}/s.test(src) || /\bconfig\.OPENCODE_BIN\b/.test(src);
  const cliLeaks = outsideRunners.filter(
    (f) => f !== "config.ts" && f !== path.join("scripts", "doctor.ts") && usesCliPath(read(f)),
  );
  check("runners/ 與 doctor 以外沒有 spawn agent CLI", cliLeaks.length === 0, cliLeaks.join(", "));

  // 硬規則 2、3：隨 repo 版控的那兩份 agent 定義本身必須守約，不只是解析器會解析而已。
  const agentDir = path.join(TESTGEN_ROOT, ".opencode", "agent");
  const writerViolations = contractViolations(path.join(agentDir, "ut-writer.md"), WRITER_RULES);
  check("內建 ut-writer.md 沒有 bash / 沒有 skill", writerViolations.length === 0, writerViolations.join("；"));
  const reviewerViolations = contractViolations(
    path.join(agentDir, "ut-reviewer.md"),
    REVIEWER_RULES,
  );
  check("內建 ut-reviewer.md 全唯讀", reviewerViolations.length === 0, reviewerViolations.join("；"));
  check(
    "內建 ut-reviewer.md temperature 固定 0",
    /^temperature:\s*0\s*$/m.test(fs.readFileSync(path.join(agentDir, "ut-reviewer.md"), "utf8")),
  );

  // 硬規則 7 的可檢查面：旋鈕加了卻沒寫進文件，操作者就不知道它存在。
  const knobs = envKnobsInSource();
  const envExample = read(".env.example");
  const readme = read("README.md");
  const undocumentedEnv = knobs.filter((k) => !envExample.includes(k));
  const undocumentedReadme = knobs.filter((k) => !readme.includes(k));
  check(`${knobs.length} 個 UT_* 全部寫進 .env.example`, undocumentedEnv.length === 0, undocumentedEnv.join(", "));
  check("UT_* 全部寫進 README", undocumentedReadme.length === 0, undocumentedReadme.join(", "));
}

// ---------------------------------------------------------------------------
// 23. Mid-run interruptions: failure classification, context compaction, code-less targets
// ---------------------------------------------------------------------------
console.log("\n[23] 中途中斷的成因（失敗分類 / context 縮短 / 沒有程式碼的目標）");
{
  const vllmOld = parseContextOverflow(
    "This model's maximum context length is 32768 tokens. However, you requested 33000 tokens (24808 in the messages, 8192 in the completion).",
  );
  check("parseContextOverflow：vLLM（舊）", vllmOld.limit === 32768 && vllmOld.used === 24808, JSON.stringify(vllmOld));
  const vllmNew = parseContextOverflow(
    "'max_tokens' or 'max_completion_tokens' is too large: 8192. This model's maximum context length is 32768 tokens and your request has 25000 input tokens (8192 > 32768 - 25000).",
  );
  check("parseContextOverflow：vLLM（新）", vllmNew.limit === 32768 && vllmNew.used === 25000, JSON.stringify(vllmNew));
  const openai = parseContextOverflow("This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.");
  check("parseContextOverflow：OpenAI", openai.limit === 8192 && openai.used === 9000, JSON.stringify(openai));
  const tgi = parseContextOverflow("Input validation error: `inputs` tokens + `max_new_tokens` must be <= 4096. Given: 3000 `inputs` tokens and 2000 `max_new_tokens`");
  check("parseContextOverflow：TGI", tgi.limit === 4096 && tgi.used === 3000, JSON.stringify(tgi));
  const llama = parseContextOverflow('{"error":{"code":400,"message":"the request exceeds the available context size","type":"exceed_context_size_error","n_prompt_tokens":5000,"n_ctx":4096}}');
  check("parseContextOverflow：llama.cpp", llama.limit === 4096 && llama.used === 5000, JSON.stringify(llama));

  check("classifyHttpFailure：400 + context 字樣 → context", classifyHttpFailure(400, "maximum context length is 4096 tokens") === "context");
  check("classifyHttpFailure：422 TGI → context", classifyHttpFailure(422, "`inputs` tokens + `max_new_tokens` must be <= 4096") === "context");
  check("classifyHttpFailure：400 其他 → rejected（不重試）", classifyHttpFailure(400, "invalid tool schema") === "rejected");
  check("classifyHttpFailure：401/403/404 → config", ["config", "config", "config"].join() === [401, 403, 404].map((c) => classifyHttpFailure(c, "")).join());
  check(
    "classifyHttpFailure：408/429/500/502/503/504 → transient",
    [408, 429, 500, 502, 503, 504].every((c) => classifyHttpFailure(c, "") === "transient"),
  );
  check("retryAfterMs：秒數", retryAfterMs("7") === 7000);
  check("retryAfterMs：HTTP 日期", retryAfterMs(new Date(1_000_000 + 5000).toUTCString(), 1_000_000) === 5000);
  check("retryAfterMs：沒有 / 亂碼 → undefined", retryAfterMs(null) === undefined && retryAfterMs("soon") === undefined);

  const specsAll = toolsFor(false);
  check("looksLikeToolCallText：hermes 的 <tool_call> 標記", looksLikeToolCallText('<tool_call>\n{"name":"write_file"', specsAll));
  check("looksLikeToolCallText：裸 JSON 呼叫已知工具", looksLikeToolCallText('{"name": "read_file", "arguments": {"path": "a"}}', specsAll));
  check("looksLikeToolCallText：一般文字 / 判決 JSON 不算", !looksLikeToolCallText('已完成。{"scores":{"coverage":8},"blockers":[]}', specsAll));

  check("unusableCompletion：{error} 是失敗的請求", unusableCompletion({ error: { message: "upstream request timeout" } })?.includes("upstream") === true);
  check("unusableCompletion：空 choices / 沒有 message", unusableCompletion({ choices: [] }) !== null && unusableCompletion({ choices: [{}] }) !== null);
  check("unusableCompletion：正常的 completion", unusableCompletion({ choices: [{ message: { content: "x" } }] }) === null);
  const sse = completionFromSse(
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n',
  );
  const sseMsg = sse?.choices?.[0].message;
  check(
    "completionFromSse：閘道強制串流時把 delta 拼回一則訊息（內容、tool call、finish_reason）",
    sseMsg?.content === "Hello" && sseMsg.tool_calls?.[0].id === "c1" && sseMsg.tool_calls?.[0].function?.arguments === '{"path":"a"}' && sse?.choices?.[0].finish_reason === "tool_calls",
    JSON.stringify(sse),
  );
  check("completionFromSse：一般 JSON 不是 SSE", completionFromSse('{"choices":[]}') === null);
  check(
    "completionFromSse：串流中的 error 事件 → 失敗的請求，不是空答案",
    unusableCompletion(completionFromSse('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"error":{"message":"upstream timeout"}}\n\n')) !== null,
  );
  check(
    "completionFromSse：沒有 finish_reason 也沒有 [DONE] 就斷了 → 失敗的請求",
    unusableCompletion(completionFromSse('data: {"choices":[{"delta":{"content":"half an ans"}}]}\n\n')) !== null,
  );
  check("textOf：陣列形式的 content", textOf([{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }]) === "ab");
  check("normalizeToolName：functions. 前綴與 <|…|> 尾巴", normalizeToolName("functions.write_file") === "write_file" && normalizeToolName("read_file<|call|>") === "read_file");

  const VERDICT = '{"scores":{"effectiveness":9,"coverage":9,"independence":9,"readability":9,"fast_reliable":9,"mock_appropriateness":9},"blockers":[],"advisories":[]}';
  const shapes: Array<[string, string]> = [
    ["<think> 裡有程式碼的大括號", `<think>看 totalCents() { if (x) { return 1; } }</think>\n${VERDICT}`],
    ["只有 </think>（Qwen3 的模板把 <think> 放在 prompt 裡）", `先想一下 { a: b } …</think>\n\n${VERDICT}`],
    ["判決後面加了帶大括號的註解", `${VERDICT}\n\n註：可再補 { null, "  " } 的情境`],
    ["字串內含大括號", VERDICT.replace('"advisories":[]', '"advisories":["考慮 {} 與 \\"}\\" 的情況"]')],
  ];
  for (const [label, text] of shapes) {
    const v = parseVerdict(text);
    check(`parseVerdict：${label} → 讀得到判決`, !v.parseError && v.passed, v.parseError ?? "");
  }
  check("parseVerdict：真的沒有判決 → 照樣 fail-closed", parseVerdict("<think>{ x }</think>我覺得不錯").parseError !== undefined);
  const blocked = VERDICT.replace('"blockers":[]', '"blockers":["FooTest.save_ok：只有 assertNotNull"]');
  check(
    "parseVerdict：兩個內容不同的判決（草稿＋最終、每檔一個）→ fail-closed，不得挑一個而丟掉另一個的 blocker",
    parseVerdict(`${blocked}\n${VERDICT}`).parseError !== undefined && parseVerdict(`[${blocked},${VERDICT}]`).parseError !== undefined,
  );
  check("parseVerdict：同一個判決重複貼兩次 → 不算歧義", !parseVerdict(`${VERDICT}\n再附一次：${VERDICT}`).parseError);
  check(
    "parseVerdict：判決前的說明裡有一個沒閉合的 {（`void save() {`）→ 照樣找到判決",
    !parseVerdict(`測試方法 \`void save() {\` 什麼都沒斷言，但整體可接受。\n${VERDICT}`).parseError,
  );
  check(
    "parseVerdict：判決包在另一個帶 blockers 的物件裡 → 不得單取內層而丟掉外層的 blocker",
    parseVerdict(`{"blockers":["FooTest.save_ok：只有 assertNotNull"],"detail":${VERDICT}}`).passed === false,
  );
  check(
    "parseVerdict：沒閉合的 { 之後有兩個不同判決 → 照樣 fail-closed",
    parseVerdict(`\`void save() {\`\n${blocked}\n${VERDICT}`).parseError !== undefined,
  );
  check("jsonObjectCandidates：依序列出頂層物件", JSON.stringify(jsonObjectCandidates('a {"x":1} b {"y":{"z":2}}')) === JSON.stringify(['{"x":1}', '{"y":{"z":2}}']));

  // compactHistory on a hand-built conversation
  const big = "y".repeat(5000);
  const msgs: Array<Record<string, unknown>> = [
    { role: "system", content: big },
    { role: "user", content: big },
    { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "p", content: big }) } }] },
    { role: "tool", tool_call_id: "a", name: "write_file", content: "已寫入 p" },
    { role: "assistant", content: "", tool_calls: [{ id: "b", type: "function", function: { name: "read_file", arguments: '{"path":"q"}' } }] },
    { role: "tool", tool_call_id: "b", name: "read_file", content: big },
    { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: '{"path":"r"}' } }] },
    { role: "tool", tool_call_id: "c", name: "read_file", content: big },
  ];
  const done = new Set<Record<string, unknown>>();
  const freed = compactHistory(msgs, done);
  const writeArgs = JSON.parse(String((msgs[2].tool_calls as Array<{ function: { arguments: string } }>)[0].function.arguments));
  check("compactHistory：較早的 read 結果被省略", String(msgs[5].content).includes("已省略") && freed > 9000, `freed=${freed}`);
  check("compactHistory：較早 write_file 的檔案內容被省略、arguments 仍是合法 JSON 且保留 path", writeArgs.path === "p" && String(writeArgs.content).includes("已省略"));
  check("compactHistory：最近一輪（剛要的結果）原封不動", msgs[7].content === big);
  check("compactHistory：system 與任務 prompt 不動", msgs[0].content === big && msgs[1].content === big);
  check("compactHistory：短的結果不值得省略", msgs[3].content === "已寫入 p");
  check("compactHistory：同一則不重複計算（第二次回 0）", compactHistory(msgs, done) === 0);
  const partial: Array<Record<string, unknown>> = [
    msgs[0], msgs[1],
    { role: "assistant", content: "", tool_calls: [] },
    { role: "tool", tool_call_id: "x1", name: "read_file", content: big },
    { role: "tool", tool_call_id: "x2", name: "read_file", content: big },
    { role: "assistant", content: "", tool_calls: [] },
  ];
  compactHistory(partial, new Set(), 1000);
  check("compactHistory：有目標量時只省略到夠用為止（由舊到新）", String(partial[3].content).includes("已省略") && partial[4].content === big);

  // Code-less targets: verified against JaCoCo 0.8.12, which writes these self-closing.
  check("codelessTypeReason：只有抽象方法的 interface", codelessTypeReason("package a;\n/** {x} */\npublic interface Port { int rate(String r); }") !== null);
  check("codelessTypeReason：annotation", codelessTypeReason("package a;\npublic @interface Ann { String value() default \"{x}\"; }") === "annotation");
  check(
    "codelessTypeReason：Feign 式 interface（字串裡的 { 不算）",
    codelessTypeReason('@FeignClient(name = "x")\npublic interface Api { @GetMapping("/u/{id}") User get(@PathVariable("id") long id); }') !== null,
  );
  check("codelessTypeReason：default method → 有程式碼", codelessTypeReason("public interface P { default int two() { return 2; } }") === null);
  check("codelessTypeReason：interface 常數 → 保守視為可能有程式碼", codelessTypeReason("public interface P { java.util.List<String> L = java.util.List.of(); }") === null);
  check(
    "codelessTypeReason：有邏輯的 class、帶參數的 enum、有 compact 建構子或方法的 record → null（保留為目標）",
    [
      "public class A { int twice(int x) { return x * 2; } }",
      'public enum E { X("x"); private final String v; E(String v) { this.v = v; } }',
      "public record R(int x) { public R { if (x < 0) throw new IllegalArgumentException(); } }",
      "public record R(int x) { int twice() { return x * 2; } }",
      "public class I { static { init(); } }",
    ].every((c) => codelessTypeReason(c) === null),
  );
  check(
    "codelessTypeReason：沒有本體的 record（含多行的元件與常數）→ 略過",
    /^record/.test(codelessTypeReason("public record R(int x) {}") ?? "") &&
      /^record/.test(codelessTypeReason("@JsonInclude(NON_NULL)\npublic record UserResponse(\n    Long id,\n    @NotNull String name\n) {\n    public static final int MAX = 5;\n}\n") ?? ""),
  );
  check(
    "codelessTypeReason：只有欄位的 Lombok DTO（含巢狀 DTO）、空類別、只有常數的 enum → 略過",
    codelessTypeReason("@Data\npublic class UserDto {\n    private Long id;\n    private String name;\n}") === "只有欄位（存取方法、equals 等由 Lombok 產生，沒有手寫的邏輯）" &&
      codelessTypeReason("@Data public class Outer { private Inner inner; @Data public static class Inner { private String v; } }") !== null &&
      codelessTypeReason("public class A {}") !== null &&
      codelessTypeReason("public enum E { X, Y; }") === "enum（只有常數）",
  );
  check(
    "codelessTypeReason：常數類別（編譯時折疊的字面值、private 建構子——含 Sonar 式丟例外的）→ 略過；非字面值、null、實例欄位的初始值 → 保留",
    codelessTypeReason('public final class Codes {\n  public static final String A = "a";\n  public static final int B = 2;\n  private Codes() {}\n}') !== null &&
      codelessTypeReason('public final class Codes { public static final String A = "a"; private Codes() { throw new IllegalStateException("Utility class"); } }') !== null &&
      codelessTypeReason('public final class P { public static final Pattern X = Pattern.compile("a"); }') === null &&
      codelessTypeReason("public final class P { public static final String X = null; }") === null &&
      codelessTypeReason("public class P { private final int max = 5; }") === null,
  );
  check(
    "codelessTypeReason：private 建構子裡有別的程式碼（Jackson 會呼叫它）→ 保留；沒有收尾的註解參數不吃掉後面的程式碼 → 保留",
    codelessTypeReason("@Data public class Dto { private List<String> items; private Dto() { items = new ArrayList<>(); } }") === null &&
      codelessTypeReason("@Data public class Dto { private Long id; private Dto() { log(); } }") === null &&
      codelessTypeReason("@Data public class Dto { @Foo(bar private Long id; int twice(int x) { return x * 2; } }") === null,
  );
  check(
    "codelessTypeReason：只有抽象方法與欄位的 abstract 類別 → 略過",
    codelessTypeReason("public abstract class B { protected String name; public abstract void run() throws Exception; }") === "abstract 類別（只有抽象方法、欄位與常數）",
  );
  check(
    "codelessTypeReason：Spring Boot 進入點（main 只呼叫 SpringApplication.run，含 WAR 的 configure）→ 略過；多一個 @Bean（在 main 前或後）、或不是 @SpringBootApplication → 保留",
    /Spring Boot 進入點/.test(codelessTypeReason("@SpringBootApplication\npublic class App {\n  public static void main(String[] args) {\n    SpringApplication.run(App.class, args);\n  }\n}") ?? "") &&
      /Spring Boot 進入點/.test(
        codelessTypeReason(
          '@SpringBootApplication\npublic class App extends SpringBootServletInitializer {\n  @Override\n  protected SpringApplicationBuilder configure(SpringApplicationBuilder b) {\n    return b.sources(App.class);\n  }\n  public static void main(String... args) { new SpringApplicationBuilder(App.class).profiles("x").run(args); }\n}',
        ) ?? "",
      ) &&
      codelessTypeReason("@SpringBootApplication\npublic class App {\n  public static void main(String[] args) { SpringApplication.run(App.class, args); }\n  @Bean Clock clock() { return Clock.systemUTC(); }\n}") === null &&
      codelessTypeReason("@SpringBootApplication\npublic class App {\n  @Bean Clock clock() { return Clock.systemUTC(); }\n  public static void main(String[] args) { SpringApplication.run(App.class, args); }\n}") === null &&
      codelessTypeReason("public class Cli { public static void main(String[] args) { SpringApplication.run(Cli.class, args); } }") === null,
  );
  check("codelessTypeReason：註解裡的 interface 字樣不算", codelessTypeReason("// this interface is old\npublic class A { void f() {} }") === null);
  check(
    "codelessTypeReason：MapStruct 的 mapper（abstract 類別或 interface）→ 保留：對應與 expression 就是邏輯",
    codelessTypeReason(
      'import org.mapstruct.Mapper;\nimport org.mapstruct.Mapping;\n@Mapper(componentModel = "spring")\npublic abstract class OrderMapper {\n  @Mapping(target = "status", expression = "java(order.isPaid() ? \\"PAID\\" : \\"OPEN\\")")\n  public abstract OrderDto toDto(Order order);\n}\n',
    ) === null &&
      codelessTypeReason("import org.mapstruct.Mapper;\n@Mapper\npublic interface UserMapper {\n  UserDto toDto(User u);\n}\n") === null &&
      codelessTypeReason("import org.apache.ibatis.annotations.Mapper;\n@Mapper\npublic interface UserDao {\n  User find(long id);\n}\n") !== null,
  );
  check(
    "codelessTypeReason：同一個檔案裡 annotation 型別後面還有別的型別 → 保留；只有 annotation → 略過",
    codelessTypeReason("@interface Audited {}\npublic class PriceService { public long discounted(long c, int p) { return p > 0 ? c * (100 - p) / 100 : c; } }") === null &&
      codelessTypeReason("public @interface Audited { String value() default \"\"; }") === "annotation",
  );
  check(
    "codelessTypeReason：main 的參數裡有三元運算、lambda、呼叫 → 是邏輯，保留",
    [
      "@SpringBootApplication\npublic class App {\n  public static void main(String[] args) {\n    SpringApplication.run(App.class, args.length == 0 ? DEFAULTS : args).getBean(Importer.class).importAll(args);\n  }\n}",
      '@SpringBootApplication\npublic class App {\n  public static void main(String[] args) {\n    new SpringApplicationBuilder(App.class).initializers(ctx -> ctx.getEnvironment().setActiveProfiles(System.getenv("P") != null ? "a" : "b")).run(args);\n  }\n}',
    ].every((c) => codelessTypeReason(c) === null) &&
      /Spring Boot 進入點/.test(
        codelessTypeReason(
          '@SpringBootApplication\npublic class App {\n  public static void main(String[] args) {\n    new SpringApplicationBuilder(App.class).bannerMode(Banner.Mode.OFF).profiles("x", "y").run(args);\n  }\n}',
        ) ?? "",
      ),
  );
  {
    // A chain of calls the entry-point pattern cannot match used to backtrack exponentially, about
    // ×4 for every two calls: 26 calls took 7 s. 26, not more, so a regression fails this in seconds
    // rather than hanging the run.
    const chain = `@SpringBootApplication\npublic class App {\n  public static void main(String[] args) {\n    new SpringApplicationBuilder(App.class)${".a(x)".repeat(26)}.run(args); foo();\n  }\n}`;
    const t0 = Date.now();
    const r = codelessTypeReason(chain);
    check("codelessTypeReason：26 個串接呼叫後面還有程式碼 → 保留，而且不會回溯到卡住", r === null && Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  }
  check(
    "codelessTypeReason：\\u000A 在 // 註解裡是換行（javac 先解跳脫），後面的 static 區塊是程式碼 → 保留",
    codelessTypeReason('public class Cfg2 { // x \\u000A static { System.out.println("static init ran"); }\n private String region; }') === null,
  );
  check(
    "codelessTypeReason：欄位有 Bean Validation 限制（@Pattern、@Size）的 DTO 與 record → 保留：規則要用 Validator 測",
    codelessTypeReason("import jakarta.validation.constraints.Pattern;\n@Data\npublic class SignUp {\n  @Pattern(regexp = \"[a-z]+\")\n  private String name;\n}\n") === null &&
      codelessTypeReason("import javax.validation.constraints.*;\npublic record Req(@NotBlank String name, @Size(max = 5) String code) {}\n") === null &&
      codelessTypeReason("import lombok.NonNull;\n@Data\npublic class Plain {\n  @NonNull private String name;\n}\n") !== null,
  );

  // JaCoCo writes code-less types self-closing. Both parser paths must read that as "nothing to
  // cover", and the <class> fallback must not run on into the next class's counters.
  const MIN = { line: 80, branch: 70 };
  const selfClosing =
    `<report><package name="com/x">` +
    `<class name="com/x/Port" sourcefilename="Port.java"/>` +
    `<class name="com/x/Foo" sourcefilename="Foo.java"><method name="a" desc="()V"><counter type="LINE" missed="9" covered="0"/></method>` +
    `<counter type="LINE" missed="9" covered="0"/></class>` +
    `<sourcefile name="Port.java"/>` +
    `<sourcefile name="Foo.java"><counter type="LINE" missed="9" covered="0"/></sourcefile>` +
    `</package></report>`;
  const sc1 = parseJacocoReport(selfClosing, ["m/src/main/java/com/x/Port.java"], MIN);
  check("parseJacocoReport：自我閉合的 <sourcefile/> → 無可執行程式碼，不擋 gate", sc1.passed && sc1.lines[0].includes("沒有可執行的程式碼"), sc1.lines.join(" | "));
  const noSf = selfClosing.replace(/<sourcefile[\s\S]*?(?=<\/package>)/, "");
  const sc2 = parseJacocoReport(noSf, ["m/src/main/java/com/x/Port.java"], MIN);
  check(
    "parseJacocoReport：<class .../> 退路不得讀到下一個類別的計數（Foo 的 0% 不是 Port 的）",
    sc2.passed && !sc2.lines[0].includes("0.0%"),
    sc2.lines.join(" | "),
  );
  const noDebug =
    `<report><package name="com/x"><sourcefile name="Nd.java">` +
    `<counter type="INSTRUCTION" missed="40" covered="0"/><counter type="METHOD" missed="2" covered="0"/>` +
    `</sourcefile></package></report>`;
  const nd = parseJacocoReport(noDebug, ["m/src/main/java/com/x/Nd.java"], MIN);
  check("parseJacocoReport：沒有行號資訊（-g:none）的類別以 instruction 覆蓋率代替，0% 照樣 FAIL", !nd.passed && nd.lines[0].includes("0.0%"), nd.lines.join(" | "));
  const sc3 = parseJacocoReport(selfClosing, ["m/src/main/java/com/x/Foo.java"], MIN);
  check("parseJacocoReport：旁邊有 code-less 類別時，真的 0% 照樣 FAIL", !sc3.passed && sc3.lines[0].includes("0.0%"), sc3.lines.join(" | "));

  const twoPkgs =
    `<report><package name="com/a"><sourcefile name="Util.java"><counter type="LINE" missed="9" covered="1"/></sourcefile></package>` +
    `<package name="com/b"><sourcefile name="Util.java"><counter type="LINE" missed="0" covered="10"/></sourcefile></package></report>`;
  const np = parseJacocoReport(twoPkgs, ["mod/src/java/com/b/Util.java"], MIN, () => "com/b");
  check("parseJacocoReport：非 src/main/java 佈局以 package 宣告定位，不拿別的 package 的同名檔", np.passed && np.lines[0].includes("100.0%"), np.lines.join(" | "));

  // Code nobody wrote, as JaCoCo 0.8.8 measured it with Spring Boot 2.7's Lombok: @Data's equals and
  // hashCode on the annotation's line, the getters on the fields' lines.
  const userDto = "package com.x.dto;\n\nimport lombok.Data;\n\n@Data\npublic class UserDto {\n    private Long id;\n    private String name;\n    private String email;\n}\n";
  check("declarationOnlyLines：@Data DTO → 註解、型別宣告、沒有初始值的欄位", JSON.stringify(declarationOnlyLines(userDto)) === "[5,6,7,8,9]", JSON.stringify(declarationOnlyLines(userDto)));
  check(
    "declarationOnlyLines / codelessTypeReason：CRLF 換行（Windows 上的常態）結果相同",
    JSON.stringify(declarationOnlyLines(userDto.replace(/\n/g, "\r\n"))) === "[5,6,7,8,9]" &&
      codelessTypeReason(userDto.replace(/\n/g, "\r\n")) === codelessTypeReason(userDto) &&
      /Spring Boot 進入點/.test(
        codelessTypeReason("@SpringBootApplication\r\npublic class App {\r\n  public static void main(String[] args) {\r\n    SpringApplication.run(App.class, args);\r\n  }\r\n}\r\n") ?? "",
      ),
    JSON.stringify(declarationOnlyLines(userDto.replace(/\n/g, "\r\n"))),
  );
  const orderDto =
    "package com.x.dto;\n\nimport java.util.ArrayList;\nimport java.util.List;\nimport lombok.AllArgsConstructor;\nimport lombok.Builder;\nimport lombok.Data;\nimport lombok.NoArgsConstructor;\n\n" +
    "@Data\n@Builder\n@NoArgsConstructor\n@AllArgsConstructor\npublic class OrderDto {\n    private String id;\n    private int quantity;\n    @Builder.Default\n    private List<String> tags = new ArrayList<>();\n}\n";
  check(
    "declarationOnlyLines：有初始值的欄位是寫出來的程式碼，它上面的註解那行也一樣（@Builder.Default 與 tags 兩行都留著）",
    !declarationOnlyLines(orderDto).includes(18) && !declarationOnlyLines(orderDto).includes(17),
    JSON.stringify(declarationOnlyLines(orderDto)),
  );
  // javac puts a field's initializer on the line its declaration starts: the first annotation's.
  // Measured with javac 21 and JaCoCo 0.8.12 — both branches of `level > 2` on line 4, three of
  // `level > 0 && level < 5` on line 6, nothing on the field lines themselves.
  const limitsSrc = [
    "package com.x;",
    "public class Limits {",
    '    static int level = Integer.getInteger("level", 0);',
    "    @Deprecated",
    "    private final boolean verbose = level > 2;",
    "    @Deprecated",
    "    private final boolean enabled = level > 0 && level < 5;",
    "    public boolean isEnabled() { return enabled; }",
    "}",
    "",
  ].join("\n");
  const limitsXml =
    '<report><package name="com/x"><sourcefile name="Limits.java"><line nr="2" mi="0" ci="2" mb="0" cb="0"/><line nr="3" mi="0" ci="6" mb="0" cb="0"/>' +
    '<line nr="4" mi="2" ci="6" mb="1" cb="1"/><line nr="6" mi="5" ci="6" mb="3" cb="1"/><line nr="8" mi="0" ci="3" mb="0" cb="0"/>' +
    '<counter type="INSTRUCTION" missed="7" covered="23"/><counter type="BRANCH" missed="4" covered="2"/><counter type="LINE" missed="0" covered="5"/></sourcefile></package></report>';
  const limits = parseJacocoReport(limitsXml, ["src/main/java/com/x/Limits.java"], MIN, undefined, () => limitsSrc);
  check(
    "declarationOnlyLines / parseJacocoReport：註解在有初始值的欄位上方時，初始值的程式碼（含分支）記在註解那行 → 照算，branch 33.3% 照樣 FAIL",
    JSON.stringify(declarationOnlyLines(limitsSrc)) === "[2]" && !limits.passed && limits.lines[0].includes("branch=33.3%"),
    [JSON.stringify(declarationOnlyLines(limitsSrc)), ...limits.lines].join(" | "),
  );
  check(
    "declarationOnlyLines：註解跟著它註解的東西——沒有初始值的欄位、型別宣告上方的算；方法上方的不算",
    JSON.stringify(declarationOnlyLines("class A {\n  @NotNull\n  @Size(max = 5)\n  private String name;\n  @Override\n  public String toString() {\n    return name;\n  }\n}\n")) ===
      "[1,2,3,4]",
    JSON.stringify(declarationOnlyLines("class A {\n  @NotNull\n  @Size(max = 5)\n  private String name;\n  @Override\n  public String toString() {\n    return name;\n  }\n}\n")),
  );
  // javac ends a line at a lone CR too. Counted on LF alone, every line after one is off by one, and
  // an excluded number lands on the method below it.
  const loneCr = "package com.x;\npublic class Calc {\n    /* spec:\r   ... */\n    public int sign(int a) { return a > 0 ? 1 : -1; }\n    private int unused;\n}\n";
  check(
    "declarationOnlyLines：單獨的 CR 也是換行（javac 的算法），CR CR LF 是兩行",
    JSON.stringify(declarationOnlyLines(loneCr)) === "[2,6]" &&
      JSON.stringify(declarationOnlyLines("class A {\r\r\n  int x;\r\n}\r\n")) === "[1,3]",
    JSON.stringify([declarationOnlyLines(loneCr), declarationOnlyLines("class A {\r\r\n  int x;\r\n}\r\n")]),
  );
  check(
    "declarationOnlyLines：接續上一行的 `Type name;`（instanceof 的 pattern、分兩行的欄位宣告）不算宣告",
    JSON.stringify(declarationOnlyLines("class A {\n  boolean f(Object o) {\n    boolean ok = o instanceof\n        String s;\n    return ok;\n  }\n  private final\n      String name;\n}\n")) === "[1]",
    JSON.stringify(declarationOnlyLines("class A {\n  boolean f(Object o) {\n    boolean ok = o instanceof\n        String s;\n    return ok;\n  }\n  private final\n      String name;\n}\n")),
  );
  check(
    "decodeUnicodeEscapes / declarationOnlyLines：\\uXXXX 照 javac 先解開（偶數個反斜線不是跳脫）；跳脫藏了換行就一行都不排除",
    decodeUnicodeEscapes("a\\u0041\\\\u0041\\uu0042") === "aA\\\\u0041B" &&
      JSON.stringify(declarationOnlyLines("class A {\n  // x \\u000A int y;\n  int z;\n}\n")) === "[]" &&
      JSON.stringify(declarationOnlyLines("class A {\n  String s = \"\\u4e2d\";\n  int z;\n}\n")) === "[1,3]" &&
      // `\u002f\u002a` opens a comment for javac: the line before it is a declaration, the line in it nothing.
      JSON.stringify(declarationOnlyLines("class A {\n  int x; \\u002f\\u002a\n  int y = compute();\n  \\u002a\\u002f\n}\n")) === "[1,2]",
    JSON.stringify(declarationOnlyLines("class A {\n  int x; \\u002f\\u002a\n  int y = compute();\n  \\u002a\\u002f\n}\n")),
  );
  const stmts = [
    "class A {",
    "  Object f() {",
    "    return x;",
    "  }",
    "  void g() { if (bad) {",
    "    throw e;",
    "  } }",
    "  int y;",
    "  private final Map<String, List<Integer>> m;",
    "  @Override public String toString() {",
    '    return "";',
    "  }",
    '  @Table(name = "t",',
    '      indexes = {})',
    "  enum E {",
    "    RED,",
    "    GREEN;",
    "  }",
    "  class B { int z = 5; }",
    "  private String 名稱;",
    "}",
  ].join("\n");
  check(
    "declarationOnlyLines：return / throw 這類兩個字加分號的敘述句、方法簽名、enum 常數、一行寫完且有初始值的類別、非 ASCII 的名稱都不算",
    JSON.stringify(declarationOnlyLines(stmts)) === "[1,8,9,13,14,15]",
    JSON.stringify(declarationOnlyLines(stmts)),
  );
  const lombokXml = (file: string, lines: string, counters: string) =>
    `<report><package name="com/x/dto"><sourcefile name="${file}">${lines}${counters}</sourcefile></package></report>`;
  const userDtoXml = lombokXml(
    "UserDto.java",
    '<line nr="5" mi="29" ci="117" mb="18" cb="12"/><line nr="7" mi="0" ci="3" mb="0" cb="0"/><line nr="8" mi="0" ci="3" mb="0" cb="0"/><line nr="9" mi="0" ci="3" mb="0" cb="0"/>',
    '<counter type="INSTRUCTION" missed="29" covered="126"/><counter type="BRANCH" missed="18" covered="12"/><counter type="LINE" missed="0" covered="4"/>',
  );
  const dtoTarget = ["src/main/java/com/x/dto/UserDto.java"];
  const dtoRaw = parseJacocoReport(userDtoXml, dtoTarget, MIN);
  const dtoOwn = parseJacocoReport(userDtoXml, dtoTarget, MIN, undefined, () => userDto);
  check("parseJacocoReport：沒有原始碼可讀 → 照 JaCoCo 的數字（@Data 的分支 40% → FAIL）", !dtoRaw.passed && dtoRaw.lines[0].includes("branch=40.0%"), dtoRaw.lines.join(" | "));
  check(
    "parseJacocoReport：@Data DTO 的程式碼全在沒有手寫程式碼的行上 → 沒有手寫的可執行程式碼，不列入門檻，並列出未計入的行",
    dtoOwn.passed && dtoOwn.lines[0].includes("沒有手寫的可執行程式碼") && dtoOwn.lines[1].includes("5, 7-9"),
    dtoOwn.lines.join(" | "),
  );
  const orderXml = lombokXml(
    "OrderDto.java",
    '<line nr="10" mi="127" ci="0" mb="24" cb="0"/><line nr="11" mi="17" ci="38" mb="1" cb="1"/><line nr="12" mi="6" ci="0" mb="0" cb="0"/>' +
      '<line nr="13" mi="0" ci="12" mb="0" cb="0"/><line nr="15" mi="0" ci="3" mb="0" cb="0"/><line nr="16" mi="0" ci="3" mb="0" cb="0"/><line nr="18" mi="0" ci="3" mb="0" cb="0"/>',
    '<counter type="BRANCH" missed="25" covered="1"/><counter type="LINE" missed="2" covered="5"/>',
  );
  const order = parseJacocoReport(orderXml, ["src/main/java/com/x/dto/OrderDto.java"], MIN, undefined, () => orderDto);
  check(
    "parseJacocoReport：@Builder DTO（builder 測試實測 line 71% / branch 4%）→ 只算寫出來的初始值那行：100%、沒有分支 → PASS",
    order.passed && order.lines[0].includes("line=100.0%") && order.lines[0].includes("branch=N/A"),
    order.lines.join(" | "),
  );
  // Measured the same way: a service whose @NonNull field makes @RequiredArgsConstructor's generated
  // constructor null-check it, on the annotation's line. One test, the not-found path untested.
  const serviceSrc = [
    "package com.x.service;",
    "",
    "import com.x.dto.UserDto;",
    "import com.x.repo.UserRepository;",
    "import lombok.NonNull;",
    "import lombok.RequiredArgsConstructor;",
    "import lombok.extern.slf4j.Slf4j;",
    "import org.springframework.stereotype.Service;",
    "",
    "@Slf4j",
    "@Service",
    "@RequiredArgsConstructor",
    "public class UserService {",
    "    @NonNull",
    "    private final UserRepository repository;",
    "",
    "    public String displayName(Long id) {",
    "        UserDto user = repository.findById(id).orElse(null);",
    "        if (user == null) {",
    '            log.info("user {} not found", id);',
    '            return "(unknown)";',
    "        }",
    "        return user.getName().trim();",
    "    }",
    "}",
    "",
  ].join("\n");
  const serviceXml = (unknownTested: boolean) =>
    '<report><package name="com/x/service"><sourcefile name="UserService.java">' +
    '<line nr="10" mi="0" ci="4" mb="0" cb="0"/><line nr="12" mi="5" ci="8" mb="1" cb="1"/><line nr="18" mi="0" ci="8" mb="0" cb="0"/>' +
    (unknownTested
      ? '<line nr="19" mi="0" ci="2" mb="0" cb="2"/><line nr="20" mi="0" ci="4" mb="0" cb="0"/><line nr="21" mi="0" ci="2" mb="0" cb="0"/>'
      : '<line nr="19" mi="0" ci="2" mb="1" cb="1"/><line nr="20" mi="4" ci="0" mb="0" cb="0"/><line nr="21" mi="2" ci="0" mb="0" cb="0"/>') +
    '<line nr="23" mi="0" ci="4" mb="0" cb="0"/>' +
    (unknownTested
      ? '<counter type="INSTRUCTION" missed="5" covered="32"/><counter type="BRANCH" missed="1" covered="3"/><counter type="LINE" missed="0" covered="7"/>'
      : '<counter type="INSTRUCTION" missed="11" covered="26"/><counter type="BRANCH" missed="2" covered="2"/><counter type="LINE" missed="2" covered="5"/>') +
    "</sourcefile></package></report>";
  const svcTarget = ["src/main/java/com/x/service/UserService.java"];
  const svc = parseJacocoReport(serviceXml(false), svcTarget, MIN, undefined, () => serviceSrc);
  check(
    "parseJacocoReport：寫出來的邏輯沒測到照樣 FAIL，未覆蓋行只列寫出來的那兩行（不列 @RequiredArgsConstructor 產生的 null 檢查）",
    !svc.passed && svc.lines[0].includes("line=60.0%") && svc.lines[0].includes("branch=50.0%") && svc.lines[1] === "  未覆蓋行：20-21",
    svc.lines.join(" | "),
  );
  check(
    "parseJacocoReport：分支不足時列出沒走到的分支在哪一行（只列算進來的 if，不列 Lombok 的 null 檢查），再列未計入的行",
    svc.lines[2] === "  未覆蓋分支：19（2 個分支有 1 個沒走到）" && svc.lines[3]?.startsWith("  未計入的行：10, 12（"),
    svc.lines.join(" | "),
  );
  const strictBranch = { line: MIN.line, branch: 80 };
  const svcAllRaw = parseJacocoReport(serviceXml(true), svcTarget, strictBranch);
  const svcAll = parseJacocoReport(serviceXml(true), svcTarget, strictBranch, undefined, () => serviceSrc);
  check(
    "parseJacocoReport：寫出來的每條路都測了 → 100% PASS；照 JaCoCo 的數字卻是 branch 75%，差的那個分支是 Lombok 的 null 檢查",
    svcAll.passed && svcAll.lines[0].includes("line=100.0%") && svcAll.lines[0].includes("branch=100.0%") && !svcAllRaw.passed && svcAllRaw.lines[0].includes("branch=75.0%"),
    [...svcAll.lines, ...svcAllRaw.lines].join(" | "),
  );
  // `if (flag)` with flag always true: every instruction ran, one branch did not. No line is missed,
  // so without the branch list the writer is told only a percentage.
  const flagXml = lombokXml(
    "Flag.java",
    '<line nr="3" mi="0" ci="3" mb="0" cb="0"/><line nr="5" mi="0" ci="2" mb="1" cb="1"/><line nr="6" mi="0" ci="4" mb="0" cb="0"/><line nr="8" mi="0" ci="2" mb="0" cb="0"/>',
    '<counter type="BRANCH" missed="1" covered="1"/><counter type="LINE" missed="0" covered="4"/>',
  );
  const flag = parseJacocoReport(flagXml, ["src/main/java/com/x/dto/Flag.java"], MIN);
  const flagOk = parseJacocoReport(flagXml, ["src/main/java/com/x/dto/Flag.java"], { line: MIN.line, branch: 50 });
  check(
    "parseJacocoReport：每行都執行過、只有分支沒走到 → 沒有未覆蓋行可列，改列未覆蓋分支；分支達標時不列",
    !flag.passed &&
      flag.lines.length === 2 &&
      flag.lines[1] === "  未覆蓋分支：5（2 個分支有 1 個沒走到）" &&
      flagOk.passed &&
      flagOk.lines.length === 1,
    [...flag.lines, ...flagOk.lines].join(" | "),
  );
  // A record, measured with JDK 21 (--release 17) and JaCoCo 0.8.8: the accessors the compiler
  // generates sit on the header's first line, even when the components run on over several lines
  // (equals / hashCode / toString JaCoCo filters itself). One accessor untested: that line is missed.
  const rangeSrc =
    "package com.x.rec;\n\npublic record Range(\n        int from,\n        int to\n) {\n    public Range {\n        if (from > to) {\n" +
    '            throw new IllegalArgumentException("from > to");\n        }\n    }\n}\n';
  const rangeXml =
    '<report><package name="com/x/rec"><sourcefile name="Range.java"><line nr="3" mi="3" ci="3" mb="0" cb="0"/><line nr="7" mi="0" ci="8" mb="0" cb="0"/>' +
    '<line nr="8" mi="0" ci="3" mb="0" cb="2"/><line nr="9" mi="0" ci="5" mb="0" cb="0"/><line nr="11" mi="0" ci="1" mb="0" cb="0"/>' +
    '<counter type="INSTRUCTION" missed="3" covered="20"/><counter type="BRANCH" missed="0" covered="2"/><counter type="LINE" missed="0" covered="5"/></sourcefile></package></report>';
  const range = parseJacocoReport(rangeXml, ["src/main/java/com/x/rec/Range.java"], { line: 100, branch: 100 }, undefined, () => rangeSrc);
  check(
    "declarationOnlyLines / parseJacocoReport：record 的標頭第一行（多行元件也一樣）列為未計入，compact 建構子的行照算",
    JSON.stringify(declarationOnlyLines(rangeSrc)) === "[3]" &&
      range.passed &&
      range.lines[0].includes("line=100.0%") &&
      range.lines[1]?.startsWith("  未計入的行：3（"),
    [JSON.stringify(declarationOnlyLines(rangeSrc)), ...range.lines].join(" | "),
  );
  // Which exec files a build's JaCoCo agent appends to, from prepare-agent's log line. A pom's
  // <append>true</append> wins over -Djacoco.append=false; an agent given no append option appends.
  const agent = "/m2/org/jacoco/org.jacoco.agent/0.8.8/org.jacoco.agent-0.8.8-runtime.jar";
  check(
    "appendingJacocoExecFiles：append=true 或沒給 append → 累加；append=false → 不算；別的 agent、別的行不算",
    JSON.stringify(appendingJacocoExecFiles(`[INFO] argLine set to -javaagent:${agent}=destfile=/w/p/target/jacoco.exec,append=true`)) === '["/w/p/target/jacoco.exec"]' &&
      JSON.stringify(appendingJacocoExecFiles(`[INFO] argLine set to -javaagent:${agent}=destfile=/w/p/target/jacoco.exec`)) === '["/w/p/target/jacoco.exec"]' &&
      appendingJacocoExecFiles(`[INFO] argLine set to -javaagent:${agent}=destfile=/w/p/target/jacoco.exec,append=false`).length === 0 &&
      appendingJacocoExecFiles("[INFO] argLine set to -javaagent:/opt/other-agent.jar=destfile=/x.exec").length === 0 &&
      appendingJacocoExecFiles(`[INFO] Tests run: 1 -javaagent:${agent}=destfile=/x.exec`).length === 0,
  );
  check(
    "appendingJacocoExecFiles：路徑有空白時整個參數加引號（Windows）、自訂屬性名稱、後面還有別的選項與 JVM 參數",
    JSON.stringify(
      appendingJacocoExecFiles(
        '[INFO] surefireArgLine set to "-javaagent:C:\\Users\\John Doe\\.m2\\repository\\org\\jacoco\\org.jacoco.agent\\0.8.8\\org.jacoco.agent-0.8.8-runtime.jar=destfile=C:\\work\\my proj\\target\\coverage-reports\\jacoco-ut.exec,append=true" -Xmx1g',
      ),
    ) === JSON.stringify(["C:\\work\\my proj\\target\\coverage-reports\\jacoco-ut.exec"]) &&
      JSON.stringify(appendingJacocoExecFiles(`[INFO] argLine set to -javaagent:${agent}=destfile=/w/p/t/j.exec,append=true,includes=com.x.* -Dfoo=bar`)) === '["/w/p/t/j.exec"]',
  );
  {
    const repo = path.resolve(os.tmpdir(), "owned-repo");
    const owned = ownedExecFiles(
      [path.join(repo, "target", "jacoco.exec"), path.join(repo, "..", "shared", "jacoco.exec"), path.join(repo, "target", "app.log"), "/elsewhere/jacoco.exec", path.join(repo + "-other", "x.exec")],
      repo,
    );
    check(
      "ownedExecFiles：只刪 repo 裡的 .exec——repo 外（上一層、別的目錄、名稱相近的兄弟目錄）與別種檔案不動",
      JSON.stringify(owned) === JSON.stringify([path.join(repo, "target", "jacoco.exec")]),
      JSON.stringify(owned),
    );
  }
  // The per-line data is trusted only when it is all there: one line short of the LINE counter, or
  // only the <class> element's counters, and the figure is JaCoCo's own.
  const dtoShort = parseJacocoReport(userDtoXml.replace('covered="4"/>', 'covered="5"/>'), dtoTarget, MIN, undefined, () => userDto);
  const dtoClassOnly = parseJacocoReport(
    '<report><package name="com/x/dto"><class name="com/x/dto/UserDto" sourcefilename="UserDto.java"><counter type="BRANCH" missed="18" covered="12"/><counter type="LINE" missed="0" covered="4"/></class></package></report>',
    dtoTarget,
    MIN,
    undefined,
    () => userDto,
  );
  check(
    "parseJacocoReport：逐行資料不齊（比 LINE 計數器少一行、或只有 <class> 的計數器）→ 不重算，照 JaCoCo 的數字",
    !dtoShort.passed && dtoShort.lines[0].includes("branch=40.0%") && !dtoClassOnly.passed && dtoClassOnly.lines[0].includes("branch=40.0%"),
    [...dtoShort.lines, ...dtoClassOnly.lines].join(" | "),
  );

  // --- the repo changes under the snapshot walk ---------------------------------------------
  const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-fsrace-"));
  fs.mkdirSync(path.join(fsRoot, "out/classes/p1"), { recursive: true });
  fs.writeFileSync(path.join(fsRoot, "out/classes/p1/A.class"), "x");
  fs.writeFileSync(path.join(fsRoot, "keep.txt"), "k");
  let vanished = false;
  let snapOk = true;
  try {
    // An IDE deleting the directory between the parent's listing and this one: skipDir runs
    // exactly in that window, so it can play the IDE.
    snapshotTree(fsRoot, {
      skipDir: (rel) => {
        if (rel === "out/classes/p1") {
          fs.rmSync(path.join(fsRoot, "out/classes/p1"), { recursive: true, force: true });
          vanished = true;
        }
        return false;
      },
    });
  } catch {
    snapOk = false;
  }
  check("snapshotTree：走訪途中目錄被刪掉（IDE 重建輸出）→ 不崩潰", vanished && snapOk);
  if (process.platform === "linux") {
    fs.mkdirSync(Buffer.from(path.join(fsRoot, "docs/") + "\xb3\x57\xae\xe6", "latin1"), { recursive: true });
    let big5Ok = true;
    let snap: Record<string, string> = {};
    try {
      snap = snapshotTree(fsRoot);
    } catch {
      big5Ok = false;
    }
    check("snapshotTree：Big5 命名的目錄（Node 解碼後路徑不存在）→ 不崩潰，且結果穩定", big5Ok && JSON.stringify(snap) === JSON.stringify(snapshotTree(fsRoot)));
    const fifo = path.join(fsRoot, "pipe.txt");
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      const t0f = Date.now();
      const r = execTool("read_file", { path: "pipe.txt" }, { repoRoot: fsRoot, maxResultChars: 1000 }, toolsFor(true));
      check("api read_file：FIFO 不讀（readFileSync 會卡死整個 event loop，連逾時都不會觸發）", r.includes("不是一般檔案") && Date.now() - t0f < 1000, r);
    }
  }
  const skipOwned = writerScopeSkip(fsRoot, fsRoot, [path.join(fsRoot, "testgen-runs")]);
  check("writerScopeSkip：repo 內的 runs 目錄是 loop 自己的，不列入 writer 範圍檢查", skipOwned("testgen-runs", "testgen-runs") && !skipOwned("testgen-runs2", "testgen-runs2"));
  check("writerScopeSkip：repo 外的 runs 目錄不影響判斷", !writerScopeSkip(fsRoot, fsRoot, ["/elsewhere/runs"])("elsewhere", "elsewhere"));
  if (process.platform !== "win32") {
    // The path typed to reach the module differs from the one the walk sees — on Windows and macOS
    // by case (`shop` vs `Shop`), anywhere by a symlink. The writable tree must be the walked one.
    fs.mkdirSync(path.join(fsRoot, "Shop", "src", "test"), { recursive: true });
    fs.symlinkSync(path.join(fsRoot, "Shop"), path.join(fsRoot, "shop-link"));
    const viaLink = writerScopeSkip(fsRoot, path.join(fsRoot, "shop-link"));
    check("writerScopeSkip：模組以不同於磁碟上的路徑（大小寫／symlink）指定 → 可寫範圍仍對得上實際走訪到的目錄", viaLink("Shop/src/test", "test"));
    // The repo itself reached through another name — a symlink here, an 8.3 short name
    // (C:\Users\RUNNER~1) on Windows — and the loop's runs dir not created yet.
    const repoLink = `${fsRoot}-link`;
    fs.symlinkSync(fsRoot, repoLink);
    const ownedViaLink = writerScopeSkip(repoLink, repoLink, [path.join(repoLink, "testgen-runs")]);
    check(
      "writerScopeSkip：repo 以別的路徑（symlink／Windows 的短檔名）指定、runs 目錄還沒建立 → 仍認得是 loop 自己的",
      ownedViaLink("testgen-runs", "testgen-runs") && !ownedViaLink("testgen-runs2", "testgen-runs2"),
    );
    fs.rmSync(repoLink, { force: true });
  }
  fs.rmSync(fsRoot, { recursive: true, force: true });

  // --- red builds the classifier used to call "unlocatable" -------------------------------------
  const crashLog = [
    "[ERROR] ExecutionException The forked VM terminated without properly saying goodbye. VM crash or System.exit called?",
    "[ERROR] Crashed tests:",
    "[ERROR] com.x.ExitTest",
    "[ERROR] com.x.Other$Inner",
    "[ERROR] -> [Help 1]",
  ].join("\n");
  check("crashedTestClasses：System.exit 讓 fork 結束時，從 Crashed tests 讀出類別", JSON.stringify(crashedTestClasses(crashLog)) === JSON.stringify(["com.x.ExitTest", "com.x.Other$Inner"]), JSON.stringify(crashedTestClasses(crashLog)));
  const hangLog = "[INFO] Running com.x.A\n[INFO] Tests run: 1, Failures: 0 -- in com.x.A\n[INFO] Running com.x.Hang\n";
  check("unfinishedTestClasses：逾時當下還沒跑完的測試類別", JSON.stringify(unfinishedTestClasses(hangLog)) === JSON.stringify(["com.x.Hang"]));
  const javacNoise =
    "[INFO] Running com.x.GeneratedSourceTest\ntarget/gen/Broken.java:3: error: ';' expected\n[INFO] Tests run: 1, Failures: 0";
  check("extractCompileErrorFiles（maven）：測試自己印出的 javac 訊息不是編譯錯誤", extractCompileErrorFiles(javacNoise, "maven").length === 0);
  check("extractCompileErrorFiles（gradle）：javac 形狀照樣認得", extractCompileErrorFiles(javacNoise, "gradle").length === 1);
  check(
    "extractCompileErrorFiles（maven on Windows）：`/C:/…` 的 URI 形狀還原成磁碟路徑（否則模組自己的測試被判範圍外、不進修復）",
    JSON.stringify(extractCompileErrorFiles("[ERROR] /C:/Users/me/repo/src/test/java/com/x/FooTest.java:[3,8] cannot find symbol", "maven")) ===
      JSON.stringify(["C:/Users/me/repo/src/test/java/com/x/FooTest.java"]),
  );

  // --- the foreign-change exemption must not reach build files or an ancestor's ignore rules ----
  if (spawnSync("git", ["--version"]).status !== 0) {
    console.log("  [SKIP] 找不到 git——splitForeignChanges 要一個真的 git repo 才測得到");
  } else {
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const g = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, env: gitEnv, stdio: "ignore" });
    const gr = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-foreign-"));
    g(gr, "init", "-q");
    fs.writeFileSync(path.join(gr, ".gitignore"), "logs/\nlombok.config\nprojects/\n");
    const own = splitForeignChanges(gr, ["logs/app.log", "lombok.config", "src/main/resources/local.yml", "README.md"]);
    check(
      "splitForeignChanges：git-ignored 的 logs/ 算別人的；被 ignore 的 lombok.config（建置會讀）與 src/ 底下照樣算",
      JSON.stringify(own.foreign) === JSON.stringify(["logs/app.log"]),
      JSON.stringify(own),
    );
    const nested = path.join(gr, "projects", "app");
    fs.mkdirSync(nested, { recursive: true });
    const inside = splitForeignChanges(nested, ["logs/app.log", "pom.xml", "notes.txt"]);
    check(
      "splitForeignChanges：repo 位在把它整個 ignore 掉的上層 repo 裡 → 一律不豁免",
      inside.foreign.length === 0 && inside.kept.length === 3,
      JSON.stringify(inside),
    );
    fs.writeFileSync(path.join(gr, ".gitignore"), "logs/\nlombok.config\nprojects/\nconfig/\napplication-local.yml\nout/\n*.mv.db\n");
    const cfg = splitForeignChanges(gr, [
      "svc/config/application.yml",
      "application-local.yml",
      "out/production/Calc.class",
      "data/app.mv.db",
      "logs/app.log",
    ]);
    check(
      "splitForeignChanges：被 ignore 的 ./config/application.yml、./application-local.yml（Spring 從工作目錄載入）照樣算；只有輸出形狀的才豁免",
      JSON.stringify(cfg.kept) === JSON.stringify(["svc/config/application.yml", "application-local.yml"]) && cfg.foreign.length === 3,
      JSON.stringify(cfg),
    );
    const many = Array.from({ length: 20000 }, (_, i) => `logs/run-${i}.log`);
    check("splitForeignChanges：兩萬個 ignored 檔（IDE 重建輸出）也判得出來（輸出超過 1MB）", splitForeignChanges(gr, many).foreign.length === 20000);
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-nogit-"));
    check("splitForeignChanges：不是 git repo → 一律不豁免", splitForeignChanges(noGit, ["logs/a.log"]).foreign.length === 0);
    fs.rmSync(gr, { recursive: true, force: true });
    fs.rmSync(noGit, { recursive: true, force: true });
  }

  // A timeout beyond setTimeout's range fires at once instead of never.
  const tsxBin = path.join(TESTGEN_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  // config.ts as the entry point evaluates numEnv at load. planSpawn quotes the tsx.cmd shim for
  // cmd.exe, as itest's runTsx does: a bare `shell: true` split a clone path containing a space.
  const hugePlan = planSpawn(tsxBin, [path.join(TESTGEN_ROOT, "config.ts")]);
  const huge = spawnSync(hugePlan.file, hugePlan.args, {
    cwd: TESTGEN_ROOT,
    env: { ...process.env, UT_AGENT_TIMEOUT_MS: "99999999999" },
    encoding: "utf8",
    windowsVerbatimArguments: hugePlan.windowsVerbatimArguments,
  });
  check(
    "numEnv：UT_AGENT_TIMEOUT_MS 超過 setTimeout 上限 → 啟動就 FATAL（否則每個 agent 會立刻被殺）",
    huge.status === 1 && /UT_AGENT_TIMEOUT_MS/.test(huge.stderr),
    `status=${huge.status} ${huge.stderr.slice(0, 200)}`,
  );
  // A count with a fraction is a typo: it would reach the model endpoint as a max_tokens it rejects.
  const loadConfig = (env: Record<string, string>) =>
    spawnSync(hugePlan.file, hugePlan.args, {
      cwd: TESTGEN_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      windowsVerbatimArguments: hugePlan.windowsVerbatimArguments,
    });
  const fractional = loadConfig({ UT_API_MAX_TOKENS: "4096.5" });
  check(
    "intEnv：次數、上限這類整數設定給了小數 → 啟動就 FATAL",
    fractional.status === 1 && /UT_API_MAX_TOKENS/.test(fractional.stderr) && /整數/.test(fractional.stderr),
    `status=${fractional.status} ${fractional.stderr.slice(0, 200)}`,
  );
  check("intEnv：整數照常接受（前後有空白也行）", loadConfig({ UT_BATCH_SIZE: "3" }).status === 0 && loadConfig({ UT_BATCH_SIZE: " 4 " }).status === 0);
  const sci = loadConfig({ UT_BATCH_SIZE: "1e3" });
  const hex = loadConfig({ UT_MAX_ITER: "0x10" });
  check(
    "intEnv：1e3、0x10 這種 Number() 也讀得懂、但沒人會這樣寫次數的 → FATAL",
    sci.status === 1 && /UT_BATCH_SIZE/.test(sci.stderr) && hex.status === 1 && /UT_MAX_ITER/.test(hex.stderr),
    `${sci.status} ${sci.stderr.slice(0, 120)} / ${hex.status} ${hex.stderr.slice(0, 120)}`,
  );
  check(
    "numEnv / intEnv：只有空白（.env 裡加了引號的空白、CI 設定的空白字串）視同沒設，不是 Number(\"  \") 的 0",
    loadConfig({ UT_BATCH_SIZE: "   " }).status === 0 && loadConfig({ UT_MIN_LINE_COV: " " }).status === 0,
  );
  check("intEnv：超過安全整數範圍 → FATAL", loadConfig({ UT_API_MAX_TOKENS: "9007199254740993" }).status === 1);

  // --- the repo lock under a race: several runs finding the same stale lock at once -----------
  if (process.platform !== "win32") {
    const lockRepo = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-lockrace-"));
    const lockFile = repoLockFile(fs.realpathSync.native(lockRepo));
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, runDir: "an earlier run that crashed" }));
    const go = path.join(lockRepo, "go");
    const child = path.join(lockRepo, "child.ts");
    fs.writeFileSync(
      child,
      `import * as fs from "node:fs";
import { acquireRepoLock } from ${JSON.stringify(path.join(TESTGEN_ROOT, "libs", "lock.ts"))};
console.log("READY");
while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
const busy = acquireRepoLock(${JSON.stringify(lockRepo)}, "run-" + process.pid);
console.log(busy ? "BUSY" : "GOT");
setTimeout(() => process.exit(0), 1500);
`,
    );
    const kids = Array.from({ length: 8 }, () => spawn(tsxBin, [child], { cwd: TESTGEN_ROOT }));
    const outs = kids.map((k) => {
      let o = "";
      k.stdout?.on("data", (d) => (o += d));
      return { get: () => o, done: new Promise((r) => k.on("exit", r)) };
    });
    const deadline = Date.now() + 60_000;
    while (outs.some((o) => !o.get().includes("READY")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(go, "");
    await Promise.all(outs.map((o) => o.done));
    const got = outs.filter((o) => o.get().includes("GOT")).length;
    const busy = outs.filter((o) => o.get().includes("BUSY")).length;
    check(
      "repo 鎖：8 個 run 同時發現同一個過期的鎖 → 只有一個接手，其餘都看到它在執行（不得兩個都跑）",
      got === 1 && busy === 7,
      `GOT=${got} BUSY=${busy}`,
    );
    check("repo 鎖：接手用的暫時鎖沒有殘留", !fs.existsSync(`${lockFile}.takeover`));
    // The pid is alive but belongs to something else now; the run that held it finished.
    const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    const finishedRun = path.join(lockRepo, "old-run");
    fs.mkdirSync(finishedRun);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: stranger.pid, runDir: finishedRun }));
    check("repo 鎖：持有者 pid 還活著但 artifacts 還沒有 summary.json → 視為執行中", acquireRepoLock(lockRepo, "new")?.pid === stranger.pid);
    fs.writeFileSync(path.join(finishedRun, "summary.json"), "{}");
    check("repo 鎖：持有者的 run 已寫出 summary.json（pid 被別的程序重用）→ 接手，不得永遠擋住", acquireRepoLock(lockRepo, "new") === undefined);
    stranger.kill("SIGKILL");
    // An empty lock is another run between its create and its write — never taken over while
    // young — or, once it has stayed empty for seconds, what a crash between the two left behind.
    fs.writeFileSync(lockFile, "");
    const young = acquireRepoLock(lockRepo, "new", { waitMs: 300, heartbeatMs: 30_000 });
    check(
      "repo 鎖：剛建立、還沒寫入內容的鎖（另一個 run 正在寫）→ 不接手、不刪；等不到它寫完就回報忙碌，不是照樣執行",
      fs.existsSync(lockFile) && fs.readFileSync(lockFile, "utf8") === "" && young?.lock === lockFile && young.pid === undefined,
      JSON.stringify(young),
    );
    // ...and waited for: once its holder has written it, the lock is held. Spinning through the
    // attempts instead ran out of them while the holder was still writing — and ran anyway.
    const midWrite = path.join(lockRepo, "mid-write.ts");
    const midGo = path.join(lockRepo, "mid-go");
    fs.writeFileSync(
      midWrite,
      `import * as fs from "node:fs";
import { acquireRepoLock } from ${JSON.stringify(path.join(TESTGEN_ROOT, "libs", "lock.ts"))};
console.log("READY");
while (!fs.existsSync(${JSON.stringify(midGo)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
console.log(acquireRepoLock(${JSON.stringify(lockRepo)}, "late") ? "BUSY" : "GOT");
`,
    );
    const late = spawn(tsxBin, [midWrite], { cwd: TESTGEN_ROOT });
    let lateOut = "";
    late.stdout?.on("data", (d) => (lateOut += d));
    const lateDone = new Promise((r) => late.on("exit", r));
    const lateDeadline = Date.now() + 60_000;
    while (!lateOut.includes("READY") && Date.now() < lateDeadline) await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(midGo, "");
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, runDir: "the run that was writing" }));
    await lateDone;
    check("repo 鎖：等寫到一半的鎖寫完 → 看到它被持有（不是耗盡重試次數後照樣執行）", lateOut.includes("BUSY"), lateOut);
    fs.writeFileSync(lockFile, "");
    const longAgo = (Date.now() - 30_000) / 1000;
    fs.utimesSync(lockFile, longAgo, longAgo);
    check(
      "repo 鎖：空了好幾秒的鎖（建立後、寫入前當掉）→ 接手",
      acquireRepoLock(lockRepo, "new") === undefined && fs.readFileSync(lockFile, "utf8").includes(`"pid":${process.pid},`),
    );
    // The holder's heartbeat: its lock stays fresh while it runs.
    fs.rmSync(lockFile, { force: true });
    check("repo 鎖：拿得到鎖", acquireRepoLock(lockRepo, "beating", { waitMs: 1000, heartbeatMs: 100 }) === undefined);
    const backdated = (Date.now() - 600_000) / 1000;
    fs.utimesSync(lockFile, backdated, backdated);
    await new Promise((r) => setTimeout(r, 400));
    check("repo 鎖：持有期間定時更新鎖的時間（心跳）", Date.now() - fs.statSync(lockFile).mtimeMs < 5_000, String(Date.now() - fs.statSync(lockFile).mtimeMs));
    fs.rmSync(lockRepo, { recursive: true, force: true });
    fs.rmSync(lockFile, { force: true });
  }
  check(
    "holderAlive：訊號送得到 → 活著；ESRCH → 不在了",
    holderAlive("ok", true, Infinity) && !holderAlive("ESRCH", true, 0) && !holderAlive("ESRCH", false, 0),
  );
  check(
    "holderAlive：EPERM + 別的使用者的鎖 → 活著（共用 /tmp 的別人的 run）；EPERM + 自己的鎖 → 看心跳（Windows 上以系統管理員身分跑的 run 送不到訊號）",
    holderAlive("EPERM", false, Infinity) && holderAlive("EPERM", true, 60_000) && !holderAlive("EPERM", true, 10 * 60_000),
  );

  // --- build output that outgrows memory ------------------------------------------------------
  // Scripts go in files, not `node -e`: on Windows shLive runs through cmd.exe, which would
  // re-parse the quotes in an inline script (and split an execPath containing spaces).
  const node = process.platform === "win32" ? "node" : process.execPath;
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-sh-"));
  const script = (name: string, body: string) => {
    const f = path.join(scriptDir, name);
    fs.writeFileSync(f, body);
    // shLive runs through cmd.exe on Windows, which splits an unquoted %TEMP% like
    // C:\Users\Jane Doe\AppData\Local\Temp at the space.
    return process.platform === "win32" && /\s/.test(f) ? `"${f}"` : f;
  };
  const noisy = await shLive(
    node,
    [
      script(
        "noisy.js",
        'console.log("[ERROR] /r/src/test/java/A.java:[3,1] cannot find symbol");const l="x".repeat(99)+"\\n";for(let i=0;i<30000;i++)process.stdout.write(l);console.log("[INFO] Tests run: 7, Failures: 0");',
      ),
    ],
    "[t]",
    os.tmpdir(),
    0,
    200_000,
  );
  check(
    "shLive：輸出超過上限 → 不崩潰、只保留尾端（上限內）",
    noisy.code === 0 && noisy.out.length < 200_000 + 5_000,
    `code=${noisy.code} len=${noisy.out.length}`,
  );
  check("shLive：被丟掉的前段裡的 [ERROR] 行保留下來", noisy.out.includes("A.java:[3,1] cannot find symbol"));
  check("shLive：尾端的 Tests run 還在、且標明有截斷", noisy.out.includes("Tests run: 7") && noisy.out.includes("已丟棄"));
  const t1 = Date.now();
  const oneLine = await shLive(node, [script("oneline.js", 'process.stdout.write("y".repeat(30*1024*1024))')], "[t]", os.tmpdir(), 0, 64 * 1024 * 1024);
  fs.rmSync(scriptDir, { recursive: true, force: true });
  check(
    "shLive：30MB 沒有換行的輸出在線性時間內處理完（舊版逐 chunk 重切整段，O(n²)）",
    oneLine.out.length === 30 * 1024 * 1024 && Date.now() - t1 < 15_000,
    `len=${oneLine.out.length} ${Date.now() - t1}ms`,
  );
  check("assembleCapture：沒有截斷時原樣回傳", assembleCapture("abc", 0, ["x"], 10) === "abc");

  // --- surefire reports that are not what they seem ---------------------------------------------
  const soap = parseSurefireXml(
    `<testsuite name="com.x.S" tests="2" failures="1" errors="0">` +
      `<testcase name="parsesFault" classname="com.x.S"><system-out><![CDATA[<soap:Body><error code="1"/><failure/></soap:Body>]]></system-out></testcase>` +
      `<testcase name="fails" classname="com.x.S"><failure message="boom" type="AssertionError">at com.x.S.fails(S.java:3)</failure></testcase>` +
      `</testsuite>`,
  );
  check(
    "parseSurefireXml：通過的測試印出 <error> 字樣不算失敗",
    JSON.stringify(soap?.cases.map((c) => c.name)) === JSON.stringify(["fails"]),
    JSON.stringify(soap?.cases.map((c) => c.name)),
  );
  const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-xml-"));
  const bigXml = path.join(xmlDir, "TEST-com.x.Big.xml");
  const noise = "line <error/> 中文\n".repeat(2_400_000);
  fs.writeFileSync(
    bigXml,
    `<testsuite name="com.x.Big" tests="2" failures="1" errors="0">` +
      `<testcase name="loud" classname="com.x.Big"><system-out><![CDATA[${noise}]]></system-out><system-err/></testcase>` +
      `<testcase name="b" classname="com.x.Big"><failure message="expected: 3" type="AssertionError">x\nCaused by: com.zaxxer.hikari.pool.HikariPool$PoolInitializationException</failure></testcase>` +
      `</testsuite>`,
  );
  const bigSuite = parseSurefireXml(readSurefireXml(bigXml));
  check(
    "readSurefireXml：超過直讀上限的報告分段讀、跳過測試輸出，失敗案例與 cause 都還在",
    fs.statSync(bigXml).size > 32 * 1024 * 1024 && bigSuite?.cases.length === 1 && bigSuite.cases[0].name === "b" && /HikariPool/.test(bigSuite.cases[0].trace ?? ""),
    JSON.stringify(bigSuite?.cases.map((c) => c.name)),
  );
  fs.rmSync(xmlDir, { recursive: true, force: true });
  check("isSurefireSummary：<class>.txt 是摘要", isSurefireSummary("com.x.FooTest.txt"));
  check("isSurefireSummary：<class>-output.txt 是測試輸出，不讀", !isSurefireSummary("com.x.FooTest-output.txt"));

  // --- environment failures are read from the failing tests, not the whole log ------------------
  const springWarn =
    "WARN o.s.c.a.AnnotationConfigApplicationContext : Exception encountered during context initialization - " +
    "cancelling refresh attempt: org.springframework.beans.factory.UnsatisfiedDependencyException: x";
  const assertionSuite = { suite: "com.x.T", tests: 1, failures: 1, errors: 0, cases: [{ kind: "failure" as const, name: "t", message: "expected: 2 but was: 3", frame: "", trace: "org.opentest4j.AssertionFailedError" }] };
  check("classifyEnvFailures：失敗是普通斷言、Spring WARN 只出現在 log → 不是環境問題", classifyEnvFailures(springWarn, [assertionSuite]).length === 0);
  const ctxSuite = { ...assertionSuite, cases: [{ kind: "error" as const, name: "t", message: "Failed to load ApplicationContext", frame: "", trace: "Caused by: com.zaxxer.hikari.pool.HikariPool$PoolInitializationException" }] };
  check("classifyEnvFailures：失敗本身是 context 起不來 → 環境問題", classifyEnvFailures("", [ctxSuite]).length >= 2);
  check("classifyEnvFailures：沒有 XML 可讀時退回掃 log", classifyEnvFailures("Failed to load ApplicationContext", []).length === 1);

  // --- opencode: the exit code is part of the answer --------------------------------------------
  if (process.platform !== "win32") {
    const ocDir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-oc-"));
    const planFile = path.join(ocDir, "plan.json");
    const fakeOc = path.join(ocDir, "opencode");
    // Replays one behaviour per invocation: ok / fail (provider error, exit 1) / null (a bare
    // `null` line on stdout, then ok) / hold (a grandchild keeps stdout open, then ok).
    fs.writeFileSync(
      fakeOc,
      `#!${process.execPath}
const fs = require("fs");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, "utf8"));
const step = st.plan[Math.min(st.n, st.plan.length - 1)];
st.n++;
fs.writeFileSync(${JSON.stringify(planFile)}, JSON.stringify(st));
process.stdin.resume();
process.stdin.on("end", () => {
  const ev = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  if (step === "fail" || step === "workfail") {
    if (step === "workfail") {
      ev({ type: "tool_use", part: { type: "tool", tool: "write", callID: "w1", state: { status: "completed", input: {} } } });
      ev({ type: "text", part: { type: "text", text: "wrote a file" } });
    }
    ev({ type: "error", error: { name: "APIError", data: { message: "provider 503" } } });
    process.exit(1);
  }
  if (step === "null") process.stdout.write("null\\n");
  ev({ type: "text", part: { type: "text", text: "done " + st.n } });
  process.exit(0);
});
`,
    );
    fs.chmodSync(fakeOc, 0o755);
    const plan = (p: string[]) => fs.writeFileSync(planFile, JSON.stringify({ n: 0, plan: p }));
    const oc = (o: Record<string, unknown> = {}) => new OpencodeRunner({ bin: fakeOc, retryDelayMs: 0, timeoutMs: 20_000, ...o });

    plan(["fail"]);
    check("OpencodeRunner：第一個 session 就異常結束 → spawn-error（設定問題，秒報）", (await oc().runWriter("x")).status === "spawn-error");
    plan(["ok", "fail", "fail", "ok"]);
    const rOc = oc();
    await rOc.runWriter("round 1");
    const again = await rOc.runWriter("round 2");
    check("OpencodeRunner：成功過之後 opencode 因 provider 錯誤結束 → 重新執行直到成功", again.status === "ok" && again.text.includes("done 4"), JSON.stringify(again));
    plan(["ok", "fail"]);
    const rOc2 = oc({ retryWindowMs: 0 });
    await rOc2.runWriter("round 1");
    const gaveUp = await rOc2.runWriter("round 2");
    check("OpencodeRunner：重試窗用完 → timeout，不得報 ok（舊版把 exit=1 當成完成）", gaveUp.status === "timeout", JSON.stringify(gaveUp));
    plan(["ok", "fail", "ok"]);
    const rOc0 = oc({ retryWindowMs: 0 });
    await rOc0.runWriter("round 1");
    check("OpencodeRunner：UT_AGENT_RETRY_WINDOW_MS=0 → 不重新執行", (await rOc0.runWriter("round 2")).status === "timeout");
    plan(["ok", ...Array(8).fill("fail"), "ok"]);
    const rOcLong = oc({ retryWindowMs: 10 * 60 * 60 * 1000 });
    await rOcLong.runWriter("round 1");
    check("OpencodeRunner：重試窗設很長時不被寫死的 6 次上限提早結束（連續 8 次失敗後恢復）", (await rOcLong.runWriter("round 2")).status === "ok");
    plan(["ok", "fail"]);
    const rOc3 = oc();
    await rOc3.runWriter("writer works");
    check("OpencodeRunner：reviewer 第一次就異常結束 → spawn-error（writer 成功不代表 reviewer 的模型設對了）", (await rOc3.runReview("r")).status === "spawn-error");
    plan(["workfail", "ok"]);
    const wf = await oc().runWriter("x");
    check(
      "OpencodeRunner：第一個 session 做了事（寫檔、輸出文字）才因 provider 錯誤結束 → 不是設定錯誤，重跑",
      wf.status === "ok" && wf.text.includes("done 2"),
      JSON.stringify(wf),
    );
    plan(["null"]);
    const nul = await oc().runWriter("x");
    check("OpencodeRunner：stdout 出現一行 null 不會讓整個程序崩潰", nul.status === "ok" && nul.text.includes("done"), JSON.stringify(nul));
    fs.rmSync(ocDir, { recursive: true, force: true });

    // killTree after the leader exited: a grandchild holding stdout kept the build gate's
    // timeout from ending anything, so the gate waited for the grandchild instead.
    const t0k = Date.now();
    const held = await shLive("sh", ["-c", "sleep 30 & echo started; exit 1"], "[t]", os.tmpdir(), 1000);
    check("shLive：外層已結束、孫程序抓著 stdout → 逾時仍能在期限內收掉", held.timedOut === true && Date.now() - t0k < 8000, `${Date.now() - t0k}ms timedOut=${held.timedOut}`);
  }

  // --- a reviewer that did not finish is the reviewer's problem, not the writer's --------------
  const unfinished = await runReviewGate(
    { runWriter: async () => ({ text: "", status: "ok" }), runReview: async () => ({ text: "", status: "timeout", toolCallCount: 0 }) },
    "p",
  );
  check("runReviewGate：reviewer 沒跑完且 0 次工具呼叫 → 視為解析不出（重試 reviewer），不是餵給 writer 的 blocker", isUnparseable(unfinished) && unfinished.blockers.length === 0, JSON.stringify(unfinished));
  const lateVerdict = await runReviewGate(
    {
      runWriter: async () => ({ text: "", status: "ok" }),
      runReview: async () => ({
        text: '{"scores":{"effectiveness":9,"coverage":9,"independence":9,"readability":9,"fast_reliable":9,"mock_appropriateness":9},"blockers":[],"advisories":[]}',
        status: "timeout",
        toolCallCount: 3,
      }),
    },
    "p",
  );
  check(
    "runReviewGate：沒跑完的 session 即使留下完整判決也不採用（可能是讀到工具結果之前寫的）→ 重試 reviewer",
    lateVerdict.passed === false && isUnparseable(lateVerdict),
    JSON.stringify(lateVerdict),
  );

  check("runnerCannotRunHint：api runner 不叫人去裝 opencode", !runnerCannotRunHint("api").includes("opencode") && runnerCannotRunHint("api").includes("[FAIL]"));
  check("runnerCannotRunHint：opencode runner 維持原本的指引", runnerCannotRunHint("opencode").includes("UT_OPENCODE_BIN"));
}

// ---------------------------------------------------------------------------
// 24. Folder targets as batches: splitting, and putting a failed batch's test tree back
// ---------------------------------------------------------------------------
{
  // A runner that cannot start a session is found before the baseline build, not after it.
  const ok = { kind: "api", apiBaseUrl: "http://h/v1", writerModel: "w", reviewerModel: "r", reviewNeeded: true, opencodeBin: "opencode" };
  const found = () => "/usr/bin/opencode";
  const missing = () => undefined;
  const probs = (over: Partial<typeof ok>, lookup: (c: string) => string | undefined = found) => runnerConfigProblems({ ...ok, ...over }, lookup);
  check("runnerConfigProblems：api 設定齊全 → 沒有問題", probs({}).length === 0, JSON.stringify(probs({})));
  check(
    "runnerConfigProblems：api 缺端點、writer 或 reviewer 的模型 → 各自點名",
    /UT_API_BASE_URL/.test(probs({ apiBaseUrl: "" }).join()) &&
      /UT_WRITER_MODEL/.test(probs({ writerModel: "" }).join()) &&
      /UT_REVIEWER_MODEL/.test(probs({ reviewerModel: "" }).join()) &&
      probs({ apiBaseUrl: "", writerModel: "", reviewerModel: "" }).length === 3,
    JSON.stringify(probs({ apiBaseUrl: "", writerModel: "", reviewerModel: "" })),
  );
  check(
    "runnerConfigProblems：UT_SKIP_REVIEW 時不需要 reviewer 的模型",
    probs({ reviewerModel: "", reviewNeeded: false }).length === 0,
  );
  check(
    "runnerConfigProblems：opencode 找不到 CLI → 點名 UT_OPENCODE_BIN；找得到、或 opencode 的模型沒設（agent 預設）→ 沒有問題",
    /UT_OPENCODE_BIN/.test(probs({ kind: "opencode" }, missing).join()) &&
      probs({ kind: "opencode", writerModel: "", reviewerModel: "", apiBaseUrl: "" }, found).length === 0,
  );
  check(
    "runnerConfigProblems：不認得的 UT_RUNNER → 點名，不默默換成 opencode；qwen 不在這裡查",
    /UT_RUNNER=openai/.test(probs({ kind: "openai" }).join()) && probs({ kind: "qwen" }, missing).length === 0,
  );
  // config.ts reads UT_RUNNER case-blind, and a blank setting is an unset one: `UT_RUNNER=` in .env
  // is the default runner, and `UT_WRITER_MODEL=` leaves UT_MODEL to apply.
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "testgen-cfg-")), "probe.mts");
  fs.writeFileSync(
    probe,
    `const c = await import(${JSON.stringify(pathToFileURL(path.join(TESTGEN_ROOT, "config.ts")).href)});\n` +
      "console.log(JSON.stringify([c.RUNNER_KIND, c.WRITER_MODEL, c.REVIEWER_MODEL]));\n",
  );
  const tsx = path.join(TESTGEN_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const readConfig = (env: Record<string, string>) => {
    const plan = planSpawn(tsx, [probe]);
    const r = spawnSync(plan.file, plan.args, { cwd: TESTGEN_ROOT, env: { ...process.env, ...env }, encoding: "utf8", windowsVerbatimArguments: plan.windowsVerbatimArguments });
    return r.stdout.trim().split("\n").pop() ?? r.stderr;
  };
  check(
    "config：UT_RUNNER 不分大小寫、前後空白不算，空白 = 沒設（opencode）；空白的 UT_WRITER_MODEL 讓 UT_MODEL 生效",
    readConfig({ UT_RUNNER: " API ", UT_WRITER_MODEL: "", UT_MODEL: " m1 ", UT_REVIEWER_MODEL: " r " }) === '["api","m1","r"]' &&
      readConfig({ UT_RUNNER: "", UT_WRITER_MODEL: "w", UT_MODEL: "", UT_REVIEWER_MODEL: "" }) === '["opencode","w",""]',
    `${readConfig({ UT_RUNNER: " API ", UT_WRITER_MODEL: "", UT_MODEL: " m1 ", UT_REVIEWER_MODEL: " r " })} ${readConfig({ UT_RUNNER: "", UT_WRITER_MODEL: "w", UT_MODEL: "", UT_REVIEWER_MODEL: "" })}`,
  );
}

console.log("\n[24] 分批（chunk / captureTree / rollbackTree）");
{
  check("chunk：依序切成最多 n 個一組", JSON.stringify(chunk([1, 2, 3, 4, 5], 2)) === "[[1,2],[3,4],[5]]");
  check("chunk：size < 1 視為 1", chunk([1, 2], 0).length === 2);
  check("chunk：空陣列 → 沒有批次", chunk([], 3).length === 0);
  check(
    "portablePathOrder：Windows 的 \\ 路徑排得跟 / 一樣（分批的順序不因平台而異）",
    JSON.stringify(["x\\aB.java", "x\\a\\B.java"].sort(portablePathOrder)) === JSON.stringify(["x\\a\\B.java", "x\\aB.java"]) &&
      JSON.stringify(["x/aB.java", "x/a/B.java"].sort(portablePathOrder)) === JSON.stringify(["x/a/B.java", "x/aB.java"]),
  );

  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-batch-"));
  const put = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.writeFileSync(path.join(tree, rel), content);
  };
  put("java/com/x/ATest.java", "class ATest {}\n");
  put("java/com/x/Same.java", "class Same {}\n");
  put("resources/data.json", "{}\n");
  const big = Buffer.alloc(9 * 1024 * 1024, 65);
  put("resources/big.bin", big);
  const cap = captureTree(tree);
  // What a batch does: a new test in a new package, an edit, a deletion, an identical rewrite,
  // and a change to a file too large to have been kept.
  put("java/com/y/NewTest.java", "class NewTest {}\n");
  put("java/com/x/ATest.java", "class ATest { /* batch edit */ }\n");
  fs.rmSync(path.join(tree, "resources/data.json"));
  put("java/com/x/Same.java", "class Same {}\n");
  put("resources/big.bin", Buffer.alloc(9 * 1024 * 1024 + 1, 66));
  const rejected = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-rejected-"));
  const rb = rollbackTree(cap, rejected, "mod/src/test");
  check(
    "rollbackTree：新增的移走、改過的還原、刪掉的放回，內容相同的重寫不算變更",
    JSON.stringify(rb.created) === JSON.stringify(["java/com/y/NewTest.java"]) &&
      JSON.stringify(rb.restored) === JSON.stringify(["java/com/x/ATest.java"]) &&
      JSON.stringify(rb.undeleted) === JSON.stringify(["resources/data.json"]),
    JSON.stringify(rb),
  );
  check(
    "rollbackTree：樹回到擷取時的內容",
    fs.readFileSync(path.join(tree, "java/com/x/ATest.java"), "utf8") === "class ATest {}\n" &&
      fs.readFileSync(path.join(tree, "resources/data.json"), "utf8") === "{}\n" &&
      !fs.existsSync(path.join(tree, "java/com/y/NewTest.java")),
  );
  check("rollbackTree：批次新建、清空後的目錄一併移除", !fs.existsSync(path.join(tree, "java/com/y")));
  check(
    "rollbackTree：嘗試的版本依前綴 + 相對路徑保留",
    fs.readFileSync(path.join(rejected, "mod/src/test/java/com/x/ATest.java"), "utf8").includes("batch edit") &&
      fs.existsSync(path.join(rejected, "mod/src/test/java/com/y/NewTest.java")),
  );
  check(
    "rollbackTree：過大沒有備份的檔被改了 → 回報無法還原、保留那個版本，不假裝還原了",
    JSON.stringify(rb.unrestorable) === JSON.stringify(["resources/big.bin"]) &&
      fs.existsSync(path.join(rejected, "mod/src/test/resources/big.bin")),
    JSON.stringify(rb.unrestorable),
  );
  const again = rollbackTree(captureTree(tree), rejected);
  check(
    "rollbackTree：什麼都沒變 → 什麼都不做",
    again.created.length + again.restored.length + again.undeleted.length + again.unrestorable.length + again.failed.length === 0,
    JSON.stringify(again),
  );

  // Sources are kept before fixtures: under the total bound, a test source is what must come back.
  const small = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-batch-"));
  fs.mkdirSync(path.join(small, "java"), { recursive: true });
  fs.mkdirSync(path.join(small, "resources"), { recursive: true });
  fs.writeFileSync(path.join(small, "resources", "a.bin"), Buffer.alloc(500));
  fs.writeFileSync(path.join(small, "resources", "b.bin"), Buffer.alloc(500));
  fs.writeFileSync(path.join(small, "java", "ATest.java"), "x".repeat(600));
  const bounded = captureTree(small, { file: 1000, total: 1500 });
  check(
    "captureTree：總量上限先留給測試原始碼，fixture 排在後面（不會因為先讀到大 fixture 而還原不了 .java）",
    Buffer.isBuffer(bounded.files.get("java/ATest.java")) && [...bounded.files.values()].filter((v) => v === null).length === 1,
    JSON.stringify([...bounded.files.entries()].map(([k, v]) => [k, v === null ? null : v.length])),
  );
  fs.rmSync(small, { recursive: true, force: true });

  // What the batch left in a deleted file's place is cleared first; what cannot be is reported, and
  // the rest of the tree is still put back.
  const odd = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-batch-"));
  const oddPut = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(odd, rel)), { recursive: true });
    fs.writeFileSync(path.join(odd, rel), content);
  };
  oddPut("java/com/x/ATest.java", "class ATest {}\n");
  oddPut("java/com/x/BTest.java", "class BTest {}\n");
  const oddCap = captureTree(odd);
  // ATest.java became a directory holding a file the batch created: emptied, removed, restored.
  fs.rmSync(path.join(odd, "java/com/x/ATest.java"));
  oddPut("java/com/x/ATest.java/Inner.java", "class Inner {}\n");
  oddPut("java/com/x/NewTest.java", "class NewTest {}\n");
  const oddRejected = path.join(odd, "..", `${path.basename(odd)}-rejected`);
  const oddRb = rollbackTree(oddCap, oddRejected);
  check(
    "rollbackTree：刪掉的檔案原位被換成目錄 → 清空、移除後照樣放回",
    oddRb.failed.length === 0 && fs.readFileSync(path.join(odd, "java/com/x/ATest.java"), "utf8") === "class ATest {}\n",
    JSON.stringify(oddRb),
  );
  // The directory in its place goes several levels down: emptied of the files the batch created,
  // the empty levels are removed deepest first.
  fs.rmSync(path.join(odd, "java/com/x/ATest.java"));
  oddPut("java/com/x/ATest.java/deep/er/Inner.java", "class Inner {}\n");
  const deepRb = rollbackTree(oddCap, oddRejected);
  check(
    "rollbackTree：原位被換成好幾層的目錄 → 一層層清掉後照樣放回",
    deepRb.failed.length === 0 && fs.readFileSync(path.join(odd, "java/com/x/ATest.java"), "utf8") === "class ATest {}\n",
    JSON.stringify(deepRb),
  );
  // Only what the batch's writer changed is undone: an edit in the developer's IDE, a file a test
  // wrote during the build, are left and listed.
  const foreignCap = captureTree(odd);
  oddPut("java/com/x/Mine.java", "class Mine {}\n");
  oddPut("java/com/x/ATest.java", "class ATest { /* edited in the IDE */ }\n");
  oddPut("resources/approvals/A.received.txt", "written by a test\n");
  const foreignRb = rollbackTree(foreignCap, oddRejected, "", new Set(["java/com/x/Mine.java"]));
  check(
    "rollbackTree：只撤回 writer 改過的檔，別的東西改的留著並列在 foreign",
    JSON.stringify(foreignRb.created) === JSON.stringify(["java/com/x/Mine.java"]) &&
      JSON.stringify(foreignRb.foreign) === JSON.stringify(["java/com/x/ATest.java", "resources/approvals/A.received.txt"]) &&
      fs.readFileSync(path.join(odd, "java/com/x/ATest.java"), "utf8").includes("edited in the IDE") &&
      fs.existsSync(path.join(odd, "resources/approvals/A.received.txt")) &&
      !fs.existsSync(path.join(odd, "java/com/x/Mine.java")),
    JSON.stringify(foreignRb),
  );
  fs.rmSync(path.join(odd, "resources"), { recursive: true, force: true });
  fs.writeFileSync(path.join(odd, "java/com/x/ATest.java"), "class ATest {}\n");
  if (process.platform !== "win32") {
    // A directory that cannot be emptied (a named pipe is not a file the walk removes) stands for
    // any path the rollback cannot put a file back at — a lock, a permission — whatever the uid.
    fs.rmSync(path.join(odd, "java/com/x/BTest.java"));
    fs.mkdirSync(path.join(odd, "java/com/x/BTest.java"));
    spawnSync("mkfifo", [path.join(odd, "java/com/x/BTest.java/pipe")]);
    oddPut("java/com/x/Other.java", "class Other {}\n");
    const stuckTwo = rollbackTree(oddCap, oddRejected);
    check(
      "rollbackTree：放不回去的檔案回報在 failed（不丟例外），其餘照樣撤回",
      stuckTwo.failed.length === 1 &&
        stuckTwo.failed[0].startsWith("java/com/x/BTest.java") &&
        stuckTwo.created.includes("java/com/x/Other.java") &&
        !fs.existsSync(path.join(odd, "java/com/x/Other.java")),
      JSON.stringify(stuckTwo),
    );
  }
  // The rejected directory cannot be written: the attempt is not kept, the tree is still restored.
  const blocked = path.join(odd, "..", `${path.basename(odd)}-blocked`);
  fs.writeFileSync(blocked, "a file where a directory should be");
  oddPut("java/com/x/Late.java", "class Late {}\n");
  const unkept2 = rollbackTree(oddCap, blocked);
  check(
    "rollbackTree：嘗試版本存不進 rejected 目錄 → 記在 notKept，樹照樣還原",
    unkept2.notKept.includes("java/com/x/Late.java") && !fs.existsSync(path.join(odd, "java/com/x/Late.java")),
    JSON.stringify(unkept2),
  );
  fs.rmSync(odd, { recursive: true, force: true });
  fs.rmSync(oddRejected, { recursive: true, force: true });
  fs.rmSync(blocked, { force: true });

  // Build outputs: what the batch's builds added goes, and so do the outputs of what it put back.
  check(
    "testOutputDirs：Maven 是 target/test-classes；Gradle 是 build/classes/*/test 與 build/resources/test",
    testOutputDirs("/m", "maven").length === 1 &&
      testOutputDirs("/m", "maven")[0] === path.join("/m", "target", "test-classes") &&
      testOutputDirs("/m", "gradle").includes(path.join("/m", "build", "resources", "test")) &&
      testOutputDirs("/m", "gradle").includes(path.join("/m", "build", "classes", "java", "test")),
  );
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-out-"));
  const outPut = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), "x");
  };
  outPut("com/x/ExistingTest.class");
  outPut("com/x/ExistingTest$1.class");
  outPut("com/x/Restored.class");
  outPut("com/x/Restored$Inner.class");
  outPut("com/x/RestoredHelper.class");
  outPut("app.yml");
  const outCap = captureOutputs([outDir, path.join(outDir, "missing")]);
  outPut("com/x/NewTest.class");
  outPut("com/x/NewTest$Nested.class");
  outPut("mockito-extensions/org.mockito.plugins.MockMaker");
  const removed = removeBatchOutputs(outCap, ["java/com/x/NewTest.java", "java/com/x/Restored.java", "resources/app.yml"]).map((f) =>
    path.relative(outDir, f).replace(/\\/g, "/"),
  );
  check(
    "removeBatchOutputs：清掉這批新增的輸出，以及還原的原始碼與資源的舊輸出（下次建置重產）",
    JSON.stringify(removed) ===
      JSON.stringify([
        "app.yml",
        "com/x/NewTest$Nested.class",
        "com/x/NewTest.class",
        "com/x/Restored$Inner.class",
        "com/x/Restored.class",
        "mockito-extensions/org.mockito.plugins.MockMaker",
      ]),
    JSON.stringify(removed),
  );
  check(
    "removeBatchOutputs：其他既有輸出不動（RestoredHelper 不是 Restored 的 nested class）",
    fs.existsSync(path.join(outDir, "com/x/ExistingTest.class")) &&
      fs.existsSync(path.join(outDir, "com/x/ExistingTest$1.class")) &&
      fs.existsSync(path.join(outDir, "com/x/RestoredHelper.class")),
  );
  fs.rmSync(outDir, { recursive: true, force: true });
  // An output directory that did not exist when the batch started is all the batch's: a class
  // named after nothing that is left — a second top-level class in a test the rollback took out —
  // would otherwise stay, and surefire would run it in the next batch's build.
  const freshOut = path.join(os.tmpdir(), `testgen-out-fresh-${process.pid}`);
  fs.rmSync(freshOut, { recursive: true, force: true });
  const freshCap = captureOutputs([freshOut]);
  for (const rel of ["com/x/ExistingTest.class", "com/x/NewTest.class", "com/x/NewTestEdgeCases.class", "app.yml"]) {
    fs.mkdirSync(path.dirname(path.join(freshOut, rel)), { recursive: true });
    fs.writeFileSync(path.join(freshOut, rel), "x");
  }
  const freshRemoved = removeBatchOutputs(freshCap, ["java/com/x/NewTest.java"]).map((f) => path.relative(freshOut, f).replace(/\\/g, "/"));
  check(
    "removeBatchOutputs：輸出目錄是這批的建置才建的 → 裡面全是這批的，全部清掉（同一個檔裡第二個類別的 .class 也不留；下一次建置重編）",
    JSON.stringify(freshRemoved) === JSON.stringify(["app.yml", "com/x/ExistingTest.class", "com/x/NewTest.class", "com/x/NewTestEdgeCases.class"]),
    JSON.stringify(freshRemoved),
  );
  fs.rmSync(freshOut, { recursive: true, force: true });

  // Across batches: the same build failure for two classes, but for their names and numbers.
  const crash = (cls: string, t: string) =>
    `[ERROR] The forked VM terminated without properly saying goodbye.\n[ERROR] Command was java -jar surefirebooter${t}.jar\n[ERROR] Crashed tests:\n[ERROR] com.x.${cls}Test`;
  check(
    "batchFailureFingerprint：去掉各批自己的類別名稱與數字後一樣 → 同一個外部問題",
    batchFailureFingerprint(crash("Calc", "20260101"), ["src/main/java/com/x/Calc.java"]) ===
      batchFailureFingerprint(crash("Greeter", "20260102"), ["src/main/java/com/x/Greeter.java"]),
  );
  check(
    "batchFailureFingerprint：各自的編譯錯誤（不同的符號）→ 不一樣",
    batchFailureFingerprint("[ERROR] CalcTest.java:[9,9] cannot find symbol: variable total", ["src/main/java/com/x/Calc.java"]) !==
      batchFailureFingerprint("[ERROR] GreeterTest.java:[9,9] cannot find symbol: variable greeting", ["src/main/java/com/x/Greeter.java"]),
  );
  check("batchFailureFingerprint：沒有報告 → 空（不當成相同）", batchFailureFingerprint(undefined, ["A.java"]) === "");
  check(
    "batchFailureFingerprint：每次都不一樣的 hash、request id（十六進位）也拿掉",
    batchFailureFingerprint("Could not resolve com.corp:lib, request id abfee1, at Calc@1b6d3586", ["Calc.java"]) ===
      batchFailureFingerprint("Could not resolve com.corp:lib, request id ac3bc8, at Calc@7a81197d", ["Calc.java"]),
  );
  check(
    "batchFailureFingerprint：由 a–f 組成的英文字（facade、added）不當成 hash",
    batchFailureFingerprint("facade added", []) === "facade added",
  );
  check(
    "batchFailureFingerprint：UUID（四位一組的部分十六進位規則抓不到）也拿掉",
    batchFailureFingerprint("jdbc:h2:mem:0f8fad5b-d9cb-469f-a165-70867728950e failed", ["Calc.java"]) ===
      batchFailureFingerprint("jdbc:h2:mem:7c9e6679-7425-40de-944b-e07fc1f90ae7 failed", ["Calc.java"]),
  );
  check(
    "batchFailureFingerprint：類別名稱只在程式碼裡算（HelpTest、Help.java），Maven 文字裡的 [Help 1]、Could not 不算",
    batchFailureFingerprint("[ERROR] Could not resolve -> [Help 1]", ["src/main/java/com/x/Help.java", "src/main/java/com/x/Could.java"]) ===
      "[ERROR] Could not resolve -> [Help #]" &&
      batchFailureFingerprint("HelpTest.java:[3,1] in com.x.Help.run(", ["src/main/java/com/x/Help.java"]).split("<target>").length === 3,
  );
  check(
    "batchFailureFingerprint：Windows 路徑的類別名稱照樣拿掉",
    batchFailureFingerprint("x CalcTest y", ["src\\main\\java\\Calc.java"]) === "x <target>Test y",
  );
}

// ---------------------------------------------------------------------------
// 25. The module's test stack, measured (libs/teststack.ts) and rendered into the prompt
// ---------------------------------------------------------------------------
console.log("\n[25] 測試相依量測（surefire classpath / pom）與 prompt");
{
  const posix = '<properties>\n<property name="java.version" value="17"/>\n<property name="surefire.test.class.path" value="/r/target/test-classes:/m2/org/junit/jupiter/junit-jupiter-api/5.10.2/junit-jupiter-api-5.10.2.jar:/m2/org/mockito/mockito-core/5.11.0/mockito-core-5.11.0.jar:/m2/org/mockito/mockito-junit-jupiter/5.11.0/mockito-junit-jupiter-5.11.0.jar:/m2/org/assertj/assertj-core/3.25.3/assertj-core-3.25.3.jar"/>\n</properties>';
  const modern = stackFromClasspath(classpathFromSurefireXml(posix))!;
  check(
    "surefire classpath（POSIX）→ JUnit 5、Mockito 5（MockitoExtension、inline）、AssertJ",
    modern.source === "surefire" && modern.junit5 === "5.10.2" && modern.junit4 === undefined && modern.mockito === "5.11.0" &&
      modern.mockitoJupiter === true && modern.mockitoInline === true && modern.assertj === "3.25.3",
    JSON.stringify(modern),
  );
  const win =
    '<property name="surefire.test.class.path" value="C:\\r\\target\\test-classes;C:\\m2\\junit\\junit\\4.12\\junit-4.12.jar;C:\\m2\\org\\mockito\\mockito-core\\2.23.4\\mockito-core-2.23.4.jar;C:\\m2\\org\\hamcrest\\hamcrest-core\\1.3\\hamcrest-core-1.3.jar"/>';
  const legacy = stackFromClasspath(classpathFromSurefireXml(win))!;
  check(
    "surefire classpath（Windows，; 分隔、磁碟機代號含 :）→ 只有 JUnit 4、Mockito 2（沒有 MockitoExtension、沒有 inline）、只有 hamcrest-core",
    legacy.junit4 === "4.12" && legacy.junit5 === undefined && legacy.mockito === "2.23.4" && legacy.mockitoJupiter === false &&
      legacy.mockitoInline === false && legacy.assertj === undefined && legacy.hamcrest === "1.3" && legacy.hamcrestCoreOnly === true,
    JSON.stringify(legacy),
  );
  check(
    "surefire 2.20 以前：報告裡的 java.class.path 是 Maven 自己的 boot jar，不是測試 classpath → 不採用",
    classpathFromSurefireXml('<property name="java.class.path" value="/opt/maven/boot/plexus-classworlds-2.9.0.jar"/>').length === 0,
  );
  check(
    "java.class.path 含模組的 test-classes（forkCount=0 等）→ 才當成測試 classpath",
    classpathFromSurefireXml('<property name="java.class.path" value="/r/target/test-classes:/m/junit-4.13.2.jar"/>').length === 2,
  );
  check("classpath 裡沒有任何測試框架 → 當作沒量到（不宣稱「沒有 Mockito」）", stackFromClasspath(["/m/commons-lang3-3.12.0.jar"]) === undefined);
  check(
    "surefire classpath：mockito-inline jar → 可 mock final；Mockito 4 有 mockStatic",
    canMockStatic(stackFromClasspath(["/m/junit-4.13.2.jar", "/m/mockito-core-4.11.0.jar", "/m/mockito-inline-4.11.0.jar"])!),
  );
  check(
    "Mockito 3.3 + inline：能 mock final，不能 mock static（mockStatic 3.4 才有）",
    !canMockStatic({ source: "surefire", mockito: "3.3.3", mockitoInline: true }) && canMockStatic({ source: "surefire", mockito: "3.4.0", mockitoInline: true }),
  );
  check("版本不明（空字串）的 inline 不宣稱能 mock static", !canMockStatic({ source: "pom", mockito: "", mockitoInline: true }));
  check("surefire classpath：屬性值裡的 XML 跳脫字元照樣解開", classpathFromSurefireXml('<property name="surefire.test.class.path" value="/a&amp;b/junit-4.13.2.jar"/>')[0] === "/a&b/junit-4.13.2.jar");
  check("surefire classpath：沒有 classpath 屬性 → 空", classpathFromSurefireXml("<testsuite/>").length === 0);
  const hamcrest2 = stackFromClasspath(["/m/junit-jupiter-api-5.9.0.jar", "/m/hamcrest-2.2.jar"])!;
  check("Hamcrest 2（單一 jar）→ 完整 Hamcrest", hamcrest2.hamcrest === "2.2" && !hamcrest2.hamcrestCoreOnly);

  const bootPom = (v: string, extra = "") =>
    `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>${v}</version><relativePath/></parent>` +
    `<artifactId>svc</artifactId><properties><java.version>1.8</java.version>${extra}</properties>` +
    "<dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency></dependencies></project>";
  const boot21 = stackFromPom(pomFactsFromChain([bootPom("2.1.4.RELEASE")]))!;
  check(
    "pom：Spring Boot 2.1 → 推斷 JUnit 4.12、Mockito 2.23.4、AssertJ 3.11.1（依 Boot 的版本管理，標明是推斷）",
    boot21.source === "pom" && boot21.junit4 === "4.12" && boot21.junit5 === undefined && boot21.mockito === "2.23.4" && boot21.assertj === "3.11.1" &&
      !!boot21.inferred?.some((l) => l.includes("只帶 JUnit 4")),
    JSON.stringify(boot21),
  );
  const boot21Prompt = renderTestStack(boot21);
  check(
    "prompt（Boot 2.1）：不叫 JUnit 4.12 用 assertThrows；有 AssertJ 就用 assertThatThrownBy；測試要 public",
    !boot21Prompt.includes("Assert.assertThrows") && boot21Prompt.includes("assertThatThrownBy") && boot21Prompt.includes("public") && frameworkOf(boot21) === "JUnit 4",
    boot21Prompt,
  );
  check("prompt（Boot 2.1、沒有其他外部 parent）：依 Boot 的版本推斷「只有 JUnit 4」", boot21Prompt.includes("**只有** JUnit 4"), boot21Prompt);
  const corpBoot = stackFromPom(
    pomFactsFromChain([
      "<project><parent><groupId>com.corp</groupId><artifactId>corp-parent</artifactId><version>9</version></parent><artifactId>x</artifactId>" +
        "<dependencyManagement><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId>" +
        "<version>2.1.4.RELEASE</version><type>pom</type><scope>import</scope></dependency></dependencies></dependencyManagement>" +
        "<dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId></dependency></dependencies></project>",
    ]),
  )!;
  const corpBootPrompt = renderTestStack(corpBoot);
  check(
    "pom：Boot 2.1 的 BOM、但 parent 是 repo 外的公司 parent → 用 JUnit 4，不宣稱「只有」（parent 可能另帶 JUnit 5）",
    frameworkOf(corpBoot) === "JUnit 4" && !corpBootPrompt.includes("只有") && corpBootPrompt.includes("corp-parent"),
    corpBootPrompt,
  );
  const boot15 = stackFromPom(pomFactsFromChain([bootPom("1.5.22.RELEASE")]))!;
  const boot15Prompt = renderTestStack(boot15);
  check(
    "pom：Spring Boot 1.5 → Mockito 1.10.19（1.x 的 Matchers 與 org.mockito.runners）",
    boot15.mockito === "1.10.19" && boot15Prompt.includes("org.mockito.Matchers") && boot15Prompt.includes("org.mockito.runners.MockitoJUnitRunner"),
    boot15Prompt,
  );
  check("pom：Spring Boot 1.3 的 starter-test 沒有 AssertJ", stackFromPom(pomFactsFromChain([bootPom("1.3.8.RELEASE")]))?.assertj === undefined);
  const boot23 = stackFromPom(pomFactsFromChain([bootPom("2.3.12.RELEASE")]))!;
  check("pom：Spring Boot 2.3 → JUnit 5 與 JUnit 4.13.2（vintage）都有、Mockito 3.3.3", boot23.junit5 !== undefined && boot23.junit4 === "4.13.2" && boot23.mockito === "3.3.3", JSON.stringify(boot23));
  const boot27 = stackFromPom(pomFactsFromChain([bootPom("2.7.18")]))!;
  check("pom：Spring Boot 2.7 → 只有 JUnit 5、有 mockito-junit-jupiter", boot27.junit5 !== undefined && boot27.junit4 === undefined && boot27.mockitoJupiter === true, JSON.stringify(boot27));
  check("pom：Spring Boot 3.1 → Mockito 5（inline，可 mock static）", canMockStatic(stackFromPom(pomFactsFromChain([bootPom("3.1.12")]))!));
  check("pom：比對照表新的 Boot（3.5）→ 沿用最後一列的主版本", stackFromPom(pomFactsFromChain([bootPom("3.5.0")]))?.mockito === "5");
  check(
    "pom：pom 用屬性覆寫 Boot 管理的版本（junit.version、mockito.version）",
    (() => {
      const o = stackFromPom(pomFactsFromChain([bootPom("2.1.4.RELEASE", "<junit.version>4.13.1</junit.version><mockito.version>3.5.13</mockito.version>")]))!;
      return o.junit4 === "4.13.1" && o.mockito === "3.5.13";
    })(),
  );
  const vintageExcluded = bootPom("2.2.13.RELEASE").replace(
    "<scope>test</scope>",
    "<scope>test</scope><exclusions><exclusion><groupId>org.junit.vintage</groupId><artifactId>junit-vintage-engine</artifactId></exclusion></exclusions>",
  );
  check("pom：Boot 2.2 排除了 vintage engine → 不說有 JUnit 4", stackFromPom(pomFactsFromChain([vintageExcluded]))?.junit4 === undefined);

  const reactorParent =
    "<project><artifactId>parent</artifactId><properties><junit.version>5.9.2</junit.version><maven.compiler.release>11</maven.compiler.release></properties>" +
    "<dependencyManagement><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency></dependencies></dependencyManagement></project>";
  const child =
    "<project><parent><artifactId>parent</artifactId></parent><artifactId>web</artifactId>" +
    "<dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>${junit.version}</version></dependency></dependencies>" +
    "<build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version></dependency></dependencies></plugin></plugins></build></project>";
  const reactorFacts = pomFactsFromChain([child, reactorParent]);
  const reactor = stackFromPom(reactorFacts);
  check(
    "pom：父 pom 的屬性解開 ${junit.version}；dependencyManagement 與 plugin 自己的相依不算",
    reactor?.junit5 === "5.9.2" && reactor?.junit4 === undefined && reactorFacts.artifactId === "web",
    JSON.stringify(reactor),
  );
  const withProfiles =
    "<project><artifactId>p</artifactId><profiles><profile><id>old</id><properties><maven.compiler.release>8</maven.compiler.release></properties>" +
    "<dependencies><dependency><groupId>org.mockito</groupId><artifactId>mockito-inline</artifactId><version>4.11.0</version></dependency></dependencies></profile></profiles>" +
    "<properties><maven.compiler.release>17</maven.compiler.release></properties>" +
    "<dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency></dependencies></project>";
  const profileFacts = pomFactsFromChain([withProfiles]);
  const profileStack = stackFromPom(profileFacts);
  check(
    "pom：profile 裡的屬性與相依不算（它啟用與否 pom 看不出來，先讀到還會蓋掉專案自己的值）",
    profileFacts.properties["maven.compiler.release"] === "17" && profileStack?.mockitoInline === undefined,
    JSON.stringify({ props: profileFacts.properties, profileStack }),
  );
  const corporate = stackFromPom(
    pomFactsFromChain(["<project><parent><groupId>com.corp</groupId><artifactId>corp-parent</artifactId><version>9</version></parent><artifactId>x</artifactId><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency></dependencies></project>"]),
  )!;
  const corporatePrompt = renderTestStack(corporate);
  check(
    "pom：只宣告 junit:junit、繼承 repo 外的公司 parent、沒有既有測試 → 用宣告的 JUnit 4，不宣稱「只有」「沒有 JUnit 5」，並說明為什麼不確定",
    corporate.unknownParent === "corp-parent" && frameworkOf(corporate) === "JUnit 4" && corporatePrompt.includes("corp-parent") &&
      corporatePrompt.includes("pom 宣告了 junit:junit") && !corporatePrompt.includes("只有") && !corporatePrompt.includes("沒有 JUnit 5"),
    corporatePrompt || JSON.stringify(corporate),
  );
  const corporateUsed = { ...corporate, usage: { junit5: 0, junit4: 7, testng: 0 } };
  const corporateUsedPrompt = renderTestStack(corporateUsed);
  check(
    "pom：同上、但既有測試都是 JUnit 4 → 用 JUnit 4，且不宣稱「沒有 JUnit 5」",
    frameworkOf(corporateUsed) === "JUnit 4" && corporateUsedPrompt.includes("既有測試用的是 JUnit 4（7 個") && !corporateUsedPrompt.includes("沒有 JUnit 5"),
    corporateUsedPrompt,
  );
  check(
    "pom：同上、但既有測試有 JUnit 5 的 → 用 JUnit 5",
    frameworkOf({ ...corporate, usage: { junit5: 1, junit4: 7, testng: 0 } }) === "JUnit 5",
  );
  const declared4 = stackFromPom(
    pomFactsFromChain(["<project><artifactId>x</artifactId><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version></dependency></dependencies></project>"]),
  )!;
  const declared4Prompt = renderTestStack(declared4);
  check(
    "pom：只宣告 junit:junit、沒有外部 parent → JUnit 4；但 JUnit 5 可能是間接帶進來的 → 不宣稱「只有」「沒有 JUnit 5」",
    frameworkOf(declared4) === "JUnit 4" && !declared4Prompt.includes("只有") && !declared4Prompt.includes("沒有 JUnit 5") && declared4Prompt.includes("實際的測試 classpath"),
    declared4Prompt,
  );
  check(
    "pom：沒宣告任何框架、既有測試是 JUnit 5 → JUnit 5，並說明它是間接帶進來的",
    (() => {
      const u = { source: "pom" as const, mockito: "4.11.0", usage: { junit5: 3, junit4: 0, testng: 0 } };
      const p = renderTestStack(u);
      return frameworkOf(u) === "JUnit 5" && p.includes("既有測試有 3 個用 JUnit 5");
    })(),
  );

  // Whether JUnit 5 tests run at all: the API alone is not enough before surefire 3.0.0-M4.
  const apiOnly = stackFromClasspath(["/m/junit-jupiter-api-5.9.0.jar", "/m/junit-4.13.2.jar", "/m/mockito-core-4.11.0.jar"])!;
  check(
    "surefire classpath：只有 junit-jupiter-api → jupiterEngine=false；有 junit-jupiter-engine → true",
    apiOnly.jupiterEngine === false && stackFromClasspath(["/m/junit-jupiter-api-5.9.0.jar", "/m/junit-jupiter-engine-5.9.0.jar"])!.jupiterEngine === true,
  );
  check(
    "surefireResolvesEngine：3.0.0-M4 起 surefire 才會自己替 API 帶 engine",
    ["3.0.0-M4", "3.0.0-M10", "3.0.0", "3.1.2", "4.0.0-beta-1"].every(surefireResolvesEngine) &&
      !["3.0.0-M3", "2.22.2", "2.12.4", "3.0.0-SNAPSHOT", "x"].some(surefireResolvesEngine),
  );
  const api2222 = { ...apiOnly, surefireVersion: "2.22.2", pluginEngine: false };
  check("jupiterRuns：surefire 2.22.2、只有 API → 不執行 JUnit 5", jupiterRuns(api2222) === false);
  check("jupiterRuns：surefire 3.0.0-M4、只有 API → 執行（plugin 自己解析 engine）", jupiterRuns({ ...api2222, surefireVersion: "3.0.0-M4" }) === true);
  check("jupiterRuns：2.22.2、engine 在測試 classpath → 執行", jupiterRuns({ ...api2222, jupiterEngine: true }) === true);
  check(
    "jupiterRuns：2.19.1、engine 在 classpath 但 plugin 沒有 provider → 不執行（2.22 以前沒有內建 JUnit Platform）",
    jupiterRuns({ ...api2222, surefireVersion: "2.19.1", jupiterEngine: true }) === false,
  );
  check("jupiterRuns：plugin 自己的相依裡有 provider / engine → 執行", jupiterRuns({ ...api2222, pluginEngine: true }) === true);
  check("jupiterRuns：不知道 surefire 版本 → 不斷定", jupiterRuns({ ...api2222, surefireVersion: undefined }) === undefined);
  check("jupiterRuns：plugin 設定可能在 repo 外的 parent → 不斷定", jupiterRuns({ ...api2222, pluginEngine: undefined }) === undefined);
  check("jupiterRuns：讀 pom 得來的 → 不斷定", jupiterRuns({ source: "pom", junit5: "5.9.0" }) === undefined);
  const api2222Prompt = renderTestStack(api2222);
  check(
    "prompt：surefire 2.22.2 只有 JUnit 5 API、另有 JUnit 4 → 用 JUnit 4，說明 JUnit 5 測試不會被執行，不宣稱「只有 JUnit 4」",
    frameworkOf(api2222) === "JUnit 4" && api2222Prompt.includes("不會執行 JUnit 5 測試") && api2222Prompt.includes("2.22.2") && !api2222Prompt.includes("**只有**"),
    api2222Prompt,
  );
  check("prompt：surefire 3.2.5 只有 JUnit 5 API → JUnit 5", frameworkOf({ ...api2222, surefireVersion: "3.2.5" }) === "JUnit 5");
  check(
    "surefire 版本：舊版 header（maven-surefire-plugin:x:test），歸屬到目標模組",
    surefireVersionFromLog("[INFO] --- maven-surefire-plugin:2.19.1:test (default-test) @ common ---\n[INFO] --- maven-surefire-plugin:2.22.2:test (default-test) @ web ---", "web") === "2.22.2",
  );
  check("surefire 版本：Maven 3.9 的短 header（surefire:3.2.5:test）", surefireVersionFromLog("12:00 [INFO] --- surefire:3.2.5:test (default-test) @ web ---", "web") === "3.2.5");
  check("surefire 版本：log 裡沒有目標模組的 → 量不到", surefireVersionFromLog("[INFO] --- surefire:3.2.5:test (default-test) @ common ---", "web") === undefined);
  check(
    "mergeTestStack：編譯失敗的建置（log 沒有 surefire）不抹掉先前量到的 surefire 版本",
    mergeTestStack(api2222, { ...apiOnly, surefireVersion: undefined })?.surefireVersion === "2.22.2",
  );
  const noInline = renderTestStack({ source: "surefire", junit5: "5.9.0", jupiterEngine: true, mockito: "4.11.0", mockitoJupiter: true, mockitoInline: false });
  check(
    "prompt：classpath 上看不到 inline mock maker → 照實說「看不到」並建議避開，不斷言「不能」（開關也可能在相依的 jar 裡）",
    noInline.includes("看不到 inline mock maker") && !noInline.includes("**不能**") && noInline.includes("mockStatic 編得過"),
    noInline,
  );

  const multiLog = [
    "[INFO] --- maven-compiler-plugin:3.11.0:testCompile (default-testCompile) @ common ---",
    "[INFO] Compiling 4 source files with javac [debug target 1.8] to target/test-classes",
    "[INFO] --- compiler:3.13.0:compile (default-compile) @ web ---",
    "[INFO] Compiling 9 source files with javac [debug release 17] to target/classes",
    "[INFO] --- compiler:3.13.0:testCompile (default-testCompile) @ web ---",
    "[INFO] Compiling 3 source files with javac [debug deprecation release 17] to target/test-classes",
  ].join("\n");
  check("編譯 log：語言層級歸屬到目標模組（不是上游模組的 1.8）", javaReleaseFromLog(multiLog, "web") === "17", String(javaReleaseFromLog(multiLog, "web")));
  check(
    "編譯 log：level 後面還有 module-path、行首有時間戳 → 照樣讀得到",
    javaReleaseFromLog("12:00:01 [INFO] --- compiler:3.13.0:testCompile (default-testCompile) @ web ---\n12:00:02 [INFO] Compiling 3 source files with javac [debug release 21 module-path] to target/test-classes", "web") === "21",
  );
  check("編譯 log：什麼都沒編（up to date）→ 量不到", javaReleaseFromLog("[INFO] Nothing to compile - all classes are up to date", "web") === undefined);
  check(
    "mergeTestStack：編譯 log 量到的語言層級不被之後讀 pom 的值蓋掉；classpath 量測不被 pom 讀取取代",
    (() => {
      const m = mergeTestStack({ ...modern, javaRelease: "17", javaReleaseFrom: "log" }, { source: "pom", junit4: "4.12", javaRelease: "8", javaReleaseFrom: "pom" })!;
      return m.source === "surefire" && m.junit5 === "5.10.2" && m.javaRelease === "17";
    })(),
  );

  const j4 = renderTestStack(legacy);
  check(
    "prompt：只有 JUnit 4 → 明說不能用 JUnit 5 的寫法、用 MockitoJUnitRunner、沒有 AssertJ、測試要 public",
    j4.includes("只有") && j4.includes("@ExtendWith") && j4.includes("org.mockito.junit.MockitoJUnitRunner") && j4.includes("沒有 AssertJ") &&
      j4.includes("public") && frameworkOf(legacy) === "JUnit 4",
    j4,
  );
  check("prompt：JUnit 4.12 沒有 assertThrows，4.13 才有", j4.includes("assertThrows 要 JUnit 4.13") && renderTestStack({ ...legacy, junit4: "4.13.2" }).includes("Assert.assertThrows"));
  check("prompt：Mockito 2 沒有 mockStatic（不是「編得過、執行時失敗」）", j4.includes("沒有 mockStatic"), j4);
  check("prompt：只有 hamcrest-core → 說沒有 org.hamcrest.Matchers", j4.includes("沒有 org.hamcrest.Matchers"), j4);
  const m5 = renderTestStack(modern);
  check("prompt：Mockito 5 → MockitoExtension（提醒 strict stubs）、可 mock static", m5.includes("MockitoExtension") && m5.includes("strict stubs") && m5.includes("mockStatic"), m5);
  const inline33 = renderTestStack({ source: "surefire", junit5: "5.6.3", mockito: "3.3.3", mockitoJupiter: true, mockitoInline: true });
  check("prompt：Mockito 3.3 + inline → 能 mock final、沒有 mockStatic", inline33.includes("可以 mock final") && inline33.includes("沒有 mockStatic"), inline33);
  const noJupiter = renderTestStack({ source: "surefire", junit5: "5.9.0", mockito: "3.3.3", mockitoJupiter: false, mockitoInline: false });
  check("prompt：沒有 mockito-junit-jupiter 的 Mockito 3.3 → initMocks（openMocks 是 3.4 才有）", noJupiter.includes("initMocks(this)") && !noJupiter.includes("openMocks"), noJupiter);
  const ngMixed: typeof modern = { source: "surefire", junit5: "5.10.2", testng: "7.5.1", mockito: "5.11.0", mockitoInline: true, mockitoJupiter: true, usage: { junit5: 1, junit4: 0, testng: 12 } };
  const ngPrompt = renderTestStack(ngMixed);
  check(
    "prompt：TestNG 與 JUnit 並存、既有測試是 TestNG → 用 TestNG，並說明 surefire 只跑一個 provider",
    frameworkOf(ngMixed) === "TestNG" && ngPrompt.includes("org.testng.annotations.Test") && ngPrompt.includes("provider") && ngPrompt.includes("openMocks"),
    ngPrompt,
  );
  const pomOnly = renderTestStack({ source: "pom", junit5: "5.9.2" });
  check("prompt：來自 pom 的清單不宣稱「沒有 AssertJ / Mockito」（多數相依是間接帶進來的）", !pomOnly.includes("沒有 AssertJ") && !pomOnly.includes("沒有 Mockito") && pomOnly.includes("沒列出的不代表沒有"), pomOnly);
  const java8 = renderTestStack({ source: "pom", javaRelease: "8" });
  check("prompt：Java 8 → 列出不能用的語法與 API（var、List.of、isBlank、Stream.toList…）", ["var", "List.of", "isBlank", "Stream.toList", "text block"].every((w) => java8.includes(w)) && !java8.includes("lambda"), java8);
  check("prompt：Java 7 → 連 lambda 都不能用", renderTestStack({ source: "pom", javaRelease: "7" }).includes("lambda"));
  check("prompt：Java 21 → 不列限制", !renderTestStack({ source: "pom", javaRelease: "21" }).includes("不能用"));
  check("prompt：量不到 → 不加任何段落、任務行維持 JUnit 5", renderTestStack(undefined) === "" && frameworkOf(undefined) === "JUnit 5");

  // measureTestStack on disk: a current surefire report wins over the pom; a stale one does not.
  const mod = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-stack-"));
  const info = { moduleRoot: mod, moduleRel: "", multiModule: false };
  const report = path.join(mod, "target", "surefire-reports", "TEST-a.AppTest.xml");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, `<testsuite>${posix}</testsuite>`);
  const past = (Date.now() - 60_000) / 1000;
  fs.utimesSync(report, past, past);
  fs.writeFileSync(path.join(mod, "pom.xml"), bootPom("2.1.4.RELEASE"));
  const stale = measureTestStack(info, mod);
  check("measureTestStack：報告比 pom 舊（pom 之後改過）→ 不採用，退回讀 pom（java.version 1.8 → 8）", stale?.source === "pom" && stale.javaRelease === "8", JSON.stringify(stale));
  const fresh = measureTestStack(info, mod, "", Date.now() - 120_000);
  check("measureTestStack：這次建置寫的報告（since 之後）→ 以實際 classpath 為準", fresh?.source === "surefire" && fresh.junit5 === "5.10.2", JSON.stringify(fresh));
  const now = Date.now() / 1000;
  fs.utimesSync(report, now, now);
  check("measureTestStack：沒有 since，但報告比 pom 新 → 採用", measureTestStack(info, mod)?.source === "surefire");
  fs.mkdirSync(path.join(mod, "src", "test", "resources", "mockito-extensions"), { recursive: true });
  const makerFile = path.join(mod, "src", "test", "resources", "mockito-extensions", "org.mockito.plugins.MockMaker");
  fs.writeFileSync(makerFile, "mock-maker-subclass\n");
  check("measureTestStack：Mockito 5 + mock-maker-subclass 開關 → 關掉 inline", measureTestStack(info, mod)?.mockitoInline === false);
  fs.writeFileSync(makerFile, "mock-maker-inline\n");
  fs.writeFileSync(report, `<testsuite>${win}</testsuite>`);
  check("measureTestStack：mock-maker-inline 開關 → 可 mock final", measureTestStack(info, mod)?.mockitoInline === true);
  fs.rmSync(mod, { recursive: true, force: true });

  // Declared JUnit 4 under a parent outside the repo, no usable report: the existing tests decide.
  const corp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-stack-"));
  const corpInfo = { moduleRoot: corp, moduleRel: "", multiModule: false };
  fs.writeFileSync(
    path.join(corp, "pom.xml"),
    "<project><parent><groupId>com.corp</groupId><artifactId>corp-parent</artifactId><version>9</version></parent><artifactId>x</artifactId>" +
      "<dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency></dependencies></project>",
  );
  const corpTest = path.join(corp, "src", "test", "java", "a", "OldTest.java");
  fs.mkdirSync(path.dirname(corpTest), { recursive: true });
  fs.writeFileSync(corpTest, "package a;\nimport org.junit.Test;\npublic class OldTest { @Test public void x() {} }\n");
  const corpStack = measureTestStack(corpInfo, corp);
  check(
    "measureTestStack：公司 parent 下只宣告 junit:junit → 數既有測試的框架，既有測試是 JUnit 4 就用 JUnit 4",
    corpStack?.usage?.junit4 === 1 && frameworkOf(corpStack) === "JUnit 4",
    JSON.stringify(corpStack),
  );
  fs.rmSync(corp, { recursive: true, force: true });

  // The JUnit 5 setup of the surefire 2.19–2.21 days: a provider (and the engine) as the plugin's
  // own dependencies, only the API on the test classpath. Measured, it runs; the same classpath on
  // 2.22 without them does not.
  const legacy5 = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-stack-"));
  const legacy5Info = { moduleRoot: legacy5, moduleRel: "", multiModule: false };
  const legacy5Pom = (pluginDeps: string) =>
    "<project><artifactId>svc</artifactId><dependencies>" +
    "<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter-api</artifactId><version>5.3.2</version></dependency>" +
    "<dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version></dependency></dependencies>" +
    `<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId>${pluginDeps}</plugin></plugins></build></project>`;
  fs.writeFileSync(
    path.join(legacy5, "pom.xml"),
    legacy5Pom("<dependencies><dependency><groupId>org.junit.platform</groupId><artifactId>junit-platform-surefire-provider</artifactId><version>1.3.2</version></dependency></dependencies>"),
  );
  const legacy5Report = path.join(legacy5, "target", "surefire-reports", "TEST-a.OldTest.xml");
  fs.mkdirSync(path.dirname(legacy5Report), { recursive: true });
  fs.writeFileSync(legacy5Report, '<testsuite><property name="surefire.test.class.path" value="/r/target/test-classes:/m/junit-jupiter-api-5.3.2.jar:/m/junit-4.12.jar"/></testsuite>');
  const withProvider = measureTestStack(legacy5Info, legacy5, "[INFO] --- maven-surefire-plugin:2.19.1:test (default-test) @ svc ---", Date.now() - 60_000);
  check(
    "measureTestStack：surefire plugin 自己的相依裡有 JUnit Platform provider → JUnit 5 會執行",
    withProvider?.pluginEngine === true && withProvider.surefireVersion === "2.19.1" && jupiterRuns(withProvider) === true && frameworkOf(withProvider) === "JUnit 5",
    JSON.stringify(withProvider),
  );
  fs.writeFileSync(path.join(legacy5, "pom.xml"), legacy5Pom(""));
  const withoutProvider = measureTestStack(legacy5Info, legacy5, "[INFO] --- maven-surefire-plugin:2.22.2:test (default-test) @ svc ---", Date.now() - 60_000);
  check(
    "measureTestStack：2.22.2、只有 API、plugin 沒有 provider → JUnit 5 不會執行，新測試用 JUnit 4",
    withoutProvider?.pluginEngine === false && jupiterRuns(withoutProvider) === false && frameworkOf(withoutProvider) === "JUnit 4",
    JSON.stringify(withoutProvider),
  );
  // The engine alone among the plugin's dependencies does nothing before 3.0.0-M4 (only JUnit's own
  // provider there does), and after it the plugin resolves the engine itself.
  fs.writeFileSync(
    path.join(legacy5, "pom.xml"),
    legacy5Pom("<dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter-engine</artifactId><version>5.3.2</version></dependency></dependencies>"),
  );
  const engineInPlugin = measureTestStack(legacy5Info, legacy5, "[INFO] --- maven-surefire-plugin:2.22.2:test (default-test) @ svc ---", Date.now() - 60_000);
  check(
    "measureTestStack：2.22.2、engine 只放在 surefire plugin 的相依裡（沒有 JUnit 的 provider）→ JUnit 5 不會執行",
    engineInPlugin?.pluginEngine === false && jupiterRuns(engineInPlugin) === false && frameworkOf(engineInPlugin) === "JUnit 4",
    JSON.stringify(engineInPlugin),
  );
  // surefire 3 prints the provider it ran with: that settles it.
  const provLog = (p: string) =>
    `[INFO] --- surefire:3.2.5:test (default-test) @ svc ---\n[INFO] Using auto detected provider org.apache.maven.surefire.${p}`;
  const withNg = measureTestStack(legacy5Info, legacy5, provLog("junitplatform.JUnitPlatformProvider"), Date.now() - 60_000);
  check(
    "surefireProviderFromLog：「Using auto detected / configured provider」→ 哪個 provider；歸屬到目標模組",
    surefireProviderFromLog(provLog("junitplatform.JUnitPlatformProvider"), "svc") === "junit-platform" &&
      surefireProviderFromLog("[INFO] --- surefire:3.2.5:test (default-test) @ svc ---\n[INFO] Using configured provider org.apache.maven.surefire.junit4.JUnit4Provider", "svc") === "junit4" &&
      surefireProviderFromLog(provLog("testng.TestNGProvider"), "other") === undefined &&
      withNg?.surefireProvider === "junit-platform",
    JSON.stringify(withNg),
  );
  fs.rmSync(legacy5, { recursive: true, force: true });
  const ngJupiter = { source: "surefire" as const, junit5: "5.9.2", testng: "7.8.0", jupiterEngine: true, pluginEngine: false };
  check(
    "jupiterRuns / frameworkOf：surefire 2.x 上 classpath 有 TestNG → TestNG provider 優先，JUnit 5 不會執行",
    jupiterRuns({ ...ngJupiter, surefireVersion: "2.22.2" }) === false && frameworkOf({ ...ngJupiter, surefireVersion: "2.22.2" }) === "TestNG",
  );
  check(
    "frameworkOf：surefire 說它用 JUnit Platform provider → JUnit 5（TestNG 測試在它底下不會執行）；說用 JUnit4Provider → JUnit 4",
    frameworkOf({ ...ngJupiter, surefireVersion: "3.2.5", surefireProvider: "junit-platform", usage: { junit5: 0, junit4: 0, testng: 9 } }) === "JUnit 5" &&
      frameworkOf({ source: "surefire", junit5: "5.9.2", junit4: "4.13.2", surefireVersion: "3.2.5", surefireProvider: "junit4" }) === "JUnit 4",
  );
  const platform = { source: "surefire" as const, junit5: "5.9.2", junit4: "4.13.2", jupiterEngine: false, pluginEngine: false, surefireProvider: "junit-platform" as const };
  check(
    "jupiterRuns：surefire 說的 provider 為準——3.x 設定成 junit47 provider → 不執行 JUnit 5（實測 3.2.5）",
    jupiterRuns({ source: "surefire", junit5: "5.9.2", junit4: "4.13.2", surefireVersion: "3.2.5", surefireProvider: "junit47" }) === false,
  );
  check(
    "jupiterRuns / frameworkOf：JUnit Platform provider 還要有 Jupiter engine——3.2.5 自己補上 → 執行；3.0.0-M3、classpath 上只有 vintage → 不執行，用 JUnit 4",
    jupiterRuns({ ...platform, surefireVersion: "3.2.5" }) === true &&
      jupiterRuns({ ...platform, surefireVersion: "3.0.0-M3" }) === false &&
      frameworkOf({ ...platform, surefireVersion: "3.0.0-M3" }) === "JUnit 4" &&
      frameworkOf({ ...platform, surefireVersion: "3.2.5" }) === "JUnit 5",
  );
  const configured4 = renderTestStack({ source: "surefire", junit5: "5.9.2", junit4: "4.13.2", surefireVersion: "3.2.5", surefireProvider: "junit4" });
  check("prompt：provider 是 JUnit 4 → 說明原因是 provider，不是「沒有 engine」", configured4.includes("junit4 provider") && !configured4.includes("沒有 junit-jupiter-engine"), configured4);
}

// ---------------------------------------------------------------------------
// 26. Non-UTF-8 source encodings (libs/encoding.ts)
// ---------------------------------------------------------------------------
console.log("\n[26] 原始碼編碼（MS950 等非 UTF-8）");
{
  check("sourceEncodingFrom：compiler plugin 的 <encoding> 優先", sourceEncodingFrom({ compilerEncoding: "MS950", sourceEncoding: "UTF-8" }, "")?.name === "MS950");
  check("sourceEncodingFrom：project.build.sourceEncoding", sourceEncodingFrom({ sourceEncoding: "Big5" }, "")?.source === "pom");
  check(
    "sourceEncodingFrom：pom 沒設 → 讀 resources plugin 2.x 的平台編碼警告",
    sourceEncodingFrom({}, "[WARNING] Using platform encoding (MS950 actually) to copy filtered resources, i.e. build is platform dependent!")?.name === "MS950",
  );
  check(
    "sourceEncodingFrom：pom 沒設 → 讀 compiler / resources 3.x 的警告",
    JSON.stringify(sourceEncodingFrom({}, "[WARNING] File encoding has not been set, using platform encoding Cp950, i.e. build is platform dependent!")) ===
      JSON.stringify({ name: "Cp950", source: "platform" }),
  );
  check(
    "sourceEncodingFrom：resources 3.x 的句點（「UTF-8. Build is platform dependent!」）不是編碼名稱的一部分",
    sourceEncodingFrom({}, "[WARNING] File encoding has not been set, using platform encoding UTF-8. Build is platform dependent!")?.name === "UTF-8",
  );
  const reactorLog = [
    "[INFO] --- resources:3.3.1:testResources (default-testResources) @ common ---",
    "[WARNING] File encoding has not been set, using platform encoding UTF-8. Build is platform dependent!",
    "[INFO] --- resources:3.3.1:testResources (default-testResources) @ web ---",
    "[WARNING] File encoding has not been set, using platform encoding MS950. Build is platform dependent!",
  ].join("\n");
  check("platformEncodingFromLog：reactor 裡歸屬到目標模組（不是上游模組的）", platformEncodingFromLog(reactorLog, "web") === "MS950" && platformEncodingFromLog(reactorLog) === "UTF-8");
  check("sourceEncodingFrom：解不開的 ${...} 不算設定，退回 log", sourceEncodingFrom({ sourceEncoding: "${enc}" }, "") === undefined);
  check("gradleEncoding：options.encoding（Groovy 與 Kotlin DSL）", gradleEncoding("compileJava.options.encoding = 'MS950'") === "MS950" && gradleEncoding('tasks.withType<JavaCompile> { options.encoding = "UTF-8" }') === "UTF-8" && gradleEncoding("// options.encoding = 'Big5'") === undefined);
  const encRepo = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-encpom-"));
  fs.writeFileSync(
    path.join(encRepo, "pom.xml"),
    "<project><artifactId>x</artifactId><properties><enc>MS950</enc><project.build.sourceEncoding>${enc}</project.build.sourceEncoding></properties></project>",
  );
  check(
    "measureSourceEncoding：project.build.sourceEncoding 透過另一個屬性（${enc}）設定 → 解開",
    measureSourceEncoding({ moduleRoot: encRepo, moduleRel: "", multiModule: false }, encRepo)?.name === "MS950",
  );
  fs.rmSync(encRepo, { recursive: true, force: true });
  // Configured where the loop cannot see: never the JDK's default charset — the sources decide.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-encpom-"));
  const outsideInfo = { moduleRoot: outside, moduleRel: "", multiModule: false };
  fs.writeFileSync(path.join(outside, "pom.xml"), "<project><parent><groupId>com.corp</groupId><artifactId>corp-parent</artifactId><version>9</version></parent><artifactId>x</artifactId></project>");
  fs.mkdirSync(path.join(outside, "src", "test", "java"), { recursive: true });
  fs.writeFileSync(path.join(outside, "src", "test", "java", "ZhTest.java"), "// 中文 in UTF-8\nclass ZhTest {}\n");
  check(
    "measureSourceEncoding：設定在 repo 外的 parent、原始碼是 UTF-8 → 當成 UTF-8（不拿 JDK 預設編碼猜）",
    measureSourceEncoding(outsideInfo, outside) === undefined,
    JSON.stringify(measureSourceEncoding(outsideInfo, outside)),
  );
  const outside2 = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-encpom-"));
  fs.cpSync(outside, outside2, { recursive: true });
  fs.writeFileSync(path.join(outside2, "src", "test", "java", "ZhTest.java"), Buffer.from([0x2f, 0x2f, 0x20, 0xa4, 0xa4, 0xa4, 0xe5, 0x0a]));
  const sniffedEnc = measureSourceEncoding({ moduleRoot: outside2, moduleRel: "", multiModule: false }, outside2);
  check(
    "measureSourceEncoding：設定在 repo 外、原始碼不是 UTF-8 → 標為「非 UTF-8、名稱不明」（只保護、不轉換）",
    sniffedEnc?.source === "sniffed",
    JSON.stringify(sniffedEnc),
  );
  fs.writeFileSync(path.join(outside, "pom.xml"), "<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version><relativePath/></parent><artifactId>x</artifactId></project>");
  check("measureSourceEncoding：Spring Boot parent → UTF-8（它設了 project.build.sourceEncoding）", measureSourceEncoding(outsideInfo, outside)?.name === "UTF-8");
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(outside2, { recursive: true, force: true });
  check(
    "gradleEncoding：只認 javac 的設定（compileJava / JavaCompile），javadoc 的 options.encoding 不算",
    gradleEncoding("compileJava.options.encoding = 'MS950'") === "MS950" &&
      gradleEncoding("tasks.withType(JavaCompile) {\n  options.encoding = 'Big5'\n}") === "Big5" &&
      gradleEncoding("javadoc {\n  options.encoding = 'UTF-8'\n}") === undefined,
  );
  check(
    "gradleDaemonEncoding：gradle.properties 的 org.gradle.jvmargs -Dfile.encoding",
    gradleDaemonEncoding("org.gradle.jvmargs=-Xmx2g -Dfile.encoding=MS950\n") === "MS950" && gradleDaemonEncoding("org.gradle.caching=true\n") === undefined,
  );
  check(
    "refineSourceEncoding：設定或建置說的優先於嗅探；建置什麼都沒說就維持之前的",
    refineSourceEncoding({ name: "x", source: "sniffed" }, { name: "MS950", source: "platform" })?.name === "MS950" &&
      refineSourceEncoding({ name: "MS950", source: "platform" }, { name: "x", source: "sniffed" })?.name === "MS950" &&
      refineSourceEncoding({ name: "MS950", source: "pom" }, undefined)?.name === "MS950",
  );
  check("isUtf8Name：UTF-8 / utf8 都算", isUtf8Name("UTF-8") && isUtf8Name("utf8") && !isUtf8Name("MS950"));

  check(
    "escapeNonAscii：中文 → \\uXXXX，ASCII 不變，emoji 成兩個 surrogate；BOM 只在檔案開頭、要求時才拿掉",
    escapeNonAscii("\uFEFF// 測試 ok 😀", undefined, { dropBom: true }) === "// \\u6e2c\\u8a66 ok \\ud83d\\ude00" &&
      escapeNonAscii("\uFEFFid") === "\\ufeffid",
    escapeNonAscii("\uFEFF// 測試 ok 😀", undefined, { dropBom: true }),
  );
  check(
    "escapeNonAscii：以字元（code point）為單位決定——BMP 以外的字不會只跳脫一半",
    escapeNonAscii("😀😁", (cp) => cp === 0x1f600) === "\\ud83d\\ude00😁",
    escapeNonAscii("😀😁", (cp) => cp === 0x1f600),
  );
  check(
    "escapeNonAscii：奇數個反斜線後面的字元 → 那個反斜線寫成 \\u005c（否則 \\u 不會被當成跳脫）；偶數個不動",
    escapeNonAscii("C:\\資") === "C:\\u005c\\u8cc7" && escapeNonAscii("\\\\資") === "\\\\\\u8cc7",
    `${escapeNonAscii("C:\\資")} ${escapeNonAscii("\\\\資")}`,
  );
  check(
    "unescapeNonAscii：非 ASCII 的跳脫寫回字元；\\u0022、\\u005c 這類 ASCII 跳脫不動；被跳脫的反斜線後面不是跳脫",
    unescapeNonAscii('"\\u542b\\u7a05" \\u0022 \\u005c \\\\u00e9 \\uuu00e9 \\ud83d\\ude00 \\ud83d') ===
      '"含稅" \\u0022 \\u005c \\\\u00e9 é 😀 \\ud83d',
    unescapeNonAscii('"\\u542b\\u7a05" \\u0022 \\u005c \\\\u00e9 \\uuu00e9 \\ud83d\\ude00 \\ud83d'),
  );
  const prose = "// 準備資料\nString s = \"含稅金額：%d 元\"; // ok\n";
  check("unescapeNonAscii(escapeNonAscii(x)) === x", unescapeNonAscii(escapeNonAscii(prose)) === prose);

  // "// 中文" in Big5/MS950: 中 = A4 A4, 文 = A4 E5 — not valid UTF-8.
  const zh = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]);
  const crlfOriginal = Buffer.concat([Buffer.from("// "), zh, Buffer.from("\r\nclass A {\r\n}\r\n")]);
  const crlfView = "// \\u4e2d\\u6587\r\nclass A {\r\n}\r\n";
  const merged = mergeEdited(crlfOriginal, crlfView, "// \\u4e2d\\u6587\nclass A {\n  int x; // 新增\n  // \\u4e2d\\u6587 ok\n}\n");
  // Two lines that read alike but differ in bytes (MS950's box-drawing characters have two codes):
  // each untouched one keeps its own; an inserted blank line in a CRLF file gets a CRLF.
  const twin = Buffer.concat([Buffer.from("// "), Buffer.from([0xa2, 0xa4]), Buffer.from("\r\nx\r\n// "), Buffer.from([0xf9, 0xf9]), Buffer.from("\r\n")]);
  const twinMerged = mergeEdited(twin, "// \\u2550\r\nx\r\n// \\u2550\r\n", "// \\u2550\nx\n\n// \\u2550\n");
  check(
    "mergeEdited：看起來一樣的兩行各自保留自己的 bytes；CRLF 檔裡新插入的空行也是 CRLF",
    (twinMerged[0] as Buffer).equals(Buffer.concat([Buffer.from("// "), Buffer.from([0xa2, 0xa4, 0x0d])])) &&
      twinMerged[2] === "\r" &&
      (twinMerged[3] as Buffer).equals(Buffer.concat([Buffer.from("// "), Buffer.from([0xf9, 0xf9, 0x0d])])),
    JSON.stringify(twinMerged.map((m) => (Buffer.isBuffer(m) ? m.toString("hex") : m))),
  );
  check(
    "mergeEdited：沒改的行用原檔的 bytes（連 CRLF），改過與新增的行寫回字元、補上原檔的 CRLF",
    merged.length === 6 &&
      Buffer.isBuffer(merged[0]) &&
      (merged[0] as Buffer).equals(Buffer.concat([Buffer.from("// "), zh, Buffer.from("\r")])) &&
      Buffer.isBuffer(merged[1]) &&
      merged[2] === "  int x; // 新增\r" &&
      merged[3] === "  // 中文 ok\r" &&
      Buffer.isBuffer(merged[4]) &&
      merged[5] === "",
    JSON.stringify(merged.map((m) => (Buffer.isBuffer(m) ? `<${m.toString("latin1")}>` : m))),
  );

  const jdk = findJdk();
  // A JDK that is there but a transcoder that is not — it does not compile, it does not answer —
  // is a failure, not a machine without a JDK.
  const home = process.env.JAVA_HOME;
  const jdkPresent = ["javac", "java"].every((t) => spawnSync(home ? path.join(home, "bin", t) : t, ["-version"], { stdio: "ignore" }).status === 0);
  check("有 JDK 就有能用的轉碼器", !jdkPresent || !!jdk);
  if (!jdk) {
    console.log("  [SKIP] 找不到 JDK——轉碼器的檢查需要一個 JDK");
  } else {
    const jt = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-jdk-"));
    const good = path.join(jt, "good.java");
    const bad = path.join(jt, "bad.java");
    fs.writeFileSync(good, Buffer.concat([Buffer.from("// "), zh, Buffer.from("\n")]));
    fs.writeFileSync(bad, Buffer.from([0x2f, 0x2f, 0xa4, 0x0a]));
    const dec = jdkDecode(jdk, "MS950", [good, bad]);
    check("jdkDecode：MS950 解得開；不是有效 MS950 的 bytes → 錯誤（不猜）", dec.get(good) === "// 中文\n" && dec.get(bad) instanceof Error, String(dec.get(good)));
    const [enc] = jdkEncode(jdk, "MS950", ["// 中文 😀"]);
    check(
      "jdkEncode：以 MS950 寫出；MS950 放不下的字（emoji）寫成 \\uXXXX",
      !!enc && enc.equals(Buffer.concat([Buffer.from("// "), zh, Buffer.from(" \\ud83d\\ude00")])),
      enc?.toString("latin1"),
    );
    fs.rmSync(jt, { recursive: true, force: true });

    // Around a session, on disk.
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-enc-"));
    const f = (rel: string) => path.join(tree, rel);
    fs.mkdirSync(f("com/x"), { recursive: true });
    const orig = Buffer.concat([Buffer.from("// "), zh, Buffer.from("\nclass T {\n}\n")]);
    for (const name of ["Untouched", "Edited", "Deleted"]) fs.writeFileSync(f(`com/x/${name}Test.java`), orig);
    const invalid = Buffer.from([0x2f, 0x2f, 0xa4, 0x0a]);
    fs.writeFileSync(f("com/x/InvalidTest.java"), invalid);
    fs.writeFileSync(f("com/x/AsciiTest.java"), "class AsciiTest {}\n");
    // All ASCII, with an escape its author wrote on purpose.
    fs.writeFileSync(f("com/x/PlainTest.java"), 'class PlainTest {\n  String e = "\\u4e2d";\n}\n');
    // A time a fraction of a millisecond past the half: put back through a Date, it rounds up, and the
    // file the writer never touched reads as changed to every snapshot after.
    const oldS = Math.floor(Date.now() / 1000) - 3600 + 0.5847;
    fs.utimesSync(f("com/x/UntouchedTest.java"), oldS, oldS);
    const oldMs = fs.statSync(f("com/x/UntouchedTest.java")).mtimeMs;
    const ms950 = { name: "MS950", source: "pom" as const };
    const view = openEncodingView(ms950, tree)!;
    const shown = fs.readFileSync(f("com/x/EditedTest.java"), "latin1");
    check(
      "openEncodingView：含中文的測試檔換成 ASCII 的 \\uXXXX 形式；不是有效 MS950 的檔不動、列為不能改",
      view.mode === "transcode" && shown === "// \\u4e2d\\u6587\nclass T {\n}\n" && [...view.protectedFiles.keys()].map((p) => path.basename(p)).join() === "InvalidTest.java",
      shown,
    );
    // What a writer does with it.
    fs.writeFileSync(f("com/x/EditedTest.java"), "// \\u4e2d\\u6587\nclass T {\n  // 補一個測試\n}\n");
    fs.rmSync(f("com/x/DeletedTest.java"));
    fs.writeFileSync(f("com/x/NewTest.java"), "class NewTest { String s = \"含稅\"; }\n");
    fs.writeFileSync(f("com/x/InvalidTest.java"), "// edited\n");
    fs.writeFileSync(f("com/x/LostTest.java"), "class LostTest { String s = \"\uFFFD\uFFFD\"; }\n");
    fs.writeFileSync(f("com/x/PlainTest.java"), 'class PlainTest {\n  String e = "\\u4e2d";\n  // 新增\n}\n');
    fs.writeFileSync(f("com/x/CopiedTest.java"), 'class CopiedTest { String s = "\\u542b\\u7a05"; }\n');
    const r = closeEncodingView(view);
    const base = (l: string[]) => l.map((p) => path.basename(p)).join();
    const big5 = new TextDecoder("big5");
    check(
      "closeEncodingView：沒改的檔拿回原本的 bytes 與修改時間（建置看不到變化）",
      fs.readFileSync(f("com/x/UntouchedTest.java")).equals(orig) && Math.floor(fs.statSync(f("com/x/UntouchedTest.java")).mtimeMs) === Math.floor(oldMs),
      `${oldMs} → ${fs.statSync(f("com/x/UntouchedTest.java")).mtimeMs}`,
    );
    const edited = fs.readFileSync(f("com/x/EditedTest.java"));
    check(
      "closeEncodingView：改過的檔——沒改的行維持原本的 bytes，新寫的中文以 MS950 存",
      edited.subarray(0, 7).equals(Buffer.concat([Buffer.from("// "), zh])) && big5.decode(edited) === "// 中文\nclass T {\n  // 補一個測試\n}\n" && !edited.includes(Buffer.from("\\u")),
      edited.toString("latin1"),
    );
    check(
      "closeEncodingView：新檔的中文以 MS950 存；刪掉的檔維持刪除（由防掏空 guard 判斷）",
      big5.decode(fs.readFileSync(f("com/x/NewTest.java"))) === 'class NewTest { String s = "含稅"; }\n' && !fs.existsSync(f("com/x/DeletedTest.java")),
    );
    check("closeEncodingView：不能改的檔被改了 → 照原 bytes 放回", base(r.restored) === "InvalidTest.java" && fs.readFileSync(f("com/x/InvalidTest.java")).equals(invalid), JSON.stringify(r));
    check(
      "closeEncodingView：writer 寫進 U+FFFD → 列出來（該輪失敗），字元以 \\ufffd 存、不假裝是別的字",
      base(r.replacement) === "LostTest.java" && fs.readFileSync(f("com/x/LostTest.java"), "latin1").includes("\\ufffd\\ufffd"),
      JSON.stringify(r),
    );
    check("closeEncodingView：純 ASCII 的檔不動", fs.readFileSync(f("com/x/AsciiTest.java"), "utf8") === "class AsciiTest {}\n");
    const plain = fs.readFileSync(f("com/x/PlainTest.java"));
    check(
      "closeEncodingView：純 ASCII 的檔被寫進中文——作者刻意寫的 \\u4e2d 那行維持原樣，新寫的行以 MS950 存",
      plain.includes(Buffer.from('String e = "\\u4e2d";')) && big5.decode(plain).includes("// 新增"),
      plain.toString("latin1"),
    );
    check(
      "closeEncodingView：writer 從視圖抄來的 \\uXXXX 寫進新檔 → 一樣寫回字元、以 MS950 存",
      big5.decode(fs.readFileSync(f("com/x/CopiedTest.java"))) === 'class CopiedTest { String s = "含稅"; }\n',
      fs.readFileSync(f("com/x/CopiedTest.java"), "latin1"),
    );
    // Interrupted with the view open: the originals go back.
    const v2 = openEncodingView(ms950, tree)!;
    check("restoreOpenViews 之前檔案是 ASCII 形式", !fs.readFileSync(f("com/x/UntouchedTest.java")).equals(orig) && v2.viewed.size > 0);
    restoreOpenViews();
    check("restoreOpenViews：中斷時把開著的 view 放回原本的 bytes", fs.readFileSync(f("com/x/UntouchedTest.java")).equals(orig));

    // Only the line endings changed: every line is the original's, nothing to encode (no final
    // line feed either, so not even an empty last line is the agent's).
    const crlf = Buffer.concat([Buffer.from("// "), zh, Buffer.from("\r\nclass Crlf {\r\n}")]);
    fs.writeFileSync(f("com/x/CrlfTest.java"), crlf);
    const cv = openEncodingView(ms950, tree)!;
    fs.writeFileSync(f("com/x/CrlfTest.java"), "// \\u4e2d\\u6587\nclass Crlf {\n}");
    const cr = closeEncodingView(cv);
    check(
      "closeEncodingView：writer 只把 CRLF 改成 LF（每一行都是原檔的）→ 原樣放回，不當成轉換失敗",
      cr.failed.length === 0 && fs.readFileSync(f("com/x/CrlfTest.java")).equals(crlf),
      JSON.stringify(cr),
    );
    check(
      "jdkCheckCharset：MS950 可用；UTF-16 與 ASCII 不相容；不存在的編碼名稱 → unknown",
      jdkCheckCharset(jdk, "MS950") === "ok" && jdkCheckCharset(jdk, "UTF-16") === "notascii" && jdkCheckCharset(jdk, "No-Such-Charset") === "unknown",
    );
    check("openEncodingView：與 ASCII 不相容的編碼（UTF-16）→ 不轉換、不動任何檔", openEncodingView({ name: "UTF-16", source: "pom" }, tree) === undefined);
    // Whatever else the JVM prints on stdout (-Xlog, an agent) is not read as an answer.
    const savedOpts = process.env.JAVA_TOOL_OPTIONS;
    process.env.JAVA_TOOL_OPTIONS = `${savedOpts ?? ""} -Xlog:gc`;
    const noisy = jdkCheckCharset(jdk, "GBK");
    process.env.JAVA_TOOL_OPTIONS = savedOpts;
    if (savedOpts === undefined) delete process.env.JAVA_TOOL_OPTIONS;
    check("轉碼器的回應有標記：JVM 在 stdout 印的其他東西（-Xlog:gc）不會被當成回應", noisy === "ok", noisy);
    const [yen] = jdkEncode(jdk, "Shift_JIS", ['String p = "¥1,000";']);
    check(
      "jdkEncode：Shift_JIS 把 ¥ 存成 0x5C（javac 讀回來是反斜線）→ 來回轉換不一樣的字一律寫成 \\uXXXX",
      !!yen && yen.toString("latin1") === 'String p = "\\u00a51,000";',
      yen?.toString("latin1"),
    );
    // GB18030 can hold U+FFFD as a character; it is still written as the escape.
    const [lostChar] = jdkEncode(jdk, "GB18030", ["s = \"\uFFFD\";"]);
    check("jdkEncode：U+FFFD 永遠以 \\ufffd 存（連裝得下它的 GB18030 也是），不當成一個真的字", !!lostChar && lostChar.toString("latin1") === 's = "\\ufffd";', lostChar?.toString("latin1"));

    // The writer's own UTF-8 from earlier in the run (before the encoding was known): converted,
    // never locked away from it; deletable; a lost character in it reported every round.
    const agentFile = f("com/x/AgentTest.java");
    fs.writeFileSync(agentFile, "class AgentTest { String s = \"含稅\"; }\n");
    const lostFile = f("com/x/AgentLostTest.java");
    fs.writeFileSync(lostFile, 'class AgentLostTest { String s = "\\ufffd"; }\n');
    const goneFile = f("com/x/AgentGoneTest.java");
    fs.writeFileSync(goneFile, "class AgentGoneTest { String s = \"含稅\"; }\n");
    const av = openEncodingView(ms950, tree, { agentFiles: [agentFile, lostFile, goneFile] })!;
    check("openEncodingView：writer 自己先前寫的 UTF-8 檔不列為不能改", !av.protectedFiles.has(agentFile) && !av.protectedFiles.has(goneFile));
    fs.rmSync(goneFile);
    const ar = closeEncodingView(av);
    check(
      "closeEncodingView：writer 先前寫的 UTF-8 檔就算這輪沒碰也轉成 MS950；它刪掉的不會被放回",
      big5.decode(fs.readFileSync(agentFile)) === 'class AgentTest { String s = "含稅"; }\n' && !fs.existsSync(goneFile),
      JSON.stringify(ar),
    );
    check("closeEncodingView：writer 先前寫進的 \\ufffd 還在 → 每一輪都點名", base(ar.replacement) === "AgentLostTest.java", JSON.stringify(ar));
    fs.rmSync(lostFile);

    // A run killed with the view open: the next run puts the originals back from the journal.
    fs.utimesSync(f("com/x/UntouchedTest.java"), oldS, oldS);
    const kv = openEncodingView(ms950, tree)!;
    check("被砍掉之前：檔案是 ASCII 形式", !fs.readFileSync(f("com/x/UntouchedTest.java")).equals(orig) && kv.viewed.size > 0);
    const recoveredFiles = recoverEncodingViews(tree);
    check(
      "recoverEncodingViews：下一次執行從復原日誌把原本的 bytes 放回",
      fs.readFileSync(f("com/x/UntouchedTest.java")).equals(orig) && recoveredFiles.map((p) => path.basename(p)).includes("UntouchedTest.java"),
      JSON.stringify(recoveredFiles.map((p) => path.basename(p))),
    );
    // And its time: put back with the time of the recovery, it read as changed after the killed run died
    // — someone else's — and that run's batch was left in place (libs/batch.ts killedWriterChanges).
    check(
      "recoverEncodingViews：修改時間也放回原本的（到毫秒以下）",
      Math.floor(fs.statSync(f("com/x/UntouchedTest.java")).mtimeMs) === Math.floor(oldMs),
      `${oldMs} → ${fs.statSync(f("com/x/UntouchedTest.java")).mtimeMs}`,
    );
    check("recoverEncodingViews：日誌用過就刪（再跑一次什麼都不做）", recoverEncodingViews(tree).length === 0);
    restoreOpenViews();
    // Every run looks for a journal; looking must not leave one directory per repo behind.
    const savedLocal = process.env.LOCALAPPDATA;
    const lookCache = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cache-"));
    process.env.LOCALAPPDATA = lookCache;
    const nothing = recoverEncodingViews(fs.mkdtempSync(path.join(os.tmpdir(), "tg-never-viewed-")));
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocal;
    check(
      "recoverEncodingViews：沒有日誌的 repo 只是查一下，不在快取裡留下空目錄",
      nothing.length === 0 && !fs.existsSync(path.join(lookCache, "testgen", "views")),
      JSON.stringify(fs.existsSync(lookCache) ? fs.readdirSync(lookCache, { recursive: true }) : []),
    );
    fs.rmSync(lookCache, { recursive: true, force: true });

    // A write that fails on one file (another user's file: its time cannot be set) does not leave
    // the rest in their view.
    // The ESM namespace is read-only; the builtin's CommonJS object is not, and syncing carries the
    // patch to every importer.
    const cjsFs = createRequire(import.meta.url)("node:fs") as { utimesSync: unknown };
    const realUtimes = cjsFs.utimesSync;
    const ev = openEncodingView(ms950, tree)!;
    cjsFs.utimesSync = () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    syncBuiltinESMExports();
    let threw = false;
    let er: ReturnType<typeof closeEncodingView> | undefined;
    try {
      er = closeEncodingView(ev);
    } catch {
      threw = true;
    }
    cjsFs.utimesSync = realUtimes;
    syncBuiltinESMExports();
    check(
      "closeEncodingView：設不了修改時間（別人的檔）不丟例外、不算失敗，每個檔照樣放回原本的內容",
      !threw &&
        er?.failed.length === 0 &&
        fs.readFileSync(f("com/x/UntouchedTest.java")).equals(orig) &&
        big5.decode(fs.readFileSync(f("com/x/EditedTest.java"))).includes("補一個測試"),
      JSON.stringify(er),
    );

    // A journal that cannot be removed (an antivirus holding it) does not throw out of the close —
    // on a crash's way out that ended the process before its summary was written.
    const cjsRm = createRequire(import.meta.url)("node:fs") as { rmSync: (p: string, o?: object) => void };
    const realRm = cjsRm.rmSync;
    const jv = openEncodingView(ms950, tree)!;
    cjsRm.rmSync = (p: string, o?: object) => {
      if (jv.journal && p === jv.journal) throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
      realRm(p, o);
    };
    syncBuiltinESMExports();
    let journalThrew = false;
    try {
      closeEncodingView(jv);
    } catch {
      journalThrew = true;
    }
    cjsRm.rmSync = realRm;
    syncBuiltinESMExports();
    check(
      "closeEncodingView：復原日誌刪不掉（被鎖住）→ 不丟例外，檔案照樣放回；下一次執行的 recover 會清掉它",
      !journalThrew && fs.readFileSync(f("com/x/UntouchedTest.java")).equals(orig) && recoverEncodingViews(tree).length === 0,
    );

    const prodFile = f("com/x/Fee.java");
    fs.writeFileSync(prodFile, Buffer.concat([Buffer.from('class Fee { String m = "'), zh, Buffer.from('"; }\n')]));
    const views = sourceViews(ms950, [prodFile, f("com/x/AsciiTest.java")]);
    check(
      "sourceViews：production 的中文以 MS950 解碼、寫成 \\uXXXX 給 prompt；純 ASCII 的檔不附",
      views.length === 1 && views[0].view === 'class Fee { String m = "\\u4e2d\\u6587"; }\n',
      JSON.stringify(views),
    );
    fs.rmSync(prodFile);
    const sv = openEncodingView({ name: "非 UTF-8", source: "sniffed" }, tree)!;
    check("openEncodingView：只嗅得出「不是 UTF-8」→ 不轉換，只保護", sv.mode === "protect" && sv.viewed.size === 0 && sv.protectedFiles.size > 0);
    closeEncodingView(sv);

    // No JDK: what cannot be written back faithfully is protected, and the writer's text escaped.
    const savedHome = process.env.JAVA_HOME;
    const savedPath = process.env.PATH;
    process.env.JAVA_HOME = "";
    process.env.PATH = "";
    resetJdkForTests();
    const pv = openEncodingView(ms950, tree)!;
    fs.writeFileSync(f("com/x/UntouchedTest.java"), "// broken by a UTF-8 tool\n");
    fs.writeFileSync(f("com/x/Plain2Test.java"), "class Plain2Test { String s = \"含稅\"; }\n");
    const pr = closeEncodingView(pv);
    process.env.JAVA_HOME = savedHome;
    process.env.PATH = savedPath;
    resetJdkForTests();
    check(
      "沒有 JDK：含非 ASCII 的既有檔一律不能改（被改了放回），writer 自己寫的中文轉成 \\uXXXX",
      pv.mode === "protect" &&
        base(pr.restored).includes("UntouchedTest.java") &&
        fs.readFileSync(f("com/x/UntouchedTest.java")).equals(orig) &&
        fs.readFileSync(f("com/x/Plain2Test.java"), "utf8") === 'class Plain2Test { String s = "\\u542b\\u7a05"; }\n',
      JSON.stringify(pr),
    );
    fs.rmSync(tree, { recursive: true, force: true });
  }

  const ms950 = { name: "MS950", source: "platform" as const };
  const transcoded = renderSourceEncoding(ms950, [], "transcode");
  check(
    "prompt（有 JDK）：說明 \\uXXXX 是同一個字、不是亂碼，中文可以直接寫",
    transcoded.includes("MS950") && transcoded.includes("\\uXXXX") && transcoded.includes("不是亂碼") && transcoded.includes("可以直接寫") && !transcoded.includes("只用 ASCII"),
    transcoded,
  );
  const protectedPrompt = renderSourceEncoding(ms950, ["src/test/java/com/x/FeeTest.java"], "protect");
  check(
    "prompt（沒有 JDK）：只用 ASCII、點名不能改的檔與替代做法",
    protectedPrompt.includes("MS950") && protectedPrompt.includes("只用 ASCII") && protectedPrompt.includes("FeeTest.java") && protectedPrompt.includes("AdditionalTest"),
    protectedPrompt,
  );
  check("prompt：UTF-8 或量不到 → 什麼都不加", renderSourceEncoding({ name: "UTF-8", source: "pom" }) === "" && renderSourceEncoding(undefined) === "");
  check(
    "review prompt：告訴 reviewer \\uXXXX 是 pipeline 的跳脫，不要因此扣分",
    renderReviewEncoding(ms950, "transcode").includes("不要因此扣") && renderReviewEncoding(ms950, undefined) === "" && renderReviewEncoding({ name: "UTF-8", source: "pom" }, "transcode") === "",
  );
  const existingLocked = renderExistingTests(
    [{ cls: "src/main/java/com/x/Fee.java", tests: ["src/test/java/com/x/FeeTest.java"] }],
    ["src/test/java/com/x/FeeTest.java"],
    "MS950",
  );
  check(
    "prompt：既有測試檔被鎖住時，不再同時要求「必須修改它、嚴禁另建新檔」",
    existingLocked.includes("不能修改") && existingLocked.includes("FeeAdditionalTest.java") && existingLocked.includes("除外"),
    existingLocked,
  );
}

// ---------------------------------------------------------------------------
// 27. Were the writer's tests run? (gates/build.ts checkTestsRan) — and the Java lexer under it
// ---------------------------------------------------------------------------
console.log("\n[27] writer 的測試有沒有真的被執行（checkTestsRan）與 codeOnly");
{
  const lexed = codeOnly('String u = "http://x/*y"; // @Test\n/* @Test */ char q = \'"\'; String t = """\n  @Test "\n  """; @Test void a() {}\n');
  check(
    "codeOnly：註解、字串、字元、text block 的內容都清成空白，長度與換行不變",
    lexed.length === 'String u = "http://x/*y"; // @Test\n/* @Test */ char q = \'"\'; String t = """\n  @Test "\n  """; @Test void a() {}\n'.length &&
      (lexed.match(/@Test/g) ?? []).length === 1 && lexed.includes("void a()") && lexed.split("\n").length === 5,
    JSON.stringify(lexed),
  );
  check("codeOnly：字串裡的 \\\" 不結束字串", codeOnly('s = "a\\"b // c"; d();').endsWith("d();"));
  check(
    "codeOnly：沒結束的區塊註解只清掉開頭的 /*，後面照樣當程式碼讀（編不過的檔交給建置報錯，不是讓後面的測試全部「消失」）",
    codeOnly("a(); /* x").length === 9 && codeOnly("a(); /* x").endsWith(" x"),
  );

  check(
    "testFrameworkOf：看 @Test 從哪裡 import——JUnit 4 的 @Test 配 JUnit 5 的 Assertions 仍是 JUnit 4",
    testFrameworkOf("import org.junit.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;") === "JUnit 4" &&
      testFrameworkOf("import org.junit.jupiter.api.*;") === "JUnit 5" &&
      testFrameworkOf("import org.testng.annotations.Test;") === "TestNG" &&
      testFrameworkOf("import org.junit.jupiter.params.ParameterizedTest;") === "JUnit 5" &&
      testFrameworkOf("import java.util.List;") === undefined,
  );
  const f = (name: string) => `/r/src/test/java/com/x/${name}.java`;
  const et = (src: string, name = "FooTest") => expectedTestOf(src, f(name), "created");
  check(
    "expectedTestOf：套件＋類名；沒有 @Test 的 helper、abstract 基底、interface 不算",
    et("package com.x;\nimport org.junit.jupiter.api.Test;\nclass FooTest { @Test void a() {} }")?.fqcn === "com.x.FooTest" &&
      et("package com.x;\nclass FooTest { void helper() {} }") === undefined &&
      et("package com.x;\nimport org.junit.Test;\npublic abstract class FooTest { @Test public void a() {} }") === undefined &&
      et("package com.x;\ninterface FooTest { @org.junit.jupiter.api.Test default void a() {} }") === undefined,
  );
  check("expectedTestOf：@Test 只出現在註解裡 → 不是測試類別", et("package com.x;\n// @Test\nclass FooTest {}") === undefined);
  check(
    "expectedTestOf：類別層級的 @Disabled（說明字串裡有分號也一樣）→ disabled；方法層級的不算",
    et('package com.x;\nimport org.junit.jupiter.api.*;\n@Disabled("later; maybe")\nclass FooTest { @Test void a() {} }')?.disabled === true &&
      et("package com.x;\nimport org.junit.jupiter.api.*;\nclass FooTest { @Disabled @Test void a() {} @Test void b() {} }")?.disabled === false &&
      et("package com.x;\nimport org.testng.annotations.Test;\n@Test(enabled = false)\npublic class FooTest { @Test public void a() {} }")?.disabled === true,
  );
  check(
    "includedByDefault：surefire 預設的 includes（Test*、*Test、*TestCase；*Tests 要 2.20 以後——2.12.4 不跑 CalcTests）",
    ["a.FooTest", "a.TestFoo", "a.FooTests", "a.FooTestCase"].every((n) => includedByDefault(n)) &&
      !["a.FooSpec", "a.FooIT", "a.FooTestHelper"].some((n) => includedByDefault(n)) &&
      !includedByDefault("a.FooTests", "2.12.4") && includedByDefault("a.FooTests", "2.22.2") && includedByDefault("a.FooTest", "2.12.4"),
  );
  check(
    "classesRunInLog：surefire 的「Running」與「- in / -- in」行",
    JSON.stringify(
      classesRunInLog(
        "[INFO] Running com.x.FooTest\n[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s - in com.x.BarTest\r\n" +
          "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in com.x.Baz$Inner\n[INFO] Running npm install\n",
      ).sort(),
    ) === JSON.stringify(["com.x.BarTest", "com.x.Baz$Inner", "com.x.FooTest"]),
  );

  // On disk: a module whose build ran its JUnit 4 test and not the writer's JUnit 5 one.
  const m = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-ran-"));
  const mi = { moduleRoot: m, moduleRel: "", multiModule: false };
  const src = (name: string, body: string) => {
    const p = path.join(m, "src", "test", "java", "com", "x", `${name}.java`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  const reports = path.join(m, "target", "surefire-reports");
  fs.mkdirSync(reports, { recursive: true });
  const report = (name: string, body = '<testsuite name="x" tests="2" skipped="0"></testsuite>', ageMs = 0) => {
    const p = path.join(reports, name);
    fs.writeFileSync(p, body);
    if (ageMs) fs.utimesSync(p, (Date.now() - ageMs) / 1000, (Date.now() - ageMs) / 1000);
  };
  src("OldTest", "package com.x;\nimport org.junit.Test;\npublic class OldTest { @Test public void a() {} }\n");
  const newFile = src("NewTest", "package com.x;\nimport org.junit.jupiter.api.Test;\nclass NewTest { @Test void a() {} }\n");
  const newTest = expectedTestOf(fs.readFileSync(newFile, "utf8"), newFile, "created")!;
  const since = Date.now() - 10_000;
  report("TEST-com.x.OldTest.xml");
  report("TEST-com.x.NewTest.xml", undefined, 60_000); // an earlier build's
  const r1 = checkTestsRan("maven", mi, since, "[INFO] Tests run: 1", [newTest])!;
  const r1Report = renderRanCheck(r1, "maven") ?? "";
  check(
    "checkTestsRan：writer 的 JUnit 5 類別沒有這次建置的報告（舊的不算）→ 沒被執行；報告說出本模組執行的是 JUnit 4、要改寫",
    r1.notRun.map((t) => t.fqcn).join() === "com.x.NewTest" && r1.ran.map((r) => `${r.fqcn}:${r.framework}`).join() === "com.x.OldTest:JUnit 4" &&
      r1Report.includes("JUnit 5 寫法") && r1Report.includes("都是 JUnit 4 寫法") && r1Report.includes("org.junit.Test"),
    r1Report,
  );
  report("TEST-com.x.NewTest$Inner.xml");
  check("checkTestsRan：@Nested 類別的報告（TEST-<類別>$<內部類別>.xml）也算有執行", checkTestsRan("maven", mi, since, "", [newTest])?.notRun.length === 0);
  fs.rmSync(path.join(reports, "TEST-com.x.NewTest$Inner.xml"));
  report("TEST-TestSuite.xml", '<testsuite name="TestSuite" tests="3"><testcase name="a" classname="com.x.NewTest" time="0"/></testsuite>');
  check("checkTestsRan：TestNG 的單一 TEST-TestSuite.xml——看裡面每個 testcase 的 classname", checkTestsRan("maven", mi, since, "", [newTest])?.notRun.length === 0);
  fs.rmSync(path.join(reports, "TEST-TestSuite.xml"));
  check(
    "checkTestsRan：報告不在，但 surefire 的 log 說「Running <類別>」→ 算有執行",
    checkTestsRan("maven", mi, since, "[INFO] Running com.x.NewTest\n", [newTest])?.notRun.length === 0,
  );
  report("TEST-com.x.NewTest.xml", '<testsuite name="com.x.NewTest" tests="3" skipped="3"></testsuite>');
  const skipped = checkTestsRan("maven", mi, since, "", [newTest])!;
  check(
    "checkTestsRan：writer 新寫的類別測試全部被略過 → 不算執行",
    skipped.notRun.length === 0 && skipped.allSkipped.length === 1 && skipped.allSkipped[0].tests === 3 && (renderRanCheck(skipped, "maven") ?? "").includes("全部被略過"),
  );
  check(
    "checkTestsRan：改過的既有類別全部略過 → 不是 writer 能決定的，不判",
    checkTestsRan("maven", mi, since, "", [{ ...newTest, origin: "changed" }])?.allSkipped.length === 0,
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  report("TEST-Adding numbers.xml", '<testsuite name="Adding numbers" tests="2"><testcase name="a" classname="Adding numbers"/></testsuite>');
  check(
    "checkTestsRan：報告以 @DisplayName 命名（usePhrasedFileName）、對不到任何測試類別 → 看不到，不判",
    checkTestsRan("maven", mi, since, "[INFO] Tests run: 2", [newTest]) === undefined,
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  check(
    "checkTestsRan：模組沒有這次的報告、log 也沒列類別，但說有跑測試 → 看不到，不判（報告可能關了或寫到別處）",
    checkTestsRan("maven", mi, since, "[INFO] Tests run: 5, Failures: 0", [newTest]) === undefined,
  );
  const none = checkTestsRan("maven", mi, since, "[INFO] Tests run: 0, Failures: 0", [newTest]);
  check("checkTestsRan：surefire 說一個測試都沒跑 → 全部沒執行", none?.notRun.length === 1);
  const upstream = checkTestsRan("maven", mi, since, "[INFO] Running com.up.CommonTest\n[INFO] Tests run: 3, Failures: 0\n[INFO] No tests to run.", [newTest]);
  check(
    "checkTestsRan：reactor 裡上游模組的「Running」不算本模組跑過什麼；本模組說 No tests to run → 全部沒執行",
    upstream?.notRun.length === 1 && !upstream.reported.includes("com.up.CommonTest"),
    JSON.stringify(upstream?.reported),
  );
  const withBefore = checkTestsRan("maven", mi, since, "[INFO] No tests to run.", [newTest], ["com.x.OldTest"])!;
  const withBeforeReport = renderRanCheck(withBefore, "maven") ?? "";
  check(
    "checkTestsRan：限縮執行時這次沒有別的類別可比 → 用 writer 介入前跑過的類別說明本模組執行的是哪個框架",
    withBefore.ran.length === 0 && withBeforeReport.includes("writer 介入前的建置執行的是：JUnit 4 寫法 1 個") && withBeforeReport.includes("都是 JUnit 4 寫法"),
    withBeforeReport,
  );
  // A class that ran before the writer and not now is no evidence of what runs: its source may
  // have been rewritten into the very framework that does not.
  const switched = { file: newFile, fqcn: "com.x.NewTest", disabled: false, origin: "changed" as const, framework: "JUnit 5" as const };
  const switchedReport = renderRanCheck(checkTestsRan("maven", mi, since, "[INFO] No tests to run.", [switched], ["com.x.OldTest", "com.x.NewTest"])!, "maven") ?? "";
  check(
    "checkTestsRan：沒被執行的類別不當成「介入前跑的是什麼」的證據（它的原始碼可能剛被改成不會跑的框架）",
    switchedReport.includes("writer 介入前的建置執行的是：JUnit 4 寫法 1 個。") && switchedReport.includes("都是 JUnit 4 寫法"),
    switchedReport,
  );
  const spec = expectedTestOf("package com.x;\nimport org.junit.Test;\npublic class FooSpec { @Test public void a() {} }", f("FooSpec"), "created")!;
  const specReport = renderRanCheck({ reported: [], notRun: [spec], allSkipped: [], ran: [], ranBefore: [] }, "maven") ?? "";
  check("renderRanCheck：類名不符 surefire 預設的 includes → 點名", specReport.includes("類名不符 surefire 預設的 includes"), specReport);
  const untouched = renderRanCheck(
    { reported: [], notRun: [{ file: f("OldTest"), fqcn: "com.x.OldTest", disabled: false, origin: "untouched", framework: "JUnit 4" }], allSkipped: [], ran: [{ fqcn: "com.x.AnyTest", framework: "JUnit 4" }], ranBefore: [] },
    "maven",
  ) ?? "";
  check(
    "renderRanCheck：writer 沒碰的既有類別不再被執行 → 說是這輪的變更造成的，指向共用的資源與基底類別",
    untouched.includes("writer 介入前有被執行") && untouched.includes("junit-platform.properties"),
    untouched,
  );
  const reactor = (web: string) =>
    ["[INFO] Reactor Summary for parent 1.0:", "[INFO] ", "[INFO] parent ............................................. SUCCESS [  0.1 s]",
      "[INFO] core ............................................... FAILURE [  2.1 s]", `[INFO] web ................................................ ${web}`,
      "[INFO] ------------------------------------------------------------------------", "[INFO] BUILD FAILURE"].join("\n");
  check(
    "targetModuleSkipped：reactor 最後一個模組（-pl <模組> -am 的目標模組）是 SKIPPED → 目標模組沒有被建置",
    targetModuleSkipped(reactor("SKIPPED")) && !targetModuleSkipped(reactor("FAILURE [  3.0 s]")) && !targetModuleSkipped("[INFO] BUILD SUCCESS") &&
      // no separator line before BUILD FAILURE: that line is not a module's
      targetModuleSkipped("[INFO] Reactor Summary:\n[INFO] common ...... FAILURE\n[INFO] web ....... SKIPPED\n[INFO] BUILD FAILURE"),
  );
  // Maven's exit code is whether it chose to stop. Shapes taken from real surefire 2.22.2 / 3.2.5
  // runs under testFailureIgnore, and Maven 3.9 under -fn.
  const SF = "[INFO] --- surefire:3.2.5:test (default-test) @ tfi ---";
  const ignoredLog = [
    SF,
    "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.004 s <<< FAILURE! -- in com.x.OtherTest",
    "[INFO] Results:",
    "[ERROR] Tests run: 4, Failures: 2, Errors: 0, Skipped: 0",
    "[ERROR] There are test failures.",
    "",
    "Please refer to /w/tfi/target/surefire-reports for the individual test results.",
    "[INFO] BUILD SUCCESS",
  ].join("\n");
  // surefire 3.x, a test that threw (an error, not a failure): no headline, only the total at ERROR.
  const errorsOnlyLog = [
    SF,
    "[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 0.056 s <<< FAILURE! -- in com.x.NpeTest",
    "[INFO] Results:",
    "[ERROR] Errors: ",
    '[ERROR]   NpeTest.add_works:6 NullPointer Cannot invoke "com.x.Calc.add(int, int)" because "this.calc" is null',
    "[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0",
    "[ERROR] ",
    "Please refer to /tmp/p5v/target/surefire-reports for the individual test results.",
    "[INFO] BUILD SUCCESS",
  ].join("\n");
  const greenLog = `${SF}\n[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS`;
  check(
    "mavenRedDespiteExit0：testFailureIgnore 下 surefire 記下的「There are test failures.」、只有 error 時的 Results 總計、fork 逾時（2.x 與 3.x 的措辭）→ 紅，說明是 testFailureIgnore",
    (mavenRedDespiteExit0(ignoredLog, false) ?? "").includes("testFailureIgnore") &&
      !!mavenRedDespiteExit0(errorsOnlyLog, false) &&
      !!mavenRedDespiteExit0(`${SF}\n[ERROR] There was a timeout or other error in the fork\n[INFO] BUILD SUCCESS`, false) &&
      !!mavenRedDespiteExit0(`${SF}\n[ERROR] There was a timeout in the fork\n[INFO] BUILD SUCCESS`, false),
  );
  check(
    "mavenRedDespiteExit0：surefire 2.12.4 的 Results 總計沒有層級前綴，只有「There are test failures.」那行說了 → 紅",
    !!mavenRedDespiteExit0(
      ["[INFO] --- maven-surefire-plugin:2.12.4:test (default-test) @ legacy ---", "Running com.x.OtherTest",
        "Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.05 sec <<< FAILURE!", "Results :",
        "Failed tests:   add_broken(com.x.OtherTest): expected:<3> but was:<2>", "Tests run: 1, Failures: 1, Errors: 0, Skipped: 0",
        "[ERROR] There are test failures.", "[INFO] BUILD SUCCESS"].join("\n"),
      false,
    ),
  );
  check(
    "mavenRedDespiteExit0：綠的建置、只有重跑通過的 flaky（總計在 WARNING）→ undefined；log 沒說、但這次建置的報告記著失敗 → 紅",
    mavenRedDespiteExit0(greenLog, false) === undefined &&
      mavenRedDespiteExit0(`${SF}\n[WARNING] Flakes: \n[WARNING] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Flakes: 1\n[INFO] BUILD SUCCESS`, false) === undefined &&
      (mavenRedDespiteExit0(greenLog, true) ?? "").includes("testFailureIgnore"),
  );
  check(
    "mavenRedDespiteExit0：測試自己印的「There are test failures.」（在它的類別結果那行之前）與別的 plugin（karma）說的 → 不算",
    mavenRedDespiteExit0(
      [SF, "[INFO] Running com.x.PrintsTest", "[ERROR] There are test failures.", "[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0",
        "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s -- in com.x.PrintsTest", "[INFO] Results:",
        "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0", "[INFO] BUILD SUCCESS"].join("\n"),
      false,
    ) === undefined &&
      mavenRedDespiteExit0(["[INFO] --- frontend:1.12.1:karma (javascript tests) @ web ---", "[ERROR] There are test failures.", greenLog].join("\n"), false) === undefined,
  );
  check(
    "mavenRedDespiteExit0：安靜模式（-q，沒有 plugin 標頭）的真失敗 → 紅",
    !!mavenRedDespiteExit0(
      ["[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: 0.040 s <<< FAILURE! -- in com.x.NpeTest", "[ERROR] Errors: ",
        "[ERROR] Tests run: 1, Failures: 0, Errors: 1, Skipped: 0", "[ERROR] "].join("\n"),
      false,
    ),
  );
  const fnCompile = "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:testCompile (default-testCompile) on project tfi: Compilation failure";
  check(
    "mavenRedDespiteExit0：--fail-never 吞掉的編譯或測試失敗（有沒有 BUILD FAILURE 那行都一樣，-q 不印它）→ 紅；吞掉的是別的 plugin（copy-resources）→ 不算",
    (mavenRedDespiteExit0(`[ERROR] /w/CalcTest.java:[9,9] cannot find symbol\n[INFO] BUILD FAILURE\n${fnCompile}\n[INFO] Build failures were ignored.`, false) ?? "").includes("--fail-never") &&
      (mavenRedDespiteExit0(`[ERROR] /w/CalcTest.java:[9,9] cannot find symbol\n${fnCompile}`, false) ?? "").includes("--fail-never") &&
      !!mavenRedDespiteExit0("[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:2.22.2:test (default-test) on project web: There are test failures.", false) &&
      mavenRedDespiteExit0(
        `${greenLog.replace("[INFO] BUILD SUCCESS", "[INFO] BUILD FAILURE")}\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-resources-plugin:3.3.1:copy-resources (always-broken) on project pfn: The parameters 'resources' are missing -> [Help 1]\n[INFO] Build failures were ignored.`,
        false,
      ) === undefined,
  );
  check(
    "gradleRedDespiteExit0：「There were failing tests」（report 或 results）、安靜時只有的「N tests completed, M failed」、測試結果記著失敗（up-to-date 什麼都不印）→ 紅；一般輸出 → undefined；有測試結果時以結果為準（test-retry 重試通過時 log 照樣說失敗）",
    (gradleRedDespiteExit0("1 test completed, 1 failed\nThere were failing tests. See the report at: file:///w/build/reports/tests/test/index.html\nBUILD SUCCESSFUL in 2s") ?? "").includes("ignoreFailures") &&
      !!gradleRedDespiteExit0("There were failing tests. See the results at: file:///w/build/test-results/test\nBUILD SUCCESSFUL in 2s") &&
      !!gradleRedDespiteExit0("2 tests completed, 1 failed") &&
      !!gradleRedDespiteExit0("> Task :test UP-TO-DATE\n\nBUILD SUCCESSFUL in 827ms", true) &&
      gradleRedDespiteExit0("BUILD SUCCESSFUL in 2s") === undefined &&
      gradleRedDespiteExit0("> Task :test UP-TO-DATE\n\nBUILD SUCCESSFUL in 827ms", false) === undefined &&
      // test-retry passed the retry: the log still says failed, the results (retries folded) do not.
      gradleRedDespiteExit0("3 tests completed, 1 failed\nThere were failing tests. See the report at: file:///w/index.html\nBUILD SUCCESSFUL in 2s", false, true) === undefined &&
      !!gradleRedDespiteExit0("3 tests completed, 1 failed\nBUILD SUCCESSFUL in 2s", true, true),
  );
  check(
    "crashedTestClasses：testFailureIgnore 下 surefire 2.x 的 Crashed tests 那幾行沒有 [ERROR] 前綴，照樣點名",
    JSON.stringify(crashedTestClasses("[ERROR] ExecutionException The forked VM terminated\nCrashed tests:\ncom.x.ExitTest\norg.apache.maven.surefire.booter.SurefireBooterForkException: The forked VM terminated")) ===
      '["com.x.ExitTest"]',
  );
  {
    // Real reports: surefire 2.22.2 + JUnit 4.12 with rerunFailingTestsCount=2, the test failing once
    // and then passing (build green, "Flakes: 1"); and a @BeforeClass that throws.
    const flaky =
      '<testsuite name="com.x.FlakyTest" time="0.092" tests="2" errors="0" skipped="0" failures="1">\n  <properties>\n  </properties>\n' +
      '  <testcase name="passesOnSecondTry" classname="com.x.FlakyTest" time="0.001">\n    <flakyFailure message="first attempt fails" type="java.lang.AssertionError">\n' +
      "      <stackTrace>java.lang.AssertionError: first attempt fails\n\tat com.x.FlakyTest.passesOnSecondTry(FlakyTest.java:13)\n</stackTrace>\n    </flakyFailure>\n  </testcase>\n</testsuite>";
    const setup =
      '<testsuite name="com.x.SetupTest" tests="1" errors="1" skipped="0" failures="0">\n  <testcase name="" classname="com.x.SetupTest" time="0.067">\n' +
      '    <error message="class setup failed" type="java.lang.IllegalStateException"><![CDATA[java.lang.IllegalStateException: class setup failed\n]]></error>\n  </testcase>\n</testsuite>';
    const countersOnly = '<testsuite name="com.x.GoneTest" tests="3" errors="1" skipped="0" failures="0"></testsuite>';
    const rec = (xml: string) => suiteRecordsFailure(parseSurefireXml(xml)!, xml);
    check(
      "suiteRecordsFailure：重跑後通過的不穩定測試（2.x 的 failures=\"1\" 底下只有 <flakyFailure>）→ 不算失敗；@BeforeClass 丟例外 → 算；沒有任何 testcase、只有計數 → 照計數",
      !rec(flaky) && rec(setup) && rec(countersOnly),
    );
    // surefire 3.2.5 keeps a flaky attempt's stack trace in CDATA, message and all: an "<error …>" in
    // it is not an element. A real failure's CDATA can hold the same text and must still be read whole.
    const cdataFlaky =
      '<testsuite name="com.x.XmlFlakyTest" tests="2" errors="0" skipped="0" failures="1">\n  <testcase name="rendersOk" classname="com.x.XmlFlakyTest" time="0.0">\n' +
      '    <flakyFailure message="unexpected response: &lt;error code=&quot;503&quot;&gt;busy&lt;/error&gt;" type="java.lang.AssertionError">\n' +
      '      <stackTrace><![CDATA[java.lang.AssertionError: unexpected response: <error code="503">busy</error>\n\tat com.x.XmlFlakyTest.rendersOk(XmlFlakyTest.java:9)\n]]></stackTrace>\n' +
      "    </flakyFailure>\n  </testcase>\n</testsuite>";
    const cdataReal =
      '<testsuite name="com.x.XmlTest" tests="1" errors="0" skipped="0" failures="1">\n  <testcase name="renders" classname="com.x.XmlTest" time="0.0">\n' +
      '    <failure message="bad" type="java.lang.AssertionError"><![CDATA[java.lang.AssertionError: got <error code="503">busy</error>\n\tat com.x.XmlTest.renders(XmlTest.java:9)\n]]></failure>\n' +
      "  </testcase>\n</testsuite>";
    // A passing test that printed a JUnit XML snippet: its captured output ends, as text, in the middle.
    const cdataOutput =
      '<testsuite name="com.x.ReportTest" tests="1" errors="0" skipped="0" failures="0">\n  <testcase name="parses" classname="com.x.ReportTest" time="0.0">\n' +
      '    <system-out><![CDATA[read: <testcase name="a"></system-out><error message="boom"/></testcase>\n]]></system-out>\n  </testcase>\n</testsuite>';
    // Gradle's test-retry plugin, mergeReruns off: each attempt is a test case of its own.
    const retried = parseSurefireXml(
      '<testsuite name="com.x.RetryTest" tests="3" skipped="1" failures="1" errors="0">\n  <testcase name="flaky()" classname="com.x.RetryTest" time="0.01">\n' +
        '    <failure message="first attempt" type="java.lang.AssertionError">java.lang.AssertionError: first attempt\n</failure>\n  </testcase>\n' +
        '  <testcase name="flaky()" classname="com.x.RetryTest" time="0.01"/>\n  <testcase name="later()" classname="com.x.RetryTest" time="0.0">\n    <skipped/>\n  </testcase>\n</testsuite>',
    )!;
    check(
      "parseSurefireXml：通過的 test case 記在 passed（重試的每一次各是一個 test case；skipped 不算通過）",
      JSON.stringify(retried.passed) === '["flaky()"]' && retried.cases.length === 1 && retried.cases[0].name === "flaky()",
      JSON.stringify([retried.passed, retried.cases.map((c) => c.name)]),
    );
    const real = parseSurefireXml(cdataReal)!;
    check(
      "parseSurefireXml：<flakyFailure> 的 CDATA 裡的 <error …> 不是失敗、測試輸出的 CDATA 裡就算有「</system-out>」字樣後面的 <error …> 也不是；真的 <failure> 的 CDATA 有同樣的字照樣是一個失敗、訊息與位置完整",
      !rec(cdataFlaky) &&
        parseSurefireXml(cdataOutput)!.cases.length === 0 &&
        parseSurefireXml(cdataFlaky)!.cases.length === 0 &&
        real.cases.length === 1 &&
        real.cases[0].kind === "failure" &&
        real.cases[0].frame.includes("XmlTest.java:9"),
      JSON.stringify(real.cases),
    );
  }
  const sfHeader = (artifact: string, exec = "default-test", legacy = false) =>
    legacy ? `[INFO] --- maven-surefire-plugin:2.22.2:test (${exec}) @ ${artifact} ---` : `[INFO] --- surefire:3.2.5:test (${exec}) @ ${artifact} ---`;
  const SKIP = "[INFO] Tests are skipped.";
  check(
    "testsSkippedInLog：目標模組每個 surefire 執行都說 Tests are skipped → true（Maven 3.9 與 3.6 的標頭都認得）",
    testsSkippedInLog([sfHeader("tfi"), SKIP, "[INFO] BUILD SUCCESS"].join("\n")) &&
      testsSkippedInLog([sfHeader("web", "default-test", true), SKIP].join("\n"), "web") &&
      testsSkippedInLog(["[INFO] --- compiler:3.13.0:testCompile (default-testCompile) @ tfi ---", "[INFO] Not compiling test sources", sfHeader("tfi"), SKIP].join("\n"), "tfi"),
  );
  check(
    "testsSkippedInLog：-am 帶進來的上游跳過、目標有跑 → false；上游有跑、目標跳過 → true；目標兩個執行只有一個跳過 → false",
    !testsSkippedInLog([sfHeader("common"), SKIP, sfHeader("web"), "[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0"].join("\n"), "web") &&
      !testsSkippedInLog([sfHeader("common"), SKIP, sfHeader("web"), "[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0"].join("\n")) &&
      testsSkippedInLog([sfHeader("common"), "[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0", sfHeader("web"), SKIP].join("\n"), "web") &&
      !testsSkippedInLog([sfHeader("web"), SKIP, sfHeader("web", "slow-tests"), "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0"].join("\n"), "web"),
  );
  check(
    "testsSkippedInLog：failsafe 的跳過（-DskipITs）不算；沒有 surefire 執行（編譯就失敗）→ false；artifactId 對不到 log（${…}）→ 看最後建置的模組",
    !testsSkippedInLog(["[INFO] --- failsafe:3.2.5:integration-test (default) @ tfi ---", SKIP, sfHeader("tfi"), "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0"].join("\n"), "tfi") &&
      !testsSkippedInLog("[ERROR] COMPILATION ERROR :\n[INFO] BUILD FAILURE", "tfi") &&
      testsSkippedInLog([sfHeader("common"), "[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0", sfHeader("web"), SKIP].join("\n"), "${app.name}"),
  );
  check("renderRanCheck：全部都有執行 → null", renderRanCheck({ reported: [], notRun: [], allSkipped: [], ran: [], ranBefore: [] }, "maven") === null);
  check(
    "renderRanCheck：surefire 2.12.4 不跑 *Tests → 點名 includes（版本從 build log 讀）",
    (renderRanCheck(
      { reported: [], notRun: [{ file: f("CalcTests"), fqcn: "com.x.CalcTests", disabled: false, origin: "created", framework: "JUnit 4" }], allSkipped: [], ran: [{ fqcn: "com.x.AnyTest", framework: "JUnit 4" }], ranBefore: [], surefireVersion: "2.12.4" },
      "maven",
    ) ?? "").includes("*Tests 要 2.20 以後"),
  );
  const grownText = renderRanCheck(
    { reported: [], notRun: [{ file: f("OldTest"), fqcn: "com.x.OldTest", disabled: false, origin: "grown", framework: "JUnit 5" }], allSkipped: [], ran: [{ fqcn: "com.x.AnyTest", framework: "JUnit 4" }], ranBefore: [] },
    "maven",
  ) ?? "";
  check("renderRanCheck：在不會被執行的既有類別裡加了測試 → 說明加在這裡的測試不會被執行", grownText.includes("加在這裡的測試不會被執行"), grownText);
  const two = renderRanCheck(
    {
      reported: [],
      notRun: ["com.x.ATest", "com.x.BTest"].map((fqcn) => ({ file: f(fqcn.split(".").pop()!), fqcn, disabled: false, origin: "untouched" as const, framework: "JUnit 4" as const })),
      allSkipped: [],
      ran: [
        ...["com.x.C1Test", "com.x.C2Test", "com.x.C3Test"].map((fqcn) => ({ fqcn, framework: "JUnit 4" as const })),
        { fqcn: "com.x.NgTest", framework: "TestNG" as const },
      ],
      ranBefore: [],
    },
    "maven",
  ) ?? "";
  check(
    "renderRanCheck：同一個原因停掉的多個既有類別只說一次",
    (two.match(/本身沒被改過/g) ?? []).length === 1 && two.includes("上面 2 個既有類別"),
    two,
  );
  const mixed = renderRanCheck(
    { reported: [], notRun: [{ ...newTest }], allSkipped: [], ran: [{ fqcn: "com.x.NgTest", framework: "TestNG" }, ...["A", "B", "C"].map((n) => ({ fqcn: `com.x.${n}Test`, framework: "JUnit 4" as const }))], ranBefore: [] },
    "maven",
  ) ?? "";
  check("renderRanCheck：被執行的有好幾種框架 → 建議改用最多的那一種", mixed.includes("改用 JUnit 4（"), mixed);
  check(
    "expectedTestOf：類別宣告緊接在 ) 後面也讀得到修飾字（@RunWith(X.class)abstract class 是 abstract）",
    et("package com.x;\nimport org.junit.Test;\n@RunWith(Parameterized.class)public class FooTest { @Test public void a() {} }")?.fqcn === "com.x.FooTest" &&
      et("package com.x;\nimport org.junit.Test;\n@RunWith(Parameterized.class)abstract class FooTest { @Test public void a() {} }") === undefined,
  );

  // A class-level @DisplayName under surefire's phrased reporters: the report is named by it, while
  // other classes still show by FQCN. The name is written in the platform's file-name encoding: on
  // Windows it keeps its Chinese; under a POSIX locale that cannot hold it, it arrives as "?"s — a
  // character Windows does not allow in a file name at all.
  const shownFile = src("ShownTest", 'package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("Calc 加法")\nclass ShownTest { @Test void a() {} }\n');
  const shown = expectedTestOf(fs.readFileSync(shownFile, "utf8"), shownFile, "created")!;
  check("expectedTestOf：讀出類別層級的 @DisplayName", shown.displayName === "Calc 加法", JSON.stringify(shown));
  const phrased = ["TEST-Calc 加法.xml", ...(process.platform === "win32" ? [] : ["TEST-Calc ??.xml"])];
  check(
    "checkTestsRan：以 @DisplayName 命名的報告（檔名保有中文，或在 POSIX locale 下變成 ?）照樣認得是它，別的類別照常以 FQCN 出現也一樣",
    phrased.every((name) => {
      for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
      report("TEST-com.x.OldTest.xml");
      report(name, '<testsuite name="Calc 加法" tests="1"><testcase name="a" classname="Calc 加法"/></testsuite>');
      return checkTestsRan("maven", mi, since, "", [shown])?.notRun.length === 0;
    }),
    phrased.join("、"),
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));

  // Two Chinese display names under a POSIX locale: both files are all "?"s, and the XML holds each
  // name whole. One of them not run is not the other's report.
  const calcShown = src("CalcShownTest", 'package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("計算機測試")\nclass CalcShownTest { @Test void a() {} }\n');
  const orderShown = src("OrderShownTest", 'package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("訂單測試")\nclass OrderShownTest { @Test void a() {} }\n');
  const calcT = expectedTestOf(fs.readFileSync(calcShown, "utf8"), calcShown, "created")!;
  const orderT = expectedTestOf(fs.readFileSync(orderShown, "utf8"), orderShown, "created")!;
  // Windows allows no "?" in a file name (and keeps the characters there): these are POSIX's.
  if (process.platform !== "win32") {
    report("TEST-com.x.OldTest.xml");
    report("TEST-????.xml", '<testsuite name="訂單測試" tests="1"><testcase name="a" classname="訂單測試"/></testsuite>');
    const cjk = checkTestsRan("maven", mi, since, "", [calcT, orderT]);
    check(
      "checkTestsRan：只有「訂單測試」有報告（檔名在 POSIX locale 下是 ????）→「計算機測試」沒執行，別的類別的 display name 不算它的",
      cjk?.notRun.map((t) => t.fqcn).join() === "com.x.CalcShownTest",
      JSON.stringify(cjk?.notRun.map((t) => t.fqcn)),
    );
    // No XML (disableXmlReport): the file name is all there is, one "?" for each character it lost.
    for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
    report("com.x.OldTest.txt", "Tests run: 1, Failures: 0, Errors: 0, Skipped: 0");
    report("????.txt", "Tests run: 1, Failures: 0, Errors: 0, Skipped: 0");
    const byFile = checkTestsRan("maven", mi, since, "", [calcT, orderT]);
    check(
      "checkTestsRan：只有 .txt、檔名 ????——四個字的「訂單測試」算有執行，五個字的「計算機測試」不算",
      byFile?.notRun.map((t) => t.fqcn).join() === "com.x.CalcShownTest",
      JSON.stringify(byFile?.notRun.map((t) => t.fqcn)),
    );
    const sameShape = src("PayShownTest", 'package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("付款測試")\nclass PayShownTest { @Test void a() {} }\n');
    const ambiguous = checkTestsRan("maven", mi, since, "", [orderT]);
    check(
      "checkTestsRan：模組裡另一個類別的 display name（「付款測試」）也寫得成 ???? → 這個檔名認不出是誰的，不算",
      ambiguous?.notRun.map((t) => t.fqcn).join() === "com.x.OrderShownTest",
      JSON.stringify(ambiguous?.notRun.map((t) => t.fqcn)),
    );
    fs.rmSync(sameShape);
    for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  }
  report("TEST-com.x.OldTest.xml");
  report("計算機測試.txt", "Tests run: 2, Failures: 0, Errors: 0, Skipped: 2, Time elapsed: 0.01 s");
  const shownSkipped = checkTestsRan("maven", mi, since, "", [calcT]);
  check(
    "checkTestsRan：以 @DisplayName 命名的它自己的報告（.txt 摘要）說全部被略過 → 全部被略過",
    shownSkipped?.notRun.length === 0 && shownSkipped.allSkipped.length === 1 && shownSkipped.allSkipped[0].tests === 2,
    JSON.stringify(shownSkipped),
  );
  // An MS950 module: the display name is what javac reads, not what the bytes read as UTF-8 or latin1 are.
  const big5Name = Buffer.from([0xad, 0x70, 0xba, 0xe2, 0xbe, 0xf7, 0xb4, 0xfa, 0xb8, 0xd5]); // 計算機測試
  const ms950 = path.join(m, "src", "test", "java", "com", "x", "CalcShownTest.java");
  fs.writeFileSync(
    ms950,
    Buffer.concat([Buffer.from('package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("'), big5Name, Buffer.from('")\nclass CalcShownTest { @Test void a() {} }\n')]),
  );
  check(
    "decodeJavaSource + expectedTestOf：MS950 原始碼的 @DisplayName 以 MS950 讀出（計算機測試）",
    expectedTestOf(decodeJavaSource(fs.readFileSync(ms950), "MS950"), ms950, "created")?.displayName === "計算機測試",
  );
  fs.writeFileSync(calcShown, 'package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("計算機測試")\nclass CalcShownTest { @Test void a() {} }\n');
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  check(
    "expectedTestOf：@DisplayName 照 JUnit 的讀法——\\u 跳脫、value =、前後空白去掉；空白的不算名字",
    et('package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("\\u8a08\\u7b97 ")\nclass FooTest { @Test void a() {} }')?.displayName === "計算" &&
      et('package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName(value = "Calc \\"x\\"")\nclass FooTest { @Test void a() {} }')?.displayName === 'Calc "x"' &&
      et('package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("  ")\nclass FooTest { @Test void a() {} }')?.displayName === undefined,
  );
  check(
    "lossyFileNameOf：一個字一個 ?；ASCII 要一樣；沒有 ? 的檔名不用這條",
    lossyFileNameOf("?????", "計算機測試") &&
      !lossyFileNameOf("????", "計算機測試") &&
      lossyFileNameOf("Calc ??", "Calc 加法") &&
      !lossyFileNameOf("Calx ??", "Calc 加法") &&
      !lossyFileNameOf("計算", "計算") &&
      !lossyFileNameOf("a?", "ab"),
  );
  check(
    "javaStringValue / decodeJavaSource：跳脫照 javac；MS950 的「處理成功」（第二個 byte 是 \\）不會把引號吃掉；不認得的編碼、不是 UTF-8 → 先試雙位元組編碼（Big5 讀得通就是它），都不行才逐 byte",
    javaStringValue("\\u8a08 \\\\u0041 \\\\\\u0041 \\t\\101") === "計 \\u0041 \\A \tA" &&
      decodeJavaSource(Buffer.from([0x22, 0xb3, 0x42, 0xb2, 0x7a, 0xa6, 0xa8, 0xa5, 0x5c, 0x22]), "x-windows-950") === '"處理成功"' &&
      decodeJavaSource(Buffer.from([0x22, 0xb3, 0x42, 0xb2, 0x7a, 0xa6, 0xa8, 0xa5, 0x5c, 0x22]), "no-such-charset") === '"處理成功"' &&
      decodeJavaSource(Buffer.from([0x22, 0xb3, 0x42, 0xb2, 0x7a, 0xa6, 0xa8, 0xa5, 0x5c, 0x22])) === '"處理成功"' &&
      decodeJavaSource(Buffer.from([0x41, 0xfd]), "no-such-charset") === "A\u00fd" &&
      decodeJavaSource(Buffer.from("\ufeff計", "utf8")) === "計",
  );

  // Round 5: a report goes by the name inside it; a class by its own reports first, and by its
  // @DisplayName only when no other class of the module goes by it too.
  const svcFile = src(
    "OrderServiceTest",
    'package com.x;\nimport org.junit.jupiter.api.*;\nimport org.junit.jupiter.api.extension.ExtendWith;\n@DisplayName("訂單服務測")\n@ExtendWith({NoopExtension.class})\n@Disabled("等 DB 環境")\nclass OrderServiceTest { @Test void total() {} }\n',
  );
  const svc = expectedTestOf(fs.readFileSync(svcFile, "utf8"), svcFile, "untouched");
  check(
    "expectedTestOf：@DisplayName 在 @ExtendWith({…}) 之前也讀得到（註解參數裡的 } 不是類別自己的註解開始的地方），之後的 @Disabled 也算",
    svc?.displayName === "訂單服務測" && svc.disabled === true,
    JSON.stringify(svc),
  );
  check(
    "expectedTestOf：@DisplayName 照 Java 的 trim——只去掉 U+0020 以下的字，全形空白留著；不是一個字串常值（常數、相加）→ 讀不到的名字",
    et('package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("\\t\\u3000計算\\u3000\\n")\nclass FooTest { @Test void a() {} }')?.displayName === "　計算　" &&
      et('package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName(Names.CALC)\nclass FooTest { @Test void a() {} }')?.displayNameUnread === true &&
      et('package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("a" + "b")\nclass FooTest { @Test void a() {} }')?.displayNameUnread === true &&
      et('package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayNameGeneration(X.class)\nclass FooTest { @Test void a() {} }')?.displayNameUnread === undefined,
  );
  // Two classes of one @DisplayName: surefire writes one TEST-服務測試.xml, the last one's — here the
  // disabled one's, every test skipped.
  const dupCalcFile = src("CalcDupTest", 'package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName("服務測試")\nclass CalcDupTest { @Test void a() {} @Test void b() {} }\n');
  src("OrderDupTest", 'package com.x;\nimport org.junit.jupiter.api.*;\n@Disabled\n@DisplayName("服務測試")\nclass OrderDupTest { @Test void a() {} }\n');
  const dupCalc = expectedTestOf(fs.readFileSync(dupCalcFile, "utf8"), dupCalcFile, "created")!;
  const dupXml = '<testsuite name="服務測試" tests="1" skipped="1"><testcase name="a" classname="com.x.OrderDupTest"><skipped/></testcase></testsuite>';
  report("com.x.CalcDupTest.txt", "Test set: com.x.CalcDupTest\nTests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s -- in com.x.CalcDupTest");
  report("com.x.OrderDupTest.txt", "Test set: com.x.OrderDupTest\nTests run: 1, Failures: 0, Errors: 0, Skipped: 1, Time elapsed: 0.01 s -- in com.x.OrderDupTest");
  report("TEST-服務測試.xml", dupXml);
  const dup = checkTestsRan("maven", mi, since, "", [dupCalc]);
  check(
    "checkTestsRan：同一個 @DisplayName 的報告是另一個（@Disabled）類別最後寫的 → 以它自己的 .txt 為準：2 個都跑了，不是全部被略過",
    dup?.notRun.length === 0 && dup.allSkipped.length === 0,
    JSON.stringify(dup),
  );
  fs.rmSync(path.join(reports, "com.x.CalcDupTest.txt"));
  fs.rmSync(path.join(reports, "com.x.OrderDupTest.txt"));
  report("TEST-com.x.OldTest.xml");
  const dupOnly = checkTestsRan("maven", mi, since, "", [dupCalc]);
  const dupText = dupOnly ? (renderRanCheck(dupOnly, "maven") ?? "") : "";
  check(
    "checkTestsRan：只有那份同名的報告 → 分不出是誰的，不算它有執行；回饋點名另一個同名的類別、要它取獨一無二的名字",
    dupOnly?.notRun.map((t) => t.fqcn).join() === "com.x.CalcDupTest" &&
      dupOnly.notRun[0].sharedName?.join() === "com.x.OrderDupTest" &&
      dupText.includes("與 com.x.OrderDupTest 相同") &&
      dupText.includes("獨一無二"),
    dupText,
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  fs.rmSync(path.join(m, "src", "test", "java", "com", "x", "CalcDupTest.java"));
  fs.rmSync(path.join(m, "src", "test", "java", "com", "x", "OrderDupTest.java"));
  // Its own report (by FQCN) says both ran; one by its @DisplayName, alone in the module, says otherwise:
  // its own is what counts.
  report("TEST-com.x.OldTest.xml");
  report("com.x.CalcShownTest.txt", "Test set: com.x.CalcShownTest\nTests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s");
  report("TEST-計算機測試.xml", '<testsuite name="計算機測試" tests="2" skipped="2"><testcase name="a" classname="計算機測試"><skipped/></testcase><testcase name="b" classname="計算機測試"><skipped/></testcase></testsuite>');
  const ownFirst = checkTestsRan("maven", mi, since, "", [calcT]);
  check(
    "checkTestsRan：有以 FQCN 命名的它自己的報告 → 只算那些，以 @DisplayName 命名的那份不算進去",
    ownFirst?.notRun.length === 0 && ownFirst.allSkipped.length === 0,
    JSON.stringify(ownFirst),
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  // A @DisplayName with "$": no class name, kept whole.
  report("TEST-com.x.OldTest.xml");
  report("TEST-滿 NT$1000 折 NT$100.xml", '<testsuite name="滿 NT$1000 折 NT$100" tests="1"><testcase name="a" classname="滿 NT$1000 折 NT$100"/></testsuite>');
  const dollar = checkTestsRan("maven", mi, since, "", [], [], true);
  check(
    "checkTestsRan：「滿 NT$1000 折 NT$100」這種 @DisplayName 不是類別名稱，照原樣列出、不在 $ 切斷",
    !!dollar?.reported.includes("滿 NT$1000 折 NT$100") && !dollar.reported.includes("滿 NT"),
    JSON.stringify(dollar?.reported),
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  if (process.platform !== "win32") {
    // Under a POSIX locale: the file name is "?????" whatever the name was; what is inside says whose.
    report("TEST-com.x.OldTest.xml");
    report("com.x.CalcShownTest.txt", "Test set: com.x.CalcShownTest\nTests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s");
    report("TEST-?????.xml", '<testsuite name="訂單服務測" tests="1" skipped="1"><testcase name="total" classname="com.x.OrderServiceTest"><skipped/></testcase></testsuite>');
    const lossyOther = checkTestsRan("maven", mi, since, "", [calcT]);
    check(
      "checkTestsRan：「?????」這份 XML 裡寫的是 @Disabled 的「訂單服務測」→ 不是「計算機測試」的，它不算全部被略過",
      lossyOther?.notRun.length === 0 && lossyOther.allSkipped.length === 0,
      JSON.stringify(lossyOther),
    );
    fs.rmSync(path.join(reports, "com.x.CalcShownTest.txt"));
    report("TEST-?????.xml", '<testsuite name="五個字名字" tests="1"><testcase name="total" classname="五個字名字"/></testsuite>');
    const credited = checkTestsRan("maven", mi, since, "", [calcT]);
    check(
      "checkTestsRan：「?????」裡的名字是別的（模組裡沒有類別叫這個）→ 不因為檔名剛好五個 ? 就算「計算機測試」有執行",
      credited?.notRun.map((t) => t.fqcn).join() === "com.x.CalcShownTest",
      JSON.stringify(credited?.notRun.map((t) => t.fqcn)),
    );
    report("TEST-?????.xml", '<testsuite name="計算機??" tests="1"><testcase name="total" classname="計算機??"/></testsuite>');
    check(
      "checkTestsRan：裡面寫的名字本來就是「計算機??」（讀得到的名字不是遺失了字的檔名）→ 不算「計算機測試」",
      checkTestsRan("maven", mi, since, "", [calcT])?.notRun.map((t) => t.fqcn).join() === "com.x.CalcShownTest",
    );
    report("?????.txt", "Test set: 計算機測試\nTests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.01 s");
    fs.rmSync(path.join(reports, "TEST-?????.xml"));
    check(
      "checkTestsRan：「?????.txt」裡的 Test set 是「計算機測試」→ 它有執行",
      checkTestsRan("maven", mi, since, "", [calcT])?.notRun.length === 0,
    );
    // Nothing inside to read: the file name is all there is — its only when no other class can be it.
    report("?????.txt", "");
    fs.rmSync(svcFile);
    check("checkTestsRan：裡面讀不到名字、模組裡只有「計算機測試」寫得成 ????? → 算它的", checkTestsRan("maven", mi, since, "", [calcT])?.notRun.length === 0);
    const constFile = src("ConstShownTest", 'package com.x;\nimport org.junit.jupiter.api.*;\n@DisplayName(Names.SHOWN)\nclass ConstShownTest { @Test void a() {} }\n');
    check(
      "checkTestsRan：另一個類別的 @DisplayName 是常數、讀不到 → 它也可能是 ?????，這個檔名不算「計算機測試」的",
      checkTestsRan("maven", mi, since, "", [calcT])?.notRun.map((t) => t.fqcn).join() === "com.x.CalcShownTest",
    );
    fs.rmSync(constFile);
    for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  }
  if (fs.existsSync(svcFile)) fs.rmSync(svcFile);
  // A name read inside a report is whole: "計算機??" is a class that goes by that, every test of it skipped —
  // not a file name that lost the characters of 計算機測試, which ran (the log says so) with none skipped.
  report("TEST-other.xml", '<testsuite name="計算機??" tests="2" skipped="2"><testcase name="a" classname="計算機??"><skipped/></testcase><testcase name="b" classname="計算機??"><skipped/></testcase></testsuite>');
  const namedInside = checkTestsRan(
    "maven",
    mi,
    since,
    "[INFO] Running com.x.CalcShownTest\n[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in com.x.CalcShownTest",
    [calcT],
  );
  check(
    "checkTestsRan：報告裡寫的名字「計算機??」是完整的名字，不是遺失了字的檔名 → 它全部略過不算「計算機測試」的",
    namedInside?.notRun.length === 0 && namedInside.allSkipped.length === 0,
    JSON.stringify(namedInside),
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));

  // A TestNG class skipped whole (a SkipException in its @BeforeClass): only TEST-TestSuite.xml, every case of it skipped.
  report("TEST-TestSuite.xml", '<testsuite name="TestSuite" tests="3" skipped="2"><testcase name="a" classname="com.x.NewTest"><skipped/></testcase><testcase name="b" classname="com.x.NewTest"><skipped message="no db"/></testcase><testcase name="c" classname="com.x.OldTest"/></testsuite>');
  const ngSkipped = checkTestsRan("maven", mi, since, "", [newTest]);
  check(
    "checkTestsRan：只在 TestNG 的 TEST-TestSuite.xml 裡、它的每個 case 都 skipped → 全部被略過（suite 的總數不算）",
    ngSkipped?.notRun.length === 0 && ngSkipped.allSkipped.length === 1 && ngSkipped.allSkipped[0].tests === 2,
    JSON.stringify(ngSkipped?.allSkipped),
  );
  report("TEST-TestSuite.xml", '<testsuite name="TestSuite" tests="3" skipped="1"><testcase name="a" classname="com.x.NewTest"><skipped/></testcase><testcase name="b" classname="com.x.NewTest"><system-out><![CDATA[<skipped/>]]></system-out></testcase><testcase name="c" classname="com.x.OldTest"/></testsuite>');
  check(
    "checkTestsRan：suite 裡它有一個 case 真的跑了（輸出裡的 <skipped/> 是文字）→ 不算全部被略過",
    checkTestsRan("maven", mi, since, "", [newTest])?.allSkipped.length === 0,
  );
  fs.rmSync(path.join(reports, "TEST-TestSuite.xml"));
  // A JUnit 4 Suite member skipped by an assumption in its @BeforeClass: one case, no name, skipped.
  report("TEST-com.x.AllTests.xml", '<testsuite name="com.x.AllTests" tests="2" skipped="1"><testcase name="" classname="com.x.NewTest"><skipped/></testcase><testcase name="a" classname="com.x.OldTest"/></testsuite>');
  const suiteSkipped = checkTestsRan("maven", mi, since, "", [newTest]);
  check(
    "checkTestsRan：JUnit 4 Suite 的成員，報告裡只有一個沒有名字、skipped 的 case → 全部被略過",
    suiteSkipped?.notRun.length === 0 && suiteSkipped.allSkipped.length === 1,
    JSON.stringify(suiteSkipped),
  );
  fs.rmSync(path.join(reports, "TEST-com.x.AllTests.xml"));
  // A suite's failure is its failing cases' classes', where the module has their source.
  report(
    "TEST-TestSuite.xml",
    '<testsuite name="TestSuite" tests="3" failures="2"><testcase name="a" classname="com.x.NewTest"><failure message="x"/></testcase><testcase name="b" classname="com.x.OldTest"/><testcase name="c" classname="org.other.ElsewhereTest"><failure/></testcase></testsuite>',
  );
  check(
    "testOnlyFailures：suite 報告（TEST-TestSuite.xml）的失敗算在失敗案例自己的類別上（模組裡有它的原始碼時）",
    JSON.stringify(testOnlyFailures("maven", mi, since, "")?.map((f) => f.cls)) === JSON.stringify(["com.x.NewTest"]),
    JSON.stringify(testOnlyFailures("maven", mi, since, "")),
  );
  report("TEST-TestSuite.xml", '<testsuite name="TestSuite" tests="1" failures="1"><testcase name="c" classname="org.other.ElsewhereTest"><failure/></testcase></testsuite>');
  check(
    "testOnlyFailures：失敗案例的類別在模組裡沒有原始碼 → 照舊是 suite 名",
    JSON.stringify(testOnlyFailures("maven", mi, since, "")?.map((f) => f.cls)) === JSON.stringify(["TestSuite"]),
    JSON.stringify(testOnlyFailures("maven", mi, since, "")),
  );
  fs.rmSync(path.join(reports, "TEST-TestSuite.xml"));
  check(
    "testCountsInLog：每個類別那行的 Tests run 與 Skipped（3.x 的「-- in」、2.x 的「- in」），同一個類別加總",
    JSON.stringify([
      ...testCountsInLog(
        [
          "[WARNING] Tests run: 2, Failures: 0, Errors: 0, Skipped: 2, Time elapsed: 0.01 s -- in com.x.CalcTest",
          "[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s - in com.x.OldTest",
          "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 1, Time elapsed: 0.01 s -- in com.x.CalcTest$Inner",
          "[WARNING] Tests run: 6, Failures: 0, Errors: 0, Skipped: 3",
        ].join("\n"),
      ),
    ]) === JSON.stringify([["com.x.CalcTest", { tests: 2, skipped: 2 }], ["com.x.OldTest", { tests: 3, skipped: 0 }], ["com.x.CalcTest$Inner", { tests: 1, skipped: 1 }]]),
  );
  check(
    "outerClassName：Java 類名在 $ 切到外層類別；不是類名的名字（有空白、標點的 @DisplayName）原樣",
    outerClassName("com.x.CalcTest$Inner") === "com.x.CalcTest" &&
      outerClassName("com.x.計算$內") === "com.x.計算" &&
      outerClassName("滿 NT$1000 折 NT$100") === "滿 NT$1000 折 NT$100" &&
      outerClassName("計算機測試 加法") === "計算機測試 加法",
  );
  check(
    "reportContents：testsuite 的名字、每個 classname 的 case 數與 skipped 數；CDATA 裡的標記是文字",
    (() => {
      const r = reportContents('<testsuite name="S"><testcase name="a" classname="p.A"/><testcase name="b" classname="p.A"><skipped/></testcase><testcase name="c" classname="p.B"><system-out><![CDATA[<testcase classname="p.C"/>]]></system-out></testcase></testsuite>');
      return JSON.stringify(r.names.sort()) === JSON.stringify(["S", "p.A", "p.B"]) && r.cases.get("p.A")?.tests === 2 && r.cases.get("p.A")?.skipped === 1 && r.cases.get("p.B")?.skipped === 0 && !r.cases.has("p.C");
    })(),
  );

  // Tests that failed and then passed when run again: green, and no evidence that they pass.
  check(
    "flakyClassesInReport：surefire 的 <flakyFailure>/<flakyError>、Gradle test-retry 同名一敗一過；真的失敗、略過、輸出裡的文字都不算",
    JSON.stringify(
      flakyClassesInReport(
        '<testsuite name="com.x.CalcTest"><testcase name="a" classname="com.x.CalcTest"><flakyFailure message="x"/></testcase>' +
          '<testcase name="b" classname="com.x.CalcTest$Inner"><flakyError/></testcase></testsuite>',
      ),
    ) === JSON.stringify(["com.x.CalcTest"]) &&
      JSON.stringify(
        flakyClassesInReport(
          '<testsuite name="com.x.RetryTest"><testcase name="a" classname="com.x.RetryTest"><failure message="1"/></testcase><testcase name="a" classname="com.x.RetryTest"/>' +
            '<testcase name="b" classname="com.x.StillTest"><failure/></testcase><testcase name="c" classname="com.x.SkipTest"><skipped/></testcase><testcase name="c" classname="com.x.SkipTest"><failure/></testcase>' +
            '<testcase name="d" classname="com.x.TextTest"><system-out><![CDATA[<flakyFailure/>]]></system-out></testcase></testsuite>',
        ),
      ) === JSON.stringify(["com.x.RetryTest"]),
  );
  check(
    "flakyClassesInReport：TestNG 的 retry analyzer 把失敗的那次記成 skipped、再記一次同名的通過 → 不穩定（實測 TestNG 7.5）",
    JSON.stringify(
      flakyClassesInReport(
        '<testsuite name="TestSuite" tests="2" skipped="0"><testcase name="add" classname="com.x.NgTest"><skipped message="expected [3] but found [4]"/></testcase><testcase name="add" classname="com.x.NgTest"/>' +
          '<testcase name="off" classname="com.x.OffTest"><skipped/></testcase></testsuite>',
      ),
    ) === JSON.stringify(["com.x.NgTest"]),
  );
  check(
    "flakyClassesInLog：3.x 的「Flakes:」（類別.方法）、2.22 的（類別.方法(類別)）與 2.20 以前的「Flaked tests:」；讀到 Tests run 就停",
    JSON.stringify(
      flakyClassesInLog(
        [
          "[INFO] Results:",
          "[INFO] ",
          "[WARNING] Flakes: ",
          "[WARNING] com.x.CalcTest.add",
          "[ERROR]   Run 1: CalcTest.add:11 expected: <3> but was: <4>",
          "[INFO]   Run 2: PASS",
          "[INFO] ",
          "[WARNING] com.x.OrderTest.total(com.x.OrderTest)",
          "[ERROR]   Run 1: OrderTest.total:9 expected:<3> but was:<4>",
          "[INFO]   Run 2: PASS",
          "[INFO] ",
          "[INFO] ",
          "[WARNING] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Flakes: 2",
          "[INFO] Running com.x.LaterTest.after",
        ].join("\n"),
      ),
    ) === JSON.stringify(["com.x.CalcTest", "com.x.OrderTest"]) &&
      JSON.stringify(
        flakyClassesInLog(
          ["[INFO] Flaked tests: ", "[INFO] com.x.CalcTest.add(com.x.CalcTest)", "[INFO]   Run 1: CalcTest.add:11 expected:<3> but was:<4>", "[INFO]   Run 2: PASS", "[INFO] ", "[WARNING] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Flakes: 1"].join("\n"),
        ),
      ) === JSON.stringify(["com.x.CalcTest"]),
  );
  report("TEST-com.x.NewTest.xml", '<testsuite name="com.x.NewTest" tests="1"><testcase name="a" classname="com.x.NewTest"><flakyFailure message="x"/></testcase></testsuite>');
  report("TEST-com.x.OldTest.xml", '<testsuite name="com.x.OldTest" tests="1"><testcase name="a" classname="com.x.OldTest"><flakyFailure message="x"/></testcase></testsuite>', 60_000);
  check(
    "flakyTestClasses：這次建置的報告裡重跑才過的類別（之前的建置留下的不算）；沒有 XML 時看 log 的 Flakes 段",
    JSON.stringify(flakyTestClasses("maven", mi, since, "")) === JSON.stringify(["com.x.NewTest"]) &&
      JSON.stringify(flakyTestClasses("maven", mi, Date.now() + 60_000, "[WARNING] Flakes: \n[WARNING] com.x.OldTest.a\n[INFO]   Run 2: PASS\n")) === JSON.stringify(["com.x.OldTest"]),
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));

  // A reactor: an upstream module has a class of the same name, and only its ran.
  const reactorLog = [
    "[INFO] -------------------------< com.x:common >--------------------------",
    "[INFO] Building common 1.0                                           [1/2]",
    "[INFO] --- surefire:3.2.5:test (default-test) @ common ---",
    "[INFO] Running com.x.NewTest",
    "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in com.x.NewTest",
    "[INFO] --- jar:3.3.0:jar (default-jar) @ common ---",
    "[INFO] -------------------------< com.x:web >--------------------------",
    "[INFO] Building web 1.0                                           [2/2]",
    "[INFO] --- surefire:3.2.5:test (default-test) @ web ---",
    "[INFO] Running com.x.OldTest",
    "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in com.x.OldTest",
  ].join("\n");
  check(
    "classesRunInModuleLog：只看目標模組的 surefire 區段；不知道 artifactId 就看最後建置的模組；沒有區段標頭就看整份",
    classesRunInModuleLog(reactorLog, "web").join() === "com.x.OldTest" &&
      classesRunInModuleLog(reactorLog, "common").join() === "com.x.NewTest" &&
      classesRunInModuleLog(reactorLog).join() === "com.x.OldTest" &&
      classesRunInModuleLog("[INFO] Running com.x.NewTest\n").join() === "com.x.NewTest" &&
      surefireSections(reactorLog).map((x) => `${x.artifact}:${x.lines.length}`).join() === "common:2,web:2",
    JSON.stringify(surefireSections(reactorLog)),
  );
  check(
    "surefireSections：測試自己印的「[INFO] Building …」、句中的「--- x @ y ---」、logger 前綴之後或後面還有字的 Maven 標頭都不會切斷區段；時間戳記開頭的標頭照樣認得",
    classesRunInModuleLog(
      [
        "[INFO] --- surefire:3.2.5:test (default-test) @ web ---",
        "[INFO] Running com.x.AaaReportTest",
        "[INFO] Building monthly report for 2026-09",
        "report --- totals @ page ---",
        // A test that runs an embedded build logs Maven's own lines — after its logger's prefix, or with more after them.
        "10:00:01.123 [main] INFO  com.x.EmbeddedMaven - [INFO] --- maven-jar-plugin:3.3.0:jar (default-jar) @ inner ---",
        "[INFO] --- surefire:3.2.5:test (default-test) @ inner --- (quoted by a test)",
        "[INFO] Running com.x.NewTest",
        "10:00:01,234 [INFO] --- jacoco:0.8.12:report (report) @ web ---",
        "[INFO] Running com.x.NotSurefire",
      ].join("\n"),
      "web",
    ).join() === "com.x.AaaReportTest,com.x.NewTest",
    JSON.stringify(surefireSections("[INFO] --- surefire:3.2.5:test (default-test) @ web ---\n[INFO] Building x\n[INFO] Running com.x.NewTest")),
  );
  const upstreamOnly = checkTestsRan("maven", mi, since, reactorLog, [newTest]);
  check(
    "checkTestsRan：上游模組跑了同名的 com.x.NewTest，目標模組沒有 → 不算目標模組的執行過",
    upstreamOnly?.notRun.map((t) => t.fqcn).join() === "com.x.NewTest",
    JSON.stringify(upstreamOnly),
  );
  // TestNG: one TEST-TestSuite.xml for everything — its classes are what ran, and what to protect.
  src("NgTest", "package com.x;\nimport org.testng.annotations.Test;\npublic class NgTest { @Test public void a() {} }\n");
  report("TEST-TestSuite.xml", '<testsuite name="TestSuite" tests="1"><testcase name="a" classname="com.x.NgTest" time="0"/></testsuite>');
  const ngRun = checkTestsRan("maven", mi, since, "", [newTest])!;
  const ngText = renderRanCheck(ngRun, "maven") ?? "";
  check(
    "checkTestsRan：TestNG 模組（只有 TEST-TestSuite.xml）→ 從裡面的 testcase 認出執行了哪些類別，建議改寫成 TestNG",
    ngRun.ran.some((r) => r.fqcn === "com.x.NgTest" && r.framework === "TestNG") && ngText.includes("改用 TestNG"),
    ngText,
  );
  check("ranTestClasses：suite 報告裡的成員類別也記下（之後要一直能執行）", ranTestClasses("maven", mi, since, "").includes("com.x.NgTest"));
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));
  // A JUnit 4 suite class: its report is named after a class, and its members run only inside it.
  src("AllTests", "package com.x;\nimport org.junit.runner.RunWith;\nimport org.junit.runners.Suite;\n@RunWith(Suite.class)\n@Suite.SuiteClasses({ OldTest.class })\npublic class AllTests {}\n");
  report("TEST-com.x.AllTests.xml", '<testsuite name="com.x.AllTests" tests="1"><testcase name="a" classname="com.x.OldTest" time="0"/></testsuite>');
  const viaSuite = ranTestClasses("maven", mi, since, "");
  check(
    "ranTestClasses：JUnit 4 suite 類別的報告以它自己命名 → 裡面的成員類別也記下",
    viaSuite.includes("com.x.AllTests") && viaSuite.includes("com.x.OldTest"),
    JSON.stringify(viaSuite),
  );
  for (const e of fs.readdirSync(reports)) fs.rmSync(path.join(reports, e));

  // gradle deletes its results before each run: whatever is there is this run's (or an up-to-date one's).
  const g = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-ran-"));
  fs.mkdirSync(path.join(g, "src", "test", "java", "com", "x"), { recursive: true });
  fs.copyFileSync(newFile, path.join(g, "src", "test", "java", "com", "x", "NewTest.java"));
  const gResults = path.join(g, "build", "test-results", "test");
  fs.mkdirSync(gResults, { recursive: true });
  fs.writeFileSync(path.join(gResults, "TEST-com.x.NewTest.xml"), '<testsuite name="com.x.NewTest" tests="1" skipped="0"></testsuite>');
  const old = (Date.now() - 3_600_000) / 1000;
  fs.utimesSync(path.join(gResults, "TEST-com.x.NewTest.xml"), old, old);
  check(
    "checkTestsRan（gradle）：結果目錄裡的就是最近一次執行的，不看修改時間",
    checkTestsRan("gradle", { moduleRoot: g, moduleRel: "", multiModule: false }, Date.now(), "", [newTest])?.notRun.length === 0,
  );
  fs.rmSync(g, { recursive: true, force: true });
  fs.rmSync(m, { recursive: true, force: true });
}

console.log("\n[28] 接續先前的執行（libs/resume.ts：通過紀錄與比對）");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-resume-"));
  const put = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  const FOO = "m/src/main/java/com/x/Foo.java";
  const BAR = "m/src/main/java/com/x/Bar.java";
  const FOO_T = "m/src/test/java/com/x/FooTest.java";
  const BAR_T = "m/src/test/java/com/x/BarTest.java";
  const HELPER = "m/src/test/java/com/x/Helper.java";
  const RES = "m/src/test/resources/data.json";
  const GONE = "m/src/test/java/com/x/OldFooTest.java";
  for (const [rel, c] of [[FOO, "class Foo {}"], [BAR, "class Bar {}"], [FOO_T, "class FooTest {}"], [BAR_T, "class BarTest {}"], [HELPER, "class Helper {}"], [RES, "{}"]]) put(rel, c);

  check("hashFile：沒有檔案 → null", hashFile(path.join(root, "nope.java")) === null);
  check("hashFile：檔案內容的 sha256", hashFile(path.join(root, FOO)) === sha256("class Foo {}"));
  const dirHash = hashFile(path.join(root, "m"));
  check("hashFile：讀不了的（目錄）→ 一個誰都對不上的值，不是 null", dirHash !== null && dirHash.startsWith("unreadable:"), String(dirHash));

  const testsOf = (cls: string) => (cls === FOO ? [FOO_T] : cls === BAR ? [BAR_T.replace(/\//g, "\\")] : []);
  const entries = passedEntries({
    classes: [FOO, BAR],
    repoRoot: root,
    testsOf,
    written: [FOO_T, BAR_T, HELPER.replace(/\//g, "\\"), RES, GONE],
    testTree: "m/src/test",
    rubric: "r1",
    verdict: { scores: { effectiveness: 8 }, blockers: [] },
    dir: "/runs/a/batch-1-Foo",
    at: "2026-01-01T00:00:00.000Z",
  });
  const foo = entries.find((e) => e.cls === FOO)!;
  const bar = entries.find((e) => e.cls === BAR)!;
  check(
    "passedEntries：每個類別記下自己的測試檔與那批寫的共用檔，不含別的類別的測試",
    JSON.stringify(Object.keys(foo.files)) === JSON.stringify([FOO_T, HELPER, GONE, RES].sort()) &&
      JSON.stringify(Object.keys(bar.files)) === JSON.stringify([BAR_T, HELPER, GONE, RES].sort()),
    JSON.stringify([Object.keys(foo.files), Object.keys(bar.files)]),
  );
  check("passedEntries：Windows 的反斜線路徑一律存成 /", !JSON.stringify(entries).includes("\\\\"), JSON.stringify(entries).slice(0, 300));
  check("passedEntries：那批刪掉的檔記成 null（之後也必須不存在）", foo.files[GONE] === null);
  check("passedEntries：類別與檔案都記內容的 sha256", foo.source === sha256("class Foo {}") && foo.files[FOO_T] === sha256("class FooTest {}"));

  const hashOf = (rel: string) => hashFile(path.join(root, rel));
  check("entryMismatch：什麼都沒變 → 相符", entryMismatch(foo, hashOf, [FOO_T]) === undefined);
  put(FOO, "class Foo { int x; }");
  check("entryMismatch：類別改過 → 說出來", entryMismatch(foo, hashOf, [FOO_T]) === "Foo.java 在上次通過之後改過", String(entryMismatch(foo, hashOf, [FOO_T])));
  put(FOO, "class Foo {}");
  put(HELPER, "class Helper { int y; }");
  check("entryMismatch：那批寫的共用檔改過", entryMismatch(foo, hashOf, [FOO_T]) === `${HELPER} 在上次通過之後改過`, String(entryMismatch(foo, hashOf, [FOO_T])));
  put(HELPER, "class Helper {}");
  fs.rmSync(path.join(root, FOO_T));
  check("entryMismatch：測試檔被刪了", entryMismatch(foo, hashOf, []) === `${FOO_T} 在上次通過之後被刪除`, String(entryMismatch(foo, hashOf, [])));
  put(FOO_T, "class FooTest {}");
  put(GONE, "class OldFooTest {}");
  check("entryMismatch：當時被刪掉的檔又出現了", entryMismatch(foo, hashOf, [FOO_T]) === `${GONE} 在上次通過之後才出現`, String(entryMismatch(foo, hashOf, [FOO_T])));
  fs.rmSync(path.join(root, GONE));
  // Two failed reads say nothing about whether the content is the same.
  const locked = { ...foo, files: { ...foo.files, [HELPER]: "unreadable:EACCES" } };
  const lockedNow = (rel: string) => (rel === HELPER ? "unreadable:EACCES" : hashOf(rel));
  check(
    "entryMismatch：讀不了的檔（兩次都讀不了）也不算沒變",
    entryMismatch(locked, lockedNow, [FOO_T]) === `${HELPER} 讀不了，無法確認它沒變`,
    String(entryMismatch(locked, lockedNow, [FOO_T])),
  );
  check(
    "entryMismatch：類別本身讀不了 → 不算沒變",
    entryMismatch({ ...foo, source: "unreadable:EACCES" }, (rel) => (rel === FOO ? "unreadable:EACCES" : hashOf(rel)), [FOO_T]) ===
      "Foo.java 讀不了，無法確認它沒變",
  );
  const unit = "m/src/test/java/com/x/FooUnitTest.java";
  check(
    "entryMismatch：多了一個當時沒有的測試檔（reviewer 沒看過）",
    entryMismatch(foo, hashOf, [FOO_T, unit]) === `多了上次通過時沒有的測試檔 ${unit}`,
    String(entryMismatch(foo, hashOf, [FOO_T, unit])),
  );

  // Newest run first; an older pass counts when the tree is back to what it passed with.
  const runs = path.join(root, "runs");
  const older = path.join(runs, "2026-01-01T00-00-00-000Z");
  const newer = path.join(runs, "2026-02-01T00-00-00-000Z");
  const broken = path.join(runs, "2026-03-01T00-00-00-000Z");
  const future = path.join(runs, "2026-04-01T00-00-00-000Z");
  const current = path.join(runs, "2026-05-01T00-00-00-000Z");
  for (const d of [older, newer, broken, future, current]) fs.mkdirSync(d, { recursive: true });
  writeLedger(older, [foo]);
  const fooEdited = { ...foo, files: { ...foo.files, [FOO_T]: sha256("class FooTest { edited }") }, dir: "/runs/b/batch-1-Foo" };
  writeLedger(newer, [fooEdited, { ...bar, verdict: { scores: {}, blockers: "x" } } as unknown as PassedEntry]);
  fs.writeFileSync(path.join(broken, LEDGER_FILE), "{ not json");
  fs.writeFileSync(path.join(future, LEDGER_FILE), JSON.stringify({ version: 99, entries: [foo] }));
  writeLedger(current, [foo]);
  check("writeLedger：不留下 .tmp", !fs.existsSync(path.join(older, `${LEDGER_FILE}.tmp`)));
  const ledger = readLedgers(runs, current);
  check(
    "readLedgers：新的執行在前；讀不了的、別的版本寫的、欄位不對的、這次自己的都略過",
    JSON.stringify(ledger.map((e) => [path.basename(e.run), e.cls])) === JSON.stringify([[path.basename(newer), FOO], [path.basename(older), FOO]]),
    JSON.stringify(ledger.map((e) => [path.basename(e.run), e.cls])),
  );
  check("readLedgers：runs 目錄不存在 → 沒有紀錄", readLedgers(path.join(root, "no-runs")).length === 0);
  const found = findPass(FOO, ledger, hashOf, [FOO_T]);
  check(
    "findPass：只看最新的紀錄——它對不上就重做，不退回較舊、記得比較少檔案的那筆",
    !found.entry && found.mismatch === `${FOO_T} 在上次通過之後改過`,
    JSON.stringify(found),
  );
  check("findPass：最新的紀錄對得上 → 用它", findPass(FOO, readLedgers(runs, newer), hashOf, [FOO_T]).entry?.dir === "/runs/a/batch-1-Foo");
  put(FOO_T, "class FooTest { something else }");
  const none = findPass(FOO.replace(/\//g, "\\"), ledger, hashOf, [FOO_T]);
  check(
    "findPass：都對不上 → 沒有 entry，理由取最新那筆的；類別路徑用反斜線也認得",
    !none.entry && none.mismatch === `${FOO_T} 在上次通過之後改過`,
    JSON.stringify(none),
  );
  check("findPass：從沒通過過的類別 → 什麼都沒有（不算要重做）", JSON.stringify(findPass(BAR, ledger, hashOf, [BAR_T])) === "{}");
  check(
    "ledgerEntry：只留自己的欄位（讀的時候加上的 run 不帶進新的紀錄）",
    !("run" in ledgerEntry(ledger[0])) && ledgerEntry(ledger[0]).cls === FOO,
  );

  check("testClassOf：模組 src/test/java 底下的 .java → 類別名", testClassOf("m/src/test/java/com/x/FooTest.java", "m/src/test/java") === "com.x.FooTest");
  check("testClassOf：反斜線路徑、根目錄結尾的斜線都行", testClassOf("m\\src\\test\\java\\com\\x\\FooTest.java", "m\\src\\test\\java\\") === "com.x.FooTest");
  check(
    "testClassOf：資源檔、別的模組、只是前綴相同的目錄 → 不是測試類別",
    testClassOf(RES, "m/src/test/java") === undefined &&
      testClassOf("n/src/test/java/com/x/FooTest.java", "m/src/test/java") === undefined &&
      testClassOf("m/src/test/javax/FooTest.java", "m/src/test/java") === undefined,
  );
  check("testClassOf：模組就是 repo 根", testClassOf("src/test/java/FooTest.java", "src/test/java") === "FooTest");

  // What a test reaches in its tree is part of what it passed with.
  const T = "m/src/test";
  put(`${T}/java/com/x/QuxTest.java`, 'package com.x;\nclass QuxTest extends BaseTest { void t() { Fixtures.build(); load("/data/qux.json"); } }\n');
  put(`${T}/java/com/x/BaseTest.java`, "package com.x;\nabstract class BaseTest { Asserts a; }\n");
  put(`${T}/java/com/x/Asserts.java`, "package com.x;\nclass Asserts {}\n");
  put(`${T}/java/com/x/Fixtures.java`, "package com.x;\nclass Fixtures { static void build() {} }\n");
  put(`${T}/java/com/x/Unrelated.java`, "package com.x;\nclass Unrelated {}\n");
  put(`${T}/java/com/x/Mentioned.java`, "package com.x;\nclass Mentioned {}\n");
  put(`${T}/resources/data/qux.json`, "{}");
  put(`${T}/resources/data/other.json`, "{}");
  put(`${T}/java/com/x/CommentOnly.java`, "package com.x;\n// see Mentioned\nclass CommentOnly {}\n");
  const reached = referencedTestFiles([`${T}/java/com/x/QuxTest.java`], root, T);
  check(
    "referencedTestFiles：它繼承的、呼叫的（連同那些再引用的）與字串裡點名的資源；沒用到的不算",
    !reached.partial &&
      JSON.stringify(reached.files) ===
        JSON.stringify([`${T}/java/com/x/Asserts.java`, `${T}/java/com/x/BaseTest.java`, `${T}/java/com/x/Fixtures.java`, `${T}/resources/data/qux.json`].sort()),
    JSON.stringify(reached),
  );
  check(
    "referencedTestFiles：只在註解裡提到的名字不算",
    !referencedTestFiles([`${T}/java/com/x/CommentOnly.java`], root, T).files.includes(`${T}/java/com/x/Mentioned.java`),
  );
  put(
    `${T}/java/com/x/SqlTest.java`,
    'package com.x;\n@Sql("classpath:seed.sql")\nclass SqlTest { void t() { load("data\\\\win.json"); load("myqux.json"); } }\n',
  );
  put(`${T}/resources/seed.sql`, "");
  put(`${T}/resources/data/win.json`, "{}");
  const sql = referencedTestFiles([`${T}/java/com/x/SqlTest.java`], root, T).files;
  check(
    "referencedTestFiles：classpath: 開頭、Windows 反斜線路徑裡點名的資源也算；只是名字結尾相同（myqux.json）的不算",
    JSON.stringify(sql) === JSON.stringify([`${T}/resources/data/win.json`, `${T}/resources/seed.sql`]),
    JSON.stringify(sql),
  );
  // One string after another on a line: each is its own literal (the closing quote of one is not the
  // opening of a match that swallows the next one's).
  put(
    `${T}/java/com/x/ConcatTest.java`,
    'package com.x;\nclass ConcatTest { char q = \'"\'; void t() { load("fixtures/" + "order.json"); load("classpath:" + "seed.sql"); ' +
      'assertEquals("expected:", read("expected.txt")); } } // "comment.json"\n',
  );
  put(`${T}/resources/fixtures/order.json`, "{}");
  put(`${T}/resources/expected.txt`, "x");
  put(`${T}/resources/comment.json`, "{}");
  const concat = referencedTestFiles([`${T}/java/com/x/ConcatTest.java`], root, T).files;
  check(
    "referencedTestFiles：同一行的幾個字串各算各的（\"fixtures/\" + \"order.json\"、\"classpath:\" + \"seed.sql\"）；char 常值裡的引號、註解裡的名字不算",
    JSON.stringify(concat) ===
      JSON.stringify([`${T}/resources/expected.txt`, `${T}/resources/fixtures/order.json`, `${T}/resources/seed.sql`]),
    JSON.stringify(concat),
  );
  check(
    "stringLiterals：一般字串與 text block 的內容，照原文",
    JSON.stringify(stringLiterals('a("x/y.json"); String t = """\n  {"k": 1}\n  """; char c = \'"\'; b("")')) ===
      JSON.stringify(["x/y.json", '\n  {"k": 1}\n  ', ""]),
    JSON.stringify(stringLiterals('a("x/y.json"); String t = """\n  {"k": 1}\n  """; char c = \'"\'; b("")')),
  );
  const byName = new Map([["expected.json", ["m/src/test/resources/golden/a/expected.json", "m/src/test/resources/golden/b/expected.json"]]]);
  check(
    "resourcesNamed：有路徑就只算那個路徑的（不是每個 expected.json）；只有檔名、或路徑對不上時算同名的每一個",
    JSON.stringify(resourcesNamed("golden/b/expected.json", byName)) === '["m/src/test/resources/golden/b/expected.json"]' &&
      JSON.stringify(resourcesNamed("classpath:/golden/a/expected.json", byName)) === '["m/src/test/resources/golden/a/expected.json"]' &&
      resourcesNamed("expected.json", byName).length === 2 &&
      resourcesNamed("../elsewhere/expected.json", byName).length === 2 &&
      resourcesNamed("golden/", byName).length === 0,
  );
  // A helper naming many same-named fixtures must not use up what the helpers it calls need.
  const B = "b/src/test";
  put(
    `${B}/java/com/x/GoldenTest.java`,
    'package com.x;\nclass GoldenTest { void t() { Golden.check("expected.json"); } }\n',
  );
  put(`${B}/java/com/x/Golden.java`, "package com.x;\nclass Golden { static void check(String n) { JsonCompare.same(n); } }\n");
  put(`${B}/java/com/x/JsonCompare.java`, "package com.x;\nclass JsonCompare { static void same(String n) {} }\n");
  for (let i = 0; i < MAX_REFERENCED_RESOURCES + 20; i++) put(`${B}/resources/golden/case${i}/expected.json`, "{}");
  const golden = referencedTestFiles([`${B}/java/com/x/GoldenTest.java`], root, B);
  check(
    "referencedTestFiles：資源超過上限 → 標記 partial，但它呼叫的 helper（連同 helper 呼叫的）照樣記下",
    golden.partial &&
      golden.files.includes(`${B}/java/com/x/Golden.java`) &&
      golden.files.includes(`${B}/java/com/x/JsonCompare.java`) &&
      golden.files.filter((f) => f.endsWith("expected.json")).length === MAX_REFERENCED_RESOURCES,
    JSON.stringify({ partial: golden.partial, n: golden.files.length, helpers: golden.files.filter((f) => f.endsWith(".java")) }),
  );
  const C = "c/src/test";
  for (let i = 0; i <= MAX_REFERENCED_CLASSES + 5; i++) put(`${C}/java/com/x/Chain${i}.java`, `package com.x;\nclass Chain${i} { Chain${i + 1} next; }\n`);
  const chain = referencedTestFiles([`${C}/java/com/x/Chain0.java`], root, C);
  check(
    "referencedTestFiles：類別超過上限 → 標記 partial，記下最近的那些",
    chain.partial && chain.files.length === MAX_REFERENCED_CLASSES && chain.files.includes(`${C}/java/com/x/Chain1.java`),
    JSON.stringify({ partial: chain.partial, n: chain.files.length }),
  );
  const qux = passedEntries({
    classes: ["m/src/main/java/com/x/Qux.java"],
    repoRoot: root,
    testsOf: () => [`${T}/java/com/x/QuxTest.java`],
    written: [],
    testTree: T,
    rubric: "r",
    verdict: null,
    dir: "/d",
    at: "t",
  })[0];
  check(
    "passedEntries：通過紀錄也記下測試引用到的 helper 與資源——事後有人把 helper 掏空，重跑會看到",
    `${T}/java/com/x/Asserts.java` in qux.files && `${T}/resources/data/qux.json` in qux.files && !(`${T}/java/com/x/Unrelated.java` in qux.files),
    JSON.stringify(Object.keys(qux.files)),
  );
  check(
    "passedEntries：只因為被引用才記下的檔列在 refs（比對內容，但不是它的測試：不要求執行）；它自己的測試不在其中",
    JSON.stringify(qux.refs) ===
      JSON.stringify([`${T}/java/com/x/Asserts.java`, `${T}/java/com/x/BaseTest.java`, `${T}/java/com/x/Fixtures.java`, `${T}/resources/data/qux.json`]) &&
      !qux.partial &&
      JSON.stringify(ledgerEntry(qux).refs) === JSON.stringify(qux.refs),
    JSON.stringify({ refs: qux.refs, partial: qux.partial }),
  );
  const goldenEntry = passedEntries({
    classes: ["b/src/main/java/com/x/Golden.java"],
    repoRoot: root,
    testsOf: () => [`${B}/java/com/x/GoldenTest.java`],
    written: [],
    testTree: B,
    rubric: "r",
    verdict: null,
    dir: "/d",
    at: "t",
  })[0];
  check(
    "passedEntries / entryMismatch：引用到的檔超過上限 → 紀錄標記 partial，重跑不接續它（說明原因）",
    goldenEntry.partial === true &&
      ledgerEntry(goldenEntry).partial === true &&
      /超過記錄的上限/.test(entryMismatch(goldenEntry, (rel) => hashFile(path.join(root, rel)), []) ?? ""),
    entryMismatch(goldenEntry, (rel) => hashFile(path.join(root, rel)), []) ?? "(matched)",
  );

  // Names resolved as javac resolves them: a helper every package has is the one of the test's own
  // package, or the one it imports — not every one of that name.
  const P = "p/src/test";
  for (const pkg of ["com/x", "com/y", "com/z"]) {
    const name = pkg.replace(/\//g, ".");
    put(`${P}/java/${pkg}/Support.java`, `package ${name};\nclass Support { static int one() { return 1; } }\n`);
  }
  put(`${P}/java/com/x/SameTest.java`, "package com.x;\nclass SameTest { void t() { Support.one(); } }\n");
  put(`${P}/java/com/x/ImportTest.java`, "package com.x;\nimport com.y.Support;\nclass ImportTest { void t() { Support.one(); } }\n");
  put(`${P}/java/com/w/DemandTest.java`, "package com.w;\nimport com.z.*;\nclass DemandTest { void t() { Support.one(); } }\n");
  put(`${P}/java/com/w/QualifiedTest.java`, "package com.w;\nclass QualifiedTest { void t() { com.y.Support.one(); } }\n");
  put(`${P}/java/com/w/StaticTest.java`, "package com.w;\nimport static com.z.Support.one;\nclass StaticTest { void t() { one(); } }\n");
  put(`${P}/java/com/v/NowhereTest.java`, "package com.v;\nclass NowhereTest { void t() { Support.one(); } }\n");
  put(`${P}/java/com/y/Outer.java`, "package com.y;\nclass Outer { static class Inner {} }\n");
  put(`${P}/java/com/w/NestedTest.java`, "package com.w;\nimport com.y.Outer.Inner;\nclass NestedTest { Inner i; }\n");
  put(`${P}/java/com/x/ForeignStaticTest.java`, "package com.x;\nimport static org.acme.Support.one;\nclass ForeignStaticTest { void t() { one(); } }\n");
  const refsOf = (cls: string) => referencedTestFiles([`${P}/java/${cls}.java`], root, P).files.map((f) => f.slice(`${P}/java/`.length));
  check(
    "referencedTestFiles：同名的 helper 以 javac 的解析取——同 package、import、on-demand import（連同自己 package 的同名檔：之後加了它就是 javac 選的）、完整類名、static import、巢狀類別的 import；import 的是樹外的同名類別就不是樹裡的；哪裡都看不到的名字不是樹裡的類別",
    JSON.stringify(refsOf("com/x/SameTest")) === '["com/x/Support.java"]' &&
      JSON.stringify(refsOf("com/x/ImportTest")) === '["com/y/Support.java"]' &&
      JSON.stringify(refsOf("com/w/DemandTest")) === '["com/w/Support.java","com/z/Support.java"]' &&
      JSON.stringify(refsOf("com/w/QualifiedTest")) === '["com/y/Support.java"]' &&
      JSON.stringify(refsOf("com/w/StaticTest")) === '["com/z/Support.java"]' &&
      JSON.stringify(refsOf("com/v/NowhereTest")) === "[]" &&
      JSON.stringify(refsOf("com/w/NestedTest")) === '["com/y/Outer.java"]' &&
      JSON.stringify(refsOf("com/x/ForeignStaticTest")) === "[]",
    JSON.stringify(
      ["com/x/SameTest", "com/x/ImportTest", "com/w/DemandTest", "com/w/QualifiedTest", "com/w/StaticTest", "com/v/NowhereTest", "com/w/NestedTest", "com/x/ForeignStaticTest"].map((c) => [c, refsOf(c)]),
    ),
  );
  // Decoded before it is lexed: an MS950 "\" second byte does not end a literal early, and names
  // outside ASCII are the names on disk.
  const E = "e/src/test";
  const big5 = (text: string) =>
    Buffer.concat(
      text.split(/(處理成功)/).map((part) => (part === "處理成功" ? Buffer.from([0xb3, 0x42, 0xb2, 0x7a, 0xa6, 0xa8, 0xa5, 0x5c]) : Buffer.from(part))),
    );
  fs.mkdirSync(path.join(root, `${E}/java/com/x`), { recursive: true });
  fs.writeFileSync(
    path.join(root, `${E}/java/com/x/Ms950Test.java`),
    big5('package com.x;\nclass Ms950Test { void t() { assertEquals("處理成功", Fixtures.load("expected.json")); } }\n'),
  );
  put(`${E}/java/com/x/Fixtures.java`, "package com.x;\nclass Fixtures { static String load(String n) { return n; } }\n");
  put(`${E}/resources/expected.json`, "{}");
  put(`${E}/java/com/x/CjkTest.java`, 'package com.x;\nclass CjkTest { String a = "fixtures/訂單.json"; String b = "caf\u00e9.json"; }\n');
  put(`${E}/resources/fixtures/訂單.json`, "{}");
  put(`${E}/resources/cafe\u0301.json`, "{}");
  const ms950Refs = referencedTestFiles([`${E}/java/com/x/Ms950Test.java`], root, E, "MS950").files;
  check(
    "referencedTestFiles：以模組的編碼（MS950）解碼後才 lex——「處理成功」第二個 byte 是 \\，同一行後面的 helper 與資源照樣記下",
    JSON.stringify(ms950Refs) === JSON.stringify([`${E}/java/com/x/Fixtures.java`, `${E}/resources/expected.json`]),
    JSON.stringify(ms950Refs),
  );
  put(`${E}/java/com/x/EscapedTest.java`, 'package com.x;\nclass EscapedTest { String a = "golden\\u002Fescaped.json"; String b = """\n    golden/block.json\n    golden/second.json\n    """; }\n');
  put(`${E}/resources/golden/escaped.json`, "{}");
  put(`${E}/resources/golden/block.json`, "{}");
  put(`${E}/resources/golden/second.json`, "{}");
  const escapedRefs = referencedTestFiles([`${E}/java/com/x/EscapedTest.java`], root, E).files;
  check(
    "referencedTestFiles：字串照 javac 的讀法（\\u002F 是 /）、text block 一行一行看",
    JSON.stringify(escapedRefs) === JSON.stringify([`${E}/resources/golden/block.json`, `${E}/resources/golden/escaped.json`, `${E}/resources/golden/second.json`]),
    JSON.stringify(escapedRefs),
  );
  const cjkRefs = referencedTestFiles([`${E}/java/com/x/CjkTest.java`], root, E).files;
  check(
    "referencedTestFiles：非 ASCII 的資源名（fixtures/訂單.json；檔名是分解形式的 café.json）照樣對得上",
    JSON.stringify(cjkRefs) === JSON.stringify([`${E}/resources/cafe\u0301.json`, `${E}/resources/fixtures/訂單.json`]),
    JSON.stringify(cjkRefs),
  );
  // Named after the test, never in a string: Spring's CalcTest.sql and CalcTest-context.xml, an
  // approval file beside the test.
  const N = "n/src/test";
  put(`${N}/java/com/x/CalcTest.java`, "package com.x;\nclass CalcTest { void t() {} }\n");
  put(`${N}/java/com/x/CalcTest.add.approved.txt`, "3");
  put(`${N}/java/com/x/snapshot.json`, "{}");
  put(`${N}/java/com/x/UsesSnapshotTest.java`, 'package com.x;\nclass UsesSnapshotTest { String s = "com/x/snapshot.json"; }\n');
  put(`${N}/resources/com/x/CalcTest.sql`, "");
  put(`${N}/resources/com/x/CalcTest-context.xml`, "");
  put(`${N}/resources/CalcTest_expected.json`, "{}");
  put(`${N}/resources/CalcTestHelper.json`, "{}");
  put(`${N}/resources/Other.sql`, "");
  const named = referencedTestFiles([`${N}/java/com/x/CalcTest.java`], root, N).files;
  check(
    "referencedTestFiles：以測試命名的檔（CalcTest.sql、CalcTest-context.xml、CalcTest_expected.json、src/test/java 裡的 CalcTest.add.approved.txt）也算；只是開頭相同的名字不算",
    JSON.stringify(named) ===
      JSON.stringify(
        [`${N}/java/com/x/CalcTest.add.approved.txt`, `${N}/resources/CalcTest_expected.json`, `${N}/resources/com/x/CalcTest-context.xml`, `${N}/resources/com/x/CalcTest.sql`].sort(),
      ),
    JSON.stringify(named),
  );
  check(
    "referencedTestFiles：src/test/java 裡的非 .java 檔以字串點名也算",
    JSON.stringify(referencedTestFiles([`${N}/java/com/x/UsesSnapshotTest.java`], root, N).files) === JSON.stringify([`${N}/java/com/x/snapshot.json`]),
  );

  // What a ledger names is read from inside the repo only; and what is not a regular file is never opened.
  check(
    "safeLedgerPath：相對、在 repo 裡；.. 、絕對路徑、磁碟代號都不行",
    safeLedgerPath("m/src/test/java/A.java") &&
      !safeLedgerPath("../outside.java") &&
      !safeLedgerPath("m/../../outside.java") &&
      !safeLedgerPath("m\\..\\..\\x") &&
      !safeLedgerPath("/etc/passwd") &&
      !safeLedgerPath("C:/x") &&
      !safeLedgerPath(""),
  );
  check(
    "entryMismatch：紀錄裡的路徑跑出 repo → 不讀它、不接續",
    /不在 repo 裡/.test(entryMismatch({ ...foo, files: { "../../etc/hosts": "x" } }, () => "x", []) ?? ""),
  );
  check(
    "entryMismatch：作廢的紀錄（後來發現它的測試不穩定）→ 說出原因，不接續",
    entryMismatch({ ...foo, invalid: "它的測試 com.x.FooTest 不穩定" }, hashOf, [FOO_T]) === "它的測試 com.x.FooTest 不穩定" &&
      ledgerEntry({ ...foo, invalid: "x" }).invalid === "x",
  );
  const fifo = path.join(root, "pipe.json");
  const mk = spawnSync("mkfifo", [fifo]);
  if (mk.status === 0) {
    const t0 = Date.now();
    const h = hashFile(fifo);
    check("hashFile：FIFO 不打開（會一直等寫入端）→ 讀不了", h === "unreadable:not-a-file" && Date.now() - t0 < 2000, String(h));
    fs.rmSync(fifo);
  }
  const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  fs.writeFileSync(path.join(root, "big.bin"), big);
  check("hashFile：分段讀（大檔一樣）", hashFile(path.join(root, "big.bin")) === sha256(big));
  // A write that cannot finish (a full disk; here a file-size limit): the ledger in place stays whole —
  // one write(2) can take fewer bytes than it was given, and a cut ledger lets older records count again.
  if (process.platform !== "win32" && spawnSync("sh", ["-c", "command -v bash"]).status === 0) {
    const full = path.join(root, "full-disk");
    fs.mkdirSync(full, { recursive: true });
    const loaderUrl = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
    const resumeUrl = new URL("../libs/resume.ts", import.meta.url).href;
    const code =
      `process.on("SIGXFSZ", () => {}); const { writeLedger } = await import(${JSON.stringify(resumeUrl)});` +
      `try { writeLedger(${JSON.stringify(full)}, Array.from({ length: 200 }, (_, i) => ({ cls: "m/src/main/java/C" + i + ".java", source: "x".repeat(64), files: {}, rubric: "r", verdict: null, dir: "/d", at: "t" }))); console.log("written"); }` +
      ` catch (e) { console.log("threw " + e.code); }`;
    const child = spawnSync(
      "bash",
      ["-c", `ulimit -f 16; exec ${JSON.stringify(process.execPath)} --import ${loaderUrl} --input-type=module -e ${JSON.stringify(code)}`],
      { encoding: "utf8" },
    );
    const ledgerPath = path.join(full, LEDGER_FILE);
    let whole = !fs.existsSync(ledgerPath);
    try {
      if (!whole) whole = JSON.parse(fs.readFileSync(ledgerPath, "utf8")).entries.length === 200;
    } catch {
      whole = false;
    }
    check(
      "writeLedger：寫不完（磁碟滿；這裡以 ulimit -f）→ 丟出錯誤、不換上半份的 passed.json",
      whole && /threw/.test(child.stdout),
      `${child.stdout} ${child.stderr.slice(-300)} exists=${fs.existsSync(ledgerPath)}`,
    );
  }
  check(
    "springLoaded：Spring 會自己載入的（@Component、@TestConfiguration、@Configuration、完整類名的註解）；@ConfigurationProperties 與一般類別不算",
    springLoaded("@Component class A {}") &&
      springLoaded("@TestConfiguration\nclass Cfg {}") &&
      springLoaded("@org.springframework.context.annotation.Configuration class C {}") &&
      !springLoaded("@ConfigurationProperties class P {}") &&
      !springLoaded("class Plain { @Test void t() {} }"),
  );
  check(
    "springLoaded：只看 top-level 類別的註解（測試類別裡巢狀的 @TestConfiguration 是它自己的）；JSR-330 的 @Named、@ManagedBean 與 JPA 的 @Entity 也算",
    springLoaded("@javax.inject.Named class A {}") &&
      springLoaded("@ManagedBean class B {}") &&
      springLoaded("@Entity\nclass Order {}") &&
      !springLoaded("class CalcTest {\n  @TestConfiguration static class Cfg {}\n  @Test void t() {}\n}") &&
      springLoaded("@ExtendWith({X.class})\n@Configuration\nclass Wired {}\nclass Other {}"),
  );
  check(
    "declaredTypes：package 與每一個 top-level 型別，連同寫在它前面的註解（註解參數裡的 } 不是起點）；巢狀的不算",
    JSON.stringify(declaredTypes(codeOnly('package com.x;\nimport a.B;\n@A({1, 2})\n@B\npublic class First { class Inner {} record R(int a) {} }\ninterface Second {}\n@interface Third {}\nrecord Fourth(int a) {}\nenum Fifth { X }\n'))) ===
      JSON.stringify({
        pkg: "com.x",
        types: [
          { name: "First", annotations: "\n@A({1, 2})\n@B\npublic " },
          { name: "Second", annotations: "\n" },
          { name: "Third", annotations: "\n@" },
          { name: "Fourth", annotations: "\n" },
          { name: "Fifth", annotations: "\n" },
        ],
      }),
    JSON.stringify(declaredTypes(codeOnly('package com.x;\nimport a.B;\n@A({1, 2})\n@B\npublic class First { class Inner {} record R(int a) {} }\ninterface Second {}\n@interface Third {}\nrecord Fourth(int a) {}\nenum Fifth { X }\n'))),
  );

  // Round 5: names resolved by what the files declare, and what else a test runs with.
  const W = "w/src/test";
  const walkOf = (tree: string, files: Record<string, string | Buffer>, charset?: string) => {
    for (const [rel, content] of Object.entries(files)) put(`${tree}/${rel}`, content as string);
    return referencedTestFiles([`${tree}/java/com/x/CalcTest.java`], root, tree, charset).files.map((f) => f.slice(tree.length + 1));
  };
  const calcUsing = (body: string, head = "") => `package com.x;\n${head}class CalcTest {\n  @org.junit.jupiter.api.Test void t() { ${body} }\n}\n`;
  check(
    "referencedTestFiles：一個檔裡的第二個 top-level 類別（Orders 在 TestData.java）照樣找到那個檔；static import 它的成員也是",
    JSON.stringify(walkOf(`${W}1`, { "java/com/x/CalcTest.java": calcUsing("Orders.total();"), "java/com/x/TestData.java": "package com.x;\nclass TestData {}\nclass Orders { static int total() { return 3; } }\n" })) ===
      '["java/com/x/TestData.java"]' &&
      JSON.stringify(walkOf(`${W}2`, { "java/com/x/CalcTest.java": calcUsing("total();", "import static com.x.Orders.total;\n"), "java/com/x/TestData.java": "package com.x;\nclass TestData {}\nclass Orders { static int total() { return 3; } }\n" })) ===
        '["java/com/x/TestData.java"]',
  );
  check(
    "referencedTestFiles：import 的類別放在和 package 不符的目錄（com/x/Support.java 宣告 com.x.support）→ 以檔案宣告的 package 找到它",
    JSON.stringify(walkOf(`${W}3`, { "java/com/x/CalcTest.java": calcUsing("Support.one();", "import com.x.support.Support;\n"), "java/com/x/Support.java": "package com.x.support;\npublic class Support { public static int one() { return 1; } }\n" })) ===
      '["java/com/x/Support.java"]',
  );
  check(
    "referencedTestFiles：以 $ 接在測試名後的資源（@Nested 類別的 CalcTest$Add.sql）也算以測試命名",
    JSON.stringify(walkOf(`${W}4`, { "java/com/x/CalcTest.java": calcUsing(""), "resources/com/x/CalcTest$Add.sql": "insert into t values (1);\n" })) === '["resources/com/x/CalcTest$Add.sql"]',
  );
  check(
    "referencedTestFiles：非 ASCII 的類別名（測試資料）照樣解析",
    JSON.stringify(walkOf(`${W}5`, { "java/com/x/CalcTest.java": calcUsing("測試資料.one();"), "java/com/x/測試資料.java": "package com.x;\nclass 測試資料 { static int one() { return 1; } }\n" })) === '["java/com/x/測試資料.java"]',
  );
  check(
    "referencedTestFiles：字串裡的完整類名（@MethodSource(\"com.x.Fixtures#cases\")、Class.forName 的 com.x.Outer$Inner）也算",
    JSON.stringify(
      walkOf(`${W}6`, {
        "java/com/x/CalcTest.java": 'package com.x;\nclass CalcTest {\n  @ParameterizedTest @MethodSource("com.x.Fixtures#cases") void t(int a) {}\n  Object o = Class.forName("com.x.Outer$Inner");\n}\n',
        "java/com/x/Fixtures.java": "package com.x;\nclass Fixtures { static int[] cases() { return new int[] {1}; } }\n",
        "java/com/x/Outer.java": "package com.x;\nclass Outer { static class Inner {} }\n",
      }),
    ) === '["java/com/x/Fixtures.java","java/com/x/Outer.java"]',
  );
  check(
    "referencedTestFiles：記下的資源（CalcTest-context.xml）裡以完整類名宣告的 stub bean 也跟著記",
    JSON.stringify(
      walkOf(`${W}7`, {
        "java/com/x/CalcTest.java": calcUsing(""),
        "resources/com/x/CalcTest-context.xml": '<beans><bean id="repo" class="com.x.StubRepo"/></beans>\n',
        "java/com/x/StubRepo.java": "package com.x;\nclass StubRepo {}\n",
      }),
    ) === '["java/com/x/StubRepo.java","resources/com/x/CalcTest-context.xml"]',
  );
  const sniffedTest = Buffer.concat([
    Buffer.from('package com.x;\nclass CalcTest {\n  @org.junit.jupiter.api.Test void t() {\n    assertEquals("'),
    Buffer.from([0xb3, 0x42, 0xb2, 0x7a, 0xa6, 0xa8, 0xa5, 0x5c]), // 處理成功
    Buffer.from('", Messages.success());\n    String f = "fixtures/'),
    Buffer.from([0xad, 0x71, 0xb3, 0xe6]), // 訂單
    Buffer.from('.json";\n  }\n}\n'),
  ]);
  put(`${W}8/java/com/x/CalcTest.java`, sniffedTest as unknown as string);
  check(
    "referencedTestFiles：模組編碼名稱不明（sniffed）的 MS950 測試——「成功」的 \\ 不會吃掉後面的程式碼，中文的 fixture 名也對得上",
    JSON.stringify(
      walkOf(`${W}8`, { "java/com/x/Messages.java": "package com.x;\nclass Messages { static String success() { return null; } }\n", "resources/fixtures/訂單.json": "{}\n" }, "非 UTF-8（名稱不明）"),
    ) === '["java/com/x/Messages.java","resources/fixtures/訂單.json"]',
  );
  check(
    "referencedTestFiles：看不到的名字（java.lang 的 Math）不是別的 package 的同名類別",
    JSON.stringify(walkOf(`${W}9`, { "java/com/x/CalcTest.java": calcUsing("Math.max(1, 2);"), "java/com/y/Math.java": "package com.y;\npublic class Math {}\n" })) === "[]",
  );
  if (process.platform !== "win32") {
    const shared = path.join(root, "shared-fixtures");
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, "order.json"), "{}\n");
    fs.mkdirSync(path.join(root, `${W}10/resources`), { recursive: true });
    fs.symlinkSync(shared, path.join(root, `${W}10/resources/fixtures`));
    fs.symlinkSync(path.join(root, `${W}10/resources`), path.join(shared, "loop")); // a cycle: read once
    check(
      "referencedTestFiles：resources 裡的 symlink 目錄照樣走進去（繞回來的只走一次）",
      JSON.stringify(walkOf(`${W}10`, { "java/com/x/CalcTest.java": calcUsing('String f = "fixtures/order.json";') })) === '["resources/fixtures/order.json"]',
    );
  }
  const globals = {
    "resources/junit-platform.properties": "junit.jupiter.extensions.autodetection.enabled=true\n",
    "resources/META-INF/services/org.junit.jupiter.api.extension.Extension": "com.x.GlobalExtension\n",
    "java/com/x/GlobalExtension.java": "package com.x;\npublic class GlobalExtension implements org.junit.jupiter.api.extension.Extension {}\n",
    "resources/application.yml": "feature: on\n",
    "resources/config/application-test.properties": "a=b\n",
    "resources/schema.sql": "create table t (id int);\n",
    "resources/other.yml": "x: 1\n",
    "java/com/x/TestConfig.java": "package com.x;\n@org.springframework.context.annotation.Configuration\nclass TestConfig {}\n",
    "java/com/x/OtherTest.java": "package com.x;\nclass OtherTest {\n  @TestConfiguration static class Cfg {}\n  @Test void t() {}\n}\n",
  };
  const plain = walkOf(`${W}11`, { ...globals, "java/com/x/CalcTest.java": calcUsing("") });
  const spring = walkOf(`${W}12`, { ...globals, "java/com/x/CalcTest.java": `package com.x;\n@SpringBootTest\nclass CalcTest {\n  @Test void t() {}\n}\n` });
  check(
    "referencedTestFiles：每個測試都記下 JUnit／Mockito／logging 自己讀的設定（junit-platform.properties、META-INF/services 與它點名的類別）；不起 Spring 的測試不記 Spring 的",
    JSON.stringify(plain) === '["java/com/x/GlobalExtension.java","resources/META-INF/services/org.junit.jupiter.api.extension.Extension","resources/junit-platform.properties"]',
    JSON.stringify(plain),
  );
  check(
    "referencedTestFiles：起 Spring context 的測試另外記下 Spring Boot 自己載入的（application*.yml／config/ 下的、schema.sql、top-level 的 @Configuration）；測試類別裡巢狀的設定與無關的 yml 不記",
    JSON.stringify(spring) ===
      JSON.stringify(
        [
          "java/com/x/GlobalExtension.java",
          "java/com/x/TestConfig.java",
          "resources/META-INF/services/org.junit.jupiter.api.extension.Extension",
          "resources/application.yml",
          "resources/config/application-test.properties",
          "resources/junit-platform.properties",
          "resources/schema.sql",
        ].sort(),
      ),
    JSON.stringify(spring),
  );

  // Only the newest record of a class counts: once each wanted class has one, older ledgers are not read.
  const L = path.join(root, "ledgers");
  const [l1, l2, l3] = ["2026-01-01T00-00-00-000Z", "2026-02-01T00-00-00-000Z", "2026-03-01T00-00-00-000Z"].map((d) => path.join(L, d));
  for (const d of [l1, l2, l3]) fs.mkdirSync(d, { recursive: true });
  writeLedger(l1, [{ ...foo, dir: "l1" }, { ...bar, dir: "l1" }]);
  writeLedger(l2, [{ ...bar, dir: "l2" }]);
  writeLedger(l3, [{ ...foo, dir: "l3" }]);
  // The oldest one cannot be read at all — opening a FIFO waits for a writer: it must not be opened.
  const l0 = path.join(L, "2025-12-01T00-00-00-000Z");
  fs.mkdirSync(l0, { recursive: true });
  const blocking = spawnSync("mkfifo", [path.join(l0, LEDGER_FILE)]).status === 0;
  const wantFoo = readLedgers(L, undefined, [FOO]);
  const wantBoth = readLedgers(L, undefined, [FOO, BAR]);
  check(
    `readLedgers(wanted)：只留要的類別、每個只到它最新的那筆為止；都找到了就不再讀更舊的${blocking ? "（更舊的一份打開就會卡住，沒有被打開）" : ""}`,
    JSON.stringify(wantFoo.map((e) => [e.cls, e.dir])) === JSON.stringify([[FOO, "l3"]]) &&
      JSON.stringify(wantBoth.map((e) => [e.cls, e.dir])) === JSON.stringify([[FOO, "l3"], [BAR, "l2"]]),
    JSON.stringify([wantFoo.map((e) => [e.cls, e.dir]), wantBoth.map((e) => [e.cls, e.dir])]),
  );
  check(
    "findPass：最新的紀錄作廢了 → 不退回較舊、仍然相符的那筆",
    (() => {
      writeLedger(l3, [{ ...foo, dir: "l3", invalid: "它的測試不穩定" }]);
      const r = findPass(FOO, readLedgers(L, undefined, [FOO]), hashOf, [FOO_T]);
      return !r.entry && r.mismatch === "它的測試不穩定";
    })(),
  );

  // A ledger that names a class and cannot be read is that class's newest record all the same: void.
  const unreadableNewest = (content: string) => {
    fs.writeFileSync(path.join(l3, LEDGER_FILE), content);
    const r = findPass(FOO, readLedgers(L, undefined, [FOO]), hashOf, [FOO_T]);
    return r.entry ? "(entry)" : (r.mismatch ?? "(none)");
  };
  const good = JSON.stringify({ version: 1, entries: [{ ...foo, dir: "l3" }] }, null, 2);
  const cut = unreadableNewest(good.slice(0, good.length - 40));
  const otherVersion = unreadableNewest(JSON.stringify({ version: 2, entries: [{ ...foo, dir: "l3" }] }));
  const malformed = unreadableNewest(JSON.stringify({ version: 1, entries: [{ cls: FOO, files: "nope" }] }));
  check(
    "readLedgers / findPass：最新一份點名了它、卻讀不了（寫到一半、別的版本、那筆格式不對）→ 當成它最新的紀錄、作廢，不回頭用較舊的",
    /讀不了/.test(cut) && /另一個版本/.test(otherVersion) && /格式不對/.test(malformed),
    JSON.stringify([cut, otherVersion, malformed]),
  );
  const voided = voidEntry({ ...foo, dir: "l3" }, "它的測試 com.x.FooTest 不穩定");
  check(
    "voidEntry：留著類別、寫下原因；source 換成讀不了的值（不認得 invalid 的舊版本也不接續）",
    voided.cls === FOO &&
      voided.invalid === "它的測試 com.x.FooTest 不穩定" &&
      voided.source.startsWith("unreadable:") &&
      entryMismatch(voided, hashOf, [FOO_T]) === "它的測試 com.x.FooTest 不穩定" &&
      /讀不了/.test(entryMismatch({ ...voided, invalid: undefined }, hashOf, [FOO_T]) ?? ""),
  );

  // TimeUnitTest.java is TimeUnit's test when there is a TimeUnit, not Time's.
  put("m/src/main/java/com/x/Time.java", "class Time {}");
  put("m/src/test/java/com/x/TimeTest.java", "class TimeTest {}");
  put("m/src/test/java/com/x/TimeUnitTest.java", "class TimeUnitTest {}");
  check(
    "findExistingTests：沒有 TimeUnit 這個類別時，TimeUnitTest.java 照舊算 Time 的",
    JSON.stringify(findExistingTests("m/src/main/java/com/x/Time.java", root)) ===
      JSON.stringify(["m/src/test/java/com/x/TimeTest.java", "m/src/test/java/com/x/TimeUnitTest.java"]),
    JSON.stringify(findExistingTests("m/src/main/java/com/x/Time.java", root)),
  );
  put("m/src/main/java/com/x/TimeUnit.java", "class TimeUnit {}");
  check(
    "findExistingTests：同一個套件有 TimeUnit 時，TimeUnitTest.java 是它的、不是 Time 的",
    JSON.stringify(findExistingTests("m/src/main/java/com/x/Time.java", root)) === '["m/src/test/java/com/x/TimeTest.java"]' &&
      JSON.stringify(findExistingTests("m/src/main/java/com/x/TimeUnit.java", root)) === '["m/src/test/java/com/x/TimeUnitTest.java"]',
    JSON.stringify([findExistingTests("m/src/main/java/com/x/Time.java", root), findExistingTests("m/src/main/java/com/x/TimeUnit.java", root)]),
  );
  fs.rmSync(root, { recursive: true, force: true });

  check("gradleTestTaskRan：> Task :test（沒有結果標記）→ 這次有執行", gradleTestTaskRan("> Task :compileTestJava\n> Task :test\n> Task :jacocoTestReport\n") === true);
  check("gradleTestTaskRan：多模組的 :core:test 也認得", gradleTestTaskRan("> Task :core:test\n") === true);
  check(
    "gradleTestTaskRan：UP-TO-DATE／SKIPPED／NO-SOURCE／FROM-CACHE → 這次沒有執行（結果是之前的）",
    ["UP-TO-DATE", "SKIPPED", "NO-SOURCE", "FROM-CACHE"].every((o) => gradleTestTaskRan(`> Task :test ${o}\n`) === false),
  );
  check("gradleTestTaskRan：log 沒有列出 test task（quiet）→ 看不出來（undefined）", gradleTestTaskRan("BUILD SUCCESSFUL in 3s\n") === undefined);
  check("gradleTestTaskRan：:testClasses、:integrationTest 不是 :test", gradleTestTaskRan("> Task :testClasses\n> Task :integrationTest\n") === undefined);
  const testng = parseSurefireXml(
    '<?xml version="1.0"?><testsuite name="TestSuite" tests="2" failures="1" errors="0">' +
      '<testcase name="add" classname="com.x.CalcTest"><failure message="boom"/></testcase>' +
      '<testcase name="ok" classname="com.x.OtherTest"/></testsuite>',
  );
  check(
    "parseSurefireXml：TestNG 的 TEST-TestSuite.xml（JUnit 4 的 Suite 也是）——失敗的案例記下它自己的類別（@classname），不只有 suite 名",
    testng?.suite === "TestSuite" && testng.cases.length === 1 && testng.cases[0].className === "com.x.CalcTest",
    JSON.stringify(testng),
  );
  check(
    "gradleTestTaskRan：看的是目標自己的 test task（最淺的那個）——子專案或 buildSrc 的 test 有跑，目標的 UP-TO-DATE／SKIPPED 照樣不算",
    gradleTestTaskRan("> Task :buildSrc:test\n> Task :app:test SKIPPED\n> Task :app:sub:test\n") === false &&
      gradleTestTaskRan("> Task :buildSrc:test\n> Task :test UP-TO-DATE\n") === false &&
      gradleTestTaskRan("> Task :app:test\n> Task :app:sub:test UP-TO-DATE\n") === true &&
      gradleTestTaskRan("> Task :buildSrc:test\n") === undefined,
  );
}

console.log("\n[29] 被強制終止的 run（libs/batch.ts：批次的復原日誌）");
{
  const here = { host: "box", boot: 29_000_000 };
  const probeOf = (running: Record<number, string | undefined>, alive: number[] = []) => ({
    alive: (pid: number) => pid in running || alive.includes(pid),
    start: (pid: number) => running[pid],
  });
  const now = 1_000_000_000_000;
  const fresh = now - 60_000;
  const old = now - 10 * 60_000;
  const stale = 5 * 60_000;
  const owner = { boot: 29_000_000, pid: 4242, start: "563817" };
  check("mayBeRunning：同一次開機、那個 pid 還是同一個程序（啟動時間相同）→ 還在跑", mayBeRunning(owner, old, here, probeOf({ 4242: "563817" }), now, stale));
  check(
    "mayBeRunning：pid 還在、心跳也新鮮，但啟動時間不同（pid 被重用）→ 已經死了",
    !mayBeRunning(owner, fresh, here, probeOf({ 4242: "999" }), now, stale),
  );
  check("mayBeRunning：pid 已經不在 → 已經死了", !mayBeRunning(owner, fresh, here, probeOf({}), now, stale));
  check(
    "mayBeRunning：pid 就是自己的（容器裡 pid 從頭編號）→ 那次執行不可能是自己，已經死了",
    !mayBeRunning({ ...owner, pid: process.pid }, fresh, here, probeOf({ [process.pid]: "563817" }), now, stale),
  );
  check("mayBeRunning：重開機過（開機時間差兩分鐘以上）→ 已經死了", !mayBeRunning({ ...owner, boot: 28_000_000 }, fresh, here, probeOf({ 4242: "563817" }), now, stale));
  check("mayBeRunning：沒記開機時間 → 已經死了", !mayBeRunning({ pid: 4242, start: "563817" }, fresh, here, probeOf({ 4242: "563817" }), now, stale));
  check(
    "mayBeRunning：讀不到啟動時間（Windows）→ pid 還在而且心跳新鮮才算還在跑",
    mayBeRunning({ ...owner, start: "" }, fresh, here, probeOf({}, [4242]), now, stale) &&
      !mayBeRunning({ ...owner, start: "" }, old, here, probeOf({}, [4242]), now, stale) &&
      !mayBeRunning({ ...owner, start: "" }, fresh, here, probeOf({}), now, stale),
  );
  // A container sharing the machine's name and boot (host networking) numbers its processes apart.
  const inBox = { ...here, pidns: "pid:[4026531836]" };
  check(
    "mayBeRunning：別的 pid namespace 寫的（共用主機名稱的另一個容器）→ 不問 pid，只看心跳",
    mayBeRunning({ ...owner, pidns: "pid:[4026532999]" }, fresh, inBox, probeOf({}), now, stale) &&
      !mayBeRunning({ ...owner, pidns: "pid:[4026532999]" }, old, inBox, probeOf({ 4242: "563817" }), now, stale) &&
      !mayBeRunning(owner, old, inBox, probeOf({ 4242: "563817" }), now, stale),
  );
  check("mayBeRunning：同一個 pid namespace → 照樣問 pid", mayBeRunning({ ...owner, pidns: inBox.pidns }, old, inBox, probeOf({ 4242: "563817" }), now, stale));
  // A clock stepped between two runs (NTP, a resume from suspend) moves the estimated boot time; the
  // boot's own id does not move.
  const booted = { ...here, bootId: "b-1" };
  check(
    "sameBoot / samePids / mayBeRunning：兩邊都有 boot_id 就只看它——時鐘被校正、估算的開機時間差了 10 分鐘，照樣是同一次開機；boot_id 不同就算估算相同也不是",
    sameBoot({ boot: here.boot + 10, bootId: "b-1" }, booted) &&
      !sameBoot({ boot: here.boot, bootId: "b-2" }, booted) &&
      sameBoot({ boot: here.boot + 1 }, booted) &&
      !sameBoot({ boot: here.boot + 10 }, booted) &&
      samePids({ host: "box", boot: here.boot + 10, bootId: "b-1" }, booted) &&
      mayBeRunning({ ...owner, boot: owner.boot + 10, bootId: "b-1" }, old, booted, probeOf({ 4242: "563817" }), now, stale) &&
      !mayBeRunning({ ...owner, bootId: "b-2" }, fresh, booted, probeOf({ 4242: "563817" }), now, stale),
  );
  check(
    "thisHost：Linux 上帶著這次開機的 boot_id",
    process.platform !== "linux" || /^[0-9a-f-]{36}$/.test(thisHost().bootId ?? ""),
    JSON.stringify(thisHost()),
  );
  check(
    "samePids：同一台、同一次開機、同一個 pid namespace 才算；都沒有 namespace（Windows、macOS）也算同一個",
    samePids({ host: "box", boot: 29_000_001 }, here) &&
      samePids({ host: "box", boot: 29_000_000, pidns: inBox.pidns }, inBox) &&
      !samePids({ host: "box", boot: 29_000_000, pidns: "pid:[4026532999]" }, inBox) &&
      !samePids({ host: "box", boot: 29_000_000 }, inBox) &&
      !samePids({ host: "other", boot: 29_000_000 }, here) &&
      !samePids({ host: "box", boot: 28_000_000 }, here) &&
      !samePids({ host: "box", boot: "29000000" }, here),
  );
  check(
    "thisHost：Linux 上帶著自己的 pid namespace",
    process.platform !== "linux" || /^pid:\[\d+\]$/.test(thisHost().pidns ?? ""),
    JSON.stringify(thisHost()),
  );

  const dead = { trace: { written: ["java/com/x/A.java", "java/com/x/B.java"], session: { "java/com/x/C.java": "1:1", "java/com/x/D.java": "1:1", "java/com/y/G.java": "1:1" } }, lastSeen: 5_000 };
  const nowTree = { "java/com/x/A.java": "2:2", "java/com/x/B.java": "2:2", "java/com/x/C.java": "1:1", "java/com/x/E.java": "3:3" };
  const mtimes: Record<string, number> = { "java/com/x/A.java": 4_000, "java/com/x/B.java": 5_000 + 60_000 + 1, "java/com/x/E.java": 5_500, "java/com/x": 4_500 };
  const startedWith = (rel: string) => ["java/com/x/C.java", "java/com/x/D.java", "java/com/y/G.java"].includes(rel);
  const changed = killedWriterChanges(dead, nowTree, (rel) => mtimes[rel], 60_000, startedWith);
  check(
    "killedWriterChanges：日誌記下的，加上開著的 session 之後的差異；死後才改的（超過心跳加寬限）不算",
    JSON.stringify([...changed.only].sort()) === JSON.stringify(["java/com/x/A.java", "java/com/x/D.java", "java/com/x/E.java"]),
    JSON.stringify([...changed.only].sort()),
  );
  check(
    "killedWriterChanges：不見了的檔，所在目錄在那之後沒動過 → 算 writer 刪的、放回；目錄也不見了 → 無法判斷，不放回",
    changed.only.has("java/com/x/D.java") && JSON.stringify(changed.undecided) === '["java/com/y/G.java"]',
    JSON.stringify(changed),
  );
  const later = killedWriterChanges(dead, nowTree, (rel) => ({ ...mtimes, "java/com/x": 5_000 + 60_000 + 1 })[rel], 60_000, startedWith);
  check(
    "killedWriterChanges：不見了的檔，所在目錄在那次執行死後又被改過（分支切換、別人刪的）→ 無法判斷，不放回",
    !later.only.has("java/com/x/D.java") && later.undecided.includes("java/com/x/D.java"),
    JSON.stringify(later),
  );
  check(
    "killedWriterChanges：沒有開著的 session → 只有日誌記下的",
    JSON.stringify([...killedWriterChanges({ trace: { written: ["java/X.java"] }, lastSeen: 0 }, nowTree, () => 0, 0, () => true).only]) === '["java/X.java"]',
  );
  const createdGone = killedWriterChanges(
    { trace: { written: ["java/com/x/H.java"] }, lastSeen: 5_000 },
    {},
    (rel) => (rel === "java/com/x" ? 9_999_999 : undefined),
    60_000,
    () => false,
  );
  check(
    "killedWriterChanges：writer 新增、後來又不見了的檔 → 沒有東西要放回，也不列為「開始時存在、現在不見了」",
    createdGone.only.size === 0 && createdGone.undecided.length === 0,
    JSON.stringify({ only: [...createdGone.only], undecided: createdGone.undecided }),
  );
  // A move after the death keeps the file's time: new name as old as the writer's own files.
  const moveStart: TreeCapture = {
    root: "/t",
    files: new Map<string, Buffer | null>([
      ["resources/fixtures/order.json", Buffer.from('{"id":1}')],
      ["resources/fixtures/empty.json", Buffer.from("")],
      ["java/com/x/ATest.java", Buffer.from("class ATest {}")],
    ]),
    fingerprints: new Map(),
    dirs: new Set(["resources/fixtures", "java/com/x"]),
  };
  const nowFiles: Record<string, string> = {
    "resources/data/order.json": '{"id":1}',
    "java/com/x/GreeterTest.java": "class GreeterTest {}",
    "java/com/x/Copy.java": "class ATest {}",
  };
  const moves = movesAfterDeath(
    new Set(["resources/data/order.json", "java/com/x/GreeterTest.java", "java/com/x/Copy.java"]),
    ["resources/fixtures/order.json"],
    moveStart,
    (rel) => (rel in nowFiles ? Buffer.from(nowFiles[rel]) : undefined),
  );
  check(
    "movesAfterDeath：新檔的內容和一個「無法判斷誰刪的」原檔一模一樣 → 是之後的移動；writer 新寫的、和還在的原檔內容相同的不算",
    JSON.stringify(moves) === '[{"from":"resources/fixtures/order.json","to":"resources/data/order.json"}]',
    JSON.stringify(moves),
  );
  const emptyStart: TreeCapture = { root: "/t", files: new Map([["resources/empty.txt", Buffer.alloc(0)]]), fingerprints: new Map(), dirs: new Set(["resources"]) };
  check(
    "movesAfterDeath：空檔不算移動的證據（writer 新建的任何空檔都會對上）",
    movesAfterDeath(new Set(["resources/new.txt"]), ["resources/empty.txt"], emptyStart, () => Buffer.alloc(0)).length === 0,
  );
  check(
    "movesAfterDeath：沒有無法判斷的刪除 → 沒有移動（writer 自己在死前的改名照樣撤回）",
    movesAfterDeath(new Set(["resources/data/order.json"]), [], moveStart, (rel) => (rel in nowFiles ? Buffer.from(nowFiles[rel]) : undefined)).length === 0,
  );

  // A journal written and read back: what setAside needs, from disk.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-journal-"));
  const repoRoot = path.join(root, "repo");
  const tree = path.join(repoRoot, "src", "test");
  fs.mkdirSync(path.join(tree, "java", "com", "x"), { recursive: true });
  fs.writeFileSync(path.join(tree, "java", "com", "x", "ATest.java"), "class ATest {}");
  fs.writeFileSync(path.join(tree, "java", "com", "x", "BTest.java"), "class BTest { int b; }");
  fs.writeFileSync(path.join(tree, "java", "com", "x", "Big.json"), "x".repeat(64));
  const out = path.join(repoRoot, "target", "test-classes");
  fs.mkdirSync(path.join(out, "com", "x"), { recursive: true });
  fs.writeFileSync(path.join(out, "com", "x", "ATest.class"), "cafebabe");
  check("dirIdentity：目錄的 inode@建立時間（不含裝置號碼）；不存在的 → \"\"", /^\d+@\d+$/.test(dirIdentity(repoRoot)) && dirIdentity(path.join(root, "nope")) === "", dirIdentity(repoRoot));
  check(
    "sameDirectory：inode 相同、建立時間相同或有一邊不知道 → 同一個；inode 不同、或建立時間都有卻不同 → 不同；舊版的 dev:ino 或空的 → 無從判斷",
    sameDirectory("12@34", "12@34") === true &&
      sameDirectory("12@0", "12@34") === true &&
      sameDirectory("12@34", "13@34") === false &&
      sameDirectory("12@34", "12@35") === false &&
      sameDirectory("41:2663439", "12@34") === undefined &&
      sameDirectory("", "12@34") === undefined,
  );
  check(
    "provenSameDirectory：只有 inode 與（有記錄的）建立時間都相同才算證明——跨機器時唯一的依據",
    provenSameDirectory("12@34", "12@34") && !provenSameDirectory("12@0", "12@0") && !provenSameDirectory("12@34", "12@35") && !provenSameDirectory("", ""),
  );
  const cap = captureTree(tree, { file: 32, total: 1024 });
  const runs = path.join(root, "runs");
  const runDir = path.join(runs, "2026-01-01T00-00-00-000Z");
  const batchDir = path.join(runDir, "batch-2-A");
  const checkout = { repoRoot, rootId: dirIdentity(repoRoot) };
  const handle = openJournal(
    {
      repoRoot,
      rootId: checkout.rootId,
      treeId: dirIdentity(tree),
      pid: 4243,
      start: "777",
      ...thisHost(),
      runDir,
      batch: 2,
      dir: batchDir,
      targetClasses: ["src/main/java/com/x/A.java"],
      testTree: tree,
      treeRel: "src/test",
    },
    cap,
    captureOutputs([out]),
    50,
  );
  const jdir = handle.dir;
  check(
    "openJournal：owner.json 也記下開機的 boot_id（寫到一半的日誌只有它可以判斷那次執行活著沒）",
    process.platform !== "linux" || JSON.parse(fs.readFileSync(path.join(handle.dir, "owner.json"), "utf8")).bootId === thisHost().bootId,
    fs.readFileSync(path.join(handle.dir, "owner.json"), "utf8"),
  );
  check(
    "openJournal：批次開始時的內容寫成單一檔案（不是一個檔一份）",
    fs.existsSync(path.join(jdir, "start.bin")) && !fs.existsSync(path.join(jdir, "start")),
    fs.readdirSync(jdir).join(","),
  );
  traceJournal(handle, { written: ["java/com/x/ATest.java"] });
  // The heartbeat: the journal's time moves while its run lives, and stops once it is closed.
  const t0 = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(jdir, "journal.json"), t0, t0);
  const beatWait = Date.now() + 2_000;
  while (fs.statSync(path.join(jdir, "journal.json")).mtimeMs < t0.getTime() + 1_000 && Date.now() < beatWait) {
    await new Promise((r) => setTimeout(r, 20));
  }
  check("openJournal：心跳在執行期間更新日誌的時間", fs.statSync(path.join(jdir, "journal.json")).mtimeMs > t0.getTime() + 1_000);
  const nobody = { alive: () => false, start: () => undefined };
  const found = findJournals(runs, checkout, nobody);
  const d = found.dead[0];
  check("findJournals：死掉的 run 留下的日誌找得到，連同 writer 的變更", found.dead.length === 1 && d.trace.written[0] === "java/com/x/ATest.java", JSON.stringify(found).slice(0, 300));
  const back = d ? journalCapture(d) : undefined;
  check(
    "journalCapture：批次開始時的樹原樣讀回（每個檔的內容、太大沒留的指紋、目錄）",
    !!back &&
      back.files.get("java/com/x/ATest.java")?.toString() === "class ATest {}" &&
      back.files.get("java/com/x/BTest.java")?.toString() === "class BTest { int b; }" &&
      back.files.get("java/com/x/Big.json") === null &&
      back.fingerprints.get("java/com/x/Big.json") === cap.fingerprints.get("java/com/x/Big.json") &&
      back.dirs.has("java/com/x") &&
      back.root === tree,
  );
  check("journalOutputs：建置輸出的清單讀回", !!d && [...journalOutputs(d).dirs[0].files].includes("com/x/ATest.class"));
  const none = (r: ReturnType<typeof findJournals>) => r.dead.length === 0 && r.stale.length === 0 && r.busy.length === 0;
  check("findJournals：別的 repo 路徑的日誌不理（不算死的、也不丟）", none(findJournals(runs, { ...checkout, repoRoot: "/elsewhere" }, nobody)));
  const otherMachine = { host: "another-machine", boot: thisHost().boot };
  const other = findJournals(runs, { ...checkout, rootId: "1@1" }, nobody, otherMachine);
  check(
    "findJournals：別台機器寫的日誌（共用 runs 目錄、同一個路徑、它自己的 checkout）→ 不碰、不丟，只計數",
    none(other) && other.elsewhere === 1,
    JSON.stringify(other),
  );
  // The same inode with no birth time on one side reads as the same directory here — not proof enough
  // for another machine, whose checkout's inode numbers can coincide (disks provisioned alike).
  const inodeOnly = findJournals(runs, { ...checkout, rootId: checkout.rootId.replace(/@\d+$/, "@0") }, nobody, otherMachine);
  check(
    "findJournals：別台機器的日誌、只有 inode 相同（沒有建立時間可以證明）→ 不當成這個 checkout：不碰、不等",
    none(inodeOnly) && inodeOnly.elsewhere === 1,
    JSON.stringify(inodeOnly),
  );
  const sameDirsFresh = findJournals(runs, checkout, nobody, otherMachine);
  const sameDirsDied = findJournals(runs, checkout, nobody, otherMachine, Date.now() + 10 * 60_000);
  check(
    "findJournals：別的主機名稱、但證明是同一個目錄（inode 與建立時間都相同：每次換名字的容器掛同一個 volume）→ 只看心跳：新鮮是還在跑，停了就撤回",
    !provenSameDirectory(checkout.rootId, checkout.rootId) || (sameDirsFresh.busy.length === 1 && sameDirsDied.dead.length === 1),
    JSON.stringify({ fresh: sameDirsFresh.busy, died: sameDirsDied.dead.length }),
  );
  check(
    "findJournals：這個 checkout 的日誌、它的執行還是同一個程序（啟動時間相同）→ busy（這次不能在它上面開始）",
    JSON.stringify(findJournals(runs, checkout, { alive: () => true, start: (pid) => (pid === 4243 ? "777" : undefined) }).busy) === JSON.stringify([jdir]),
  );
  check(
    "findJournals：記了啟動時間、現在讀不到（程序已經結束，zombie 照樣回應 kill 0）→ 死了",
    findJournals(runs, checkout, { alive: () => true, start: () => undefined }).dead.length === 1,
  );
  const recloned = findJournals(runs, { ...checkout, rootId: "1@1" }, nobody);
  check("findJournals：這個路徑現在是另一個 checkout（重新 clone 過）→ 丟掉，不撤回", recloned.dead.length === 0 && /重新 clone/.test(recloned.stale[0]?.why ?? ""), JSON.stringify(recloned));
  // Read from another container on this machine: same name and boot, its own pid namespace.
  const container = { ...thisHost(), pidns: "pid:[1]" };
  const theirCheckout = findJournals(runs, { ...checkout, rootId: "1@1" }, nobody, container, Date.now() + 10 * 60_000);
  check(
    "findJournals：另一個容器寫的、checkout 不是這一個（它自己同路徑的 checkout）→ 不丟，只計數",
    none(theirCheckout) && theirCheckout.elsewhere === 1,
    JSON.stringify(theirCheckout),
  );
  const fromContainer = findJournals(runs, checkout, { alive: () => true, start: () => "777" }, container);
  check(
    "findJournals：另一個容器寫的、同一個 checkout（共用的 volume）→ pid 不算數，心跳還新鮮就是還在跑（busy）",
    fromContainer.busy.length === 1 && fromContainer.dead.length === 0,
    JSON.stringify(fromContainer),
  );
  const containerDied = findJournals(runs, checkout, { alive: () => true, start: () => "777" }, container, Date.now() + 10 * 60_000);
  check(
    "findJournals：另一個容器寫的、同一個 checkout、心跳停了 → 死了，撤回",
    containerDied.dead.length === 1,
    JSON.stringify(containerDied).slice(0, 300),
  );
  fs.writeFileSync(path.join(runDir, "summary.json"), "{}");
  const ended = findJournals(runs, checkout, nobody);
  check("findJournals：那次執行有 summary.json（有收尾）→ 日誌是剩下的，列為可丟", ended.dead.length === 0 && ended.stale[0]?.dir === jdir, JSON.stringify(ended));
  fs.rmSync(path.join(runDir, "summary.json"));
  fs.writeFileSync(path.join(jdir, "trace.json"), "");
  const lost = findJournals(runs, checkout, nobody);
  check(
    "findJournals：trace.json 讀不了（斷電後的空檔、損毀）→ 不丟日誌：照樣撤回，標記 trace 不見了（改用那批開始之後的所有變更）",
    lost.dead.length === 1 && lost.dead[0].traceLost === true && lost.stale.length === 0,
    JSON.stringify(lost).slice(0, 300),
  );
  fs.writeFileSync(path.join(jdir, "trace.json"), '{"written":["../../../outside.txt"]}');
  check("findJournals：trace 點名測試目錄以外的路徑 → 當成讀不了", findJournals(runs, checkout, nobody).dead[0]?.traceLost === true);
  fs.rmSync(path.join(jdir, "trace.json"));
  const journalOk = fs.readFileSync(path.join(jdir, "journal.json"), "utf8");
  const tamper = (patch: Record<string, unknown>) => {
    fs.writeFileSync(path.join(jdir, "journal.json"), JSON.stringify({ ...JSON.parse(journalOk), ...patch }));
    const r = findJournals(runs, checkout, nobody);
    fs.writeFileSync(path.join(jdir, "journal.json"), journalOk);
    return r;
  };
  const outsideTree = tamper({ testTree: root });
  const escaping = tamper({ capture: { ...JSON.parse(journalOk).capture, kept: [["../../../outside.txt", 0, 1]] } });
  check(
    "findJournals：測試目錄在這個 checkout 之外、或檔名跳出測試目錄（..）→ 內容不合法，丟掉，不拿它撤回（共用的 runs 目錄裡別人寫的）",
    outsideTree.dead.length === 0 && /不合法/.test(outsideTree.stale[0]?.why ?? "") && escaping.dead.length === 0 && /不合法/.test(escaping.stale[0]?.why ?? ""),
    JSON.stringify({ outsideTree: outsideTree.stale, escaping: escaping.stale }),
  );
  const notATestTree = tamper({ testTree: path.join(repoRoot, "src", "main") });
  check(
    "findJournals：測試目錄不是某個模組的 src/test（例如 src/main）→ 內容不合法，丟掉",
    notATestTree.dead.length === 0 && /不合法/.test(notATestTree.stale[0]?.why ?? ""),
    JSON.stringify(notATestTree.stale),
  );
  const mainSrc = path.join(repoRoot, "src", "main", "java");
  const movedArtifacts = tamper({
    runDir: "/somewhere/else",
    dir: "/somewhere/else/batch-2-A",
    outputs: [{ dir: "/etc", files: ["passwd"] }, { dir: mainSrc, files: [] }, ...JSON.parse(journalOk).outputs],
  });
  check(
    "findJournals：它的 artifacts 以找到它的位置為準；建置輸出只認它那個模組放測試的地方（checkout 外的、src/main 這種都不理——撤回會清空它）",
    movedArtifacts.dead[0]?.journal.runDir === runDir &&
      movedArtifacts.dead[0]?.journal.dir === batchDir &&
      movedArtifacts.dead[0]?.journal.outputs.length === 1 &&
      movedArtifacts.dead[0]?.journal.outputs[0].dir === out,
    JSON.stringify(movedArtifacts.dead[0]?.journal ?? {}).slice(0, 300),
  );
  const journalText = fs.readFileSync(path.join(jdir, "journal.json"), "utf8");
  fs.writeFileSync(path.join(jdir, "journal.json"), JSON.stringify({ ...JSON.parse(journalText), capture: null }));
  check("findJournals：journal.json 解析得了、但欄位不對 → 丟掉（每次啟動都當掉不是選項）", /損毀/.test(findJournals(runs, checkout, nobody).stale[0]?.why ?? ""));
  check("isJournal：欄位齊全才算", isJournal(JSON.parse(journalText)) && !isJournal({ ...JSON.parse(journalText), outputs: [null] }) && !isJournal(null));
  fs.writeFileSync(path.join(jdir, "journal.json"), journalText);
  fs.renameSync(tree, `${tree}-moved`);
  const gone = findJournals(runs, checkout, nobody);
  check("findJournals：它的測試目錄不見了 → 丟掉，不重建", gone.dead.length === 0 && /測試目錄/.test(gone.stale[0]?.why ?? ""), JSON.stringify(gone));
  fs.mkdirSync(tree, { recursive: true });
  const rebuilt = findJournals(runs, checkout, nobody);
  check(
    "findJournals：它的測試目錄被刪掉又建了一個（不是同一個目錄）→ 丟掉",
    dirIdentity(tree) === "" || (rebuilt.dead.length === 0 && /測試目錄/.test(rebuilt.stale[0]?.why ?? "")),
    JSON.stringify(rebuilt),
  );
  fs.rmSync(tree, { recursive: true, force: true });
  fs.renameSync(`${tree}-moved`, tree);
  fs.rmSync(path.join(jdir, "journal.json"));
  const cut = findJournals(runs, checkout, nobody);
  check("findJournals：寫到一半就被終止的日誌（沒有 journal.json）→ 可丟", cut.dead.length === 0 && cut.stale[0]?.dir === jdir, JSON.stringify(cut));
  check(
    "findJournals：寫到一半、但寫它的執行還活著 → 不丟（busy）",
    findJournals(runs, checkout, { alive: () => true, start: (pid) => (pid === 4243 ? "777" : undefined) }).busy.length === 1,
  );
  const cutElsewhere = findJournals(runs, { ...checkout, rootId: "1@1" }, { alive: () => true, start: (pid) => (pid === 4243 ? "777" : undefined) });
  check(
    "findJournals：寫到一半、寫它的執行還活著，但它是另一個 checkout 的（owner 記的目錄不同）→ 不擋這次，只計數",
    cutElsewhere.busy.length === 0 && cutElsewhere.elsewhere === 1,
    JSON.stringify(cutElsewhere),
  );
  fs.writeFileSync(path.join(jdir, "journal.json"), JSON.stringify({ version: 99, repoRoot, pid: 4243, runDir }));
  check("findJournals：別的版本寫的日誌 → 不理", none(findJournals(runs, checkout, nobody)));
  closeJournal(handle);
  check("closeJournal：日誌目錄刪掉", !fs.existsSync(jdir));
  fs.mkdirSync(jdir, { recursive: true });
  fs.writeFileSync(path.join(jdir, "journal.json"), "{}");
  fs.utimesSync(path.join(jdir, "journal.json"), t0, t0);
  await new Promise((r) => setTimeout(r, 200));
  check("closeJournal：心跳跟著停（不再碰同一個路徑）", fs.statSync(path.join(jdir, "journal.json")).mtimeMs < t0.getTime() + 1_000);
  // A journal that cannot be written is not left behind half-written: its batch dir is a file here.
  fs.writeFileSync(path.join(root, "not-a-dir"), "");
  let threw = false;
  try {
    openJournal(
      { repoRoot, rootId: "", treeId: "", pid: 1, start: "", ...thisHost(), runDir, batch: 3, dir: path.join(root, "not-a-dir"), targetClasses: [], testTree: tree, treeRel: "src/test" },
      cap,
      captureOutputs([]),
      50,
    );
  } catch {
    threw = true;
  }
  check("openJournal：寫不進去就丟出（呼叫端警告、照常往下），不留下半份日誌", threw && fs.statSync(path.join(root, "not-a-dir")).isFile());
  // Cut short partway — the disk full while the tree is copied in: nothing of it is left behind.
  const exploding = {
    *[Symbol.iterator]() {
      yield ["java/com/x/ATest.java", Buffer.from("class ATest {}")] as [string, Buffer];
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    },
  } as unknown as Map<string, Buffer | null>;
  const halfDir = path.join(runDir, "batch-4-H");
  let halfThrew = false;
  try {
    openJournal(
      { repoRoot, rootId: "", treeId: "", pid: 1, start: "", ...thisHost(), runDir, batch: 4, dir: halfDir, targetClasses: [], testTree: tree, treeRel: "src/test" },
      { ...cap, files: exploding },
      captureOutputs([]),
      50,
    );
  } catch {
    halfThrew = true;
  }
  check(
    "openJournal：寫到一半失敗（磁碟滿）→ 丟出，已經寫了的那一半刪掉",
    halfThrew && fs.existsSync(halfDir) && !fs.existsSync(path.join(halfDir, JOURNAL_DIR)),
    fs.existsSync(halfDir) ? fs.readdirSync(halfDir, { recursive: true }).join(",") : "(no batch dir)",
  );

  // What a recovery decided, kept for a retry.
  const decisionDir = path.join(root, "decision");
  fs.mkdirSync(decisionDir, { recursive: true });
  check("readDecision：還沒有判斷過 → undefined", readDecision(decisionDir) === undefined);
  const decided = { at: 123, only: ["java/com/x/GreeterTest.java"], undecided: ["resources/a.json"], moves: [{ from: "resources/b.json", to: "resources/c/b.json" }] };
  writeDecision(decisionDir, decided);
  check("writeDecision / readDecision：原樣讀回", JSON.stringify(readDecision(decisionDir)) === JSON.stringify(decided));
  fs.writeFileSync(path.join(decisionDir, "decision.json"), JSON.stringify({ ...decided, only: ["../../outside.txt"] }));
  check("readDecision：點名測試目錄以外的路徑 → 不採用", readDecision(decisionDir) === undefined);

  // A retry decides as the first attempt did: that attempt's own changes are not someone else's.
  const retryDir = path.join(root, "retry");
  fs.mkdirSync(retryDir, { recursive: true });
  const retryCap: TreeCapture = {
    root: "/t",
    files: new Map<string, Buffer | null>([["java/com/x/OtherTest.java", Buffer.from("class OtherTest {}")], ["java/com/x/Kept.java", Buffer.from("k")]]),
    fingerprints: new Map(),
    dirs: new Set(["java/com/x"]),
  };
  const deadRetry = {
    path: retryDir,
    journal: {} as BatchJournal,
    trace: { written: ["java/com/x/OtherTest.java", "java/com/x/GreeterTest.java", "java/com/x/Kept.java"] },
    lastSeen: 1_000_000,
  };
  let times: Record<string, number | undefined> = { "java/com/x": 999_000, "java/com/x/GreeterTest.java": 998_000, "java/com/x/Kept.java": 998_000 };
  const view = () => ({
    snapshot: () => ({}),
    mtimeOf: (rel: string) => times[rel],
    read: () => undefined,
  });
  const first = decideRecovery(deadRetry, retryCap, deadRetry.lastSeen, 60_000, view(), 1_000_500);
  // The first attempt moved GreeterTest out (its directory changed) and could not put OtherTest back;
  // someone then edited Kept.java.
  times = { "java/com/x": 1_070_000, "java/com/x/Kept.java": 1_000_500 + 60_001 };
  const retry = decideRecovery(deadRetry, retryCap, deadRetry.lastSeen, 60_000, view(), 1_000_700);
  check(
    "decideRecovery：第一次的判斷寫進日誌；重試時沿用——被刪的 OtherTest 照樣放回（不因為第一次撤回改了目錄就變成無法判斷），之後才被人改過的 Kept.java 不再撤回",
    !first.reused &&
      JSON.stringify(first.decision.only) === JSON.stringify(["java/com/x/GreeterTest.java", "java/com/x/Kept.java", "java/com/x/OtherTest.java"]) &&
      retry.reused &&
      JSON.stringify(retry.decision.only) === JSON.stringify(["java/com/x/GreeterTest.java", "java/com/x/OtherTest.java"]),
    JSON.stringify({ first, retry }),
  );
  const movedDir = path.join(root, "retry-moved");
  const moveCap: TreeCapture = {
    root: "/t",
    files: new Map<string, Buffer | null>([["resources/fixtures/order.json", Buffer.from('{"id":1}')]]),
    fingerprints: new Map(),
    dirs: new Set(["resources/fixtures"]),
  };
  const movedDecision = decideRecovery(
    { path: movedDir, journal: {} as BatchJournal, trace: { written: [], session: { "resources/fixtures/order.json": "1:1" } }, lastSeen: 1_000_000 },
    moveCap,
    1_000_000,
    60_000,
    {
      snapshot: () => ({ "resources/data/order.json": "1:1" }),
      mtimeOf: (rel) => ({ "resources/data/order.json": 900_000, resources: 1_100_000, "resources/data": 900_000 })[rel],
      read: (rel) => (rel === "resources/data/order.json" ? Buffer.from('{"id":1}') : undefined),
    },
    1_100_500,
  ).decision;
  fs.mkdirSync(movedDir, { recursive: true });
  check(
    "decideRecovery：死後的移動——新位置的檔不在要撤回的清單、舊位置的不算無法判斷，記在 moves",
    !movedDecision.only.includes("resources/data/order.json") &&
      movedDecision.undecided.length === 0 &&
      JSON.stringify(movedDecision.moves) === '[{"from":"resources/fixtures/order.json","to":"resources/data/order.json"}]',
    JSON.stringify(movedDecision),
  );
  const decidedAnew = decideRecovery({ ...deadRetry, path: path.join(root, "retry-fresh") }, retryCap, deadRetry.lastSeen, 60_000, view(), 1_000_700);
  check(
    "decideRecovery：（對照）不沿用而重新判斷的話，OtherTest 會因為目錄在死後改過而放不回去",
    !decidedAnew.reused && decidedAnew.decision.undecided.includes("java/com/x/OtherTest.java"),
    JSON.stringify(decidedAnew),
  );
  const lostTrace = decideRecovery(
    { ...deadRetry, path: path.join(root, "retry-lost"), trace: { written: [] }, traceLost: true },
    retryCap,
    deadRetry.lastSeen,
    60_000,
    { snapshot: () => ({ "java/com/x/New.java": "1:1", "java/com/x/Kept.java": "1:1" }), mtimeOf: (rel) => ({ "java/com/x": 999_000, "java/com/x/New.java": 998_000, "java/com/x/Kept.java": 998_000 })[rel], read: () => undefined },
    1_000_700,
  );
  check(
    "decideRecovery：trace 不見了 → 那批開始時的檔與現在的檔全都算（死前改的），交給撤回逐一比對內容",
    JSON.stringify(lostTrace.decision.only) === JSON.stringify(["java/com/x/Kept.java", "java/com/x/New.java", "java/com/x/OtherTest.java"]),
    JSON.stringify(lostTrace),
  );

  // Waiting out a batch that may still be going: until it stops, or the time is up.
  let clockNow = 0;
  const fakeSleep = async (ms: number) => {
    clockNow += ms;
  };
  let polls = 0;
  const stopsAfter3 = await waitWhileBusy(() => (++polls <= 3 ? ["j"] : []), 60_000, 1_000, fakeSleep, () => clockNow);
  check("waitWhileBusy：它停了就不再等，回傳空的", stopsAfter3.length === 0 && polls === 4 && clockNow === 3_000, `polls=${polls} t=${clockNow}`);
  clockNow = 0;
  const never = await waitWhileBusy(() => ["j"], 10_000, 3_000, fakeSleep, () => clockNow);
  check("waitWhileBusy：時間到了還在跑 → 回傳還在跑的（呼叫端停下）", JSON.stringify(never) === '["j"]' && clockNow >= 10_000 && clockNow < 13_000, `t=${clockNow}`);

  // Paths the caller accounts for its own way are neither undone nor listed as someone else's.
  const leaveRoot = path.join(root, "leave");
  fs.mkdirSync(path.join(leaveRoot, "a"), { recursive: true });
  fs.writeFileSync(path.join(leaveRoot, "a", "old.json"), "1");
  fs.writeFileSync(path.join(leaveRoot, "a", "keep.json"), "2");
  const leaveCap = captureTree(leaveRoot);
  fs.mkdirSync(path.join(leaveRoot, "b"), { recursive: true });
  fs.renameSync(path.join(leaveRoot, "a", "old.json"), path.join(leaveRoot, "b", "old.json"));
  fs.writeFileSync(path.join(leaveRoot, "a", "keep.json"), "changed by someone");
  const leaveRb = rollbackTree(leaveCap, path.join(root, "leave-rejected"), "", new Set<string>(), new Set(["a/old.json", "b/old.json"]));
  check(
    "rollbackTree：leave 裡的路徑（之後的移動、無法判斷誰刪的）不撤回、也不列成別人的變更；其他沒在 only 裡的照樣列為別人的",
    fs.existsSync(path.join(leaveRoot, "b", "old.json")) &&
      !fs.existsSync(path.join(leaveRoot, "a", "old.json")) &&
      JSON.stringify(leaveRb.foreign) === '["a/keep.json"]',
    JSON.stringify(leaveRb),
  );
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n[30] 被強制終止的 run 留下的子程序（libs/shell.ts）");
{
  const stat = (name: string, state: string, pgrp: number, start: number) =>
    `4242 (${name}) ${state} 1 ${pgrp} ${pgrp} 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 ${start} 7368704 1531`;
  check("parseStat：狀態、程序群組、啟動時間", JSON.stringify(parseStat(stat("java", "S", 4242, 563817))) === '{"state":"S","pgrp":4242,"start":"563817"}');
  check(
    "parseStat：名稱裡有空白與括號也從最後一個「)」算起",
    JSON.stringify(parseStat(stat("a b) (c", "R", 7, 99))) === '{"state":"R","pgrp":7,"start":"99"}',
    JSON.stringify(parseStat(stat("a b) (c", "R", 7, 99))),
  );
  check("parseStat：不是 stat 的內容 → undefined", parseStat("garbage") === undefined && parseStat("1 (x) S 1") === undefined);
  const me = processStart(process.pid);
  if (process.platform === "linux") {
    check("processStart（Linux，/proc）：自己的啟動時間讀得到、兩次一樣", !!me && me === processStart(process.pid), String(me));
  }
  if (process.platform !== "win32") {
    const viaPs = processStart(process.pid, "darwin");
    check("processStart（其他 POSIX，ps -o lstart=）：讀得到、兩次一樣", !!viaPs && viaPs === processStart(process.pid, "darwin"), String(viaPs));
    // ps prints the start in the local zone: two runs under different TZ would never match each other's.
    const savedTz = process.env.TZ;
    process.env.TZ = "TST-8"; // a POSIX zone, eight hours east: no tz database needed
    const underTaipei = processStart(process.pid, "darwin");
    const local = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim();
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    check(
      "processStart（ps）：不論使用者的時區與語系，都用同一種格式與 UTC（兩次執行在不同 TZ 下也認得彼此的子程序）",
      !!viaPs && underTaipei === viaPs && (local === "" || local !== viaPs),
      `${underTaipei} / ${viaPs} / local ${local}`,
    );
  }
  check("processStart：Windows 沒有便宜的辦法 → undefined（只點名、不結束）", processStart(process.pid, "win32") === undefined);
  const done = spawnSync(process.execPath, ["-e", "0"]);
  check("processStart：已經結束的程序 → undefined", processStart(done.pid ?? 0) === undefined && processStart(0x3ffffffe) === undefined);

  const rec = { pid: 4242, start: "563817", cmd: "mvn test" };
  const win = { from: 1_000_000, to: 2_000_000 };
  const act = (o: Parameters<typeof orphanAction>[1]) => JSON.stringify(orphanAction(rec, o, win));
  check("orphanAction：同一個程序（啟動時間相同）→ 結束它的程序群組", act({ start: "563817", groupAlive: true }) === '{"kind":"stop-group"}');
  check("orphanAction：pid 被別的程序重用（啟動時間不同）→ 不是它的", act({ start: "999", groupAlive: true }) === '{"kind":"not-ours"}');
  check(
    "orphanAction：沒記到啟動時間 → 無從確認，不碰還在的程序",
    JSON.stringify(orphanAction({ ...rec, start: "" }, { start: "563817", groupAlive: true }, win)) === '{"kind":"not-ours"}',
  );
  check("orphanAction：都不在了 → gone", act({ groupAlive: false }) === '{"kind":"gone"}');
  check(
    "orphanAction：launcher 已經不在、群組還有程序 → 只結束那次執行還活著時啟動的（fork 出去的 JVM）；之後才啟動的可能是別人重用了這個群組 id，只列出",
    act({ groupAlive: true, members: [{ pid: 11, startMs: 1_500_000 }, { pid: 12, startMs: 2_500_000 }, { pid: 13 }] }) ===
      '{"kind":"stop-members","pids":[11],"left":[12,13]}',
    act({ groupAlive: true, members: [{ pid: 11, startMs: 1_500_000 }, { pid: 12, startMs: 2_500_000 }, { pid: 13 }] }),
  );
  check(
    "orphanAction：比那個子程序還早啟動的成員不是它 fork 的",
    act({ groupAlive: true, members: [{ pid: 14, startMs: 900_000 }] }) === '{"kind":"stop-members","pids":[],"left":[14]}',
  );
  check("orphanAction：launcher 不在、又看不到成員何時啟動（沒有 /proc）→ 只回報，不結束", act({ groupAlive: true }) === '{"kind":"report"}');
  if (process.platform === "linux") {
    const mine = processStart(process.pid);
    const started = mine ? startMsOf(mine) : undefined;
    const expected = Date.now() - process.uptime() * 1000;
    check("startMsOf：/proc 的啟動時間換算成時刻（誤差在幾秒內）", started !== undefined && Math.abs(started - expected) < 3_000, `${started} vs ${expected}`);
  }
  check("groupMembers：不是 Linux → 看不到（undefined）", groupMembers(process.pid, "darwin") === undefined);

  if (process.platform !== "win32") {
    // A real process group, and a zombie in it: `sleep 0.1` ends while its parent (which exec'd into
    // `sleep 30`) never waits for it.
    const leader = spawn("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 30"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const zombie = Number(await new Promise<string>((r) => leader.stdout!.once("data", (d) => r(String(d)))));
    await new Promise((r) => setTimeout(r, 400));
    check("groupAlive：群組裡還有在跑的程序 → true", groupAlive(leader.pid!), String(leader.pid));
    if (process.platform === "linux") {
      const members = groupMembers(leader.pid!) ?? [];
      check(
        "groupMembers：列出群組裡還在跑的程序與啟動時間，已經結束的（zombie）不列",
        members.some((m) => m.pid === leader.pid && m.startMs !== undefined && Math.abs(m.startMs - Date.now()) < 10_000) &&
          !members.some((m) => m.pid === zombie),
        JSON.stringify(members),
      );
    }
    if (process.platform === "linux") {
      let isZombie = false;
      try {
        isZombie = / Z /.test(fs.readFileSync(`/proc/${zombie}/stat`, "utf8"));
      } catch {
        /* reaped already */
      }
      if (isZombie) check("processStart：已經結束、還沒被回收的程序（zombie）→ undefined", processStart(zombie) === undefined);
    }
    process.kill(-leader.pid!, "SIGKILL");
    await new Promise((r) => leader.once("exit", r));
    await new Promise((r) => setTimeout(r, 200));
    check("groupAlive：群組的程序都結束了 → false（還沒被回收的也不算）", !groupAlive(leader.pid!), String(leader.pid));
  }

  // The children journal: a tracked child is on disk while it runs, and off it once it has ended.
  const jdir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-children-"));
  const file = path.join(jdir, "children.json");
  journalChildren(file, { repoRoot: "/repo", host: "box", boot: 1, pid: process.pid, start: me ?? "" }, 50);
  const t0 = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, t0, t0);
  const beatWait = Date.now() + 2_000;
  while (fs.statSync(file).mtimeMs < t0.getTime() + 1_000 && Date.now() < beatWait) await new Promise((r) => setTimeout(r, 20));
  check("journalChildren：心跳在執行期間更新紀錄的時間（下一次執行拿它當最後還活著的時刻）", fs.statSync(file).mtimeMs > t0.getTime() + 1_000);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { detached: DETACH_CHILDREN, stdio: "ignore" });
  trackForShutdown(child);
  const listed = JSON.parse(fs.readFileSync(file, "utf8"));
  check(
    "journalChildren：執行中的子程序連同啟動時間寫進紀錄",
    listed.repoRoot === "/repo" && listed.children.length === 1 && listed.children[0].pid === child.pid &&
      (process.platform === "win32" || listed.children[0].start === processStart(child.pid!)),
    JSON.stringify(listed),
  );
  const build = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { detached: DETACH_CHILDREN, stdio: "ignore" });
  trackForShutdown(build, "build");
  const kinds = JSON.parse(fs.readFileSync(file, "utf8")).children.map((c: { pid: number; kind?: string }) => [c.pid === build.pid, c.kind]);
  check(
    "journalChildren：建置記成 kind=build（只寫 target/）；其他的（agent session）記成 other",
    JSON.stringify(kinds) === JSON.stringify([[false, "other"], [true, "build"]]),
    JSON.stringify(kinds),
  );
  await Promise.all([child, build].map((c) => (c.exitCode !== null ? Promise.resolve() : new Promise((r) => c.once("exit", r)))));
  check("journalChildren：子程序結束就從紀錄移除", JSON.parse(fs.readFileSync(file, "utf8")).children.length === 0);
  journalChildren(undefined);
  fs.utimesSync(file, t0, t0);
  await new Promise((r) => setTimeout(r, 200));
  check("journalChildren(undefined)：不再記錄，心跳也停", fs.statSync(file).mtimeMs < t0.getTime() + 1_000);
  fs.rmSync(jdir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
if (failures.length) console.log(`\n失敗的檢查（${failures.length}）：\n${failures.join("\n")}`);
console.log(`\n結果：${passCount} passed / ${failCount} failed`);
if (failCount > 0) process.exit(1);
console.log("[OK] selftest 全數通過");
