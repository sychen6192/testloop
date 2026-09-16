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
} from "../libs/utils";
import {
  resolveAgentPath,
  contractViolations,
  parseToolsBlock,
  WRITER_RULES,
  REVIEWER_RULES,
} from "../libs/guard";
import { parseJacocoReport, toRanges, missedLines, reportIsStale } from "../gates/coverage";
import { parseVerdict, runReviewGate } from "../gates/review";
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
import { ScoreThresholds } from "../config";
import { AgentRunner } from "../libs/types";
import { traceEvent, buildInvocation } from "../runners/opencode";
import { ApiRunner } from "../runners/api";
import { execTool, resolveInside, toOpenAiTools, toolsFor } from "../runners/api-tools";
import { planSpawn, resolveWindowsCommand, explainSpawnError, planKill, killTree } from "../libs/shell";
import { spawn } from "node:child_process";
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
    "---\ntools:\n  write: true\n  edit: true\n  bash: false\n  webfetch: false\n---\nbody";
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
    "---\ntools:\n  write: true\n  edit: true\n  bash: true\n  webfetch: false\n---\n",
  );
  const errs = contractViolations(badWriter, WRITER_RULES);
  check("writer 拿到 bash → 違規", errs.length === 1 && errs[0].includes("bash"));

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
        return true;
      } catch {
        return false;
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
    "---\ndescription: bash: false 只是描述\ntools:\n  write: true\n  edit: true\n  bash: true\n  webfetch: false\n---\nbody",
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
console.log(`\n結果：${passCount} passed / ${failCount} failed`);
if (failCount > 0) process.exit(1);
console.log("[OK] selftest 全數通過");
