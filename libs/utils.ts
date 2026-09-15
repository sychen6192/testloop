// Pure helpers: Java-file walk, module detection, test-path derivation.
import * as fs from "node:fs";
import * as path from "node:path";
import { ModuleInfo } from "./types";

// List Java classes under target (dir or single .java); paths relative to repoRoot.
export function listJavaClasses(target: string, repoRoot: string): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    const b = path.basename(p);
    if (b.endsWith(".java") && b !== "package-info.java" && b !== "module-info.java") {
      out.push(path.relative(repoRoot, p));
    }
  };
  const st = fs.statSync(target);
  if (st.isFile()) {
    add(target);
    return out;
  }
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else add(p);
    }
  };
  walk(target);
  return out;
}

function hasBuildFile(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "pom.xml")) ||
    fs.existsSync(path.join(dir, "build.gradle")) ||
    fs.existsSync(path.join(dir, "build.gradle.kts"))
  );
}

// Module detection: walk up from target to the nearest pom.xml / build.gradle;
// that dir is the module root. Falls back to repoRoot if none is found.
export function findModuleInfo(absTarget: string, repoRoot: string): ModuleInfo {
  let dir = fs.statSync(absTarget).isDirectory() ? absTarget : path.dirname(absTarget);
  while (!hasBuildFile(dir)) {
    if (dir === repoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      dir = repoRoot;
      break;
    }
    dir = parent;
  }
  const moduleRoot = dir;
  const moduleRel = path.relative(repoRoot, moduleRoot);
  return { moduleRoot, moduleRel, multiModule: moduleRel !== "" };
}

// Derive the expected test path: src/main/java -> src/test/java, Foo -> FooTest.
export function expectedTestPath(clsRelPath: string): string {
  const norm = clsRelPath.replace(/\\/g, "/");
  const renamed = norm.replace(/([^/]+)\.java$/, (_m, n: string) => `${n}Test.java`);
  if (renamed.includes("src/main/java/")) {
    return renamed.replace("src/main/java/", "src/test/java/");
  }
  return renamed;
}

// Pure: drop ANSI escape sequences from captured build output.
//
// Maven colours its level tags whenever jansi believes it is attached to a terminal, and the
// escape lands *inside* the tag — the bytes are `[<ESC>[1;31mERROR<ESC>[m]`, not `<ESC>[1;31m`
// followed by `[ERROR]`. So a parser looking for a literal `[ERROR]` matches nothing at all,
// not even unanchored, and every classifier downstream silently reports "no files". Gradle is
// pinned with --console=plain; maven now gets -B, and this is the belt to that pair of braces
// (a project's own .mvn/maven.config can still force colour back on).
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI_ESCAPE, "");

// Pure: bound a writer-facing report, keeping the head. Reports are written most-actionable
// first (compile errors, then failing tests, then log noise), so the head is what the writer
// needs — tail() would keep maven's "-> [Help 1]" footer and drop the error itself.
// The notice states how much went missing: a silently shortened report reads as a complete one.
export function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（報告過長，已截斷 ${s.length - max} 字元；完整輸出見 build.log）`;
}

/**
 * Pure: reduce a failure report to what actually happened, for the stuck detector.
 *
 * "Two rounds produced the same failure" is the signal; the clock is not part of it. A
 * surefire block re-runs at 0.018s and then 0.015s, and identical failures compare unequal
 * — so the loop burns every remaining round on a failure it had already diagnosed as fixed.
 * The report the writer sees keeps its real values; only the comparison is normalized.
 *
 * Deliberately narrow. Over-normalizing collapses two *different* failures into one
 * fingerprint, and a false "stuck" aborts a run that was still making progress — a worse
 * failure than a few wasted rounds. Only patterns observed to vary between identical runs
 * belong here.
 */
export function feedbackFingerprint(s: string): string {
  return (
    s
      // surefire: "Time elapsed: 0.018 s"
      .replace(/Time elapsed:\s*[\d.,]+\s*s(ec)?\b/gi, "Time elapsed: <t>")
      // JVM identity hash codes, e.g. "expected: <com.x.Foo@1b6d3586>" — the class name
      // stays, so two different objects still produce different fingerprints.
      .replace(/@[0-9a-f]{6,}\b/g, "@<id>")
  );
}

// Pure: does `fileName` look like an existing test for `className`?
// Deliberately narrow — only the canonical name and the qualifiers a previous run or a
// colleague actually uses (FooTest / FooTests / FooUnitTest / TestFoo). A looser pattern
// would match FooBarTest, and pointing the writer at another class's test is worse than
// missing a duplicate.
export function matchesTestNaming(className: string, fileName: string): boolean {
  const cls = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:${cls}(?:Unit)?Tests?|Tests?${cls})\\.java$`).test(fileName);
}

// Existing test files for a target class, repo-relative, canonical <ClassName>Test.java first.
// The writer is told about these explicitly: left to infer it, it writes a second file
// (FooUnitTest.java) beside the one that already exists.
export function findExistingTests(clsRelPath: string, repoRoot: string): string[] {
  const expected = expectedTestPath(clsRelPath);
  const dir = path.dirname(expected).replace(/\\/g, "/");
  const className = path.basename(clsRelPath).replace(/\.java$/, "");
  const absDir = path.join(repoRoot, dir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return [];
  return fs
    .readdirSync(absDir)
    .filter((f) => matchesTestNaming(className, f))
    .map((f) => `${dir}/${f}`)
    .sort((a, b) => (a === expected ? -1 : b === expected ? 1 : a.localeCompare(b)));
}

// Pure: surefire `-Dtest` values (simple class names) from test file paths. Deduped and
// sorted so the same round always produces the same argument — a build command that varies
// between identical rounds would defeat the stuck detector.
export function testClassNames(paths: string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    const base = p.replace(/\\/g, "/").split("/").pop() ?? "";
    if (base.endsWith(".java") && base.length > 5) set.add(base.slice(0, -5));
  }
  return [...set].sort();
}

// Skill-dir search order: env override -> target repo (.opencode, .claude) -> the tool's own copy.
export function skillDirCandidates(
  repoRoot: string,
  testgenRoot: string,
  envDir?: string,
): string[] {
  return [
    envDir,
    path.join(repoRoot, ".opencode", "skills", "test-quality-evaluator"),
    path.join(repoRoot, ".claude", "skills", "test-quality-evaluator"),
    path.join(testgenRoot, ".opencode", "skills", "test-quality-evaluator"),
  ].filter(Boolean) as string[];
}

// Per-target-repo artifacts namespace: runs/<repo basename>.
export function runsDirFor(testgenRoot: string, repoRoot: string): string {
  return path.join(testgenRoot, "runs", path.basename(repoRoot));
}

// JSON.stringify replacer that drops the bulky `raw` fields from persisted artifacts.
export const stripRaw = (k: string, v: unknown) => (k === "raw" ? undefined : v);

// ─── Tree snapshots ──────────────────────────────────────────────────────────
// The loop snapshots the filesystem around every writer session, for two opposite reasons.
// The test tree MUST have changed: a writer that silently no-ops (context exhausted,
// permission-blocked) would otherwise let the gates judge the repo's PRE-EXISTING tests, and
// a run could "succeed" having generated nothing. Everything else MUST NOT have changed: a
// writer that edits production code makes every later gate result meaningless — the tests
// would be validated against code it rewrote to make them pass. mtime+size per file is
// enough to detect a write either way.

export type TreeSnapshot = Record<string, string>;

export interface SnapshotOptions {
  // Return true to leave a directory, and everything under it, out of the snapshot.
  // `rel` is the directory's path relative to the snapshot root, forward slashes.
  skipDir?: (rel: string, name: string) => boolean;
}

export function snapshotTree(root: string, opts: SnapshotOptions = {}): TreeSnapshot {
  const snap: TreeSnapshot = {};
  if (!fs.existsSync(root)) return snap;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).replace(/\\/g, "/");
      if (e.isDirectory()) {
        if (!opts.skipDir?.(rel, e.name)) walk(p);
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue; // dangling symlink or a file that vanished mid-walk — nothing to compare
      }
      snap[rel] = `${st.mtimeMs}:${st.size}`;
    }
  };
  walk(root);
  return snap;
}

// Never part of the writer-scope check: build output changes under the loop's own builds,
// dependency caches are huge and irrelevant, and dot-directories hold tooling state
// (.git, .opencode, .idea) the agent runtime itself may touch.
const SCOPE_IGNORED_DIRS = new Set(["target", "build", "node_modules"]);

/**
 * Skip predicate for the writer-scope snapshot: the whole repo is protected except the
 * target module's test source set. The prompt's contract is "only <module>/src/test/java";
 * `src/test` as a whole is granted so a test resource file does not fail a run. Production
 * code, build files, and every other module — their test trees included — stay read-only.
 * The prompt says "嚴禁修改 production code"; this is what makes it an assert.
 */
export function writerScopeSkip(
  repoRoot: string,
  moduleRoot: string,
): (rel: string, name: string) => boolean {
  const moduleRel = path.relative(repoRoot, moduleRoot).replace(/\\/g, "/");
  const writable = moduleRel ? `${moduleRel}/src/test` : "src/test";
  return (rel, name) => name.startsWith(".") || SCOPE_IGNORED_DIRS.has(name) || rel === writable;
}

// Paths that were added, removed, or modified between two snapshots.
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const changed: string[] = [];
  for (const p of Object.keys(after)) {
    if (before[p] !== after[p]) changed.push(p);
  }
  for (const p of Object.keys(before)) {
    if (!(p in after)) changed.push(p);
  }
  return changed.sort();
}
