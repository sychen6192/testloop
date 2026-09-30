// Hard gate: compile + test, module-aware.
// Maven: reactor pom at REPO_ROOT -> `mvn -pl <module> -am test` from root; else `mvn test` in the module.
// Gradle: `-p <module>` for multi-module (best-effort; Maven is the primary path).
// Test reports are read from the *module's* target/build, not the repo root.
import * as fs from "node:fs";
import * as os from "node:os";
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
import { codeOnly, decodeJavaSource, javaStringValue } from "../libs/javasrc";
import { shLive } from "../libs/shell";
import { pomFactsFromChain, readPomChain } from "../libs/teststack";
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
  // The classes of the failing test cases (their @classname, outer class): where a report is per
  // suite — TestNG's TestSuite, a JUnit 4 Suite — failingTestClasses names the suite, not the class.
  failingCaseClasses?: string[];
  // Green only because the target module's tests never ran: surefire said "Tests are skipped."
  // (skipTests or maven.test.skip, from a pom, settings.xml or .mvn/maven.config). Every round's
  // build would say the same, and no test the writer writes would ever run. Why, and what to set.
  testsSkipped?: string;
}

/**
 * Pure: the JaCoCo exec files a build's agents append to, from the line jacoco-maven-plugin's
 * prepare-agent logs — `argLine set to -javaagent:…jacoco…jar=destfile=X,append=true`, the whole
 * argument quoted when a path has a space, the property name a pom may change. -Djacoco.append=false
 * only sets the default: a pom's <append>true</append> wins over it, and an agent given no append
 * option appends. Measured on JaCoCo 0.8.8: with <append>true</append>, a test removed after one
 * build left the next build's report at the removed test's coverage (branch 2/2 instead of 1/2).
 */
export function appendingJacocoExecFiles(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!/ set to /.test(line)) continue;
    for (const m of line.matchAll(/"-javaagent:([^"]*)"|-javaagent:(\S+)/g)) {
      const arg = m[1] ?? m[2];
      const at = arg.search(/jacoco[^=]*\.jar=/i);
      if (at < 0) continue;
      const opts = arg.slice(arg.indexOf("=", at) + 1);
      const option = (k: string) => new RegExp(`(?:^|,)${k}=([^,]*)`).exec(opts)?.[1];
      const dest = option("destfile");
      if (dest && option("append") !== "false") files.push(dest);
    }
  }
  return [...new Set(files)];
}

// The exec files this run's builds were seen appending to (see appendingJacocoExecFiles), removed
// before every later build so that each report counts that build alone: the round-1 test the
// writer since deleted, the rolled-back batch's tests, the developer's own `mvn test`. The module's
// default target/jacoco.exec goes every time — a build rewrites it anyway unless it appends — so only
// a destfile configured elsewhere depends on having been seen, which the baseline build does first.
const appendingExec = new Set<string>();

function clearCoverageData(mod: ModuleInfo): void {
  for (const f of new Set([path.join(mod.moduleRoot, "target", "jacoco.exec"), ...appendingExec])) {
    try {
      fs.rmSync(f, { force: true });
    } catch (e) {
      log(`[WARN] 無法刪除 JaCoCo 的 exec 檔 ${f}（${(e as Error).message}）：這次的覆蓋率會含前幾次建置的資料`);
    }
  }
}

/** Pure: the exec files among `files` that are this repo's to remove — `.exec` files inside it. */
export function ownedExecFiles(files: string[], repoRoot: string): string[] {
  return files
    .map((f) => path.resolve(repoRoot, f))
    .filter((abs) => {
      const rel = path.relative(repoRoot, abs);
      return /\.exec$/i.test(abs) && rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    });
}

function learnAppendingExec(out: string): void {
  for (const abs of ownedExecFiles(appendingJacocoExecFiles(out), REPO_ROOT)) {
    if (appendingExec.has(abs)) continue;
    appendingExec.add(abs);
    log(
      `[WARN] JaCoCo 把覆蓋率累加進 ${path.relative(REPO_ROOT, abs).replace(/\\/g, "/")}（append 不是 false——pom 的設定蓋過了 -Djacoco.append=false）：` +
        "之後每次建置前先刪掉它，覆蓋率才只算那次建置",
    );
  }
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
  // Its @classname as written: the test class itself where the suite is not the class — TestNG's
  // TEST-TestSuite.xml, a JUnit 4 @RunWith(Suite) — though a @DisplayName where JUnit 5 names it.
  className?: string;
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
  // Every test case in document order, named as `cases` are, and how it ended; the failed ones are
  // `cases`, in the same order. Gradle's test-retry plugin writes each attempt as a test case of its
  // own, after the attempt it retries: see failingAfterRetries.
  runs?: Array<{ name: string; outcome: "passed" | "failed" | "skipped" }>;
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

  // The markup, with every CDATA section blanked to spaces of the same length. A test's captured
  // output and every stack trace are CDATA, and an unescaped "</testcase>" or "<error …>" in them is
  // text: read as markup, a logged SOAP fault made a passing test fail, and the first attempt of a
  // flaky test that passed on its rerun — kept in a <flakyFailure> — made that test fail. Offsets
  // found here read the same span of `xml`.
  const blank = (t: string) => t.replace(/[^\n]/g, " ");
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, blank);
  const cases: SurefireCase[] = [];
  const runs: NonNullable<SurefireSuite["runs"]> = [];
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(markup))) {
    const method = attr(m[1], "name");
    const className = attr(m[1], "classname");
    const nested = className.includes("$")
      ? className.slice(className.lastIndexOf("$") + 1)
      : className && className !== suite
        ? className
        : "";
    const name = nested ? `${nested}.${method}` : method;
    // <flakyFailure>, <rerunFailure> and <skipped> are other elements: not this round's failures.
    const fail = m[2] ? /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(m[2]) : null;
    if (!fail) {
      runs.push({ name, outcome: /<skipped\b/.test(m[2] ?? "") ? "skipped" : "passed" });
      continue;
    }
    runs.push({ name, outcome: "failed" });
    const bodyAt = m.index + m[0].length - "</testcase>".length - m[2].length;
    // Its content from the document itself, CDATA and all: that is where the stack trace is.
    const contentAt = bodyAt + fail.index + fail[0].length - `</${fail[1]}>`.length - (fail[3]?.length ?? 0);
    const content = fail[3] === undefined ? "" : xml.slice(contentAt, contentAt + fail[3].length);
    const stack = unescapeXml(content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
    const message = unescapeXml(attr(fail[2], "message")) || attr(fail[2], "type");
    cases.push({
      kind: fail[1] as "failure" | "error",
      name,
      ...(className ? { className } : {}),
      message: message.replace(/\s+/g, " ").trim(),
      frame: firstProjectFrame(stack),
      trace: stack.length > 20_000 ? stack.slice(0, 20_000) : stack,
    });
  }
  return { suite, tests: num("tests"), failures: num("failures"), errors: num("errors"), cases, runs };
}

/**
 * Pure: the failing test cases of a suite, the retries a build ran counted. `retries`: the build
 * retries a failing test (Gradle's test-retry plugin or Develocity's — gradleRetriesTests), writing
 * each attempt as a test case of its own after the one it retries; a failure that a later case of
 * the same name passed is then a retry that passed, each passing case answering one failure before it.
 * Nowhere else: two tests go by one name — a @DisplayName given twice, two parameterized methods
 * called with the same arguments ("[2] -1") — and one of them passing says nothing about the other.
 */
export function failingAfterRetries(suite: SurefireSuite, retries: boolean): SurefireCase[] {
  if (!retries || !suite.runs) return suite.cases;
  // name → indexes into `cases` of the failures no pass has answered yet, oldest first.
  const open = new Map<string, number[]>();
  let failed = 0;
  for (const r of suite.runs) {
    if (r.outcome === "failed") {
      const q = open.get(r.name) ?? [];
      q.push(failed++);
      open.set(r.name, q);
    } else if (r.outcome === "passed") {
      open.get(r.name)?.shift();
    }
  }
  const still = new Set([...open.values()].flat());
  return suite.cases.filter((_, i) => still.has(i));
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

/**
 * Pure: does this report record a failing test? A <failure> or <error> element under a test case
 * — a class whose @BeforeAll / @BeforeClass threw included, surefire records it as a case too — and
 * not the testsuite's counters: surefire 2.x counts a flaky test that passed on a rerun
 * (rerunFailingTestsCount, JUnit 4) in failures="1" with nothing but a <flakyFailure> under it, on a
 * green build. The counters decide only for a report that lists no test case at all.
 */
export function suiteRecordsFailure(suite: SurefireSuite, xml: string): boolean {
  return suite.cases.length > 0 || (suite.failures + suite.errors > 0 && !/<testcase\b/.test(xml));
}

// One report of this build, if it records a failing test.
function failingSuiteIn(dir: string, f: string): SurefireSuite | null {
  let suite: SurefireSuite | null = null;
  let xml = "";
  try {
    xml = readSurefireXml(path.join(dir, f));
    suite = parseSurefireXml(xml);
  } catch (e) {
    // Truncated by a crashed JVM, or unreadable — the .txt fallback still applies, but a
    // failing suite that disappears from the report must at least leave a trace in the log.
    log(`[WARN] 無法解析 surefire 報告 ${f}：${e instanceof Error ? e.message : String(e)}`);
  }
  return suite && suiteRecordsFailure(suite, xml) ? { ...suite, dir } : null;
}

function failingSuites(moduleRoot: string, since: number): SurefireSuite[] {
  const out: SurefireSuite[] = [];
  for (const dir of surefireDirs(moduleRoot)) {
    for (const f of freshFiles(dir, "TEST-", ".xml", since)) {
      const suite = failingSuiteIn(dir, f);
      if (suite) out.push(suite);
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

// Gradle's test results that record a failing test. Not filtered by time: the build deletes them
// before the test task runs (runBuild), so the directory holds this build's execution only. Read
// only where the build exited 0 — one that failed before its test task ran has none.
function gradleFailingSuites(mod: ModuleInfo): SurefireSuite[] {
  const dir = path.join(mod.moduleRoot, "build", "test-results", "test");
  if (!fs.existsSync(dir)) return [];
  const retries = gradleRetriesTests();
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"))
    .sort()
    .map((f) => failingSuiteIn(dir, f))
    .flatMap((suite) => {
      if (!suite) return [];
      // The test-retry plugin writes each attempt as a test case of its own (unless mergeReruns folds
      // them into a <flakyFailure>, as surefire does): a test a retry of which passed is not failing.
      const cases = failingAfterRetries(suite, retries);
      if (suite.cases.length && !cases.length) return [];
      // Not a surefire-reports directory: moduleOfSurefireDir would place it in <module>/build, and
      // the baseline would call the writer's own module out of its reach.
      return [{ ...suite, cases, dir: undefined }];
    });
}

/**
 * The text of this Gradle build's configuration, comments aside: its build scripts, version catalogs
 * and precompiled script plugins (src/main/groovy, src/main/kotlin — a test's fixture scripts configure
 * no build of this repo), and the init scripts in the Gradle user home. Read once per root: the scope
 * guard keeps the writer off all of it.
 */
const gradleConfigMemo = new Map<string, string[]>();
function gradleConfigTexts(root: string, userHome: string): string[] {
  const key = `${path.resolve(root)}\0${path.resolve(userHome)}`;
  const memo = gradleConfigMemo.get(key);
  if (memo) return memo;
  const files: string[] = [];
  const script = /\.gradle(?:\.kts)?$/;
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || files.length >= 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const under = path.basename(dir);
    const inSrcMain = under === "main" && path.basename(path.dirname(dir)) === "src";
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || ["node_modules", "build", "target", "out"].includes(e.name)) continue;
        if (under === "src" && e.name !== "main") continue;
        if (inSrcMain && !["groovy", "kotlin"].includes(e.name)) continue;
        walk(p, depth + 1);
      } else if (e.isFile() && (script.test(e.name) || /\.versions\.toml$/.test(e.name) || (under === "gradle" && e.name.endsWith(".toml")))) {
        files.push(p);
      }
    }
  };
  walk(root, 0);
  for (const f of ["init.gradle", "init.gradle.kts"]) files.push(path.join(userHome, f));
  try {
    for (const f of fs.readdirSync(path.join(userHome, "init.d")).sort()) if (script.test(f)) files.push(path.join(userHome, "init.d", f));
  } catch {
    /* no init scripts */
  }
  const texts = files.flatMap((f) => {
    try {
      if (!fs.statSync(f).isFile()) return [];
      const text = fs.readFileSync(f, "utf8");
      return [f.endsWith(".toml") ? text.replace(/^\s*#.*$/gm, "") : codeOnly(text, true)];
    } catch {
      return [];
    }
  });
  gradleConfigMemo.set(key, texts);
  return texts;
}

const gradleUserHome = () => process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle");

/**
 * Whether this Gradle build may retry a failing test: its configuration (gradleConfigTexts) applies
 * the test-retry plugin — org.gradle.test-retry by its id, through a version catalog, or from a
 * convention plugin that depends on test-retry-gradle-plugin — or configures a retry block
 * (test-retry's retry, Develocity's testRetry). Only then is a failure that a later test case of the
 * same name passed a retry that passed (failingAfterRetries). A retry applied from outside the repo
 * is not seen: every failure then counts, which can turn a round red that a retry made green, never
 * the other way.
 */
const TEST_RETRY = /org\.gradle\.test-?retry|test-retry-gradle-plugin|\btestRetry\b|\bretry\s*\{|\bretry\.maxRetries\b/;
export function gradleRetriesTests(root: string = REPO_ROOT, userHome: string = gradleUserHome()): boolean {
  return gradleConfigTexts(root, userHome).some((t) => TEST_RETRY.test(t));
}

/** Whether this Gradle build may run TestNG: its configuration names it (useTestNG, the org.testng artifacts). */
export function gradleMayRunTestNG(root: string = REPO_ROOT, userHome: string = gradleUserHome()): boolean {
  return gradleConfigMentions(/\buseTestNG\b|\borg\.testng\b/, root, userHome);
}

/** Whether this Gradle build's configuration (gradleConfigTexts) says `what` anywhere. */
export function gradleConfigMentions(what: RegExp, root: string = REPO_ROOT, userHome: string = gradleUserHome()): boolean {
  return gradleConfigTexts(root, userHome).some((t) => what.test(t));
}

// The failing tests of this Gradle build, as its test results say — retries counted
// (gradleFailingSuites) — rendered as a surefire report is: each failing test by name, its message,
// its first frame; a result file that does not parse is quoted as it is. Where no test failed to the
// end and one passed only when retried, that is what turned the build red (the test-retry plugin's
// failOnPassedAfterRetry): those tests, and what their failed attempts said — not failures.
function collectGradleFailures(mod: ModuleInfo): string {
  const suites = gradleFailingSuites(mod);
  const shown = suites.slice(0, MAX_FAILURE_BLOCKS);
  let failures = shown.map((s) => `\n${renderSurefireSuite(s)}`).join("");
  if (suites.length > shown.length) failures += `\n（另有 ${suites.length - shown.length} 個失敗的測試類別未列出，見 build.log）`;
  const dir = path.join(mod.moduleRoot, "build", "test-results", "test");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"));
  } catch {
    /* no test results */
  }
  for (const f of files) {
    let xml: string;
    try {
      xml = readSurefireXml(path.join(dir, f));
    } catch {
      continue;
    }
    let parsed = false;
    try {
      parsed = parseSurefireXml(xml) !== null;
    } catch {
      /* quoted as it is */
    }
    if (parsed) continue;
    const blocks = [
      ...(xml.match(/<failure[^>]*>[\s\S]*?<\/failure>/g) ?? []),
      ...(xml.match(/<error[^>]*>[\s\S]*?<\/error>/g) ?? []),
    ];
    for (const b of blocks) {
      const msg = b.replace(/<[^>]*>/g, "").trim();
      if (msg) failures += `\n----- ${f} -----\n${tail(msg, 1500)}`;
    }
  }
  if (failures) return failures;
  const retried = flakyTestCases("gradle", mod, 0, "");
  if (!retried.length) return "";
  return [
    "\n沒有測試失敗到最後，但這些測試失敗之後重試才通過——它們不穩定（test-retry 設了 failOnPassedAfterRetry 時，建置因此失敗）：",
    ...retried.slice(0, MAX_FAILURE_CASES).map((c) => `  ✗ ${c.cls}${c.test ? ` › ${c.test}` : ""}${c.message ? `\n    第一次失敗：${clampText(c.message, 500)}` : ""}`),
    ...(retried.length > MAX_FAILURE_CASES ? [`  （另有 ${retried.length - MAX_FAILURE_CASES} 個未列出，見 build.log）`] : []),
    "請讓它們每一次都得到相同的結果，不要靠重試。",
  ].join("\n");
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
  // The [ERROR] prefix is optional: under testFailureIgnore surefire 2.x logs the crash as one
  // multi-line message, and only its first line gets a level.
  for (let i = 0; i < lines.length; i++) {
    if (!/^(?:\[ERROR\]\s+)?Crashed tests:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^(?:\[ERROR\]\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*$/.exec(lines[j]);
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
 * The test classes a red Maven build failed in, each with the module whose reports name it, when
 * failing tests are all it failed on: no compile error, and every failure named — in a report
 * written since `since`, or as a class whose forked JVM crashed (placed in the target module, where
 * surefire ran it). undefined otherwise, and for gradle. Whether a rebuild can change the verdict
 * depends on it: a compile error does not come and go, a flaky test does.
 */
export function testOnlyFailures(
  tool: BuildTool,
  mod: ModuleInfo,
  since: number,
  raw: string,
): Array<{ cls: string; module: string }> | undefined {
  if (tool !== "maven" || extractCompileErrorFiles(raw, tool).length) return undefined;
  const suites = failingSuites(mod.moduleRoot, since);
  // A suite report — TestNG's one TEST-TestSuite.xml, a JUnit 4 Suite's — names the suite, which has no
  // source to tell touched from untouched, or is not the class that failed: the failing cases' own
  // classes are, where their module has their source.
  const sourceIn = (module: string, cls: string) =>
    fs.existsSync(path.join(module, "src", "test", "java", ...cls.split(".")) + ".java");
  const failing = suites.length
    ? suites.flatMap((s) => {
        const module = s.dir ? moduleOfSurefireDir(s.dir) : mod.moduleRoot;
        const own = [...new Set(s.cases.map((c) => outerClassName(c.className ?? "")))].filter(
          (c) => c && c !== outerClassName(s.suite) && sourceIn(module, c),
        );
        return own.length ? own.map((cls) => ({ cls, module })) : [{ cls: s.suite, module }];
      })
    : surefireDirs(mod.moduleRoot).flatMap((dir) =>
        failingReports(dir, since).map((f) => ({ cls: f.replace(/\.txt$/, ""), module: moduleOfSurefireDir(dir) })),
      );
  for (const c of crashedTestClasses(raw)) {
    if (!failing.some((f) => f.cls === c)) failing.push({ cls: c, module: mod.moduleRoot });
  }
  return failing.length ? failing : undefined;
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
  // The module's source encoding (Java's name), for reading its test classes' @DisplayName.
  charset?: string,
): Promise<BaselineResult> {
  const startedAt = Date.now();
  const tag = phase === "repair" ? "修復後建置" : "預檢基準";
  log(
    phase === "repair"
      ? "修復驗證：重新建置，確認既有紅燈是否清除"
      : "預檢：在 writer 介入前先建置一次，取得既有紅燈基準",
  );
  const { gate: r, aborted, notRun, ignoredBy, startedAt: builtAt } = await runBuild(tool, mod, { allowZeroTests: true, mustRun, ranBefore, charset });
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
    // Green because nothing ran is not a baseline: every round's build would be the same zero
    // tests, and the gate would feed the writer "write a test class" until the run ended stuck.
    // Unless the module has no test sources yet: a profile activated by <missing>src/test/java</missing>
    // that sets skipTests is a common way to build modules without tests, and it lets go the moment
    // the writer writes one. If it does not, the gate says what to set.
    let skipped =
      phase === "baseline" && tool === "maven" && testsSkippedInLog(r.raw ?? "", moduleArtifactId(mod))
        ? TESTS_SKIPPED_HINT
        : undefined;
    if (skipped && !hasJavaFile(path.join(mod.moduleRoot, "src", "test", "java"))) {
      log(
        "[WARN] 目標模組的測試被跳過（Tests are skipped.），但模組還沒有任何測試原始碼——常見的 profile 以 " +
          "<missing>src/test/java</missing> 啟用 skipTests，writer 寫出測試後就會執行，照常開始；若之後仍被跳過，gate 會說明要設什麼",
      );
      skipped = undefined;
    }
    return {
      clean: !skipped,
      compileErrorFiles: [],
      failingTestClasses: [],
      outOfScope: [],
      envFailures: [],
      failureDetail: "",
      failingTests: [],
      summary: skipped ? `${tag}：${skipped}` : `${tag}：乾淨（模組可編譯且測試全過）。`,
      raw: r.raw ?? "",
      ranTests,
      testsSkipped: skipped,
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
  // Gradle's only where it exited 0 over them (ignoreFailures) — see gradleFailingSuites. Without
  // them a Gradle baseline red that way could neither be repaired (nothing named) nor tolerated.
  const suites = tool === "maven" ? failingSuites(mod.moduleRoot, startedAt) : ignoredBy ? gradleFailingSuites(mod) : [];
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
  // The operator's own `mvn test` says BUILD SUCCESS on this module; without this line the red
  // baseline reads as the tool's mistake.
  if (ignoredBy) lines.push(`（${ignoredBy}；loop 不看 exit code。）`);
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
      : collectGradleFailures(mod);
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
    failingCaseClasses: [...new Set(suites.flatMap((s) => s.cases.map((c) => outerClassName(c.className ?? "")).filter(Boolean)))].sort(),
    summary: lines.join("\n"),
    raw,
    ranTests,
  };
}

/** The test classes a build ran in the module: its fresh reports, and surefire's log lines. */
export function ranTestClasses(tool: BuildTool, mod: ModuleInfo, since: number, out: string): string[] {
  const check = checkTestsRan(tool, mod, since, out, [], [], true);
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
  /** The class's own @DisplayName: what surefire's phrased reporters name it by instead of its FQCN. */
  displayName?: string;
  /** It has a class-level @DisplayName whose text is no string literal here (a constant): a name it goes by, unknown. */
  displayNameUnread?: boolean;
  /**
   * Set by checkTestsRan on a class it did not see run: the other classes of the module whose
   * @DisplayName is the same as its own, while a report goes by that name — surefire writes one report
   * for a name, and which class's it is, nothing tells.
   */
  sharedName?: string[];
  /**
   * "created": the writer's new class — one whose every test was skipped is not run either.
   * "changed": a class the writer edited that ran before it did. "grown": one it added tests to
   * that did not run before either. "untouched": a class that ran before the writer, and that
   * nothing the writer did may stop running.
   */
  origin: "created" | "changed" | "grown" | "untouched";
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
  // The class's own annotations: after the statement before it (the last import, a type before it)
  // and before it. A ";" or "}" inside an annotation's arguments — @ExtendWith({A.class, B.class}) —
  // is not where they start: only one outside every parenthesis.
  const head = code.slice(0, decl.index + 1);
  let ownStart = 0;
  for (let i = 0, depth = 0; i < head.length; i++) {
    const c = head[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (!depth && (c === ";" || c === "}")) ownStart = i + 1;
  }
  const own = head.slice(ownStart);
  const disabled = /@(?:[\w.]+\.)?(?:Disabled|Ignore)\b|@(?:[\w.]+\.)?Test\s*\([^)]*\benabled\s*=\s*false/.test(own);
  // Its text is a string literal, which codeOnly blanked: read at the same place in the source, and
  // taken as JUnit takes it — escapes translated, trimmed as Java trims (what is at most U+0020; an
  // ideographic space stays); a blank one is no name. Anything but one literal (a constant, a
  // concatenation) is a name this cannot read.
  const literal = /@(?:[\w.]+\.)?DisplayName\s*\(\s*(?:value\s*=\s*)?"((?:[^"\\\n]|\\.)*)"\s*\)/.exec(src.slice(ownStart, decl.index + 1))?.[1];
  const shown = literal === undefined ? "" : javaStringValue(literal).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  const unread = literal === undefined && /@(?:[\w.]+\.)?DisplayName\s*\(/.test(own);
  return {
    file,
    fqcn: pkg ? `${pkg}.${name}` : name,
    framework: testFrameworkOf(code),
    disabled,
    ...(shown ? { displayName: shown } : {}),
    ...(unread ? { displayNameUnread: true } : {}),
    origin,
  };
}

/**
 * Pure: the simple names surefire's default includes run — Test*, *Test, *TestCase, and *Tests
 * from 2.20 (2.12.4, what Maven 3.8 binds when the pom names no version, does not run CalcTests).
 * An unknown version is taken as a recent one.
 */
export function includedByDefault(fqcn: string, surefireVersion?: string): boolean {
  const simple = fqcn.split(".").pop() ?? "";
  if (/^Test|Test$|TestCase$/.test(simple)) return true;
  if (!/Tests$/.test(simple)) return false;
  const m = /^(\d+)\.(\d+)/.exec(surefireVersion ?? "");
  return !m || Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 20);
}

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
  /** The surefire version the build log shows, for what its default includes are. */
  surefireVersion?: string;
}

/**
 * Pure: the class a reported name belongs to — `com.x.CalcTest$Inner` is com.x.CalcTest's — and a name
 * that is no Java class name, a @DisplayName under surefire's phrased reporters ("滿 NT$1000 折 NT$100",
 * "NT$1000折扣"), as it is: cut at its "$", it is nobody's. A nested class's name after the "$" starts
 * as an identifier does, never with a digit.
 */
export function outerClassName(name: string): string {
  return /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(name) ? name.replace(/\$[\p{L}_].*$/u, "") : name;
}

// A class ran when something names it: its own report (TEST-<fqcn>.xml, <fqcn>.txt, with a
// reportNameSuffix or for a @Nested class after it), a suite report's test cases (TestNG writes one
// TEST-TestSuite.xml for everything), or surefire's "Running <fqcn>" line.
const names = (fqcn: string, name: string) => name === fqcn || name.startsWith(`${fqcn}$`) || name.startsWith(`${fqcn}-`);
// Or its @DisplayName, where surefire's phrased reporters name it by that: exactly as JUnit read it
// from the source, which is how the report holds it inside.
const sameShown = (a: string, b: string) => a.normalize("NFC") === b.normalize("NFC");

/**
 * The name a report goes by inside it — its testsuite's (XML), its "Test set:" (a .txt summary) — for a
 * report whose file name is no class's: a phrased one, a suite's. What is inside is UTF-8 and whole,
 * where the file name is the JVM's file-name encoding's (a POSIX locale writes "計算機測試" as "?????")
 * and one per name (two classes of the same @DisplayName write one file, the last one's). undefined when
 * it cannot be read.
 */
function reportNameInside(file: string): string | undefined {
  const text = readHead(file);
  if (text === undefined) return undefined;
  const tag = /<testsuite\b[^>]*>/.exec(text)?.[0];
  const name = tag ? unescapeXml(attr(tag, "name")) : /^Test set:[ \t]*(.*?)[ \t]*\r?$/m.exec(text)?.[1];
  return name && !name.includes("\uFFFD") ? name : undefined;
}

/**
 * Pure: can `fileName`, a report's name, be `shown` written by a JVM whose file-name encoding could not
 * hold all of it? Every character it could not is one "?", every other one is there as it is: under a
 * POSIX locale "計算機測試" is "?????". Only a name with a "?" in it; and only one character for one, so
 * "訂單測試" is not "?????" — but "訂單測試" is "????" as much as "計算測試" is: the caller asks whether
 * another class's name fits too.
 */
export function lossyFileNameOf(fileName: string, shown: string): boolean {
  const a = [...fileName.normalize("NFC")];
  const b = [...shown.normalize("NFC")];
  return a.length === b.length && a.includes("?") && a.every((c, i) => c === b[i] || (c === "?" && b[i].codePointAt(0)! > 0x7f));
}

/**
 * Pure: how many tests surefire's console says each class ran, and how many of them it skipped — its
 * "Tests run: 2, Failures: 0, Errors: 0, Skipped: 2, Time elapsed: 0.01 s -- in com.x.CalcTest" lines
 * ("- in" before 3.0). What says a class's tests were all skipped when its reports are written elsewhere.
 */
export function testCountsInLog(out: string): Map<string, { tests: number; skipped: number }> {
  const counts = new Map<string, { tests: number; skipped: number }>();
  for (const m of out.matchAll(/Tests run:\s*(\d+),.*?Skipped:\s*(\d+)\b.*?\s--?\sin\s+([\w.$]+)\s*$/gm)) {
    const c = counts.get(m[3]) ?? { tests: 0, skipped: 0 };
    counts.set(m[3], { tests: c.tests + Number(m[1]), skipped: c.skipped + Number(m[2]) });
  }
  return counts;
}

/** Pure: the classes a surefire console log says it ran. */
export function classesRunInLog(out: string): string[] {
  const found = new Set<string>();
  for (const m of out.matchAll(/(?:\bRunning|\s--?\sin)\s+([\w.$]+)\s*$/gm)) found.add(m[1]);
  return [...found];
}

/**
 * Pure: a Maven log with the prefix its logger puts before each of Maven's own lines taken off — a
 * timestamp (org.slf4j.simpleLogger.showDateTime, set in .mvn/maven.config or MAVEN_OPTS: "12:00:00,123",
 * "2026-09-30 12:00:00", "2026-09-30T12:00:00.123Z"), a thread name (showThreadName: "[main]", and
 * "[ThreadedStreamConsumer]" on surefire's lines). Every parser here reads a line as starting with
 * "[INFO]"; read with the prefix, nothing matched, and a build that ignored its failing tests passed.
 * The prefix's shape is learned from Maven's own first line — digits as any digits, a bracketed name
 * as any — and taken off only where a level tag follows it. A test's output, printed as it is, has no
 * such prefix, and a log without one is returned as it is.
 */
export function normalizeMavenLog(out: string): string {
  const first = /^(.*?)\[(?:INFO|WARNING|WARN|ERROR|DEBUG)\] (?:Scanning for projects|Building |Reactor Build Order|BUILD (?:SUCCESS|FAILURE)|--- |Total time)/m.exec(out);
  const prefix = first?.[1];
  if (!prefix) return out;
  let shape = "";
  for (const m of prefix.matchAll(/\[[^\]\r\n]*\]|\d+|\s+|[^[\d\s]+|\[/g)) {
    const t = m[0];
    if (t.length > 1 && t.startsWith("[") && t.endsWith("]")) shape += "\\[[^\\]\\r\\n]*\\]";
    else if (/^\d+$/.test(t)) shape += "\\d+";
    else if (/^\s+$/.test(t)) shape += "[ \\t]+";
    else shape += t.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  return out.replace(new RegExp(`^${shape}(?=\\[(?:INFO|WARNING|WARN|ERROR|DEBUG|TRACE)\\] )`, "gm"), "");
}

/**
 * Pure: the names a phrased reporter's "Running" lines give (usePhrasedClassNameInRunning): the rest of
 * the line, a class's @DisplayName — "計算機測試", "OrderTest 當折扣 NT$100". Surefire's own lines only,
 * "[INFO] Running …"; one a test printed names no class of the module (checkTestsRan resolves them).
 */
export function phrasedRunningIn(log: string): string[] {
  return [...new Set([...log.matchAll(/^\[INFO\] Running (\S.*?)\s*$/gm)].map((m) => m[1]))];
}

// The class-level @DisplayName of each test class of a module, read once a version of each file: the
// names phrased reports go by. A file without "DisplayName" in it has none, and is not parsed.
const shownCache = new Map<string, { stamp: string; entry?: { fqcn: string; shown?: string } }>();
/**
 * The test classes of a module that go by a class-level @DisplayName: the name, or none when it cannot
 * be read (a constant, a source that will not decode) — then it may be any. Classes without one are
 * not listed.
 */
export function moduleDisplayNames(testRoot: string, charset?: string): Array<{ fqcn: string; shown?: string }> {
  const out: Array<{ fqcn: string; shown?: string }> = [];
  const walk = (d: string) => {
    let es: fs.Dirent[];
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && e.name.endsWith(".java")) {
        let stamp: string;
        try {
          const st = fs.statSync(f);
          stamp = `${st.mtimeMs}:${st.size}:${charset ?? ""}`;
        } catch {
          continue;
        }
        let hit = shownCache.get(f);
        if (hit?.stamp !== stamp) {
          let entry: { fqcn: string; shown?: string } | undefined;
          try {
            const buf = fs.readFileSync(f);
            if (buf.includes("DisplayName")) {
              const t = expectedTestOf(decodeJavaSource(buf, charset), f, "untouched");
              if (t?.displayName) entry = { fqcn: t.fqcn, shown: t.displayName };
              else if (t?.displayNameUnread) entry = { fqcn: t.fqcn };
            }
          } catch {
            entry = { fqcn: path.relative(testRoot, f).slice(0, -".java".length).split(path.sep).join(".") };
          }
          hit = { stamp, entry };
          shownCache.set(f, hit);
        }
        if (hit.entry) out.push(hit.entry);
      }
    }
  };
  walk(testRoot);
  return out;
}

// A Maven plugin execution's header, "[INFO] --- surefire:3.2.5:test (default-test) @ web ---": a whole
// line of Maven's own (a timestamp before the level allowed), never a test's output that says the same
// in the middle of a line. Its goal, and the module it ran for.
const PLUGIN_HEADER = /^(?:[\d:.,T-]+\s+)?\[INFO\] --- (\S.*?) @ (\S+) ---\s*$/;
const isSurefireTest = (goal: string) => /^(?:maven-)?surefire(?:-plugin)?:[^:\s]+:test\b/.test(goal);

/**
 * Pure: the lines of each surefire execution in a Maven log, by the module it ran for — from its
 * header ("--- surefire:3.2.5:test (default-test) @ web ---") to the next plugin's. Surefire is the
 * last goal of `test` a module runs, and the next module starts with a header of its own: nothing in
 * between ends a section — a test that prints "[INFO] Building the report" is still inside it.
 */
export function surefireSections(out: string): Array<{ artifact: string; lines: string[] }> {
  const sections: Array<{ artifact: string; lines: string[] }> = [];
  let current: { artifact: string; lines: string[] } | undefined;
  for (const line of out.split(/\r?\n/)) {
    const header = PLUGIN_HEADER.exec(line);
    if (header) {
      current = isSurefireTest(header[1]) ? { artifact: header[2], lines: [] } : undefined;
      if (current) sections.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return sections;
}

/**
 * Pure: the classes surefire ran for one module of a reactor build — its "Running" lines under that
 * module's executions. Under -pl web -am a class of the same name in an upstream module is another
 * class, and its line said nothing about web's. When the log has no execution for `artifactId` (or it
 * is not known), the module built last: the target, under -pl -am. A log with no execution headers
 * at all (quiet) is read whole.
 */
export function classesRunInModuleLog(out: string, artifactId?: string): string[] {
  return classesRunInLog(moduleSurefireLog(out, artifactId));
}

/** Pure: what surefire printed for one module (see classesRunInModuleLog); the whole log when it has no execution headers. */
export function moduleSurefireLog(out: string, artifactId?: string): string {
  const sections = surefireSections(out);
  if (!sections.length) return out;
  const target = artifactId && sections.some((s) => s.artifact === artifactId) ? artifactId : sections[sections.length - 1].artifact;
  return sections.filter((s) => s.artifact === target).flatMap((s) => s.lines).join("\n");
}

/**
 * Pure: the classes (outer) of the test cases a report says passed only when run again. Surefire's
 * rerunFailingTestsCount keeps the failed attempts in <flakyFailure> / <flakyError> under a case that
 * counts as passed, on a green build. `retries` (a Gradle build that retries failing tests:
 * gradleRetriesTests): the test-retry plugin writes each attempt as a case of its own, a failed one
 * and later one of the same name that passed (mergeReruns folds them as surefire does). `testng`
 * (TestNG may run these tests; left out, the report's test classpath says, and a report without one is
 * taken to): its retry analyzer reports the failed attempt as skipped, its message the failure's, then
 * the one that passed (measured: TestNG 7.5, surefire 2.22.2 and 3.2.5). Nowhere else: two tests go by
 * one name — a @DisplayName given twice, one of them @Disabled; two parameterized methods called with
 * the same arguments — and one of them passing says nothing about the other.
 */
export function flakyClassesInReport(xml: string, retries = false, testng?: boolean): string[] {
  return [...new Set(flakyCasesInReport(xml, retries, testng).map((c) => c.cls).filter(Boolean).map(outerClassName))].sort();
}

/** A test case that failed and then passed when run again: its class as reported, its name, and what the failed attempt said. */
export interface FlakyCase {
  cls: string;
  test: string;
  message: string;
}

/** Pure: the test cases of flakyClassesInReport, one each, with the failed attempt's message. */
export function flakyCasesInReport(xml: string, retries = false, testng?: boolean): FlakyCase[] {
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (t) => t.replace(/[^\n]/g, " "));
  const suite = unescapeXml(attr(/<testsuite\b[^>]*>/.exec(markup)?.[0] ?? "", "name"));
  const classpath = /<property\s+name="surefire\.test\.class\.path"\s+value="([^"]*)"/.exec(markup)?.[1];
  const ng = testng ?? (classpath === undefined || /(?:^|[\\/])testng-\d[^\\/]*\.jar/.test(unescapeXml(classpath)));
  const flaky = new Map<string, FlakyCase>();
  // Test cases that did not pass yet, by class and name — what they said: a later one of the same name
  // that passed was the retry.
  const retried = new Map<string, string>();
  const messageOf = (tag: string | undefined) => (tag ? unescapeXml(attr(tag, "message") || attr(tag, "type")).replace(/\s+/g, " ").trim() : "");
  for (const m of markup.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const cls = unescapeXml(attr(m[1], "classname")) || suite;
    const test = unescapeXml(attr(m[1], "name"));
    const body = m[2] ?? "";
    const id = JSON.stringify([cls, test]);
    const rerun = /<flaky(?:Failure|Error)\b[^>]*>/.exec(body)?.[0];
    if (rerun) flaky.set(id, { cls, test, message: messageOf(rerun) });
    const failed = /<(?:failure|error)\b[^>]*>/.exec(body)?.[0];
    const skipped = /<skipped\b[^>]*>/.exec(body)?.[0];
    if (failed) {
      if (retries) retried.set(id, messageOf(failed));
    } else if (skipped) {
      if (ng) retried.set(id, messageOf(skipped));
    } else if (retried.has(id) && !flaky.has(id)) {
      flaky.set(id, { cls, test, message: retried.get(id)! });
    }
  }
  return [...flaky.values()];
}

/**
 * Pure: the classes surefire's summary lists as flaky — "Flakes:" ("Flaked tests:" before 2.20), one
 * `<class>.<method>` a line, its runs below it — for a build that wrote no XML report to read.
 */
export function flakyClassesInLog(out: string): string[] {
  const found = new Set<string>();
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^(?:\[\w+\]\s+)?(?:Flakes|Flaked tests):\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^(?:\[\w+\])?\s*$/.test(l) || /^(?:\[\w+\])?\s+Run \d+:/.test(l)) continue;
      const test = /^(?:\[\w+\]\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?:[(\[].*)?\s*$/.exec(l);
      if (!test) break;
      const cls = outerClassName(test[1].split(".").slice(0, -1).join("."));
      if (cls.includes(".") || /^[A-Z]/.test(cls)) found.add(cls);
    }
  }
  return [...found].sort();
}

/**
 * The test classes of the module that this build ran and that passed only when run again — failing
 * tests a green build hid: see flakyClassesInReport, whose rules for a Gradle build come from its
 * configuration (gradleRetriesTests, gradleMayRunTestNG). Its reports in the module (Maven's written
 * since `since`), or, when it wrote no XML, what the log's summary lists for the module.
 */
export function flakyTestClasses(tool: BuildTool, mod: ModuleInfo, since: number, out: string): string[] {
  return [...new Set(flakyTestCases(tool, mod, since, out).map((c) => outerClassName(c.cls)))].sort();
}

/** The test cases of flakyTestClasses; from the log (no XML), each class once, without a message. */
export function flakyTestCases(tool: BuildTool, mod: ModuleInfo, since: number, out: string): FlakyCase[] {
  const dir = tool === "maven" ? surefireDirOf(mod.moduleRoot) : path.join(mod.moduleRoot, "build", "test-results", "test");
  let xml: string[] = [];
  try {
    xml = tool === "maven" ? freshFiles(dir, "TEST-", ".xml", since) : fs.readdirSync(dir).filter((f) => /^TEST-.+\.xml$/.test(f));
  } catch {
    /* no reports */
  }
  const found: FlakyCase[] = [];
  const retries = tool === "gradle" && gradleRetriesTests();
  const testng = tool === "gradle" ? gradleMayRunTestNG() : undefined;
  for (const f of xml) {
    try {
      found.push(...flakyCasesInReport(readSurefireXml(path.join(dir, f)), retries, testng));
    } catch {
      /* unreadable: not evidence either way */
    }
  }
  if (!xml.length && tool === "maven") {
    for (const cls of flakyClassesInLog(moduleSurefireLog(out, moduleArtifactId(mod)))) found.push({ cls, test: "", message: "" });
  }
  return found;
}

/**
 * Pure: what a surefire XML report names inside it — its testsuite's name, its test cases' classnames
 * — and for each classname how many test cases it has and how many of them were skipped. A suite
 * report (TestNG's TEST-TestSuite.xml, a JUnit 4 Suite's) is the only report its classes have. The
 * captured output (CDATA) is text, not markup.
 */
export function reportContents(xml: string): { names: string[]; cases: Map<string, { tests: number; skipped: number }> } {
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (t) => t.replace(/[^\n]/g, " "));
  const names = new Set<string>();
  const cases = new Map<string, { tests: number; skipped: number }>();
  for (const m of markup.matchAll(/<testsuite\b[^>]*>/g)) {
    const name = attr(m[0], "name");
    if (name) names.add(unescapeXml(name));
  }
  for (const m of markup.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const cls = unescapeXml(attr(m[1], "classname"));
    if (!cls) continue;
    names.add(cls);
    const c = cases.get(cls) ?? { tests: 0, skipped: 0 };
    c.tests++;
    if (/<skipped\b/.test(m[2] ?? "")) c.skipped++;
    cases.set(cls, c);
  }
  return { names: [...names], cases };
}

// "tests" and "skipped" of each report of a class: XML attributes, or the .txt summary line.
// The first 64 KB of a report: the testsuite tag and its counters are at the top of the file, and
// the rest can be hundreds of MB of captured test output. undefined when it cannot be read.
function readHead(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function skippedCounts(dir: string, files: string[]): { tests: number; skipped: number } {
  let tests = 0;
  let skipped = 0;
  const xml = files.filter((f) => f.endsWith(".xml"));
  for (const f of xml.length ? xml : files) {
    const text = readHead(path.join(dir, f));
    if (text === undefined) continue;
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
  // Also every class a report names inside it, not only by its file name: a JUnit 4 suite's members.
  members = false,
  // The module's source encoding (Java's name for it): the @DisplayName of the module's other
  // classes, read as javac reads them, when a report's file name has lost its characters.
  charset?: string,
): RanCheck | undefined {
  const dir = tool === "maven" ? surefireDirOf(mod.moduleRoot) : path.join(mod.moduleRoot, "build", "test-results", "test");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    /* no reports at all */
  }
  // Maven leaves earlier builds' reports in place; the Gradle build deletes them first (runBuild), so
  // the ones there are this build's.
  const reports = entries.filter((f) => {
    if (!/^TEST-.+\.xml$/.test(f) && !(tool === "maven" && isSurefireSummary(f))) return false;
    if (tool !== "maven") return true;
    try {
      return fs.statSync(path.join(dir, f)).mtimeMs >= since;
    } catch {
      return false;
    }
  });
  const testRoot = path.join(mod.moduleRoot, "src", "test", "java");
  const sourceOf = (name: string) => path.join(testRoot, ...name.replace(/[$-].*$/, "").split(".")) + ".java";
  const isClass = (name: string) => fs.existsSync(sourceOf(name));
  // Each report by the name it goes by: its file name, when that is a class of the module (after it a
  // @Nested class's "$", a reportNameSuffix's "-"); otherwise — a phrased file name, a suite's — the name
  // inside it (reportNameInside). One whose inside cannot be read keeps its file name, which may have
  // lost characters: `lossy`.
  const reportOf = new Map<string, string[]>();
  const lossy = new Set<string>();
  let unnamed = false;
  // A report file named by something other than a class of the module: usePhrasedFileName is on.
  let phrasedFiles = false;
  for (const f of reports) {
    const fileName = f.endsWith(".xml") ? f.slice("TEST-".length, -".xml".length) : f.slice(0, -".txt".length);
    let name = fileName;
    if (!isClass(fileName)) {
      phrasedFiles = true;
      if (f.endsWith(".xml")) unnamed = true;
      const inner = reportNameInside(path.join(dir, f));
      if (inner) name = inner;
      else lossy.add(fileName);
    }
    reportOf.set(name, [...(reportOf.get(name) ?? []), f]);
  }
  // The log covers the whole reactor: only this module's executions say anything about this module —
  // an upstream module's class of the same name is not this one. A phrased reporter names a class in
  // its "Running" line by its @DisplayName, the whole rest of the line.
  const moduleLog = tool === "maven" ? moduleSurefireLog(out, moduleArtifactId(mod)) : "";
  const logged = tool === "maven" ? [...new Set([...classesRunInLog(moduleLog), ...phrasedRunningIn(moduleLog)])] : [];
  const fileNames = [...reportOf.keys()];
  const seen = [...fileNames, ...logged];
  // A suite report (TestNG's one TEST-TestSuite.xml, a JUnit 4 suite class) names its classes inside,
  // and holds their test cases.
  let inside: ReturnType<typeof reportContents> | undefined;
  const scanInside = () => {
    if (inside) return inside;
    const all = { names: new Set<string>(), cases: new Map<string, { tests: number; skipped: number }>() };
    for (const f of reports.filter((r) => r.endsWith(".xml"))) {
      try {
        const found = reportContents(readSurefireXml(path.join(dir, f)));
        found.names.forEach((n) => all.names.add(n));
        for (const [cls, c] of found.cases) {
          const sum = all.cases.get(cls) ?? { tests: 0, skipped: 0 };
          all.cases.set(cls, { tests: sum.tests + c.tests, skipped: sum.skipped + c.skipped });
        }
      } catch {
        /* unreadable: not evidence either way */
      }
    }
    inside = { names: [...all.names], cases: all.cases };
    return inside;
  };
  // The class-level @DisplayName of each test class of the module (moduleDisplayNames). A class whose
  // name cannot be read (a constant, an unreadable source) may go by any name that is no class's.
  let shownIndex: { byShown: Map<string, string[]>; unread: string[] } | undefined;
  const shown = () => {
    if (shownIndex) return shownIndex;
    shownIndex = { byShown: new Map(), unread: [] };
    for (const o of moduleDisplayNames(testRoot, charset)) {
      if (o.shown === undefined) shownIndex.unread.push(o.fqcn);
      else {
        const key = o.shown.normalize("NFC");
        shownIndex.byShown.set(key, [...(shownIndex.byShown.get(key) ?? []), o.fqcn]);
      }
    }
    return shownIndex;
  };
  // The one class of the module a reported name can be, if there is exactly one: the class of that name
  // (after a @Nested class's "$", a reportNameSuffix's "-"), the classes whose @DisplayName it is — a
  // @DisplayName("com.x.HiddenSpec") makes "com.x.HiddenSpec" two classes' name, and neither's — and,
  // for a name that is no class's, those whose @DisplayName is unknown. Under a reportNameSuffix a
  // phrased name ends in "(<suffix>)".
  //
  // A report's file name, where no file of this build is named by anything but a class, is that
  // class's: surefire names a file by the class unless usePhrasedFileName is on, and then a class
  // with a @DisplayName would have one named by it.
  const ownerOf = (n: string, bare = false, file = false): string | undefined => {
    const candidates = new Set<string>();
    for (const t of expected) if (names(t.fqcn, n)) candidates.add(t.fqcn);
    const cls = isClass(n) ? n.replace(/[$-].*$/, "") : undefined;
    if (cls) candidates.add(cls);
    if (file && !phrasedFiles) return candidates.size === 1 ? [...candidates][0] : undefined;
    const { byShown, unread } = shown();
    for (const f of byShown.get(n.normalize("NFC")) ?? []) candidates.add(f);
    if (!candidates.size && !bare) {
      const suffixed = /^(.*\S)\([^()]*\)$/.exec(n.normalize("NFC"))?.[1];
      if (suffixed) return ownerOf(suffixed, true);
    }
    if (!cls && !candidates.size) unread.forEach((f) => candidates.add(f));
    return candidates.size === 1 ? [...candidates][0] : undefined;
  };
  const ownerOfSeen = (n: string, i: number) => ownerOf(n, false, i < fileNames.length);
  if (!seen.some((n, i) => ownerOfSeen(n, i) !== undefined)) {
    if (reports.length) {
      // Reports that name no test class of the module, by its name or its @DisplayName — a suite's —
      // unless the cases inside do: "cannot see", not "did not run".
      if (!scanInside().names.some((n) => ownerOf(n) !== undefined)) return undefined;
    } else {
      // Nothing names a class: only surefire saying it ran nothing tells "nothing ran" from
      // "cannot see" (reports disabled or written elsewhere, a quiet log).
      const none = tool === "maven" && (countTestsRun(out) === 0 || /\bNo tests (?:to run|were executed)\b/.test(out));
      if (!none) return undefined;
    }
  }
  // The other classes that go by t's @DisplayName.
  const sharing = (t: ExpectedTest) => (t.displayName ? (shown().byShown.get(t.displayName.normalize("NFC")) ?? []).filter((f) => f !== t.fqcn) : []);
  const ranAs = (t: ExpectedTest, n: string, file = false) => ownerOf(n, false, file) === t.fqcn;
  // A file name that lost characters is t's only when t's @DisplayName fits it and no other class's
  // can: one that fits it too, or one that cannot be read.
  const lossyAs = (t: ExpectedTest, fileName: string) =>
    !!t.displayName &&
    lossy.has(fileName) &&
    lossyFileNameOf(fileName, t.displayName) &&
    !shown().unread.some((f) => f !== t.fqcn) &&
    ![...shown().byShown].some(([name, fs]) => fs.some((f) => f !== t.fqcn) && lossyFileNameOf(fileName, name));
  let notRun = expected.filter((t) => !seen.some((n, i) => ranAs(t, n, i < fileNames.length)));
  if (notRun.length && reports.length) notRun = notRun.filter((t) => !scanInside().names.some((n) => ranAs(t, n)));
  if (notRun.length && lossy.size) notRun = notRun.filter((t) => ![...lossy].some((n) => lossyAs(t, n)));
  notRun = notRun.map((t) => {
    let read: ExpectedTest | undefined;
    // A class listed by name only (it ran before the writer): what its source says, for the report.
    if (!t.framework) {
      try {
        read = expectedTestOf(decodeJavaSource(fs.readFileSync(t.file), charset), t.file, t.origin);
      } catch {
        read = undefined;
      }
    }
    const withSource = read ? { ...t, framework: read.framework, disabled: read.disabled } : t;
    // A report goes by its @DisplayName (a phrased one's file, or a phrased Running line), and another
    // class goes by that too: which of them it is, nothing tells — a name of its own is what does.
    const shownAs = t.displayName;
    if (!shownAs || ![...fileNames.filter((n) => !isClass(n)), ...logged].some((n) => sameShown(n, shownAs))) return withSource;
    const shared = sharing(t);
    return shared.length ? { ...withSource, sharedName: shared } : withSource;
  });
  const allSkipped: RanCheck["allSkipped"] = [];
  let logCounts: Map<string, { tests: number; skipped: number }> | undefined;
  for (const t of expected) {
    if (t.origin !== "created" || notRun.some((n) => n.fqcn === t.fqcn)) continue;
    // Its reports: the ones that go by its name; by its @DisplayName only when it has none of those —
    // the report of that name can be another class's (a disabled one's, every test skipped).
    const own = [...reportOf].filter(([n]) => names(t.fqcn, n) && ranAs(t, n, true)).flatMap(([, f]) => f);
    const files = own.length ? own : [...reportOf].filter(([n]) => ranAs(t, n, true) || lossyAs(t, n)).flatMap(([, f]) => f);
    let { tests, skipped } = files.length ? skippedCounts(dir, files) : { tests: 0, skipped: 0 };
    if (!files.length) {
      // No report of its own: it ran inside a suite's — TestNG's TestSuite, a JUnit 4 Suite — whose
      // counters are the whole suite's. Its own test cases there are what say it was skipped: a
      // SkipException in its @BeforeClass, an assumption in a JUnit 4 @BeforeClass.
      for (const [cls, c] of scanInside().cases) {
        if (!ranAs(t, cls)) continue;
        tests += c.tests;
        skipped += c.skipped;
      }
      // In no report at all (they are written elsewhere): what surefire printed of it.
      if (!tests && tool === "maven") {
        logCounts ??= testCountsInLog(moduleLog);
        for (const [cls, c] of logCounts) {
          if (!ranAs(t, cls)) continue;
          tests += c.tests;
          skipped += c.skipped;
        }
      }
    }
    if (tests > 0 && skipped >= tests) allSkipped.push({ test: t, tests });
  }
  // What ran, and in which framework — read only when something did not run: every name that is one
  // class's, as that class. A suite report names its classes inside: TestNG's one TEST-TestSuite.xml,
  // a JUnit 4 suite's members. A name that is no Java class name and no one's @DisplayName is kept
  // whole ("滿 NT$1000 折 NT$100"); a class name that is not the module's (an upstream module's, in a
  // log without sections) is left out, and one that could be two classes' is neither's.
  const outer = new Set<string>();
  const add = (n: string, file = false) => {
    const owner = ownerOf(n, false, file);
    if (owner) outer.add(owner);
    else if (!isClass(n) && !/^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(n)) outer.add(n);
  };
  seen.forEach((n, i) => add(n, i < fileNames.length));
  if (members || unnamed) for (const n of scanInside().names) if (ownerOf(n)) add(n);
  // The classes that did not run are no evidence of what runs — before the writer, their source
  // may have been another framework.
  const frameworksOf = (classes: Iterable<string>) => {
    const found: RanCheck["ran"] = [];
    for (const fqcn of [...classes].sort()) {
      if (notRun.some((t) => t.fqcn === fqcn) || allSkipped.some((a) => a.test.fqcn === fqcn)) continue;
      if (found.length >= 200) break;
      let src: string;
      try {
        src = decodeJavaSource(fs.readFileSync(sourceOf(fqcn)), charset);
      } catch {
        continue; // another module's, or not a class (TestNG's "TestSuite")
      }
      found.push({ fqcn, framework: testFrameworkOf(codeOnly(src)) });
    }
    return found;
  };
  const reporting = notRun.length > 0 || allSkipped.length > 0;
  const ran = reporting ? frameworksOf(outer) : [];
  return {
    reported: [...outer],
    notRun,
    allSkipped,
    ran,
    ranBefore: reporting && !ran.length ? frameworksOf(ranBefore) : [],
    surefireVersion: surefireVersionOf(out),
  };
}

const HOW_TO_WRITE: Record<TestFramework, string> = {
  "JUnit 4": "JUnit 4（org.junit.Test、org.junit.Assert；測試類別與 @Test 方法都要 public）",
  "JUnit 5": "JUnit 5（org.junit.jupiter.api.Test、org.junit.jupiter.api.Assertions）",
  TestNG: "TestNG（org.testng.annotations.Test、org.testng.Assert）",
};

const MAX_NOT_RUN_LISTED = 20;

/** How a not-run report starts: a caller that frames it (the final verification) can tell it apart. */
export const NOT_RUN_HEADER = "編譯與測試都通過，但";

/** Pure: the surefire version in a build log ("--- surefire:3.2.5:test", "maven-surefire-plugin:2.22.2:test"). */
export function surefireVersionOf(out: string): string | undefined {
  return /--- (?:maven-)?surefire(?:-plugin)?:([^:\s]+):test\b/.exec(out)?.[1];
}

/** Pure: the failure report for tests the build did not run; null when every one of them ran. */
export function renderRanCheck(check: RanCheck, tool: BuildTool): string | null {
  if (!check.notRun.length && !check.allSkipped.length) return null;
  const fw = (t: ExpectedTest) => (t.framework ? `（${t.framework} 寫法）` : "");
  const WHAT: Record<ExpectedTest["origin"], string> = {
    created: "你新寫的測試類別，這次建置沒有執行它",
    changed: "你改過的測試類別，改之前有被執行，這次沒有",
    grown: "你在這個既有類別裡加了測試，但這個模組的建置沒有執行它（writer 介入前也沒有）——加在這裡的測試不會被執行",
    untouched: "既有的測試類別，writer 介入前有被執行，這次沒有——你的變更讓它不再被執行（例如測試資源裡的設定、共用的基底類別）",
  };
  const shared = (t: ExpectedTest) =>
    t.sharedName?.length
      ? `（它的 @DisplayName「${t.displayName}」與 ${t.sharedName.join("、")} 相同：報告以這個名字寫、只有一份，分不出是哪一個類別的——請給它一個這個模組裡獨一無二的名字）`
      : "";
  const listed = [
    ...check.notRun.map((t) => `  - ${t.fqcn}${fw(t)}：${WHAT[t.origin]}${shared(t)}`),
    ...check.allSkipped.map(({ test, tests }) => `  - ${test.fqcn}：你新寫的測試類別，${tests} 個測試全部被略過（skipped）`),
  ];
  const lines = [
    `${NOT_RUN_HEADER}有 ${listed.length} 個該執行的測試類別沒有真的被執行——沒被執行的測試不算數，本輪判 FAIL：`,
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
    if (tool === "maven" && !includedByDefault(t.fqcn, check.surefireVersion)) {
      causes.push(
        `類名不符 surefire${check.surefireVersion ? ` ${check.surefireVersion}` : ""} 預設的 includes（Test*、*Test、*TestCase；*Tests 要 2.20 以後）` +
          "——改成以 Test 結尾的名字（模組若在 pom 自訂了 includes，以 pom 為準）",
      );
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

/**
 * Pure: the reactor's last module was never built — SKIPPED in the reactor summary. With
 * `-pl <module> -am` the target module is built last, after everything it depends on, so this is
 * the target module left out because an upstream one failed first.
 */
export function targetModuleSkipped(out: string): boolean {
  const at = out.lastIndexOf("Reactor Summary");
  if (at < 0) return false;
  let last: string | undefined;
  for (const line of out.slice(at).split(/\r?\n/).slice(1)) {
    // A module's line has dot leaders ("web ........ SKIPPED"); "BUILD FAILURE" after the block does not.
    const m = /\.{2,}\s*(SUCCESS|FAILURE|SKIPPED)\b(?:\s*\[[^\]]*\])?\s*$/.exec(line);
    if (m && /\[INFO\]/.test(line)) last = m[1];
    else if (last && /-{8,}|BUILD (?:SUCCESS|FAILURE)/.test(line)) break;
  }
  return last === "SKIPPED";
}

/**
 * Pure: the lines surefire itself printed once an execution's tests were done — in each surefire
 * execution's section of the log, what follows its last per-class result line. A test's own output
 * comes before its class's result line, and an embedded build it runs prints "There are test
 * failures." exactly as surefire does; another plugin's section is not surefire's either
 * (frontend-maven-plugin's karma goal says the same words). A quiet build (-q) prints no section
 * headers at all, and then the whole log counts.
 */
export function surefireSummaryLines(out: string): string {
  const PER_CLASS = /Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+.*Time elapsed/;
  // What comes before the first header is Maven's preamble — or, with no header at all, everything.
  const sections: Array<{ surefire: boolean; lines: string[] }> = [{ surefire: true, lines: [] }];
  for (const line of out.split(/\r?\n/)) {
    const header = PLUGIN_HEADER.exec(line);
    if (header) {
      sections.push({ surefire: isSurefireTest(header[1]), lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }
  const kept: string[] = [];
  for (const s of sections) {
    if (!s.surefire) continue;
    let last = -1;
    s.lines.forEach((l, i) => {
      if (PER_CLASS.test(l)) last = i;
    });
    kept.push(...s.lines.slice(last + 1));
  }
  return kept.join("\n");
}

/**
 * Pure: why a Maven build that exited 0 is red all the same, or undefined when it is not.
 *
 * Maven's exit code says whether it chose to stop, not whether the build passed. With surefire's
 * testFailureIgnore — the property maven.test.failure.ignore, set in company parents so CI still
 * collects reports, or in .mvn/maven.config — failing tests are logged and the build exits 0; with
 * --fail-never (-fn) so is a compile error. Taken at its exit code, the gate passed a writer's
 * failing test and the run ended gates-passed, and the baseline called a module with a failing
 * test clean (both measured on a real project). `reported`: this build's own surefire reports
 * record a failing test.
 */
export function mavenRedDespiteExit0(out: string, reported: boolean): string | undefined {
  // --fail-never carries on past any failed goal. Only compiling and running the tests are this
  // gate's business: a copy-resources or checkstyle failure the project lives with is not the
  // writer's, and read as red it stopped runs that used to work. Logged at the end, at ERROR, so a
  // quiet build (-q, which drops BUILD FAILURE with the other INFO lines) prints it too.
  if (/^\[ERROR\] Failed to execute goal [\w.-]+:maven-(?:compiler|surefire)-plugin:[^:\s]+:(?:compile|testCompile|test)\b/m.test(out)) {
    return "Maven 的編譯或測試失敗了，卻以 exit=0 結束（--fail-never／-fn，多半設在 .mvn/maven.config）";
  }
  // Under testFailureIgnore surefire logs, instead of failing: "There are test failures." (every 2.x;
  // 3.x only when an assertion failed), a fork timeout ("…timeout or other error in the fork" in
  // 2.x, "…timeout in the fork" in 3.x), and its Results total at ERROR — which, for a test that
  // threw rather than failed an assertion, is all 3.x says. At WARNING it is flakes only.
  const summary = surefireSummaryLines(out);
  const totals = [...summary.matchAll(/^\[ERROR\] Tests run: \d+, Failures: (\d+), Errors: (\d+), Skipped: \d+(?:, Flakes: \d+)?\s*$/gm)];
  if (
    reported ||
    totals.some((m) => Number(m[1]) + Number(m[2]) > 0) ||
    /^\[ERROR\] There (?:are test failures|was a timeout(?: or other error)? in the fork)/m.test(summary)
  ) {
    return (
      "Maven 以 exit=0、BUILD SUCCESS 結束，但有測試失敗——專案設定了 surefire 的 testFailureIgnore" +
      "（maven.test.failure.ignore），測試失敗不會讓建置失敗"
    );
  }
  return undefined;
}

/**
 * Pure: Gradle's counterpart — a test task with ignoreFailures = true says there were failing tests
 * ("…See the report at", or "…See the results at" with the HTML report off; only the count with
 * logging quiet) and succeeds. `reported`: the test results record a failing test that no retry of it
 * passed (gradleFailingSuites). `retried`: the build retries failing tests and left test results to go
 * by — and then they, not the log, decide: the test-retry plugin's green build says "3 tests completed,
 * 1 failed" and "There were failing tests" all the same (measured: Gradle 8.14.3, test-retry 1.6.2,
 * mergeReruns or not), and a test whose retry passed is not failing. Anywhere else what the log says
 * stands.
 */
export function gradleRedDespiteExit0(out: string, reported = false, retried = false): string | undefined {
  return reported || (!retried && /There were failing tests\b|^\d+ tests? completed, \d+ failed/m.test(out))
    ? "Gradle 以 exit=0 結束，但有測試失敗——test 任務設定了 ignoreFailures = true，測試失敗不會讓建置失敗"
    : undefined;
}

/** Whether this Gradle build left test results in the module to go by. */
function gradleHasResults(mod: ModuleInfo): boolean {
  try {
    return fs.readdirSync(path.join(mod.moduleRoot, "build", "test-results", "test")).some((f) => /^TEST-.+\.xml$/.test(f));
  } catch {
    return false;
  }
}

/**
 * Pure: whether a Gradle build log shows the target project's test task executed this time — not
 * UP-TO-DATE, SKIPPED, NO-SOURCE or FROM-CACHE. Gradle keeps the last execution's results in
 * build/test-results, so a task that did not execute leaves results that say nothing about this
 * build: evidence only when it ran. `gradle test` in a project runs the task in its subprojects
 * too, and buildSrc's tests run before any build: the target's own task is the shallowest one
 * outside buildSrc. undefined when the log names no test task (quiet logging).
 */
export function gradleTestTaskRan(out: string): boolean | undefined {
  const tasks = [...out.matchAll(/^> Task ((?::[\w.-]+)*):test(?:[ \t]+([A-Z-]+))?[ \t]*$/gm)]
    .map((m) => ({ project: m[1], outcome: m[2] }))
    .filter((t) => !/^:buildSrc(?::|$)/.test(t.project));
  if (!tasks.length) return undefined;
  const depth = (project: string) => project.split(":").length;
  const top = Math.min(...tasks.map((t) => depth(t.project)));
  return tasks.filter((t) => depth(t.project) === top).every((t) => !t.outcome);
}

/**
 * Pure: were the target module's tests skipped — did every surefire execution Maven ran for it say
 * "Tests are skipped."? skipTests or maven.test.skip, from the pom, settings.xml or
 * .mvn/maven.config: the build is green, nothing ran, and nothing the writer writes ever will.
 * `artifactId` names the module; when the log has no execution for it (or it is unknown), the
 * module built last — under -pl <module> -am, the target.
 */
export function testsSkippedInLog(out: string, artifactId?: string): boolean {
  const runs = surefireSections(out).map((s) => ({
    artifact: s.artifact,
    skipped: s.lines.some((l) => /^\[INFO\] Tests are skipped\.\s*$/.test(l)),
  }));
  const target = artifactId && runs.some((r) => r.artifact === artifactId) ? artifactId : runs[runs.length - 1]?.artifact;
  const own = runs.filter((r) => r.artifact === target);
  return own.length > 0 && own.every((r) => r.skipped);
}

/** Whether a directory holds a .java file anywhere below it. */
function hasJavaFile(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => (e.isDirectory() ? hasJavaFile(path.join(dir, e.name)) : e.name.endsWith(".java")));
}

/** The target module's artifactId, from its pom chain; undefined when the pom cannot be read. */
function moduleArtifactId(mod: ModuleInfo): string | undefined {
  try {
    return pomFactsFromChain(readPomChain(mod.moduleRoot, REPO_ROOT).map((c) => c.xml)).artifactId;
  } catch {
    return undefined;
  }
}

/** What to tell a human whose module's tests are skipped by its own configuration. */
export const TESTS_SKIPPED_HINT =
  "目標模組的測試被跳過（surefire：Tests are skipped.）——pom、settings.xml 或 .mvn/maven.config 設定了 " +
  "skipTests 或 maven.test.skip。loop 要實際執行測試才驗證得了任何東西，writer 寫的測試在這個設定下永遠不會被執行。\n" +
  '請設 UT_MAVEN_ARGS="-DskipTests=false -Dmaven.test.skip=false" 後重跑；若 pom 在 surefire 的 <configuration> ' +
  "裡直接寫死 <skipTests>true</skipTests>，-D 蓋不過它，請改用啟用測試的 profile（UT_MAVEN_ARGS=\"-P<profile>\"）。";

// The tests this build's reports in the target module say ran; null when it wrote none. The module's
// own: under -am the upstream modules' tests run whether or not its do, and counting theirs passed a
// quiet round whose module skipped its tests (maven.test.skip) — the writer's never even compiled.
// Heads only, as skippedCounts reads them.
function testsInReports(moduleRoot: string, since: number): number | null {
  let seen = false;
  let tests = 0;
  const dir = surefireDirOf(moduleRoot);
  for (const f of freshFiles(dir, "TEST-", ".xml", since)) {
    const tag = /<testsuite\b[^>]*>/.exec(readHead(path.join(dir, f)) ?? "")?.[0];
    if (!tag) continue;
    seen = true;
    tests += Number(attr(tag, "tests")) || 0;
  }
  return seen ? tests : null;
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
function detectZeroTests(tool: BuildTool, mod: ModuleInfo, out: string, since: number): string | null {
  let detail: string | null = null;
  if (tool === "maven") {
    // A quiet build (-q in .mvn/maven.config or MAVEN_ARGS) logs errors only: a green one prints no
    // "Tests run" at all, and every round of it read as zero tests. Its reports still say.
    const n = countTestsRun(out) ?? testsInReports(mod.moduleRoot, since);
    // No file the writer can write changes this, so it gets said as it is rather than as advice to
    // add a test class: the baseline stops on it, this is for a run that skipped the baseline.
    // Whatever upstream modules ran under -am, the target module's own tests did not.
    if (testsSkippedInLog(out, moduleArtifactId(mod))) {
      return `編譯成功，但本輪沒有執行任何測試。${TESTS_SKIPPED_HINT}`;
    }
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

export type BuildOptions = {
  allowZeroTests?: boolean;
  onlyTests?: string[];
  tolerate?: string[];
  // Test classes the build must have run for its green to count: see checkTestsRan.
  mustRun?: ExpectedTest[];
  // The classes that ran before the writer, for the report's "which frameworks run here".
  ranBefore?: string[];
  // The module's source encoding (Java's name), for reading the @DisplayName of its test classes.
  charset?: string;
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
// gave up with advice about Lombok. The orchestrator needs it for the same reason: a build that
// timed out is not one to run again on the chance that it was flaky.
// `ignoredBy` is set when the build exited 0 over failures it was told to ignore (see
// mavenRedDespiteExit0): red all the same, and a human reading the baseline needs to know why a
// build they call green is not.
export type BuildRun = { gate: GateResult; aborted?: string; notRun?: string[]; ignoredBy?: string; startedAt: number };

export async function runBuild(tool: BuildTool, mod: ModuleInfo, opts: BuildOptions = {}): Promise<BuildRun> {
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
      // the module has no JaCoCo. A pom that sets <append> itself wins over this; the exec
      // files are removed before the build for that (clearCoverageData).
      "-Djacoco.append=false",
      // failIfNoSpecifiedTests=false is required, not cosmetic: with -am the same -Dtest is
      // applied to the upstream modules, where those classes do not exist, and surefire
      // would fail the reactor for finding nothing to run.
      ...(opts.onlyTests?.length
        ? [`-Dtest=${opts.onlyTests.flatMap((n) => [n, `${n}$*`]).join(",")}`, "-Dsurefire.failIfNoSpecifiedTests=false"]
        : []),
      "test",
      ...MAVEN_EXTRA_ARGS,
    ];
    clearCoverageData(mod);
    r = await shLive(cmd, args, "[mvn]", cwd, BUILD_TIMEOUT_MS);
    // What every parser below reads is Maven's lines as they start without a logger's prefix.
    r.out = normalizeMavenLog(stripAnsi(r.out));
    learnAppendingExec(r.out);
  } else {
    const wrapper = isWin ? "gradlew.bat" : "gradlew";
    const wrapperAt = fs.existsSync(path.join(REPO_ROOT, wrapper));
    const cmd = wrapperAt ? (isWin ? wrapper : `./${wrapper}`) : "gradle";
    // The target's test task must execute, not be skipped as UP-TO-DATE (nothing changed since its last
    // execution) or FROM-CACHE (the build cache holds its outputs for these inputs): either way it
    // leaves results that no test run of this tree produced, and what did not run proves nothing — a
    // baseline like that is no evidence for resuming (loop.ts), and a test that fails only when run
    // passes. Deleting its results — an output of the task — ends UP-TO-DATE, for this project only:
    // `cleanTest` does the same in every subproject the task name reaches, and their tests ran again
    // every round (a root project that includes others, a -p project with its own), where a stateful
    // one turned rounds red that the writer could neither see nor touch. The property turns the build
    // cache off for this build (gradle.properties and ~/.gradle's lose to it): --no-build-cache is an
    // unknown option to a Gradle before 4, and --rerun needs 7.6. Measured on Gradle 8.14.3.
    const results = path.join(mod.moduleRoot, "build", "test-results", "test");
    try {
      fs.rmSync(results, { recursive: true, force: true });
    } catch (e) {
      // Left in place, they are this build's only if its test task executes: checkTestsRan and the
      // failure reading go by what is there, and gradleTestTaskRan says whether it did.
      log(`[WARN] 無法刪除上一次的測試結果 ${path.relative(REPO_ROOT, results) || results}：${e instanceof Error ? e.message : String(e)}`);
    }
    const args = [...(mod.multiModule ? ["-p", mod.moduleRel] : []), "test", "-Dorg.gradle.caching=false", "--console=plain"];
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
    const unrun = notRunReport(tool, mod, startedAt, r.out, opts.mustRun, opts.ranBefore, opts.charset);
    return unrun && { gate: { passed: false, report: unrun.report, raw: r.out }, notRun: unrun.classes, startedAt };
  };

  // An exit code of 0 is Maven (or Gradle) choosing not to stop, which a project can ask it to do
  // over failing tests: see mavenRedDespiteExit0. The reports and the tool's own verdict decide.
  const ignoredBy =
    r.code !== 0
      ? undefined
      : tool === "maven"
        ? mavenRedDespiteExit0(r.out, reportsRecordFailure(mod.moduleRoot, startedAt))
        : gradleRedDespiteExit0(r.out, gradleFailingSuites(mod).length > 0, gradleRetriesTests() && gradleHasResults(mod));
  // Not "FAIL" here: under UT_ALLOW_DIRTY_BASELINE the failures may all be tolerated ones.
  if (ignoredBy) log(`[WARN] ${ignoredBy}——loop 不看 exit code，以測試報告與建置工具自己的判定為準`);

  if (r.code === 0 && !ignoredBy) {
    const zeroReport =
      ALLOW_ZERO_TESTS || opts.allowZeroTests ? null : detectZeroTests(tool, mod, r.out, startedAt);
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
  // Gradle's failures are identifiable only where it exited 0 over them (ignoreFailures): see
  // gradleFailingSuites.
  if (opts.tolerate?.length && (tool === "maven" || ignoredBy)) {
    const v = subtractTolerated(r.out, tool === "maven" ? failingSuites(mod.moduleRoot, startedAt) : gradleFailingSuites(mod), opts.tolerate);
    // Failures that were there before are all there is — but the reactor stopped at them, before
    // the target module: nothing the writer wrote was compiled, let alone run.
    const skipped = targetModuleSkipped(r.out);
    if (skipped) {
      log("[dirty-baseline] 不予扣除：上游模組失敗，reactor 在目標模組之前就停了");
      broke = "\n上游模組的失敗讓 Maven 停在上游，目標模組沒有被建置——writer 的測試沒有被編譯、也沒有被執行，這不能算通過。\n";
    }
    if (v.pass && !skipped) {
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
      : collectGradleFailures(mod);

  return {
    gate: {
      passed: false,
      report:
        (ignoredBy ? `${ignoredBy}。loop 不看 exit code：這一輪是紅的。` : `編譯或測試失敗（exit=${r.code}）。`) +
        `${broke}\n錯誤節錄：\n${summarizeBuildErrors(r.out)}\n${failures}`,
      raw: r.out,
    },
    ignoredBy,
    startedAt,
  };
}

// Whether this build's own surefire XML reports, anywhere in the reactor, record a failing test. Not
// the .txt summaries: surefire 2.x writes "Failures: 1 <<< FAILURE!" into one for a flaky test that
// passed on its rerun, and only the XML tells the two apart. A build with XML reports turned off has
// surefire's own "There are test failures." to go by.
// Asked of every green build, so it reads what skippedCounts reads — the head of each report — and
// parses a whole report only when its counters are not both zero: surefire counts every failing
// case, and also, in 2.x, the flaky ones.
function reportsRecordFailure(moduleRoot: string, since: number): boolean {
  for (const dir of surefireDirs(moduleRoot)) {
    for (const f of freshFiles(dir, "TEST-", ".xml", since)) {
      const tag = /<testsuite\b[^>]*>/.exec(readHead(path.join(dir, f)) ?? "")?.[0];
      if (tag && !(Number(attr(tag, "failures")) || 0) && !(Number(attr(tag, "errors")) || 0)) continue;
      if (failingSuiteIn(dir, f)) return true;
    }
  }
  return false;
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
  charset: string | undefined,
): { report: string; classes: string[] } | null {
  if (!mustRun?.length) return null;
  const check = checkTestsRan(tool, mod, since, out, mustRun, ranBefore, false, charset);
  if (!check) {
    log("[WARN] 無法確認 writer 寫的測試有被執行：這次建置在模組裡沒有留下測試報告，log 也沒有列出執行了哪些測試類別");
    return null;
  }
  const report = renderRanCheck(check, tool);
  if (!report) return null;
  return { report, classes: [...check.notRun.map((t) => t.fqcn), ...check.allSkipped.map((a) => a.test.fqcn)] };
}
