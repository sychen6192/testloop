// Test-file metrics: what a writer must not take away from a pre-existing test.
//
// "Fix the failing test" and "delete the failing test" are indistinguishable to the build gate —
// both turn it green. The count of test methods and assertions is what tells them apart, so the
// loop measures every pre-existing test file before round 1 and refuses a round in which any of
// them lost a test, lost an assertion, or gained a way to skip one. Regexes over comment- and
// string-stripped source: an approximation, but a monotone one — a writer cannot remove a test
// method without the count going down.
import * as fs from "node:fs";
import * as path from "node:path";
import { codeOnly } from "./javasrc";

// readFileSync on a FIFO or a device blocks the whole process; only regular files are sources.
function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface TestMetrics {
  tests: number;
  assertions: number;
  /** Skip markers: a test that does not run, or ends as skipped instead of failed. */
  disabled: number;
  /**
   * Test methods that run on their own: not in an abstract class, not private / static / returning
   * a value. Making a failing test's class abstract keeps every @Test and runs none; adding tests
   * to an abstract base class (which run through its subclasses) leaves this count alone.
   */
  runnable: number;
}

// Keyed by path relative to the test root, forward slashes.
export type MetricsSnapshot = Record<string, TestMetrics>;

export interface ShrinkViolation {
  file: string;
  before: TestMetrics;
  after: TestMetrics | null; // null = the file is gone
}

// Every way to make a test not run, or end as skipped instead of failed — each one turns a red
// build green with the @Test count intact: JUnit 5's @Disabled and its conditional @Disabled… /
// @Enabled… forms, JUnit 4's @Ignore, TestNG's @Test(enabled = false) — only inside @Test(…):
// `boolean enabled = false;` is code, and counting it would fail a round that tests a feature flag —
// assumptions (JUnit, AssertJ, Hamcrest), JUnit 5's Assumptions.abort, and throwing what the
// frameworks report as skipped.
const SKIP_MARKERS = new RegExp(
  [
    String.raw`@(?:[\w.]+\.)?(?:Disabled|Enabled)\w*`,
    String.raw`@(?:[\w.]+\.)?Ignore\b`,
    String.raw`@(?:[\w.]+\.)?Test\s*\([^)]*\benabled\s*=\s*false\b`,
    String.raw`\bassum(?:e(?:True|False|That\w*|NotNull|NoException)|ingThat)\s*\(`,
    String.raw`\bAssumptions\s*\.\s*abort\s*\(`,
    String.raw`\bnew\s+(?:[\w.]+\.)?(?:SkipException|TestAbortedException|AssumptionViolatedException)\b`,
  ].join("|"),
  "g",
);
// abort() on its own is anybody's method; it is JUnit's only when statically imported from there.
const ABORT_IMPORTED = /\bimport\s+static\s+org\.junit\.jupiter\.api\.Assumptions\.(?:abort|\*)\s*;/;

const TEST_ANNOTATION = /@(?:[\w.]+\.)?(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b(?:\s*\((?:[^()]|\([^()]*\))*\))?/g;

/**
 * Pure: test methods that are declared and never run. JUnit 5 and TestNG pass over private and
 * static test methods without a word, and Jupiter over a @Test that returns a value — the
 * annotation is still there to count, the test is gone.
 */
export function unrunnableTests(code: string): number {
  return unrunnableAt(code).length;
}

// Where each unrunnable test's annotation is, for runnableTests to tell apart.
function unrunnableAt(code: string): number[] {
  const at: number[] = [];
  for (const m of code.matchAll(TEST_ANNOTATION)) {
    // Past the other annotations to the declaration: modifiers, type parameters (nested
    // generics included: <T extends Comparable<T>>), return type, name.
    const rest = code.slice(m.index! + m[0].length).replace(/^(?:\s*@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?)*/, "");
    const decl =
      /^\s*((?:(?:public|protected|private|static|final|synchronized|abstract|default|strictfp)\s+)*)(?:<(?:[^<>{};]|<(?:[^<>{};]|<[^<>{};]*>)*>)*>\s*)?([\w.$<>[\],?\s]+?)\s+[\w$]+\s*\(/.exec(rest);
    if (!decl) continue; // on a class (TestNG), or not a method
    if (/\b(?:private|static)\b/.test(decl[1])) at.push(m.index!);
    else if (m[1] !== "TestFactory" && m[1] !== "TestTemplate" && decl[2].trim() !== "void") at.push(m.index!);
  }
  return at;
}

// The bodies of abstract classes: [from, to) spans of the code.
function abstractBodies(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of code.matchAll(/\babstract\s+(?:(?:public|protected|private|static|strictfp|sealed|non-sealed)\s+)*class\s+[\w$]+[^{;]*\{/g)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) break;
    }
    spans.push([m.index!, i]);
  }
  return spans;
}

/** Pure: test methods that run on their own — see TestMetrics.runnable. */
export function runnableTests(code: string): number {
  const unrunnable = new Set(unrunnableAt(code));
  const abstract = abstractBodies(code);
  let n = 0;
  for (const m of code.matchAll(TEST_ANNOTATION)) {
    if (unrunnable.has(m.index!) || abstract.some(([a, b]) => m.index! > a && m.index! < b)) continue;
    // A TestNG @Test on the class is not a test method.
    const rest = code.slice(m.index! + m[0].length).replace(/^(?:\s*@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?)*/, "");
    if (/^\s*(?:(?:public|protected|private|abstract|static|final|strictfp)\s+)*class\b/.test(rest)) continue;
    n++;
  }
  return n;
}

// Pure.
export function testMetrics(src: string): TestMetrics {
  // One pass as the lexer reads it: a "/*" inside a string ("**/*.java") used to swallow the code up
  // to the next comment — every test in between gone, a false "shrunk" — and a trailing
  // "// assertEquals(...)" used to count as an assertion.
  const s = codeOnly(src);
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  return {
    tests: count(/@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/g),
    // JUnit / AssertJ assert*, Mockito verify*, BDDMockito should(), JUnit fail()
    assertions: count(/\b(?:assert\w*|verify\w*|should|fail)\s*\(/g),
    disabled: count(SKIP_MARKERS) + (ABORT_IMPORTED.test(s) ? count(/(?<![.\w])abort\s*\(/g) : 0) + unrunnableTests(s),
    runnable: runnableTests(s),
  };
}

export function collectTestMetrics(testRoot: string): MetricsSnapshot {
  const snap: MetricsSnapshot = {};
  if (!fs.existsSync(testRoot)) return snap;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable or vanished mid-walk: nothing to protect, and no reason to end the run
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".java") && isRegularFile(p)) {
        try {
          snap[path.relative(testRoot, p).replace(/\\/g, "/")] = testMetrics(
            fs.readFileSync(p, "utf8"),
          );
        } catch {
          /* unreadable — nothing to protect */
        }
      }
    }
  };
  walk(testRoot);
  return snap;
}

// Pure: every pre-existing file that ended up with less than it started with. Files the
// writer created are not in `before` and are therefore free to be reshaped between rounds.
export function findShrunk(before: MetricsSnapshot, after: MetricsSnapshot): ShrinkViolation[] {
  const out: ShrinkViolation[] = [];
  for (const file of Object.keys(before).sort()) {
    const b = before[file];
    const a = after[file];
    if (!a) {
      if (b.tests > 0) out.push({ file, before: b, after: null });
      continue;
    }
    if (a.tests < b.tests || a.assertions < b.assertions || a.disabled > b.disabled || a.runnable < b.runnable) {
      out.push({ file, before: b, after: a });
    }
  }
  return out;
}
