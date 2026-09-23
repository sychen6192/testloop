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
} from "../prompts";
import { testMetrics, findShrunk, collectTestMetrics } from "../libs/testmetrics";
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
import { acquireRepoLock, repoLockFile } from "../libs/lock";
import { planSpawn, resolveWindowsCommand, explainSpawnError, planKill, killTree, shLive, assembleCapture } from "../libs/shell";
import { classifyEnvFailures, readSurefireXml, isSurefireSummary, crashedTestClasses, unfinishedTestClasses } from "../gates/build";
import { spawn, spawnSync } from "node:child_process";
import { envKnobsInSource, TESTGEN_ROOT } from "./itest-lib";
import { bypassesProxy, redactProxy } from "../libs/proxy";
import { bundleFrom, caSummary, load, sourcePaths } from "../libs/tls";

let passCount = 0;
let failCount = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passCount++;
    console.log(`  [OK] ${name}`);
  } else {
    failCount++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
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

  const foo = { tests: 4, assertions: 5, disabled: 1 };
  const bar = { tests: 2, assertions: 2, disabled: 0 };
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
  const del = findShrunk(before, { "com/x/FooTest.java": foo });
  check(
    "findShrunk：檔案被刪 → 違規且 after=null",
    del.length === 1 && del[0].file === "com/x/BarTest.java" && del[0].after === null,
  );
  const grown = {
    ...before,
    "com/x/FooTest.java": { tests: 6, assertions: 9, disabled: 0 },
    "com/x/NewTest.java": { tests: 3, assertions: 3, disabled: 0 },
  };
  check("findShrunk：增加、或 writer 新建的檔 → 不違規", findShrunk(before, grown).length === 0);
  check(
    "findShrunk：writer 自己新建的檔之後縮水也不受約束（不在 before 裡）",
    findShrunk(before, { ...grown, "com/x/NewTest.java": { tests: 0, assertions: 0, disabled: 0 } })
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
  check("codelessTypeReason：class / enum / record → null", ["public class A {}", "public enum E { X }", "public record R(int x) {}"].every((c) => codelessTypeReason(c) === null));
  check("codelessTypeReason：註解裡的 interface 字樣不算", codelessTypeReason("// this interface is old\npublic class A { void f() {} }") === null);

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
    fs.rmSync(lockRepo, { recursive: true, force: true });
    fs.rmSync(lockFile, { force: true });
  }

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
console.log(`\n結果：${passCount} passed / ${failCount} failed`);
if (failCount > 0) process.exit(1);
console.log("[OK] selftest 全數通過");
