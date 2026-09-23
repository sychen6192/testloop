// Hard gate: compile + test, module-aware.
// Maven: reactor pom at REPO_ROOT -> `mvn -pl <module> -am test` from root; else `mvn test` in the module.
// Gradle: `-p <module>` for multi-module (best-effort; Maven is the primary path).
// Test reports are read from the *module's* target/build, not the repo root.
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
import { codeOnly } from "../libs/javasrc";
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
  // P: the identity of every test already failing before the writer wrote anything. Under
  // UT_ALLOW_DIRTY_BASELINE the build gate treats a round as green when this round's failing
  // identities are a subset of these — see DESIGN.md「dirty baseline 下，gate 扣除既有失敗」.
  // Maven only: without surefire XML there are no identities and the gate stays strict.
  failingTests: string[];
  summary: string;
  raw: string;
  // The build never reached a verdict (timed out, or killed by a signal). Not a red module:
  // there is nothing to repair, and the repair loop must not be entered on it.
  aborted?: string;
  // Green, but tests that had to run did not (see checkTestsRan): failingTestClasses names them,
  // and the summary says why. There is no build error to quote.
  notRun?: boolean;
  // The test classes this build ran in the module — before a writer, the ones it has to keep running.
  ranTests?: string[];
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
  // The failure's stack trace with its cause chain (bounded), for classifying *why* it failed.
  trace?: string;
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
    // <skipped/>, <system-out> and <rerunFailure> are not this round's failures. The test's own
    // output is dropped before looking: surefire keeps a passing test's stdout in the XML, and a
    // logged SOAP fault or XML payload containing "<error" made that test read as failed.
    const scan = body.replace(/<(system-out|system-err)\b[^>]*>[\s\S]*?<\/\1>/g, "");
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(scan);
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
      trace: stack.length > 20_000 ? stack.slice(0, 20_000) : stack,
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

/**
 * Pure: the identity of every failing test in these suites.
 *
 * FQCN plus the case name surefire recorded — which for a @ParameterizedTest already carries
 * the invocation ("add(int)[2]") and for a @Nested class already carries the inner class.
 * Per-case and deliberately not per-class: "that class was already red" would let a test the
 * writer actually broke ride in behind one that was failing before it started.
 */
export function failingTestIds(suites: SurefireSuite[]): string[] {
  const ids = new Set<string>();
  for (const s of suites) for (const c of s.cases) ids.add(`${s.suite}#${c.name}`);
  return [...ids].sort();
}

export interface SubtractionVerdict {
  pass: boolean;
  current: string[];
  unexpected: string[];
  reason: string;
}

/**
 * Pure: may this red build be treated as "no worse than before the writer touched it"?
 *
 * Three ways it must answer no, each a guardrail the design was accepted on:
 * - a compile error — nothing ran, so there is nothing to compare;
 * - no failing test identified at all — the empty set is a subset of anything, so a dependency
 *   resolution failure, a dead plugin or a build with XML reports disabled would sail through;
 * - any identity the baseline did not already have — that is the writer breaking something,
 *   which is the whole promise this gate exists to keep.
 */
export function subtractTolerated(
  raw: string,
  suites: SurefireSuite[],
  tolerate: string[],
): SubtractionVerdict {
  const current = failingTestIds(suites);
  const allowed = new Set(tolerate);
  const unexpected = current.filter((id) => !allowed.has(id));
  const compileErrors = extractCompileErrorFiles(raw, "maven");
  if (compileErrors.length) {
    return { pass: false, current, unexpected, reason: "編譯失敗，沒有任何測試跑過，無從比對" };
  }
  if (current.length === 0) {
    return {
      pass: false,
      current,
      unexpected,
      reason: "建置紅但定位不到任何失敗的測試，不能當成「沒有變糟」",
    };
  }
  if (unexpected.length) {
    return { pass: false, current, unexpected, reason: "出現基準沒有的新失敗" };
  }
  return { pass: true, current, unexpected, reason: "全部都是 writer 介入前就存在的失敗" };
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

// A TEST-*.xml can be enormous — surefire keeps every test's stdout in it — and one past V8's
// ~512M-character string limit cannot be read with readFileSync at all. It used to be swallowed
// silently (the failing suite vanished from the report); now anything big is read in chunks with
// the <system-out>/<system-err> bodies skipped, which is everything but a few KB of it.
const XML_DIRECT_READ_BYTES = 32 * 1024 * 1024;

/** Reads a surefire XML report without its captured test output. */
export function readSurefireXml(file: string): string {
  if (fs.statSync(file).size <= XML_DIRECT_READ_BYTES) return fs.readFileSync(file, "utf8");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    const decoder = new StringDecoder("utf8");
    const out: string[] = [];
    let carry = "";
    let skipping: string | null = null; // the closing tag we are skipping to
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      let text = carry + (n > 0 ? decoder.write(buf.subarray(0, n)) : decoder.end());
      carry = "";
      for (;;) {
        if (skipping) {
          const end = text.indexOf(skipping);
          if (end < 0) {
            carry = text.slice(-skipping.length); // a closing tag may straddle chunks
            text = "";
            break;
          }
          out.push(skipping);
          text = text.slice(end + skipping.length);
          skipping = null;
          continue;
        }
        // The first opening tag that has a body; a self-closing <system-out/> has nothing to skip.
        const open = /<(system-out|system-err)(?:\s[^>]*)?(?<!\/)>/.exec(text);
        if (open) {
          out.push(text.slice(0, open.index + open[0].length));
          skipping = `</${open[1]}>`;
          text = text.slice(open.index + open[0].length);
          continue;
        }
        // Hold back a possible partial opening tag at the end of the chunk.
        const lt = text.lastIndexOf("<");
        const keep = lt >= 0 && text.length - lt < 64 ? lt : text.length;
        out.push(text.slice(0, keep));
        carry = text.slice(keep);
        break;
      }
      if (n <= 0) {
        if (!skipping) out.push(carry);
        break;
      }
    }
    return out.join("");
  } finally {
    fs.closeSync(fd);
  }
}

function failingSuites(moduleRoot: string, since: number): SurefireSuite[] {
  const out: SurefireSuite[] = [];
  for (const dir of surefireDirs(moduleRoot)) {
    for (const f of freshFiles(dir, "TEST-", ".xml", since)) {
      let suite: SurefireSuite | null = null;
      try {
        suite = parseSurefireXml(readSurefireXml(path.join(dir, f)));
      } catch (e) {
        // Truncated by a crashed JVM, or unreadable — the .txt fallback still applies, but a
        // failing suite that disappears from the report must at least leave a trace in the log.
        log(`[WARN] 無法解析 surefire 報告 ${f}：${e instanceof Error ? e.message : String(e)}`);
      }
      if (suite && suite.failures + suite.errors > 0) out.push({ ...suite, dir });
    }
  }
  return out;
}

// Surefire's per-class summaries are "<class>.txt", about a kilobyte each. The same directory
// also holds "<class>-output.txt" — the test's whole stdout under redirectTestOutputToFile — which
// the ".txt" suffix matched too: reading a 600MB one to regex a summary line crashed the run with
// ERR_STRING_TOO_LONG. Only summaries are read, and nothing large is read at all.
const SUMMARY_TXT_MAX_BYTES = 4 * 1024 * 1024;

function readSummary(file: string): string | null {
  try {
    if (fs.statSync(file).size > SUMMARY_TXT_MAX_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Pure: is this surefire-reports file a per-class summary (as opposed to captured output)? */
export const isSurefireSummary = (f: string) => f.endsWith(".txt") && !/-output\.txt$|-jvmRun\d*\.txt$/.test(f);

function failingReports(surefireDir: string, since: number): string[] {
  return freshFiles(surefireDir, "", ".txt", since)
    .filter(isSurefireSummary)
    .filter((f) => {
      const txt = readSummary(path.join(surefireDir, f));
      return txt !== null && surefireHasFailure(txt);
    });
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
    const txt = readSummary(path.join(dir, file)) ?? "";
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

/**
 * Pure: environment reasons, read from the failing tests themselves when surefire said which
 * failed and why; the whole build log only when it did not.
 *
 * The build log carries every test's console output, passing tests included, and healthy Spring
 * modules log these very signatures all the time — Spring warns "Exception encountered during
 * context initialization … UnsatisfiedDependencyException" on every failed refresh, which is what
 * an ApplicationContextRunner `hasFailed()` test is there to provoke. Scanned whole, one such
 * passing test turned a red baseline that was an ordinary assertion bug into an "environment"
 * abort before round 1, and the repair loop that would have fixed it never ran.
 */
export function classifyEnvFailures(raw: string, suites: SurefireSuite[]): string[] {
  if (suites.length === 0) return detectEnvFailures(raw);
  const evidence = suites
    .flatMap((s) => s.cases.map((c) => `${c.message}\n${c.trace ?? ""}`))
    .join("\n");
  return detectEnvFailures(evidence);
}

// Pure: the distinct .java files the compiler reported errors in. Two shapes cover both
// build tools — Maven prefixes and bracket-wraps the position, javac (gradle) does not:
//   [ERROR] /abs/path/FooTest.java:[12,34] cannot find symbol
//   /abs/path/FooTest.java:12: error: cannot find symbol
// Order is first-seen, so the report reads in the order the compiler produced it.
// For maven only the compiler plugin's own shape counts: the bare javac shape also matches a
// diagnostic a *passing* test printed (a test that compiles a template in-process), which made a
// green file under target/ an out-of-scope compile error and aborted the run.
export function extractCompileErrorFiles(raw: string, tool: BuildTool | "any" = "any"): string[] {
  const seen = new Set<string>();
  const text = stripAnsi(raw);
  const patterns =
    tool === "maven"
      ? [/^\[ERROR\]\s+(.+?\.java):\[\d+,\d+\]/gm]
      : [/^\[ERROR\]\s+(.+?\.java):\[\d+,\d+\]/gm, /^(.+?\.java):\d+:\s*error:/gm];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    // On Windows the maven compiler plugin prints the file as a URI path, `/C:/repo/...`. Read
    // as-is it is "absolute" and resolves to `C:\C:\repo\...`, so a compile error in the
    // module's own src/test was classed out of scope and the run stopped before repair.
    while ((m = re.exec(text))) seen.add(m[1].trim().replace(/\\/g, "/").replace(/^\/([A-Za-z]:\/)/, "$1"));
  }
  return [...seen];
}

/**
 * Pure: test classes whose forked JVM died (System.exit, a crash) — surefire lists them under
 * "Crashed tests:" and writes no report for them. Unread, a module whose only red is a test
 * calling System.exit was "unlocatable" and the repair loop gave up before round 1, although
 * surefire had named the class and the writer could fix it.
 */
export function crashedTestClasses(raw: string): string[] {
  const out: string[] = [];
  const lines = stripAnsi(raw).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\[ERROR\]\s+Crashed tests:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^\[ERROR\]\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*$/.exec(lines[j]);
      if (!m) break;
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/** Pure: test classes surefire started and never finished — where a timed-out build was stuck. */
export function unfinishedTestClasses(raw: string): string[] {
  const text = stripAnsi(raw);
  const started = [...text.matchAll(/^\[INFO\] Running ([\w.$]+)\s*$/gm)].map((m) => m[1]);
  const done = new Set([...text.matchAll(/ -- in ([\w.$]+)\s*$/gm)].map((m) => m[1]));
  return [...new Set(started.filter((c) => !done.has(c)))];
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
  // Repair only: the tests that ran before it, which a repair must leave running.
  mustRun?: ExpectedTest[],
  ranBefore?: string[],
): Promise<BaselineResult> {
  const startedAt = Date.now();
  const tag = phase === "repair" ? "修復後建置" : "預檢基準";
  log(
    phase === "repair"
      ? "修復驗證：重新建置，確認既有紅燈是否清除"
      : "預檢：在 writer 介入前先建置一次，取得既有紅燈基準",
  );
  const { gate: r, aborted, notRun, startedAt: builtAt } = await runBuild(tool, mod, { allowZeroTests: true, mustRun, ranBefore });
  const ranTests = ranTestClasses(tool, mod, builtAt, r.raw ?? "");

  if (aborted) {
    return {
      clean: false,
      compileErrorFiles: [],
      failingTestClasses: [],
      outOfScope: [],
      envFailures: [],
      failureDetail: "",
      failingTests: [],
      summary: `${tag}：建置沒有跑完——${aborted}`,
      raw: r.raw ?? "",
      aborted,
    };
  }

  if (r.passed) {
    return {
      clean: true,
      compileErrorFiles: [],
      failingTestClasses: [],
      outOfScope: [],
      envFailures: [],
      failureDetail: "",
      failingTests: [],
      summary: `${tag}：乾淨（模組可編譯且測試全過）。`,
      raw: r.raw ?? "",
      ranTests,
    };
  }
  if (notRun) {
    return {
      clean: false,
      compileErrorFiles: [],
      failingTestClasses: notRun,
      outOfScope: [],
      envFailures: [],
      failureDetail: "",
      failingTests: [],
      summary: `${tag}：${r.report}`,
      raw: r.raw ?? "",
      notRun: true,
      ranTests,
    };
  }

  const raw = r.raw ?? "";
  const compileErrorFiles = extractCompileErrorFiles(raw, tool);
  const suites = tool === "maven" ? failingSuites(mod.moduleRoot, startedAt) : [];
  const failingTestClasses = suites.length
    ? suites.map((s) => s.suite)
    : tool === "maven"
      ? collectFailingTestClasses(mod.moduleRoot, startedAt)
      : [];
  const crashed = tool === "maven" ? crashedTestClasses(raw) : [];
  for (const c of crashed) if (!failingTestClasses.includes(c)) failingTestClasses.push(c);

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
  if (crashed.length) {
    lines.push(`fork 的 JVM 中途結束（System.exit 或 crash，surefire 沒有留下報告）的測試類別：${crashed.join("、")}`);
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
  const failingTests = failingTestIds(suites);
  const failureDetail =
    tool === "maven"
      ? collectSurefireFailures(mod.moduleRoot, startedAt)
      : collectGradleFailures(mod.moduleRoot);
  const envFailures = classifyEnvFailures(raw, suites);
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
    failingTests,
    summary: lines.join("\n"),
    raw,
    ranTests,
  };
}

/** The test classes a build ran in the module: its fresh reports, and surefire's log lines. */
export function ranTestClasses(tool: BuildTool, mod: ModuleInfo, since: number, out: string): string[] {
  const check = checkTestsRan(tool, mod, since, out, []);
  return check ? [...new Set(check.reported)].sort() : [];
}

// ─── Were the writer's tests run? ────────────────────────────────────────────
//
// A passing build proves that the tests it ran pass — not that the writer's were among them. A
// JUnit 5 test in a module whose surefire runs the JUnit 4 provider compiles and is never run; so
// is a JUnit 4 test on a JUnit Platform without the vintage engine, a class whose name surefire's
// includes do not match, a class disabled as a whole. The build is green, the coverage gate finds
// the class untested, and nothing says why. Worse, a failing test rewritten into a framework the
// build does not run turns green with every test still there: the shrink guard counts @Test
// annotations, and none was lost.

export type TestFramework = "JUnit 5" | "JUnit 4" | "TestNG";

/** A test class a build is expected to run. */
export interface ExpectedTest {
  /** Absolute path of its source. */
  file: string;
  fqcn: string;
  framework?: TestFramework;
  /** Disabled as a whole: @Disabled / @Ignore on the class, or TestNG's @Test(enabled = false). */
  disabled: boolean;
  /**
   * "created": the writer's new class — one whose every test was skipped is not run either.
   * "changed": a class the writer edited that ran before it did. "untouched": a class that ran
   * before the writer, and that nothing the writer did may stop running.
   */
  origin: "created" | "changed" | "untouched";
}

/** Pure: the framework a test source is written for — by the @Test it uses, then by any import. */
export function testFrameworkOf(code: string): TestFramework | undefined {
  if (/\bimport\s+org\.junit\.jupiter\.api\.(?:Test|\*)\s*;|@org\.junit\.jupiter\.api\.Test\b/.test(code)) return "JUnit 5";
  if (/\bimport\s+org\.testng\.annotations\.(?:Test|\*)\s*;|@org\.testng\.annotations\.Test\b/.test(code)) return "TestNG";
  if (/\bimport\s+org\.junit\.(?:Test|\*)\s*;|@org\.junit\.Test\b/.test(code)) return "JUnit 4";
  if (/\borg\.junit\.jupiter\./.test(code)) return "JUnit 5";
  if (/\borg\.testng\./.test(code)) return "TestNG";
  if (/\borg\.junit\./.test(code)) return "JUnit 4";
  return undefined;
}

/**
 * Pure: the test class a source file declares, when it is one a build runs — test methods in a
 * concrete top-level class. undefined for helpers, abstract bases, interfaces.
 */
export function expectedTestOf(src: string, file: string, origin: ExpectedTest["origin"]): ExpectedTest | undefined {
  const name = path.basename(file, ".java");
  if (!file.endsWith(".java") || !/^[\w$]+$/.test(name)) return undefined;
  const code = codeOnly(src);
  if (!/@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(code)) return undefined;
  const decl = new RegExp(
    `(?:^|[\\s;})])((?:(?:public|protected|private|abstract|static|final|strictfp|sealed|non-sealed)\\s+)*)(class|interface|enum|record)\\s+${name.replace(/\$/g, "\\$")}\\b`,
  ).exec(code);
  if (!decl || decl[2] !== "class" || /\babstract\b/.test(decl[1])) return undefined;
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(code)?.[1];
  // The class's own annotations: after the statement before it (the last import) and before it.
  const head = code.slice(0, decl.index + 1);
  const own = head.slice(Math.max(head.lastIndexOf(";"), head.lastIndexOf("}")) + 1);
  const disabled = /@(?:[\w.]+\.)?(?:Disabled|Ignore)\b|@(?:[\w.]+\.)?Test\s*\([^)]*\benabled\s*=\s*false/.test(own);
  return { file, fqcn: pkg ? `${pkg}.${name}` : name, framework: testFrameworkOf(code), disabled, origin };
}

/** Pure: the simple names surefire's default includes run — Test*, *Test, *Tests, *TestCase. */
export const includedByDefault = (fqcn: string) => /^Test|Test$|Tests$|TestCase$/.test(fqcn.split(".").pop() ?? "");

export interface RanCheck {
  /** Every class the build reported running (outer class names), in the module or its log. */
  reported: string[];
  /** Expected classes this build did not run. */
  notRun: ExpectedTest[];
  /** Classes created this run whose every test was skipped. */
  allSkipped: Array<{ test: ExpectedTest; tests: number }>;
  /** The classes this build did run in the module, with the framework their source is written for. */
  ran: Array<{ fqcn: string; framework?: TestFramework }>;
  /** When this build ran nothing else: the classes that ran before the writer, the same way. */
  ranBefore: Array<{ fqcn: string; framework?: TestFramework }>;
}

// A class ran when something names it: its own report (TEST-<fqcn>.xml, <fqcn>.txt, with a
// reportNameSuffix or for a @Nested class after it), a suite report's test cases (TestNG writes one
// TEST-TestSuite.xml for everything), or surefire's "Running <fqcn>" line.
const names = (fqcn: string, name: string) => name === fqcn || name.startsWith(`${fqcn}$`) || name.startsWith(`${fqcn}-`);

/** Pure: the classes a surefire console log says it ran. */
export function classesRunInLog(out: string): string[] {
  const found = new Set<string>();
  for (const m of out.matchAll(/(?:\bRunning|\s--?\sin)\s+([\w.$]+)\s*$/gm)) found.add(m[1]);
  return [...found];
}

// "tests" and "skipped" of each report of a class: XML attributes, or the .txt summary line.
function skippedCounts(dir: string, files: string[]): { tests: number; skipped: number } {
  let tests = 0;
  let skipped = 0;
  const xml = files.filter((f) => f.endsWith(".xml"));
  for (const f of xml.length ? xml : files) {
    let text = "";
    try {
      const fd = fs.openSync(path.join(dir, f), "r");
      try {
        const buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const tag = /<testsuite\b[^>]*>/.exec(text)?.[0];
    if (tag) {
      tests += Number(attr(tag, "tests")) || 0;
      skipped += Number(attr(tag, "skipped")) || 0;
      continue;
    }
    const line = /Tests run:\s*(\d+),.*?Skipped:\s*(\d+)/.exec(text);
    if (line) {
      tests += Number(line[1]);
      skipped += Number(line[2]);
    }
  }
  return { tests, skipped };
}

/**
 * Which of `expected` this build ran. undefined when that cannot be told: the build left no
 * report of its own in the module and its log names no test class, yet says tests ran — reports
 * disabled or written elsewhere, where "not run" would fail every round of a module the check
 * simply cannot see.
 */
export function checkTestsRan(
  tool: BuildTool,
  mod: ModuleInfo,
  since: number,
  out: string,
  expected: ExpectedTest[],
  // Classes known to have run before the writer: which frameworks run here, when this build
  // (scoped to the writer's classes) ran nothing else to tell by.
  ranBefore: string[] = [],
): RanCheck | undefined {
  const dir = tool === "maven" ? surefireDirOf(mod.moduleRoot) : path.join(mod.moduleRoot, "build", "test-results", "test");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    /* no reports at all */
  }
  // Maven leaves earlier builds' reports in place; gradle deletes them before each run, and an
  // up-to-date test task (nothing changed since) keeps reports that still hold.
  const reports = entries.filter((f) => {
    if (!/^TEST-.+\.xml$/.test(f) && !(tool === "maven" && isSurefireSummary(f))) return false;
    if (tool !== "maven") return true;
    try {
      return fs.statSync(path.join(dir, f)).mtimeMs >= since;
    } catch {
      return false;
    }
  });
  const reportOf = new Map<string, string[]>();
  for (const f of reports) {
    const cls = f.endsWith(".xml") ? f.slice("TEST-".length, -".xml".length) : f.slice(0, -".txt".length);
    reportOf.set(cls, [...(reportOf.get(cls) ?? []), f]);
  }
  const testRoot = path.join(mod.moduleRoot, "src", "test", "java");
  const sourceOf = (name: string) => path.join(testRoot, ...name.replace(/[$-].*$/, "").split(".")) + ".java";
  const isClass = (name: string) => fs.existsSync(sourceOf(name));
  // The log covers the whole reactor: only this module's classes say anything about this module.
  const logged = tool === "maven" ? classesRunInLog(out).filter(isClass) : [];
  const seen = [...reportOf.keys(), ...logged];
  // A suite report (TestNG's one TEST-TestSuite.xml, a JUnit 4 suite class) names its classes inside.
  let inside: string[] | undefined;
  const scanInside = () => {
    if (inside) return inside;
    inside = [];
    for (const f of reports.filter((r) => r.endsWith(".xml"))) {
      try {
        const xml = readSurefireXml(path.join(dir, f));
        for (const m of xml.matchAll(/<testsuite\b[^>]*?\bname="([^"]*)"|<testcase\b[^>]*?\bclassname="([^"]*)"/g)) inside.push(unescapeXml(m[1] ?? m[2]));
      } catch {
        /* unreadable: not evidence either way */
      }
    }
    return inside;
  };
  if (!seen.some(isClass)) {
    if (reports.length) {
      // Reports that name no test class of the module — named by @DisplayName (surefire's
      // usePhrasedFileName), or a suite's — unless the cases inside do: "cannot see", not "did not run".
      if (!scanInside().some(isClass)) return undefined;
    } else {
      // Nothing names a class: only surefire saying it ran nothing tells "nothing ran" from
      // "cannot see" (reports disabled or written elsewhere, a quiet log).
      const none = tool === "maven" && (countTestsRun(out) === 0 || /\bNo tests (?:to run|were executed)\b/.test(out));
      if (!none) return undefined;
    }
  }
  let notRun = expected.filter((t) => !seen.some((n) => names(t.fqcn, n)));
  if (notRun.length && reports.length) notRun = notRun.filter((t) => !scanInside().some((n) => names(t.fqcn, n)));
  // A class listed by name only (it ran before the writer): what its source says, for the report.
  notRun = notRun.map((t) => {
    if (t.framework) return t;
    try {
      const read = expectedTestOf(fs.readFileSync(t.file, "latin1"), t.file, t.origin);
      return read ? { ...t, framework: read.framework, disabled: read.disabled } : t;
    } catch {
      return t;
    }
  });
  const allSkipped: RanCheck["allSkipped"] = [];
  for (const t of expected) {
    if (t.origin !== "created" || notRun.some((n) => n.fqcn === t.fqcn)) continue;
    const files = [...reportOf].filter(([n]) => names(t.fqcn, n)).flatMap(([, f]) => f);
    if (!files.length) continue;
    const { tests, skipped } = skippedCounts(dir, files);
    if (tests > 0 && skipped >= tests) allSkipped.push({ test: t, tests });
  }
  // What ran, and in which framework — read only when something did not run.
  const outer = new Set(seen.map((n) => n.replace(/[$-].*$/, "")));
  // The classes that did not run are no evidence of what runs — before the writer, their source
  // may have been another framework.
  const frameworksOf = (classes: Iterable<string>) => {
    const found: RanCheck["ran"] = [];
    for (const fqcn of [...classes].sort()) {
      if (notRun.some((t) => t.fqcn === fqcn) || allSkipped.some((a) => a.test.fqcn === fqcn)) continue;
      if (found.length >= 200) break;
      let src: string;
      try {
        src = fs.readFileSync(sourceOf(fqcn), "latin1");
      } catch {
        continue; // another module's, or not a class (TestNG's "TestSuite")
      }
      found.push({ fqcn, framework: testFrameworkOf(codeOnly(src)) });
    }
    return found;
  };
  const reporting = notRun.length > 0 || allSkipped.length > 0;
  const ran = reporting ? frameworksOf(outer) : [];
  return { reported: [...outer], notRun, allSkipped, ran, ranBefore: reporting && !ran.length ? frameworksOf(ranBefore) : [] };
}

const HOW_TO_WRITE: Record<TestFramework, string> = {
  "JUnit 4": "JUnit 4（org.junit.Test、org.junit.Assert；測試類別與 @Test 方法都要 public）",
  "JUnit 5": "JUnit 5（org.junit.jupiter.api.Test、org.junit.jupiter.api.Assertions）",
  TestNG: "TestNG（org.testng.annotations.Test、org.testng.Assert）",
};

const MAX_NOT_RUN_LISTED = 20;

/** Pure: the failure report for tests the build did not run; null when every one of them ran. */
export function renderRanCheck(check: RanCheck, tool: BuildTool): string | null {
  if (!check.notRun.length && !check.allSkipped.length) return null;
  const fw = (t: ExpectedTest) => (t.framework ? `（${t.framework} 寫法）` : "");
  const WHAT: Record<ExpectedTest["origin"], string> = {
    created: "你新寫的測試類別，這次建置沒有執行它",
    changed: "你改過的測試類別，改之前有被執行，這次沒有",
    untouched: "既有的測試類別，writer 介入前有被執行，這次沒有——你的變更讓它不再被執行（例如測試資源裡的設定、共用的基底類別）",
  };
  const listed = [
    ...check.notRun.map((t) => `  - ${t.fqcn}${fw(t)}：${WHAT[t.origin]}`),
    ...check.allSkipped.map(({ test, tests }) => `  - ${test.fqcn}：你新寫的測試類別，${tests} 個測試全部被略過（skipped）`),
  ];
  const lines = [
    `編譯與測試都通過，但有 ${listed.length} 個該執行的測試類別沒有真的被執行——沒被執行的測試不算數，本輪判 FAIL：`,
    ...listed.slice(0, MAX_NOT_RUN_LISTED),
    ...(listed.length > MAX_NOT_RUN_LISTED ? [`  …另 ${listed.length - MAX_NOT_RUN_LISTED} 個`] : []),
  ];
  // Which frameworks do run here: this build's other classes, or failing that the ones that ran
  // before the writer.
  const evidence = check.ran.length ? check.ran : check.ranBefore;
  const counts = new Map<string, number>();
  for (const r of evidence) counts.set(r.framework ?? "框架不明", (counts.get(r.framework ?? "框架不明") ?? 0) + 1);
  const tally = [...counts].map(([k, v]) => `${k} 寫法 ${v} 個`).join("、");
  lines.push(
    check.ran.length
      ? `這次建置在本模組執行了 ${check.ran.length} 個測試類別：${tally}。`
      : check.ranBefore.length
        ? `這次建置在本模組沒有執行其他測試類別；writer 介入前的建置執行的是：${tally}。`
        : "這次建置在本模組沒有執行任何其他測試類別。",
  );
  // The framework to rewrite in: the one most of what runs here is written in.
  const runs = [...counts].filter(([k]) => k !== "框架不明").sort((a, b) => b[1] - a[1]).map(([k]) => k as TestFramework);
  const example = evidence.find((r) => r.framework)?.fqcn ?? evidence[0]?.fqcn;
  lines.push("原因與修法：");
  const unexplained: string[] = [];
  for (const t of check.notRun.slice(0, MAX_NOT_RUN_LISTED)) {
    const causes: string[] = [];
    if (t.framework && runs.length && !runs.includes(t.framework)) {
      causes.push(
        `它是 ${t.framework} 寫法，而本模組被執行的測試都是 ${runs.join("、")} 寫法——這個模組的建置不執行 ${t.framework} 測試。` +
          `改用 ${HOW_TO_WRITE[runs[0]]}寫`,
      );
    }
    if (tool === "maven" && !includedByDefault(t.fqcn)) {
      causes.push("類名不符 surefire 預設的 includes（Test*、*Test、*Tests、*TestCase）——改成以 Test 結尾的名字（模組若在 pom 自訂了 includes，以 pom 為準）");
    }
    if (t.disabled) causes.push("類別層級被停用（@Disabled / @Ignore / @Test(enabled = false)）——拿掉它");
    if (!causes.length && t.origin === "untouched") unexplained.push(t.fqcn);
    else if (!causes.length) {
      causes.push(
        "從原始碼看不出原因：可能是 surefire 的 includes/excludes、測試框架的 provider 或 engine、類別或方法的可見性（private 的 @Test 不會被執行）" +
          (example ? `——對照本模組有被執行的 ${example} 的寫法` : ""),
      );
    }
    lines.push(...causes.map((c) => `  - ${t.fqcn}：${c}`));
  }
  // Classes nobody touched stopped running together, for one reason: say it once.
  if (unexplained.length) {
    lines.push(
      `  - ${unexplained.length === 1 ? unexplained[0] : `上面 ${unexplained.length} 個既有類別`}本身沒被改過：看看這輪改了哪些共用的東西——` +
        "測試資源（junit-platform.properties、META-INF/services 底下的設定）、基底類別、suite 設定",
    );
  }
  for (const { test } of check.allSkipped.slice(0, MAX_NOT_RUN_LISTED)) {
    lines.push(
      `  - ${test.fqcn}：測試全部被略過——檢查 assumption（assumeTrue / assumeFalse / assumingThat）、@Disabled / @Ignore、@EnabledIf… 之類的條件，單元測試不該依環境略過`,
    );
  }
  return lines.join("\n");
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

type BuildOptions = {
  allowZeroTests?: boolean;
  onlyTests?: string[];
  tolerate?: string[];
  // Test classes the build must have run for its green to count: see checkTestsRan.
  mustRun?: ExpectedTest[];
  // The classes that ran before the writer, for the report's "which frameworks run here".
  ranBefore?: string[];
};

export async function runBuildAndTests(
  tool: BuildTool,
  mod: ModuleInfo,
  // onlyTests: run just these test classes (simple names). Compilation is unaffected — the
  // whole module's test sources still have to compile — so this narrows execution, not scope.
  // tolerate: the baseline's failing identities. Set only by loop.ts under
  // UT_ALLOW_DIRTY_BASELINE; absent means the gate keeps its "module is green" requirement.
  opts: BuildOptions = {},
): Promise<GateResult> {
  return (await runBuild(tool, mod, opts)).gate;
}

// The build plus whether it reached a verdict at all. `aborted` is set when it did not — timed
// out, or killed by a signal (the OOM killer's SIGKILL is the usual one). The gate report says so
// either way; runBaseline needs the distinction, because an aborted baseline has no failures to
// locate and was classified as a red module nobody could name, ending in a repair loop that
// gave up with advice about Lombok.
async function runBuild(
  tool: BuildTool,
  mod: ModuleInfo,
  opts: BuildOptions,
): Promise<{ gate: GateResult; aborted?: string; notRun?: string[]; startedAt: number }> {
  const isWin = process.platform === "win32";
  // Taken before the build so stale reports from an earlier round can be told apart.
  const startedAt = Date.now();
  let r: { code: number; out: string; timedOut?: boolean; signal?: NodeJS.Signals };

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
    const hung = tool === "maven" ? unfinishedTestClasses(r.out) : [];
    const stuckIn = hung.length ? `；逾時當下仍在執行的測試類別：${hung.join("、")}` : "";
    return {
      gate: {
        passed: false,
        report:
          `建置/測試逾時（${BUILD_TIMEOUT_MS}ms），已終止程序樹${stuckIn}。` +
          `常見原因：依賴解析卡住、測試含真實網路 I/O 或無限等待。可調整 UT_BUILD_TIMEOUT_MS。`,
        raw: r.out,
      },
      aborted: `建置/測試逾時（UT_BUILD_TIMEOUT_MS=${BUILD_TIMEOUT_MS}ms），已終止程序樹${stuckIn}`,
      startedAt,
    };
  }
  if (r.signal) {
    const why =
      `建置程序被 ${r.signal} 終止，沒有跑完——這不是編譯或測試失敗。` +
      (r.signal === "SIGKILL" ? "常見原因：記憶體不足被 OOM killer 收掉（dmesg 可查）。" : "");
    return { gate: { passed: false, report: why, raw: r.out }, aborted: why, startedAt };
  }

  // Green counts only with the tests that had to run among those that did.
  const notRun = (): { gate: GateResult; notRun: string[]; startedAt: number } | null => {
    const unrun = notRunReport(tool, mod, startedAt, r.out, opts.mustRun, opts.ranBefore);
    return unrun && { gate: { passed: false, report: unrun.report, raw: r.out }, notRun: unrun.classes, startedAt };
  };

  if (r.code === 0) {
    const zeroReport =
      ALLOW_ZERO_TESTS || opts.allowZeroTests ? null : detectZeroTests(tool, mod, r.out);
    const unrun = notRun();
    // Nothing ran at all: that first, and then why the writer's own classes were not among it.
    if (zeroReport) {
      return {
        gate: { passed: false, report: unrun ? `${zeroReport}\n\n${unrun.gate.report}` : zeroReport, raw: r.out },
        notRun: unrun?.notRun,
        startedAt,
      };
    }
    if (unrun) return unrun;
    return { gate: { passed: true, report: "編譯與測試全數通過。", raw: r.out }, startedAt };
  }

  // Dirty-baseline subtraction: the gate's promise weakens from "the module is green" to
  // "the module is no worse than before the writer touched it", and only when the operator
  // asked for that. Every test still runs — this compares results, it does not skip any.
  let broke = "";
  if (opts.tolerate?.length && tool === "maven") {
    const v = subtractTolerated(r.out, failingSuites(mod.moduleRoot, startedAt), opts.tolerate);
    if (v.pass) {
      const unrun = notRun();
      if (unrun) return unrun;
      return {
        startedAt,
        gate: {
          passed: true,
          report:
            `編譯通過。${v.current.length} 個失敗全部是 writer 介入前就存在的，` +
            `依 UT_ALLOW_DIRTY_BASELINE 放行：\n` +
            v.current.map((id) => `  - ${id}`).join("\n"),
          raw: r.out,
        },
      };
    }
    log(`[dirty-baseline] 不予扣除：${v.reason}`);
    // Named in the report, not just the log: "these are the ones you broke" is the single most
    // actionable line the writer can get when the module was already red — without it the
    // feedback is a wall of failures it has been told to ignore, plus the ones it must not.
    if (v.unexpected.length) {
      broke =
        `\n這些失敗在 writer 介入前**不存在**，是本輪造成的，必須修好（其餘既有失敗請勿理會）：\n` +
        v.unexpected.map((id) => `  - ${id}`).join("\n") + "\n";
      v.unexpected.forEach((id) => log(`  新失敗：${id}`));
    }
  }

  const failures =
    tool === "maven"
      ? collectSurefireFailures(mod.moduleRoot, startedAt)
      : collectGradleFailures(mod.moduleRoot);

  return {
    gate: {
      passed: false,
      report:
        `編譯或測試失敗（exit=${r.code}）。${broke}\n錯誤節錄：\n${summarizeBuildErrors(r.out)}\n${failures}`,
      raw: r.out,
    },
    startedAt,
  };
}

// The ran check as the gate uses it: the report and the classes it names, or null when every one
// ran — or when the build left nothing to tell by, which is said in the log instead.
function notRunReport(
  tool: BuildTool,
  mod: ModuleInfo,
  since: number,
  out: string,
  mustRun: ExpectedTest[] | undefined,
  ranBefore: string[] | undefined,
): { report: string; classes: string[] } | null {
  if (!mustRun?.length) return null;
  const check = checkTestsRan(tool, mod, since, out, mustRun, ranBefore);
  if (!check) {
    log("[WARN] 無法確認 writer 寫的測試有被執行：這次建置在模組裡沒有留下測試報告，log 也沒有列出執行了哪些測試類別");
    return null;
  }
  const report = renderRanCheck(check, tool);
  if (!report) return null;
  return { report, classes: [...check.notRun.map((t) => t.fqcn), ...check.allSkipped.map((a) => a.test.fqcn)] };
}
