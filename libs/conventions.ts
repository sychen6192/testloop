// Project-convention scan: what the module's existing tests actually do, measured and then
// injected as fact (injection over discovery, same as standards and rubric).
//
// The motivating case is test-class visibility, where no blanket rule is correct. JUnit 5 does
// not require `public` and Sonar's S5786 flags it as redundant — but a suite that lists its
// test classes by symbol (@SelectClasses / @SuiteClasses) cannot reference a package-private
// class from another package, and the module stops compiling. Only the repo can settle it,
// so the loop measures the repo instead of guessing in the prompt.
import * as fs from "node:fs";
import * as path from "node:path";

// Reading every test source in a large module costs more than the signal is worth; the
// convention is legible from a sample. Suites are what the cap could realistically miss,
// so filenames are scanned for suite-ish names first and always read.
const MAX_SCANNED_FILES = 200;

export interface TestConventions {
  scanned: number;
  publicCount: number;
  packagePrivateCount: number;
  // Suites that enumerate their test classes by symbol — these force `public`.
  classRefSuites: string[];
}

// Pure: strip comments so a declaration quoted in a comment cannot be mistaken for real code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Pure: visibility of the first *top-level* class declaration, or null if there is none.
 * Top-level is identified by column 0 — the one formatting convention Java code reliably
 * follows, and what separates the outer class from its nested ones.
 */
export function classVisibility(src: string): "public" | "package-private" | null {
  const m = /^(public\s+)?(?:(?:final|abstract|strictfp)\s+)*class\s+\w+/m.exec(stripComments(src));
  if (!m) return null;
  return m[1] ? "public" : "package-private";
}

/**
 * Pure: does this source enumerate test classes by symbol? `@SelectClasses` (JUnit 5) and
 * `@SuiteClasses` (JUnit 4) name the classes, so visibility matters. `@SelectPackages`
 * resolves by package name at runtime and does not — a suite using only that imposes nothing.
 */
export function isClassRefSuite(src: string): boolean {
  return /@(?:SelectClasses|SuiteClasses)\b/.test(stripComments(src));
}

// Walk the module's test tree and measure. Paths returned are repo-relative.
export function scanTestConventions(testRoot: string, repoRoot: string): TestConventions {
  const out: TestConventions = {
    scanned: 0,
    publicCount: 0,
    packagePrivateCount: 0,
    classRefSuites: [],
  };
  if (!fs.existsSync(testRoot)) return out;

  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".java")) files.push(p);
    }
  };
  walk(testRoot);

  // Suite-named files first, so the scan cap can never drop the one file that decides
  // whether `public` is required.
  const suiteish = (p: string) => /suite/i.test(path.basename(p));
  const ordered = [...files.filter(suiteish), ...files.filter((p) => !suiteish(p))];

  for (const p of ordered.slice(0, MAX_SCANNED_FILES)) {
    let src: string;
    try {
      src = fs.readFileSync(p, "utf8");
    } catch {
      continue; // unreadable file is not a convention signal
    }
    out.scanned++;
    if (isClassRefSuite(src)) {
      out.classRefSuites.push(path.relative(repoRoot, p).replace(/\\/g, "/"));
      continue; // a suite is not a test class; counting its visibility skews the sample
    }
    const vis = classVisibility(src);
    if (vis === "public") out.publicCount++;
    else if (vis === "package-private") out.packagePrivateCount++;
  }
  out.classRefSuites.sort();
  return out;
}
