// Shared helpers: Java-file walk, module detection, test-path derivation, the writer-scope
// snapshot. Mostly pure; the snapshot reads the tree and splitForeignChanges asks git.
import * as fs from "node:fs";
import * as path from "node:path";
import { codeOnly, decodeUnicodeEscapes, stripAnnotations } from "./javasrc";
import { execFileSync } from "node:child_process";
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
  // readdir order is the file system's (hash order on ext4): sorted, the batches and the order in
  // the prompt are the same on every machine and every run.
  return out.sort(portablePathOrder);
}

/**
 * Pure: path order that is the same on every platform — compared with "/" separators, since "\"
 * sorts after digits and capitals where "/" sorts before them, and Windows batched differently.
 */
export function portablePathOrder(a: string, b: string): number {
  const x = a.replace(/\\/g, "/");
  const y = b.replace(/\\/g, "/");
  return x < y ? -1 : x > y ? 1 : 0;
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

// A literal a `static final` field can be initialized with and the compiler folds into a constant:
// no code runs for it. (`null` is not one — it is assigned in the static initializer.)
const FOLDED_LITERAL =
  "[-+]?\\s*(?:\"[^\"\\n]*\"|'[^'\\n]*'|(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][-+]?\\d+)?)[lLfFdD]?|true|false)" +
  "(?:\\s*\\+\\s*(?:\"[^\"\\n]*\"|'[^'\\n]*'|\\d[\\d_]*[lL]?))*";
const CONSTANT_FIELD = new RegExp(
  `(?:\\b(?:public|protected|private|static|final|transient|volatile)\\s+)+[\\w$.]+(?:\\s*<[^;=(){}]*>)?(?:\\s*\\[\\s*\\])*\\s+[\\w$]+\\s*=\\s*${FOLDED_LITERAL}\\s*;`,
  "g",
);
// `throw new IllegalStateException("Utility class");` — the body Sonar asks a utility class's private
// constructor to have. Its argument is blanked to spaces by codeOnly.
const PRIVATE_CTOR_THROW = "(?:throw\\s+new\\s+[\\w$.]+\\s*\\([^;{}()]*\\)\\s*;\\s*)";
// The Lombok annotations that generate a class's methods.
const LOMBOK_GENERATES =
  /@\s*(?:lombok\s*\.\s*)?(?:Data|Value|Getter|Setter|Builder|SuperBuilder|EqualsAndHashCode|ToString|With|NoArgsConstructor|AllArgsConstructor|RequiredArgsConstructor)\b/;
// A Spring Boot application's entry point: a main that only hands over to Spring, and for a WAR the
// configure override that names the sources. Running it starts the whole application context.
const SPRING_BOOT_APPLICATION = /@\s*(?:[\w$]+\s*\.\s*)*(?:SpringBootApplication|EnableAutoConfiguration)\b/;
// The arguments a bootstrap call is written with: names, `App.class`, `args`, strings. A ternary, a
// lambda or a call among them is logic, and the class stays a target.
const BOOT_ARG = '(?:[\\w$]+(?:\\s*\\.\\s*[\\w$]+)*|"[^"\\n]*")';
const BOOT_ARGS = `\\(\\s*(?:${BOOT_ARG}(?:\\s*,\\s*${BOOT_ARG})*)?\\s*\\)`;
const BOOT_MAIN =
  "(?:public\\s+)?static\\s+void\\s+main\\s*\\(\\s*(?:final\\s+)?String\\s*(?:\\[\\s*\\]\\s*[\\w$]+|\\.\\.\\.\\s*[\\w$]+|[\\w$]+\\s*\\[\\s*\\])\\s*\\)" +
  `\\s*(?:throws\\s+[\\w$.,\\s]+)?\\{\\s*(?:SpringApplication\\s*\\.\\s*run\\s*${BOOT_ARGS}|new\\s+SpringApplicationBuilder\\s*${BOOT_ARGS}(?:\\s*\\.\\s*[\\w$]+\\s*${BOOT_ARGS})*)\\s*;\\s*\\}`;
const BOOT_CONFIGURE =
  "(?:public|protected)\\s+SpringApplicationBuilder\\s+configure\\s*\\(\\s*(?:final\\s+)?SpringApplicationBuilder\\s+[\\w$]+\\s*\\)" +
  `\\s*\\{\\s*return\\s+[\\w$]+\\s*\\.\\s*sources\\s*${BOOT_ARGS}\\s*;\\s*\\}`;
// MapStruct writes the implementation from the annotations: their mappings and expressions are the
// logic, and a test of the mapper is how it is checked.
const MAPSTRUCT = /\borg\s*\.\s*mapstruct\b/;
// Bean Validation constraints on the fields — a @Pattern's expression, a @Size's bounds — are rules a
// unit test checks with a Validator.
const BEAN_VALIDATION = /\b(?:javax|jakarta)\s*\.\s*validation\b|\borg\s*\.\s*hibernate\s*\.\s*validator\b/;
const BOOT_MAIN_ONLY = new RegExp(`^\\s*(?:${BOOT_MAIN}(?:\\s*${BOOT_CONFIGURE})?|${BOOT_CONFIGURE}\\s*${BOOT_MAIN})\\s*$`);

/**
 * Pure: why a Java source has nothing to unit-test, or null when it may have. Such a type is not
 * given to the writer: a test of it is effort spent on nothing, and a gate that holds it to coverage
 * or a reviewer that holds it to effectiveness blocks a batch the writer cannot unblock.
 *
 * Nothing to execute: annotation types, and interfaces with only abstract methods (JaCoCo writes both
 * with no counters). Nothing anyone wrote: a class of fields and annotations — Lombok or the compiler
 * generates its accessors, equals and constructors — with constants the compiler folds, a private
 * constructor that keeps it from being instantiated, abstract methods; an enum of constants alone; a
 * record with no body, whose accessors, equals and constructor the compiler generates.
 * Measured on JaCoCo 0.8.8 with Spring Boot 2.7's Lombok, a @Data DTO whose every accessor, equals,
 * hashCode and toString was tested stayed at 40% branch coverage, the rest being generated branches.
 * And a Spring Boot entry point whose main only calls SpringApplication.run: executing it starts the
 * application context, which a unit test must not, and there is no logic in it to test otherwise.
 *
 * Read with the lexer (codeOnly), annotations removed. Anything else in the body — a method, a
 * constructor that could run (a record's compact one included), an initializer — keeps the type a target: this errs
 * toward keeping one, and the coverage gate reads a class with no code left as nothing to cover.
 */
export function codelessTypeReason(src: string): string | null {
  const code = codeOnly(decodeUnicodeEscapes(src));
  const bare = stripAnnotations(code);
  const decl = /(?:^|[\s;}])(@\s*interface|interface|class|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(bare);
  if (!decl) return null;
  // Another type after it in the same file is read as nothing here: the file stays a target.
  if (decl[1].startsWith("@")) {
    return /\b(?:class|interface|enum|record)\s+[\w$]/.test(bare.slice(decl.index + decl[0].length)) ? null : "annotation";
  }
  if (MAPSTRUCT.test(code)) return null;
  const open = bare.indexOf("{", decl.index + decl[0].length);
  if (open < 0) return null;
  const close = bare.lastIndexOf("}");
  const body = bare.slice(open + 1, close > open ? close : undefined);
  if (decl[1] === "interface") return /[{=]/.test(body) ? null : "interface（只有抽象方法）";
  if (SPRING_BOOT_APPLICATION.test(code) && BOOT_MAIN_ONLY.test(body)) {
    return "Spring Boot 進入點（main 只呼叫 SpringApplication.run——要執行它就得啟動 Spring context，那是整合測試的範圍）";
  }
  let abstractMethods = 0;
  let rest = body
    .replace(CONSTANT_FIELD, (m) => (/\bstatic\b/.test(m) && /\bfinal\b/.test(m) ? " " : m))
    // Its body empty or Sonar's `throw new IllegalStateException("Utility class")`: anything else
    // may run — Jackson calls a private no-arg constructor.
    .replace(new RegExp(`\\bprivate\\s+${decl[2].replace(/\$/g, "\\$")}\\s*\\(\\s*\\)\\s*\\{\\s*${PRIVATE_CTOR_THROW}?\\}`, "g"), " ")
    .replace(/\babstract\s+[^;{}=()]*\([^;{}()]*\)\s*(?:throws\s+[\w$.,\s]+)?;/g, () => {
      abstractMethods++;
      return " ";
    });
  // Nested types are read with the rest: their headers go, and their bodies must hold nothing either.
  rest = rest.replace(/\b(?:class|interface|enum)\s+[\w$]+[^{};=()]*\{/g, " ");
  if (/[({=]/.test(rest.replace(/\}/g, " "))) return null;
  if (BEAN_VALIDATION.test(code)) return null;
  if (decl[1] === "enum") return "enum（只有常數）";
  if (decl[1] === "record") return "record（只有元件——存取方法、equals 等由編譯器產生）";
  if (abstractMethods) return "abstract 類別（只有抽象方法、欄位與常數）";
  return LOMBOK_GENERATES.test(code)
    ? "只有欄位（存取方法、equals 等由 Lombok 產生，沒有手寫的邏輯）"
    : "只有欄位與常數（沒有手寫的邏輯）";
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
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (err) {
      // The walk covers the whole repo twice a round, and anything in it can fail to list: a
      // directory an IDE or dev server deletes while it regenerates output (ENOENT), a docker
      // volume owned by another uid (EACCES), a Big5 name Node decodes lossily (ENOENT on the
      // mangled path), a tree deeper than PATH_MAX. Throwing here ended the whole run with a
      // FATAL stack trace at a random round. None of it is the writer's doing: a vanished
      // directory is recorded like a vanished file (not at all), and an unreadable one by its
      // state, so a directory that *becomes* unreadable between two snapshots still counts.
      if (d === root) throw err;
      const code = (err as NodeJS.ErrnoException).code ?? "?";
      if (code === "ENOENT" || code === "ENOTDIR") return;
      snap[`${path.relative(root, d).replace(/\\/g, "/")}/`] = `unreadable:${code}`;
      return;
    }
    for (const e of entries) {
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
      // Whole milliseconds: a time put back through a Date (as the encoding view restores a file
      // it did not change) loses the fraction, and an untouched file read as changed.
      snap[rel] = `${Math.floor(st.mtimeMs)}:${st.size}`;
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
  // Directories the loop itself writes to while the writer runs — its own runs/ artifacts, when
  // UT_RUNS_DIR or the tool clone sits inside the target repo. Every run aborted in round 1 over
  // the loop's own writer-summary.md. Absolute or repo-relative; ones outside the repo are moot.
  loopOwned: string[] = [],
): (rel: string, name: string) => boolean {
  // The walk's paths carry the on-disk case; these are built from what the user typed. On a
  // case-insensitive file system (Windows, macOS) `cd C:\work\shop` for a directory named
  // `Shop` made the writable tree — or the loop's own runs dir — fail to match, and the writer's
  // own tests (or writer-summary.md) were a scope-violation in round 1. realpath gives the
  // on-disk case; both ends go through it so a symlinked repo path stays consistent. A path that
  // does not exist yet (a runs dir before its first run) takes its deepest existing ancestor's:
  // as typed, a repo reached through a symlink or an 8.3 short name (C:\Users\RUNNER~1) put it
  // outside the repo.
  const real = (p: string) => {
    const rest: string[] = [];
    for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
      try {
        return path.join(fs.realpathSync.native(dir), ...rest);
      } catch {
        if (path.dirname(dir) === dir) return path.resolve(p);
        rest.unshift(path.basename(dir));
      }
    }
  };
  const root = real(repoRoot);
  const relTo = (p: string) => path.relative(root, p).replace(/\\/g, "/");
  const testTree = path.join(moduleRoot, "src", "test");
  const writable = relTo(fs.existsSync(testTree) ? real(testTree) : path.join(real(moduleRoot), "src", "test"));
  const owned = new Set(
    loopOwned
      .map((d) => relTo(real(path.resolve(repoRoot, d))))
      .filter((r) => r && !r.startsWith("..") && !path.isAbsolute(r)),
  );
  return (rel, name) =>
    name.startsWith(".") || SCOPE_IGNORED_DIRS.has(name) || rel === writable || owned.has(rel);
}

/**
 * Splits out-of-scope changes into the ones the scope guard must act on and the ones that are
 * someone else's: git-ignored, outside any src/ tree, and shaped like output — logs/ of an
 * application running from the repo, out/ or bin/ of an IDE building on its own, a local
 * database, pid and swap files. Those changed during the writer's session because something else
 * wrote them, and the guard used to stop the run over them at whatever round they happened to
 * change. The list is an allowlist on purpose: being ignored is not enough. Spring Boot loads
 * ./application.yml and ./config/ from the working directory, which for surefire is the module
 * root, so an ignored <module>/config/application.yml is configuration the tests read.
 * Everything else keeps full strength: tracked files (git does not report them as ignored),
 * anything under src/ even when ignored (an ignored application-local.yml is still
 * configuration the tests load), build files, and everything when the repo is not a git repo
 * or git is missing.
 */
// Build files are never someone else's change, ignored or not: the build reads them.
const BUILD_FILE = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|lombok\.config|mvnw(?:\.cmd)?|gradlew(?:\.bat)?)$/;
const FOREIGN_OUTPUT_DIRS = new Set(["logs", "log", "out", "bin", "tmp", "temp"]);
const FOREIGN_OUTPUT_FILE = /\.(?:log(?:\.\d+)?(?:\.gz)?|pid|tmp|swp|lck|lock|class|mv\.db|trace\.db|h2\.db|sqlite3?|db)$/i;

function outputShaped(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts.pop() ?? "";
  return parts.some((d) => FOREIGN_OUTPUT_DIRS.has(d)) || FOREIGN_OUTPUT_FILE.test(name);
}

export function splitForeignChanges(repoRoot: string, paths: string[]): { kept: string[]; foreign: string[] } {
  const candidates = paths.filter((p) => !p.split("/").includes("src") && !BUILD_FILE.test(p) && outputShaped(p));
  if (!candidates.length) return { kept: paths, foreign: [] };
  // Git must be answering for this repo, not for an ancestor that happens to contain it: an SVN
  // or unversioned checkout inside a workspace repo that ignores `projects/` (or a dotfiles repo
  // ignoring `*`) reports everything as ignored, and the exemption would swallow real edits.
  // `git check-ignore .` exits 0 exactly when the repo root itself is ignored.
  try {
    execFileSync("git", ["check-ignore", "-q", "."], { cwd: repoRoot, stdio: "ignore" });
    return { kept: paths, foreign: [] };
  } catch {
    /* exit 1: the root is not ignored (or no git at all, handled below) */
  }
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: repoRoot,
      input: candidates.join("\0") + "\0",
      stdio: ["pipe", "pipe", "ignore"],
      // An IDE regenerating out/ changes tens of thousands of files; at the default 1MB the
      // answer overflowed, and the fallback exempted nothing — the very case this is for.
      maxBuffer: 256 * 1024 * 1024,
    }).toString();
  } catch {
    // exit 1 = none of them is ignored; 128 = not a git repo, or no git: nothing is exempt.
    out = "";
  }
  const ignored = new Set(out.split("\0").filter(Boolean));
  return { kept: paths.filter((p) => !ignored.has(p)), foreign: paths.filter((p) => ignored.has(p)) };
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
