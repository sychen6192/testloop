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

// Pure: bound a writer-facing report, keeping the head. Reports are written most-actionable
// first (compile errors, then failing tests, then log noise), so the head is what the writer
// needs — tail() would keep maven's "-> [Help 1]" footer and drop the error itself.
// The notice states how much went missing: a silently shortened report reads as a complete one.
export function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（報告過長，已截斷 ${s.length - max} 字元；完整輸出見 build.log）`;
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

// ─── Test-tree snapshots ─────────────────────────────────────────────────────
// The loop verifies after every writer session that the test tree actually changed.
// Without this, a writer that silently no-ops (context exhausted, permission-blocked)
// lets the gates judge the repo's PRE-EXISTING tests — and a run can "succeed" having
// generated nothing. mtime+size per file is enough to detect that.

export type TreeSnapshot = Record<string, string>;

export function snapshotTree(root: string): TreeSnapshot {
  const snap: TreeSnapshot = {};
  if (!fs.existsSync(root)) return snap;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        snap[path.relative(root, p).replace(/\\/g, "/")] = `${st.mtimeMs}:${st.size}`;
      }
    }
  };
  walk(root);
  return snap;
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
