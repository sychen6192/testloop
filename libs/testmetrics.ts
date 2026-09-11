// Test-file metrics: what a writer must not take away from a pre-existing test.
//
// "Fix the failing test" and "delete the failing test" are indistinguishable to the build gate —
// both turn it green. The count of test methods and assertions is what tells them apart, so the
// loop measures every pre-existing test file before round 1 and refuses a round in which any of
// them lost a test, lost an assertion, or gained an @Disabled. Regexes over comment- and
// string-stripped source: an approximation, but a monotone one — a writer cannot remove a test
// method without the count going down.
import * as fs from "node:fs";
import * as path from "node:path";

export interface TestMetrics {
  tests: number;
  assertions: number;
  disabled: number;
}

// Keyed by path relative to the test root, forward slashes.
export type MetricsSnapshot = Record<string, TestMetrics>;

export interface ShrinkViolation {
  file: string;
  before: TestMetrics;
  after: TestMetrics | null; // null = the file is gone
}

function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

// Pure.
export function testMetrics(src: string): TestMetrics {
  const s = stripCommentsAndStrings(src);
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  return {
    tests: count(/@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/g),
    // JUnit / AssertJ assert*, Mockito verify*, BDDMockito should(), JUnit fail()
    assertions: count(/\b(?:assert\w*|verify\w*|should|fail)\s*\(/g),
    disabled: count(/@Disabled\b/g),
  };
}

export function collectTestMetrics(testRoot: string): MetricsSnapshot {
  const snap: MetricsSnapshot = {};
  if (!fs.existsSync(testRoot)) return snap;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".java")) {
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
    if (a.tests < b.tests || a.assertions < b.assertions || a.disabled > b.disabled) {
      out.push({ file, before: b, after: a });
    }
  }
  return out;
}
