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
} from "../libs/utils";
import { resolveAgentPath, contractViolations, parseToolsBlock, WRITER_RULES } from "../libs/guard";
import { parseJacocoReport, toRanges, missedLines } from "../gates/coverage";
import { parseVerdict, runReviewGate } from "../gates/review";
import {
  buildFixPrompt,
  buildGeneratePrompt,
  renderExistingTests,
  renderPreExisting,
  renderConventions,
} from "../prompts";
import {
  countTestsRun,
  extractCompileErrorFiles,
  summarizeBuildErrors,
  surefireHasFailure,
} from "../gates/build";
import { classVisibility, isClassRefSuite, scanTestConventions } from "../libs/conventions";
import { loadRubric } from "../libs/rubric";
import { ScoreThresholds } from "../config";
import { AgentRunner } from "../libs/types";
import { traceEvent, buildInvocation } from "../runners/opencode";
import { planSpawn, resolveWindowsCommand, explainSpawnError, planKill, killTree } from "../libs/shell";
import { spawn } from "node:child_process";

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
console.log(`\n結果：${passCount} passed / ${failCount} failed`);
if (failCount > 0) process.exit(1);
console.log("[OK] selftest 全數通過");
