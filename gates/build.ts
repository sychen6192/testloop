// Hard gate: compile + test, module-aware.
// Maven: reactor pom at REPO_ROOT -> `mvn -pl <module> -am test` from root; else `mvn test` in the module.
// Gradle: `-p <module>` for multi-module (best-effort; Maven is the primary path).
// Test reports are read from the *module's* target/build, not the repo root.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  REPO_ROOT,
  MAVEN_EXTRA_ARGS,
  ALLOW_ZERO_TESTS,
  BUILD_TIMEOUT_MS,
  MAX_FAILURE_BLOCKS,
  MAX_FAILURE_CASES,
} from "../config";
import { tail, die, log } from "../libs/log";
import { clampText, stripAnsi } from "../libs/utils";
import { shLive } from "../libs/shell";
import { BuildTool, GateResult, ModuleInfo } from "../libs/types";

// What the module already looked like before the writer touched anything.
// Without this the build gate cannot tell "the writer broke it" from "it arrived broken",
// and the fix prompt sends the writer chasing other people's compile errors.
export interface BaselineResult {
  clean: boolean;
  compileErrorFiles: string[];
  failingTestClasses: string[];
  // Broken things outside the writer's write scope (the target module's src/test): another
  // module's tests, production code, build files. Repairing these is not slow, it is
  // impossible — the writer has no permission to touch them — so the loop must not try.
  outOfScope: string[];
  // Red that comes from the environment rather than from test code: a Spring context that will
  // not start, a datasource that cannot connect or decrypt its password. The file is usually
  // well inside the writer's scope, which is exactly why this needs its own classification —
  // outOfScope would not catch it, and no edit to the test body makes it green.
  envFailures: string[];
  // Why the failing tests failed, quoted from the surefire reports: assertion messages plus the
  // first stack frame in the project's own code. runBuildAndTests puts this in its `report` for
  // the build gate, and runBaseline discarded it — so the repair loop knew *which* classes were
  // red and never *why*, which is the one thing a writer cannot infer from a class name.
  failureDetail: string;
  summary: string;
  raw: string;
}

/** The writer's only writable path, repo-relative, for messages. */
export const writableRel = (mod: ModuleInfo) =>
  path.join(mod.moduleRel || ".", "src", "test").replace(/\\/g, "/");

export function detectBuildTool(moduleRoot: string): BuildTool {
  if (fs.existsSync(path.join(moduleRoot, "pom.xml"))) return "maven";
  if (
    fs.existsSync(path.join(moduleRoot, "build.gradle")) ||
    fs.existsSync(path.join(moduleRoot, "build.gradle.kts"))
  ) {
    return "gradle";
  }
  die(`在 ${moduleRoot} 偵測不到 pom.xml 或 build.gradle`);
}

// Maven's own footer — it repeats on every failed build and tells the writer nothing about
// the code. It is also the part tail() would keep, which is why the report is extracted
// rather than tailed.
const MAVEN_BOILERPLATE =
  /-> \[Help \d\]|\[Help \d\] http|To see the full stack trace|Re-run Maven|For more information about the errors|After correcting the problems|^\s*mvn <args>/;

/**
 * Pure: the actionable part of a failed maven/gradle build.
 *
 * Keeps `[ERROR]` lines and the unprefixed continuation lines javac emits under them
 * ("symbol: variable log", "location: class Foo"), drops the boilerplate footer, and falls
 * back to a tail when nothing matched — an empty report would tell the writer nothing at all.
 */
export function summarizeBuildErrors(raw: string, max = 4000): string {
  const kept: string[] = [];
  // Colour codes land inside the level tag, so an un-stripped line matches neither the
  // `[ERROR]` test below nor the boilerplate filter, and every line falls through to the
  // tail() fallback — a report of maven's footer instead of the compiler's errors.
  const lines = stripAnsi(raw).split("\n");
  let inErrorBlock = false;
  for (const line of lines) {
    const isError = /^\[ERROR\]/.test(line);
    // javac continuation: indented, no level prefix, directly under an [ERROR] line.
    const isContinuation = inErrorBlock && /^\s+\S/.test(line) && !/^\s*\[\w+\]/.test(line);
    if (!isError && !isContinuation) {
      inErrorBlock = false;
      continue;
    }
    inErrorBlock = true;
    const text = line.replace(/\s*-> \[Help \d\]\s*$/, "").trimEnd();
    // Boilerplate is matched against the payload, not the raw line: the patterns are anchored
    // and every maven line carries an "[ERROR] " prefix in front of them.
    const payload = text.replace(/^\[ERROR\]\s*/, "");
    if (!payload.trim()) continue; // bare "[ERROR]" spacer
    if (MAVEN_BOILERPLATE.test(payload)) continue;
    kept.push(text);
  }
  if (kept.length === 0) return tail(raw, max);
  return clampText(kept.join("\n"), max);
}

/**
 * Pure: does a surefire .txt report record an actual failure?
 *
 * Every report — passing ones included — contains the summary line
 * "Tests run: 1, Failures: 0, Errors: 0, Skipped: 0", so a substring match on /FAILURE|ERROR/
 * flags all of them. The counts have to be read. Falls back to surefire's per-test marker
 * when the summary line is missing (a report truncated by a crashed JVM).
 */
export function surefireHasFailure(txt: string): boolean {
  const m = /Failures:\s*(\d+),\s*Errors:\s*(\d+)/i.exec(txt);
  if (m) return Number(m[1]) > 0 || Number(m[2]) > 0;
  return /<<<\s*(?:FAILURE|ERROR)!/.test(txt);
}

// ─── Surefire reports ────────────────────────────────────────────────────────
//
// The .txt summary is not a reliable source of failures. When a class keeps its tests in
// @Nested inner classes — an ordinary JUnit 5 layout — surefire writes
// "Tests run: 0, Failures: 0" into the .txt while the XML for the same run records
// tests=14 failures=12. Reading counts off the .txt therefore drops every assertion message,
// and the writer is told which methods failed but never why.
//
// Measured on a real run against a @Nested handler test: the true cause was
// "expected: 400 BAD_REQUEST but was: 400" — one line to fix. Given only the method names,
// the writer inferred the right area, overshot, and spent the next round on a compile error.
// So the XML is the source; the .txt stays as the fallback for a build that disabled it.

export interface SurefireCase {
  kind: "failure" | "error";
  // "Inner.deliberately_fails" — the nested container is kept; it locates the code.
  name: string;
  message: string;
  // First stack frame in the project's own code. Framework frames locate nothing.
  frame: string;
}

export interface SurefireSuite {
  // testsuite/@name, the reliable class identifier: a case's @classname may be a @DisplayName
  // ("handleValidation") rather than a type name.
  suite: string;
  // The surefire-reports directory it was read from. In a reactor build that identifies the
  // module, which is what says whether the writer is allowed to touch it.
  dir?: string;
  tests: number;
  failures: number;
  errors: number;
  cases: SurefireCase[];
}

const XML_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    return XML_ENTITIES[body] ?? whole;
  });
}

const attr = (tag: string, name: string): string =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";

const FOREIGN_FRAME =
  /^\s*at (?:java\.|javax\.|jdk\.|sun\.|org\.junit|org\.opentest4j|org\.assertj|org\.mockito|net\.bytebuddy|org\.apache\.maven|org\.springframework\.test)/;

function firstProjectFrame(stack: string): string {
  for (const line of stack.split("\n")) {
    if (!/^\s*at /.test(line)) continue;
    if (FOREIGN_FRAME.test(line)) continue;
    return line.trim();
  }
  return "";
}

/** Pure: one surefire TEST-*.xml. null when the text is not a surefire report. */
export function parseSurefireXml(xml: string): SurefireSuite | null {
  const openTag = /<testsuite\b[^>]*>/.exec(xml)?.[0];
  if (!openTag) return null;
  const suite = attr(openTag, "name");
  if (!suite) return null;
  const num = (n: string) => Number(attr(openTag, n)) || 0;

  const cases: SurefireCase[] = [];
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(xml))) {
    const body = m[2];
    if (!body) continue; // self-closing: the test passed
    // <skipped/>, <system-out> and <rerunFailure> are not this round's failures.
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (!fail) continue;
    const method = attr(m[1], "name");
    const className = attr(m[1], "classname");
    const nested = className.includes("$")
      ? className.slice(className.lastIndexOf("$") + 1)
      : className && className !== suite
        ? className
        : "";
    const stack = unescapeXml((fail[3] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
    const message = unescapeXml(attr(fail[2], "message")) || attr(fail[2], "type");
    cases.push({
      kind: fail[1] as "failure" | "error",
      name: nested ? `${nested}.${method}` : method,
      message: message.replace(/\s+/g, " ").trim(),
      frame: firstProjectFrame(stack),
    });
  }
  return { suite, tests: num("tests"), failures: num("failures"), errors: num("errors"), cases };
}

/** Pure: one suite rendered for the writer. The message leads — it is the actionable part. */
export function renderSurefireSuite(s: SurefireSuite, maxCases = MAX_FAILURE_CASES): string {
  const shown = s.cases.slice(0, maxCases);
  const lines = shown.map((c) => {
    const parts = [`  ✗ ${c.name}`];
    if (c.message) parts.push(`    ${clampText(c.message, 500)}`);
    if (c.frame) parts.push(`    ${c.frame}`);
    return parts.join("\n");
  });
  if (s.cases.length > shown.length) {
    lines.push(`  （另有 ${s.cases.length - shown.length} 個失敗的測試未列出，見 build.log）`);
  }
  return [
    `----- ${s.suite}（測試 ${s.tests}、失敗 ${s.failures}、錯誤 ${s.errors}）-----`,
    ...lines,
  ].join("\n");
}

const surefireDirOf = (moduleRoot: string) =>
  path.join(moduleRoot, "target", "surefire-reports");

/**
 * Every surefire-reports directory in the build, target module first.
 *
 * `mvn -pl web -am test` compiles and runs the upstream modules too, so the failure that
 * turned the build red may sit in common/target/surefire-reports and never appear under the
 * target module at all. Looking only at the target module leaves the writer with maven's
 * stdout — the failing method's name, and nothing about why.
 *
 * The mtime filter downstream is what keeps this safe: extra directories can only contribute
 * reports this build actually wrote.
 */
function surefireDirs(moduleRoot: string): string[] {
  const dirs = [surefireDirOf(moduleRoot)];
  const seen = new Set(dirs.map((d) => path.resolve(d)));
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (e.name === "node_modules" || e.name === "src") continue;
      if (e.name === "target" || e.name === "build") {
        const sr = path.join(dir, e.name, "surefire-reports");
        const key = path.resolve(sr);
        if (!seen.has(key) && fs.existsSync(sr)) {
          seen.add(key);
          dirs.push(sr);
        }
        continue;
      }
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(REPO_ROOT, 0);
  return dirs;
}

/** The module a surefire-reports directory belongs to: <module>/target/surefire-reports. */
export const moduleOfSurefireDir = (dir: string) => path.dirname(path.dirname(dir));

// Reports older than `since` are left over from an earlier build. Quoting them tells the
// writer about tests that this round never ran — the compile step may have failed first.
function freshFiles(dir: string, prefix: string, suffix: string, since: number): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).mtimeMs >= since;
      } catch {
        return false; // vanished mid-walk
      }
    })
    .sort();
}

function failingSuites(moduleRoot: string, since: number): SurefireSuite[] {
  const out: SurefireSuite[] = [];
  for (const dir of surefireDirs(moduleRoot)) {
    for (const f of freshFiles(dir, "TEST-", ".xml", since)) {
      let suite: SurefireSuite | null = null;
      try {
        suite = parseSurefireXml(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        /* unreadable, or truncated by a crashed JVM — the .txt fallback still applies */
      }
      if (suite && suite.failures + suite.errors > 0) out.push({ ...suite, dir });
    }
  }
  return out;
}

function failingReports(surefireDir: string, since: number): string[] {
  return freshFiles(surefireDir, "", ".txt", since).filter((f) =>
    surefireHasFailure(fs.readFileSync(path.join(surefireDir, f), "utf8")),
  );
}

function collectSurefireFailures(moduleRoot: string, since: number): string {
  const suites = failingSuites(moduleRoot, since);
  if (suites.length) {
    const shown = suites.slice(0, MAX_FAILURE_BLOCKS);
    let out = shown.map((s) => `\n${renderSurefireSuite(s)}`).join("");
    if (suites.length > shown.length) {
      out += `\n（另有 ${suites.length - shown.length} 個失敗的測試類別未列出，見 build.log）`;
    }
    return out;
  }

  // No usable XML this build (disableXmlReport, or the JVM died before writing one).
  const failing: Array<{ dir: string; file: string }> = [];
  for (const dir of surefireDirs(moduleRoot)) {
    for (const file of failingReports(dir, since)) failing.push({ dir, file });
  }
  let failures = "";
  for (const { dir, file } of failing.slice(0, MAX_FAILURE_BLOCKS)) {
    const txt = fs.readFileSync(path.join(dir, file), "utf8");
    failures += `\n----- ${file} -----\n${tail(txt, 1500)}`;
  }
  if (failing.length > MAX_FAILURE_BLOCKS) {
    failures += `\n（另有 ${failing.length - MAX_FAILURE_BLOCKS} 個失敗的測試類別未列出，見 build.log）`;
  }
  return failures;
}

function collectGradleFailures(moduleRoot: string): string {
  let failures = "";
  const dir = path.join(moduleRoot, "build", "test-results", "test");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"))) {
      const xml = fs.readFileSync(path.join(dir, f), "utf8");
      const blocks = [
        ...(xml.match(/<failure[^>]*>[\s\S]*?<\/failure>/g) ?? []),
        ...(xml.match(/<error[^>]*>[\s\S]*?<\/error>/g) ?? []),
      ];
      for (const b of blocks) {
        const msg = b.replace(/<[^>]*>/g, "").trim();
        if (msg) failures += `\n----- ${f} -----\n${tail(msg, 1500)}`;
      }
    }
  }
  return failures;
}

/**
 * Pure: reasons this build is red that no edit to a test body can fix.
 *
 * A @SpringBootTest whose context will not start reports as a failing test class, so the repair
 * loop treats it as test code and spends its whole budget — 8-15 minutes a round on a module of
 * that shape — rewriting assertions that were never the problem. The writer has full write
 * permission on the file; the cause is a datasource, a credential or a profile.
 *
 * Deliberately narrow. Each signature names a subsystem failing to come up, not a test failing
 * an assertion, because a false positive here refuses to repair something that was repairable.
 */
const ENV_FAILURE_SIGNATURES: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /Failed to load ApplicationContext/, why: "Spring context 無法啟動" },
  {
    re: /org\.springframework\.beans\.factory\.(?:BeanCreationException|UnsatisfiedDependencyException)/,
    why: "Spring bean 建立失敗",
  },
  {
    re: /org\.springframework\.context\.ApplicationContextException/,
    why: "Spring context 啟動失敗",
  },
  { re: /com\.zaxxer\.hikari\.pool\.HikariPool\$PoolInitializationException/, why: "連線池初始化失敗（HikariCP）" },
  {
    re: /Unable to acquire JDBC Connection|Cannot (?:load|create) driver class|Driver class .* not found/,
    why: "JDBC 連線無法建立",
  },
  { re: /org\.apache\.commons\.codec\.DecoderException/, why: "設定值解密失敗（DecoderException）" },
];

export function detectEnvFailures(raw: string): string[] {
  const text = stripAnsi(raw);
  return ENV_FAILURE_SIGNATURES.filter((s) => s.re.test(text)).map((s) => s.why);
}

// Pure: the distinct .java files the compiler reported errors in. Two shapes cover both
// build tools — Maven prefixes and bracket-wraps the position, javac (gradle) does not:
//   [ERROR] /abs/path/FooTest.java:[12,34] cannot find symbol
//   /abs/path/FooTest.java:12: error: cannot find symbol
// Order is first-seen, so the report reads in the order the compiler produced it.
export function extractCompileErrorFiles(raw: string): string[] {
  const seen = new Set<string>();
  const text = stripAnsi(raw);
  const patterns = [/^\[ERROR\]\s+(.+?\.java):\[\d+,\d+\]/gm, /^(.+?\.java):\d+:\s*error:/gm];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) seen.add(m[1].trim().replace(/\\/g, "/"));
  }
  return [...seen];
}

// Test classes this build ran and failed. Same source preference as the failure detail:
// a @Nested class is invisible in the .txt, and a baseline that cannot name its broken
// classes gives the repair loop nothing to aim at.
function collectFailingTestClasses(moduleRoot: string, since: number): string[] {
  const suites = failingSuites(moduleRoot, since);
  if (suites.length) return suites.map((s) => s.suite);
  return surefireDirs(moduleRoot).flatMap((dir) =>
    failingReports(dir, since).map((f) => f.replace(/\.txt$/, "")),
  );
}

/**
 * Baseline pre-check: run the *same* command the build gate will run, before the writer
 * has written anything. A baseline computed with a cheaper command (test-compile, -Dtest=X)
 * is not a baseline — it would miss exactly the failures that later block the gate.
 *
 * Zero tests is not a baseline failure: a module with no tests yet is the normal case for
 * this tool, so the zero-test guard is suppressed here and left to the real gate.
 */
export async function runBaseline(
  tool: BuildTool,
  mod: ModuleInfo,
  // The repair loop re-runs this after every fix round: same command, same classification,
  // different wording in the log and summary.
  phase: "baseline" | "repair" = "baseline",
): Promise<BaselineResult> {
  const startedAt = Date.now();
  const tag = phase === "repair" ? "修復後建置" : "預檢基準";
  log(
    phase === "repair"
      ? "修復驗證：重新建置，確認既有紅燈是否清除"
      : "預檢：在 writer 介入前先建置一次，取得既有紅燈基準",
  );
  const r = await runBuildAndTests(tool, mod, { allowZeroTests: true });

  if (r.passed) {
    return {
      clean: true,
      compileErrorFiles: [],
      failingTestClasses: [],
      outOfScope: [],
      envFailures: [],
      failureDetail: "",
      summary: `${tag}：乾淨（模組可編譯且測試全過）。`,
      raw: r.raw ?? "",
    };
  }

  const raw = r.raw ?? "";
  const compileErrorFiles = extractCompileErrorFiles(raw);
  const suites = tool === "maven" ? failingSuites(mod.moduleRoot, startedAt) : [];
  const failingTestClasses = suites.length
    ? suites.map((s) => s.suite)
    : tool === "maven"
      ? collectFailingTestClasses(mod.moduleRoot, startedAt)
      : [];

  // What the writer is allowed to change. Everything red outside it is a human's job: the
  // repair loop would spend its whole budget discovering it cannot write there.
  const writable = path.join(mod.moduleRoot, "src", "test");
  const inside = (abs: string) => {
    const rel = path.relative(writable, abs);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const show = (abs: string) => (path.relative(REPO_ROOT, abs) || ".").replace(/\\/g, "/");
  const outOfScope: string[] = [];
  for (const f of compileErrorFiles) {
    const abs = path.isAbsolute(f) ? f : path.join(REPO_ROOT, f);
    if (!inside(abs)) outOfScope.push(`${show(abs)}（編譯失敗）`);
  }
  for (const s of suites) {
    if (!s.dir) continue;
    const owner = moduleOfSurefireDir(s.dir);
    if (path.resolve(owner) !== path.resolve(mod.moduleRoot)) {
      outOfScope.push(`${s.suite}（測試失敗，位於模組 ${show(owner)}）`);
    }
  }

  const lines = [
    phase === "repair" ? `${tag}：模組仍然是紅的。` : `${tag}：模組在 writer 介入前就已經是紅的。`,
  ];
  if (compileErrorFiles.length) {
    lines.push(`編譯失敗的檔案（${compileErrorFiles.length}）：`);
    compileErrorFiles.forEach((f) => lines.push(`  - ${f}`));
  }
  if (failingTestClasses.length) {
    lines.push(`測試失敗的類別（${failingTestClasses.length}）：`);
    failingTestClasses.forEach((c) => lines.push(`  - ${c}`));
  }
  if (!compileErrorFiles.length && !failingTestClasses.length) {
    lines.push("（無法從輸出定位到具體檔案，錯誤節錄如下）");
    lines.push(summarizeBuildErrors(raw, 2000));
  }
  if (outOfScope.length) {
    lines.push(`超出 writer 可寫範圍（${writableRel(mod)}）的有 ${outOfScope.length} 項：`);
    outOfScope.forEach((f) => lines.push(`  - ${f}`));
  }
  // Same source the build gate quotes from, read here rather than plumbed through
  // runBuildAndTests' report string — that string also carries summarizeBuildErrors, which the
  // caller adds itself, and two copies of it is what the feedback budget cannot afford.
  const failureDetail =
    tool === "maven"
      ? collectSurefireFailures(mod.moduleRoot, startedAt)
      : collectGradleFailures(mod.moduleRoot);
  const envFailures = detectEnvFailures(raw);
  if (envFailures.length) {
    lines.push(`環境/設定問題（改測試碼修不好）：`);
    envFailures.forEach((w) => lines.push(`  - ${w}`));
  }
  return {
    clean: false,
    compileErrorFiles,
    failingTestClasses,
    outOfScope,
    envFailures,
    failureDetail,
    summary: lines.join("\n"),
    raw,
  };
}

// Pure: last "Tests run: N" in the maven stream = the Results-block aggregate.
// null = surefire never reported (no tests compiled/ran, or tests were skipped).
export function countTestsRun(mavenOut: string): number | null {
  const re = /Tests run: (\d+)/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(mavenOut))) last = m;
  return last ? Number(last[1]) : null;
}

// Zero-test detection on a *passing* build; returns the failure report, or null if tests ran.
// Maven parses the reactor stdout (with -am, upstream-module tests may inflate the count —
// errs lenient, never blocks a valid run). Gradle counts the module's TEST-*.xml (best-effort;
// gradle rewrites its results dir per run).
function detectZeroTests(tool: BuildTool, mod: ModuleInfo, out: string): string | null {
  let detail: string | null = null;
  if (tool === "maven") {
    const n = countTestsRun(out);
    if (n === null) detail = "surefire 未回報任何「Tests run」";
    else if (n === 0) detail = "surefire 回報 Tests run: 0";
  } else {
    const dir = path.join(mod.moduleRoot, "build", "test-results", "test");
    const hasResults =
      fs.existsSync(dir) &&
      fs.readdirSync(dir).some((f) => f.startsWith("TEST-") && f.endsWith(".xml"));
    if (!hasResults) detail = "build/test-results/test 沒有任何 TEST-*.xml";
  }
  if (!detail) return null;
  const testRoot = path
    .join(mod.moduleRel || ".", "src", "test", "java")
    .replace(/\\/g, "/");
  return (
    `編譯成功，但本輪實際執行了 0 個測試（${detail}）。依 fail-closed 原則 build gate 判 FAIL。\n` +
    `請在 ${testRoot} 對應 package 下建立 <ClassName>Test.java（類名以 Test 結尾、` +
    `至少一個 @Test 方法），並確認測試會被建置工具撿起。\n` +
    `（確定要允許零測試通過可設 UT_ALLOW_ZERO_TESTS=1）`
  );
}

export async function runBuildAndTests(
  tool: BuildTool,
  mod: ModuleInfo,
  // onlyTests: run just these test classes (simple names). Compilation is unaffected — the
  // whole module's test sources still have to compile — so this narrows execution, not scope.
  opts: { allowZeroTests?: boolean; onlyTests?: string[] } = {},
): Promise<GateResult> {
  const isWin = process.platform === "win32";
  // Taken before the build so stale reports from an earlier round can be told apart.
  const startedAt = Date.now();
  let r: { code: number; out: string; timedOut?: boolean };

  if (tool === "maven") {
    const wrapper = isWin ? "mvnw.cmd" : "mvnw";
    const reactorHasPom = fs.existsSync(path.join(REPO_ROOT, "pom.xml"));
    const useReactor = mod.multiModule && reactorHasPom;
    const cwd = useReactor ? REPO_ROOT : mod.moduleRoot;
    const wrapperAt = fs.existsSync(path.join(cwd, wrapper));
    const cmd = wrapperAt ? (isWin ? wrapper : `./${wrapper}`) : "mvn";
    const args = [
      ...(useReactor ? ["-pl", mod.moduleRel, "-am"] : []),
      // Batch mode: no ANSI colour and no download-progress spam. Gradle below is pinned with
      // --console=plain for the same reason — the parsers must not have to guess whether maven
      // decided this was a terminal. Colour is stripped again at capture, since a project's own
      // .mvn/maven.config can re-enable it.
      "-B",
      "-DskipITs",
      // JaCoCo's agent appends to target/jacoco.exec by default, so coverage accumulates
      // across builds: a round-1 test that covers nothing inherits the previous run's — or
      // the developer's own — coverage and passes the gate. Measured on the fixture: 2 of 6
      // lines covered reported as 100%. Each build must measure only itself. Harmless when
      // the module has no JaCoCo.
      "-Djacoco.append=false",
      // failIfNoSpecifiedTests=false is required, not cosmetic: with -am the same -Dtest is
      // applied to the upstream modules, where those classes do not exist, and surefire
      // would fail the reactor for finding nothing to run.
      ...(opts.onlyTests?.length
        ? [`-Dtest=${opts.onlyTests.join(",")}`, "-Dsurefire.failIfNoSpecifiedTests=false"]
        : []),
      "test",
      ...MAVEN_EXTRA_ARGS,
    ];
    r = await shLive(cmd, args, "[mvn]", cwd, BUILD_TIMEOUT_MS);
  } else {
    const wrapper = isWin ? "gradlew.bat" : "gradlew";
    const wrapperAt = fs.existsSync(path.join(REPO_ROOT, wrapper));
    const cmd = wrapperAt ? (isWin ? wrapper : `./${wrapper}`) : "gradle";
    const args = [
      ...(mod.multiModule ? ["-p", mod.moduleRel] : []),
      "test",
      "--console=plain",
    ];
    r = await shLive(cmd, args, "[gradle]", REPO_ROOT, BUILD_TIMEOUT_MS);
  }

  // One strip at the boundary: every parser below, the zero-test count, and the build.log
  // artifact all see plain text. The live console output above keeps its colour.
  r.out = stripAnsi(r.out);

  if (r.timedOut) {
    return {
      passed: false,
      report:
        `建置/測試逾時（${BUILD_TIMEOUT_MS}ms），已終止程序樹。` +
        `常見原因：依賴解析卡住、測試含真實網路 I/O。可調整 UT_BUILD_TIMEOUT_MS。`,
      raw: r.out,
    };
  }

  if (r.code === 0) {
    const zeroReport =
      ALLOW_ZERO_TESTS || opts.allowZeroTests ? null : detectZeroTests(tool, mod, r.out);
    if (zeroReport) return { passed: false, report: zeroReport, raw: r.out };
    return { passed: true, report: "編譯與測試全數通過。", raw: r.out };
  }

  const failures =
    tool === "maven"
      ? collectSurefireFailures(mod.moduleRoot, startedAt)
      : collectGradleFailures(mod.moduleRoot);

  return {
    passed: false,
    report:
      `編譯或測試失敗（exit=${r.code}）。\n錯誤節錄：\n${summarizeBuildErrors(r.out)}\n${failures}`,
    raw: r.out,
  };
}
