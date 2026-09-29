// Resuming a run: a class an earlier run already passed every gate for is not written again.
//
// A folder target runs one batch per class, and a batch is several writer and reviewer sessions and
// builds — minutes to half an hour each. A run cut short at its twentieth class (a terminal that
// hung up, a laptop that went to sleep, a build that ran out of memory), or one that ended with
// three classes failed, started over from the first class when run again: hours of passes redone,
// the writer told to "improve" tests that had just passed every gate.
//
// Each passed batch now leaves a record of what it passed with (passed.json in its run's artifacts):
// every class's source and its test files, hashed. A later run skips a class only when that record
// still describes the tree exactly, and only after checking again what can be checked again:
//
// - Build: this run's baseline built the module and ran the class's tests — green. A baseline that
//   is red (UT_ALLOW_DIRTY_BASELINE) or skipped proves nothing, and nothing is skipped then.
// - Coverage: measured again from that build's own JaCoCo report, at today's thresholds. Other tests
//   and the classes it calls change what a test covers without touching either file.
// - Review: not run again — a reviewer session is what a skip saves. Its verdict holds for exactly
//   what it read, the class and its test files under the rubric, and nothing else: all three are
//   compared, and the scores are judged again at today's thresholds (gates/review.ts parseVerdict).
//
// Pure except for the file reads and the one write; the gate checks are loop.ts's.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { codeOnly, decodeJavaSource, javaStringValue } from "./javasrc";

export const LEDGER_FILE = "passed.json";
const LEDGER_VERSION = 1;

/** A class that passed every gate, and what exactly it passed with. */
export interface PassedEntry {
  /** Repo-relative, forward slashes. */
  cls: string;
  /** sha256 of the class's source. */
  source: string;
  /** Its test files and whatever else its batch wrote in src/test, repo-relative → sha256; null: absent. */
  files: Record<string, string | null>;
  /**
   * Of `files`, those there only because its tests reach them (referencedTestFiles): fingerprinted,
   * but not tests it passed by — a base class surefire never runs on its own is one. Absent in
   * records of earlier versions: every test class in `files` is then taken as its.
   */
  refs?: string[];
  /** What its tests reach was more than the walk records: a change beyond it would go unseen. */
  partial?: boolean;
  /**
   * Why the pass no longer holds, found after it was recorded: its tests failed a build and passed
   * when run again, failed at a baseline, or a repair changed what any test may read. Kept rather than
   * dropped — the newest record is the one that counts (findPass), and without it an older record of
   * the class would count again. Such a record also has an unreadable `source` (voidEntry), which a
   * version of the tool that does not know this field takes as "cannot tell": it redoes the class too.
   */
  invalid?: string;
  /** sha256 of the rubric the reviewer judged by. */
  rubric: string;
  /** The passing verdict; null when the review gate was switched off (UT_SKIP_REVIEW=1). */
  verdict: { scores: Record<string, number>; blockers: string[] } | null;
  /** The artifacts of the batch (or run) that passed it. */
  dir: string;
  /** When it passed, ISO. */
  at: string;
}

const toSlash = (p: string) => p.replace(/\\/g, "/");

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const UNREADABLE = "unreadable:";
const unreadable = (h: string | null) => !!h && h.startsWith(UNREADABLE);

// One buffer for every hash: they run one at a time, and a fresh megabyte for each of a few thousand
// small files is most of the work.
const HASH_BUFFER = Buffer.alloc(1024 * 1024);

/**
 * sha256 of a file's bytes; null when there is no file there. A file that cannot be read gets
 * `unreadable:<code>`, which entryMismatch never takes as a match — not even for itself: two reads
 * that both failed say nothing about whether the content is the same. Only a regular file is read:
 * it is opened without waiting (a FIFO waits for a writer that never comes) and then asked what it
 * is — a stat before the open can be of another file than the one opened. It is read in pieces, so
 * its size is no limit (a whole read fails past 2 GB).
 */
export function hashFile(abs: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    if (!fs.fstatSync(fd).isFile()) return `${UNREADABLE}not-a-file`;
    const hash = createHash("sha256");
    for (let n; (n = fs.readSync(fd, HASH_BUFFER, 0, HASH_BUFFER.length, null)) > 0; ) hash.update(HASH_BUFFER.subarray(0, n));
    return hash.digest("hex");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : `${UNREADABLE}${code ?? "?"}`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Pure: a path a ledger may name — relative, inside the repo, not `..` anywhere in it. */
export function safeLedgerPath(rel: string): boolean {
  return !!rel && !path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel) && !rel.split(/[\\/]/).includes("..");
}

// The walk is bounded, classes and resources each on their own budget — a helper that names a
// thousand fixtures must not use up what the helpers it calls need. Past either, the record is
// marked partial, and a partial record is never resumed: a change beyond it would not be seen, and
// a hollowed-out helper passes the build and the coverage both.
export const MAX_REFERENCED_CLASSES = 400;
export const MAX_REFERENCED_RESOURCES = 400;

/**
 * Pure: the string literals of a Java source, as written between their quotes (text blocks too),
 * from its lexed form (codeOnly keeps the delimiters where it blanks the content, char for char):
 * a quote in a char literal or a comment does not start one, and two literals on a line stay two.
 */
export function stringLiterals(src: string, code = codeOnly(src)): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/"""[\s\S]*?"""|"[^"\r\n]*"/g)) {
    const q = m[0].startsWith('"""') ? 3 : 1;
    out.push(src.slice(m.index! + q, m.index! + m[0].length - q));
  }
  return out;
}

/**
 * Pure: the resources a string literal names, from those of the test tree by file name. A path names
 * the ones at that path ("golden/case1/expected.json" — not every expected.json); when none is, or
 * the literal is a bare name, every one of that name. A scheme ("classpath:"), backslashes and a
 * leading slash do not count. Names compare in NFC: a file system may hand them back decomposed.
 */
export function resourcesNamed(literal: string, byName: Map<string, string[]>): string[] {
  const p = literal
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^[A-Za-z][\w+.*-]*:/, "")
    .replace(/^\.?\//, "");
  const name = p.split("/").pop();
  const all = (name && byName.get(name)) || [];
  if (!p.includes("/")) return all;
  const at = all.filter((r) => `/${r}`.endsWith(`/${p}`));
  return at.length ? at : all;
}

// A Java identifier as javac reads one (JLS 3.8): a letter of any script, "$" or "_", then those and
// digits — 測試資料 is a class name as much as Fixtures is.
const ID = "[\\p{L}\\p{Nl}_$][\\p{L}\\p{Nl}\\p{Nd}\\p{Mn}\\p{Mc}\\p{Pc}_$]*";
const QUALIFIED = `${ID}(?:\\s*\\.\\s*${ID})*`;
const IMPORT = new RegExp(`\\bimport\\s+(static\\s+)?(${QUALIFIED})(\\s*\\.\\s*\\*)?\\s*;`, "gu");
const DOTTED = new RegExp(`${ID}(?:\\s*\\.\\s*${ID})+`, "gu");
const IDENT = new RegExp(ID, "gu");
// A class named in text — a string, a resource: "com.x.Fixtures#cases" (JUnit's @MethodSource),
// <bean class="com.x.StubRepo">, a line of META-INF/services.
const NAMED_IN_TEXT = new RegExp(`(?<![\\p{L}\\p{N}_$.])${ID}(?:\\.${ID})+`, "gu");

/**
 * Pure: what a Java source (code only: see codeOnly) declares at its top level — its package, and each
 * type with the annotations written before it. A file may declare more than one (a package-private
 * helper after the public class), and its package need not be its folder's: javac goes by what the
 * file says.
 */
export function declaredTypes(code: string): { pkg: string; types: Array<{ name: string; annotations: string }> } {
  const pkg = new RegExp(`^\\s*package\\s+(${QUALIFIED})\\s*;`, "mu").exec(code)?.[1].replace(/\s+/g, "") ?? "";
  const types: Array<{ name: string; annotations: string }> = [];
  let depth = 0;
  let parens = 0;
  // Where the statement being read starts: after the last ";" or "}" outside every brace and
  // parenthesis — one inside an annotation's arguments (@ExtendWith({A.class})) is not an end.
  let start = 0;
  for (const m of code.matchAll(new RegExp(`[{}();]|(?<![.\\p{L}\\p{N}_$])(?:class|interface|enum|record)\\s+(${ID})`, "gu"))) {
    const c = m[0];
    if (c === "(") parens++;
    else if (c === ")") parens = Math.max(0, parens - 1);
    else if (c === "{") depth++;
    else if (c === "}" || c === ";") {
      if (c === "}") depth = Math.max(0, depth - 1);
      if (!depth && !parens) start = m.index! + 1;
    } else if (!depth) types.push({ name: m[1], annotations: code.slice(start, m.index) });
  }
  return { pkg, types };
}

// What Spring finds with no test naming it, on a top-level type: a stereotype component scanning
// picks up (JSR-330's @Named and @ManagedBean as well), a configuration class, a @TestConfiguration a
// @SpringBootTest's search finds, a JPA entity the entity scan reads. One nested in a test class is
// that test's own: Spring Boot's TestTypeExcludeFilter keeps it out of every other test's scan.
const SPRING_FOUND =
  /@(?:[\w$]+\s*\.\s*)*(?:Component|ComponentScan|Service|Repository|Controller|RestController|ControllerAdvice|RestControllerAdvice|Configuration|TestConfiguration|SpringBootConfiguration|SpringBootApplication|AutoConfiguration|TestComponent|JsonComponent|Named|ManagedBean|Entity|Embeddable|MappedSuperclass)\b/;

/**
 * Pure: does this test source (code only: see codeOnly) declare a top-level class Spring loads without
 * any test naming it? Changed, it changes what every test that starts a context runs with, and no
 * reference from a test leads to it.
 */
export function springLoaded(code: string): boolean {
  return declaredTypes(code).types.some((t) => SPRING_FOUND.test(t.annotations));
}

// A test that starts a Spring context: what Spring Boot loads on its own is part of what it runs with.
const SPRING_TEST =
  /@(?:[\w$]+\s*\.\s*)*(?:SpringBootTest|WebMvcTest|WebFluxTest|Data\w*Test|JdbcTest|JooqTest|JsonTest|RestClientTest|WebServiceClientTest|GraphQlTest|ContextConfiguration|ContextHierarchy|SpringJUnitConfig|SpringJUnitWebConfig|TestPropertySource|ActiveProfiles|Sql|MockBean|SpyBean|MockitoBean|MockitoSpyBean)\b|\bSpring(?:Extension|Runner|JUnit4ClassRunner)\b/;
// Read by JUnit, Mockito, TestNG and the test logging for every test, with no test naming them —
// relative to the resources folder: the classpath's root.
const TEST_GLOBAL = /^(?:junit-platform\.properties|logback-test\.xml|log4j2-test\.[^/]+|testng\.xml|META-INF\/services\/.+|mockito-extensions\/.+)$/;
// And by Spring Boot, for a test that starts a context: its configuration files (with profiles, in
// config/), its SQL initialization scripts, the auto-configuration a module declares.
const SPRING_GLOBAL =
  /^(?:(?:config\/(?:[^/]+\/)?)?(?:application|bootstrap)(?:[-.][^/]*)?\.(?:ya?ml|properties)|(?:schema|data)(?:-[^/]*)?\.sql|META-INF\/spring(?:[./-][^/]*|\/.+))$/;
// A resource read for the classes it names: small, and of a kind that names classes — a Spring context,
// a configuration file, a JSON fixture's type ids, a line of META-INF/services. Approval files, SQL and
// CSV are data.
const TEXTUAL = /(?:\.(?:xml|properties|ya?ml|json|conf|factories|imports|handlers)|\/META-INF\/services\/[^/]+)$/i;
const MAX_SCANNED_RESOURCE = 256 * 1024;

/** The module's test tree as the walk reads it: read once for every class a batch passed. */
export interface TestTreeIndex {
  /** Repo-relative, "/" separators: the module's src/test. */
  tree: string;
  /** Top-level types by fully qualified name (as their files declare them) → the files. */
  types: Map<string, string[]>;
  /** Every .java file by the name its path gives it: com/x/Foo.java → com.x.Foo. */
  byPath: Map<string, string>;
  /** Files that could not be read, by file name: what they declare is unknown. */
  unread: Map<string, string[]>;
  /** Files with a top-level type Spring finds on its own (SPRING_FOUND). */
  springLoaded: string[];
  /** Resources — under resources/, and beside the tests — by file name (NFC). */
  resources: Map<string, string[]>;
  /** The same by every prefix of the name that ends at a separator (see indexTestTree). */
  byPrefix: Map<string, string[]>;
  /** Resources under resources/, relative to it → repo-relative. */
  rooted: Map<string, string>;
}

const addTo = (map: Map<string, string[]>, key: string, rel: string) => {
  const list = map.get(key);
  if (list) list.push(rel);
  else map.set(key, [rel]);
};

/**
 * Every file under `dir` (repo-relative), symbolic links followed — a fixture folder linked in from
 * elsewhere is read through its link, as the build copies it — and each directory once.
 */
function walkTree(repoRoot: string, dir: string, onFile: (rel: string, name: string) => void, seen = new Set<string>()): void {
  let real: string;
  let entries: fs.Dirent[];
  try {
    real = fs.realpathSync(path.join(repoRoot, dir));
    entries = fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true });
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    let dirent: { isDirectory(): boolean; isFile(): boolean } = e;
    if (e.isSymbolicLink()) {
      try {
        dirent = fs.statSync(path.join(repoRoot, rel));
      } catch {
        continue; // dangling
      }
    }
    if (dirent.isDirectory()) walkTree(repoRoot, rel, onFile, seen);
    else if (dirent.isFile()) onFile(rel, e.name);
  }
}

/**
 * The module's test tree, indexed: what each source declares (decoded in `charset`, the module's
 * source encoding), and every resource by name.
 */
export function indexTestTree(repoRoot: string, testTree: string, charset?: string): TestTreeIndex {
  const tree = toSlash(testTree).replace(/\/$/, "");
  const javaRoot = `${tree}/java`;
  const idx: TestTreeIndex = {
    tree,
    types: new Map(),
    byPath: new Map(),
    unread: new Map(),
    springLoaded: [],
    resources: new Map(),
    byPrefix: new Map(),
    rooted: new Map(),
  };
  const addResource = (rel: string, raw: string) => {
    const name = raw.normalize("NFC");
    addTo(idx.resources, name, rel);
    // By every prefix of its name that ends at a separator: "CalcTest.add.approved.txt" under CalcTest
    // and CalcTest.add, "CalcTest$Add.sql" (Spring's script for a @Nested class) under CalcTest — what
    // is named after a test and never in a string: Spring's CalcTest.sql and CalcTest-context.xml, an
    // approval or snapshot file.
    for (let i = 1; i < name.length; i++) if (".-_$".includes(name[i])) addTo(idx.byPrefix, name.slice(0, i), rel);
  };
  walkTree(repoRoot, javaRoot, (rel, name) => {
    // Beside the tests, not only under resources/: approval and snapshot files are read by path.
    if (!name.endsWith(".java")) return addResource(rel, name);
    idx.byPath.set(rel.slice(javaRoot.length + 1, -".java".length).replace(/\//g, "."), rel);
    let code: string;
    try {
      code = codeOnly(decodeJavaSource(fs.readFileSync(path.join(repoRoot, rel)), charset));
    } catch {
      addTo(idx.unread, name.slice(0, -".java".length), rel);
      return;
    }
    const { pkg, types } = declaredTypes(code);
    for (const t of types) addTo(idx.types, pkg ? `${pkg}.${t.name}` : t.name, rel);
    if (types.some((t) => SPRING_FOUND.test(t.annotations))) idx.springLoaded.push(rel);
  });
  walkTree(repoRoot, `${tree}/resources`, (rel, name) => {
    addResource(rel, name);
    idx.rooted.set(rel.slice(`${tree}/resources/`.length), rel);
  });
  return idx;
}

/** The text of a small regular file; undefined for anything else. Opened without waiting (a FIFO waits for a writer), then asked what it is. */
function readSmallText(abs: string, max: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    for (let n; got < buf.length && (n = fs.readSync(fd, buf, got, buf.length - got, null)) > 0; ) got += n;
    return buf.subarray(0, got).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The files of the test tree `roots` reach: the classes of the tree they name, and the ones those
 * name, and the resources their string literals name or that are named after them, and the classes
 * those resources name. What a reviewer reading a test also reads — the base class it extends, the
 * fixture builder and assertion helper it calls, the JSON it loads — and what the test's behaviour
 * hangs on: a hollowed-out helper leaves the build green and the coverage where it was. Breadth first:
 * the nearest helpers are the ones kept when a budget runs out (`partial`). Repo-relative, "/"
 * separators; `testTree` is the module's src/test, `charset` its sources' encoding (Java's name).
 *
 * And, outside the budget, what every test runs with that no test names: JUnit's, Mockito's and the
 * test logging's configuration; for a test that starts a Spring context, Spring Boot's configuration
 * files and the classes of the tree Spring finds on its own.
 *
 * A name is resolved as javac resolves it, by what the files declare (a package need not be its
 * folder, a file may declare more than one type): an import names its class, and a simple name is the
 * one of the file's own package, else of a package it imports on demand — and then the file its own
 * package would have of that name is recorded too, present or not: added later, it is the one javac
 * takes. A name none of those has is no class of the tree (a JDK class, a main one); what a file that
 * could not be read declares is not known, and it is taken by its file name.
 */
export function referencedTestFiles(
  roots: string[],
  repoRoot: string,
  testTree: string,
  charset?: string,
  index: TestTreeIndex = indexTestTree(repoRoot, testTree, charset),
): { files: string[]; partial: boolean } {
  const javaRoot = `${index.tree}/java`;
  const unreadFiles = new Set([...index.unread.values()].flat());
  // A qualified name's files: the longest prefix of it that is a top-level type of the tree
  // (a.b.Outer.Inner.x is a.b.Outer's) — or, for a file that could not be read, where one would be.
  const typeFiles = (dotted: string, least: number): string[] => {
    const segs = dotted.split(".");
    for (let n = segs.length; n >= least; n--) {
      const fq = segs.slice(0, n).join(".");
      const declared = index.types.get(fq);
      if (declared) return declared;
      const at = index.byPath.get(fq);
      if (at && unreadFiles.has(at)) return [at];
    }
    return [];
  };
  const classesNamedIn = (text: string) => {
    const out: string[] = [];
    for (const m of text.matchAll(NAMED_IN_TEXT)) {
      const found = typeFiles(m[0], 2);
      out.push(...(found.length ? found : typeFiles(m[0].replace(/\$.*$/, ""), 2)));
    }
    return out;
  };
  const classes = new Set<string>();
  const named = new Set<string>();
  const always = new Set<string>();
  let partial = false;
  const queue = roots.map(toSlash).filter((r) => r.endsWith(".java"));
  const seen = new Set(queue);
  const texts: string[] = [];
  const reach = (f: string, free = false) => {
    if (seen.has(f)) return;
    seen.add(f);
    if (free) always.add(f);
    else if (classes.size >= MAX_REFERENCED_CLASSES) {
      partial = true;
      return;
    } else classes.add(f);
    queue.push(f);
  };
  const name = (r: string, free = false) => {
    if (named.has(r) || always.has(r)) return;
    if (free) always.add(r);
    else if (named.size >= MAX_REFERENCED_RESOURCES) {
      partial = true;
      return;
    } else named.add(r);
    if (TEXTUAL.test(r)) texts.push(r);
  };
  for (const [under, rel] of index.rooted) if (TEST_GLOBAL.test(under)) name(rel, true);
  let spring = false;
  let springAdded = false;
  while (queue.length || texts.length || (spring && !springAdded)) {
    if (!queue.length && !texts.length) {
      springAdded = true;
      for (const [under, rel] of index.rooted) if (SPRING_GLOBAL.test(under)) name(rel, true);
      index.springLoaded.forEach((f) => reach(f, true));
      continue;
    }
    if (!queue.length) {
      const text = readSmallText(path.join(repoRoot, texts.shift()!), MAX_SCANNED_RESOURCE);
      if (text !== undefined) classesNamedIn(text).forEach((f) => reach(f));
      continue;
    }
    const rel = queue.shift()!;
    let src: string;
    try {
      src = decodeJavaSource(fs.readFileSync(path.join(repoRoot, rel)), charset);
    } catch {
      continue;
    }
    const code = codeOnly(src);
    if (SPRING_TEST.test(code)) spring = true;
    // What is left to read for simple names once the package, the imports and the qualified names
    // that name a class of the tree are read: the "Support" of com.y.Support is that one, no other.
    const rest = code.split("");
    const done = (m: RegExpMatchArray) => {
      for (let k = m.index!; k < m.index! + m[0].length; k++) if (rest[k] !== "\n" && rest[k] !== "\r") rest[k] = " ";
    };
    const pkgDecl = new RegExp(`^\\s*package\\s+(${QUALIFIED})\\s*;`, "mu").exec(code);
    const pkg = pkgDecl?.[1].replace(/\s+/g, "") ?? "";
    if (pkgDecl) done(pkgDecl);
    const single = new Set<string>();
    const onDemand: string[] = [];
    for (const m of code.matchAll(IMPORT)) {
      done(m);
      const imported = m[2].replace(/\s+/g, "");
      typeFiles(imported, 1).forEach((f) => reach(f));
      if (m[3]) onDemand.push(imported);
      else single.add(imported.split(".").pop()!);
    }
    // Qualified names in the code: com.x.support.Fixtures.load().
    for (const m of rest.join("").matchAll(DOTTED)) {
      const found = typeFiles(m[0].replace(/\s+/g, ""), 2);
      if (!found.length) continue;
      found.forEach((f) => reach(f));
      done(m);
    }
    const pkgDir = pkg ? `${pkg.replace(/\./g, "/")}/` : "";
    for (const id of new Set(rest.join("").match(IDENT) ?? [])) {
      if (single.has(id)) continue;
      const own = index.types.get(pkg ? `${pkg}.${id}` : id);
      if (own) {
        own.forEach((f) => reach(f));
        continue;
      }
      const imported = onDemand.flatMap((q) => index.types.get(`${q}.${id}`) ?? []);
      if (imported.length) {
        imported.forEach((f) => reach(f));
        // A class of this name in the file's own package would be the one javac takes.
        const shadow = `${javaRoot}/${pkgDir}${id}.java`;
        if (!seen.has(shadow)) {
          seen.add(shadow);
          always.add(shadow);
        }
        continue;
      }
      (index.unread.get(id) ?? []).forEach((f) => reach(f));
    }
    for (const literal of stringLiterals(src, code)) {
      const value = javaStringValue(literal);
      for (const piece of new Set([value, ...value.split(/\r?\n/)].map((p) => p.trim()).filter(Boolean))) {
        resourcesNamed(piece, index.resources).forEach((r) => name(r));
        classesNamedIn(piece).forEach((f) => reach(f));
      }
    }
    for (const r of index.byPrefix.get(path.posix.basename(rel, ".java").normalize("NFC")) ?? []) name(r);
  }
  return { files: [...new Set([...classes, ...named, ...always])].sort(), partial };
}

/**
 * The records a passed batch leaves: one per class. A class's files are its own test files (by the
 * naming convention the loop uses everywhere, findExistingTests), whatever else the batch's writer
 * wrote that is not another class's test — a helper, a fixture under resources/ — and what all of
 * those reach in the test tree (referencedTestFiles). A change to any of them after the pass is a
 * change the reviewer never saw.
 */
export function passedEntries(o: {
  classes: string[];
  repoRoot: string;
  testsOf: (cls: string) => string[];
  /** Repo-relative paths the batch's writer changed, deleted ones included. */
  written: string[];
  /** The module's src/test, repo-relative: where the tests' helpers and resources are looked for. */
  testTree: string;
  /** The module's source encoding (Java's name): the tests are read as javac reads them. */
  charset?: string;
  rubric: string;
  verdict: PassedEntry["verdict"];
  dir: string;
  at: string;
}): PassedEntry[] {
  const own = new Map(o.classes.map((c) => [c, o.testsOf(c).map(toSlash)]));
  const written = o.written.map(toSlash);
  const index = indexTestTree(o.repoRoot, o.testTree, o.charset);
  return o.classes.map((cls) => {
    const others = new Set(o.classes.filter((c) => c !== cls).flatMap((c) => own.get(c) ?? []));
    const mine = own.get(cls) ?? [];
    const direct = [...new Set([...mine, ...written.filter((w) => !others.has(w) || mine.includes(w))])];
    const reach = referencedTestFiles(direct, o.repoRoot, o.testTree, o.charset, index);
    const refs = reach.files.filter((f) => !direct.includes(f));
    const rels = [...new Set([...direct, ...refs])].sort();
    return {
      cls: toSlash(cls),
      source: hashFile(path.join(o.repoRoot, cls)) ?? "",
      files: Object.fromEntries(rels.map((r) => [r, hashFile(path.join(o.repoRoot, r))])),
      ...(refs.length ? { refs } : {}),
      ...(reach.partial ? { partial: true } : {}),
      rubric: o.rubric,
      verdict: o.verdict,
      dir: o.dir,
      at: o.at,
    };
  });
}

/** An entry as a ledger holds it: its own fields and nothing a reader added (the run it was read from). */
export function ledgerEntry(e: PassedEntry): PassedEntry {
  return {
    cls: e.cls,
    source: e.source,
    files: e.files,
    ...(e.refs ? { refs: e.refs } : {}),
    ...(e.partial ? { partial: true } : {}),
    ...(e.invalid ? { invalid: e.invalid } : {}),
    rubric: e.rubric,
    verdict: e.verdict,
    dir: e.dir,
    at: e.at,
  };
}

/**
 * This run's ledger, rewritten whole each time — a reader never sees half a file (rename is atomic),
 * and the file is on disk before it replaces the last one: a power cut after a rename of unsynced
 * data can leave an empty file, and every pass it held with it.
 */
export function writeLedger(runDir: string, entries: PassedEntry[]): void {
  const file = path.join(runDir, LEDGER_FILE);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    // Every byte of it: one write(2) may take fewer than it was given (a full disk), and a truncated
    // ledger put in place loses every pass it held — worse, it lets an older one count again.
    fs.writeFileSync(fd, JSON.stringify({ version: LEDGER_VERSION, entries }, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(runDir, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    /* a directory cannot be synced everywhere (Windows): the rename is as durable as it gets */
  }
}

/**
 * Pure: `e` voided for `why` — kept as the class's newest record, so that no older one counts again
 * (see PassedEntry.invalid), with its `source` unreadable for a version of the tool that does not
 * read `invalid`.
 */
export function voidEntry(e: PassedEntry, why: string): PassedEntry {
  return { ...ledgerEntry(e), source: `${UNREADABLE}invalid`, invalid: why };
}

const isEntry = (e: unknown): e is PassedEntry => {
  const x = e as PassedEntry;
  return (
    !!x &&
    typeof x.cls === "string" &&
    typeof x.source === "string" &&
    !!x.files &&
    typeof x.files === "object" &&
    Object.values(x.files).every((h) => h === null || typeof h === "string") &&
    (x.refs === undefined || (Array.isArray(x.refs) && x.refs.every((r) => typeof r === "string"))) &&
    (x.partial === undefined || typeof x.partial === "boolean") &&
    (x.invalid === undefined || typeof x.invalid === "string") &&
    typeof x.rubric === "string" &&
    (x.verdict === null ||
      (!!x.verdict &&
        typeof x.verdict === "object" &&
        !!x.verdict.scores &&
        typeof x.verdict.scores === "object" &&
        Array.isArray(x.verdict.blockers))) &&
    typeof x.dir === "string" &&
    typeof x.at === "string"
  );
};

/**
 * Every pass the earlier runs of this repo recorded, newest run first: run ids are ISO timestamps,
 * so their order is the order they ran in. A ledger that will not parse, or that a later version of
 * the tool wrote, is left out.
 *
 * `wanted`: only these classes (repo-relative, "/"), and no older ledger once each has its newest
 * entry — only the newest counts (findPass), and every run's ledger carries the passes it resumed, so
 * the newest ledger or two is usually all there is to read, however many runs the directory holds.
 * A ledger that names a wanted class and cannot be read as this version writes it — cut short, not
 * JSON, another version's, an entry of the wrong shape — is that class's newest record all the same:
 * it stands in as a void one (entryMismatch says why). Left out, an older record would count again,
 * the very one a newer run may have found wanting.
 */
export function readLedgers(runsDir: string, exceptDir?: string, wanted?: Iterable<string>): Array<PassedEntry & { run: string }> {
  let runs: string[] = [];
  try {
    runs = fs.readdirSync(runsDir).sort().reverse();
  } catch {
    return [];
  }
  const want = wanted ? new Set([...wanted].map(toSlash)) : undefined;
  const found = new Set<string>();
  const out: Array<PassedEntry & { run: string }> = [];
  for (const run of runs) {
    if (want && found.size >= want.size) break;
    const dir = path.join(runsDir, run);
    if (exceptDir && path.resolve(dir) === path.resolve(exceptDir)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, LEDGER_FILE), "utf8");
    } catch {
      continue;
    }
    // A class that never passed is looked for in every ledger there is: one that names none of those
    // still looked for is not parsed — the "cls" values are all that is read of it.
    const named = new Set<string>();
    if (want) {
      for (const m of text.matchAll(/"cls"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        let cls: unknown;
        try {
          cls = JSON.parse(`"${m[1]}"`);
        } catch {
          continue;
        }
        if (typeof cls === "string" && want.has(cls) && !found.has(cls)) named.add(cls);
      }
      if (!named.size) continue;
    }
    const file = path.join(dir, LEDGER_FILE);
    const unreadableAs = (cls: string, why: string): PassedEntry & { run: string } => ({
      cls,
      source: `${UNREADABLE}ledger`,
      files: {},
      rubric: "",
      verdict: null,
      dir,
      at: "",
      invalid: `它最新的通過紀錄（${file}）${why}，無法確認它還成立`,
      run: dir,
    });
    let doc: { version?: unknown; entries?: unknown };
    try {
      doc = JSON.parse(text);
    } catch {
      doc = {};
    }
    if (doc?.version !== LEDGER_VERSION || !Array.isArray(doc.entries)) {
      for (const cls of named) out.push(unreadableAs(cls, doc?.version !== undefined && doc?.version !== LEDGER_VERSION ? "是另一個版本的工具寫的" : "讀不了"));
      named.forEach((c) => found.add(c));
      continue;
    }
    const newlyFound: string[] = [];
    for (const e of doc.entries) {
      if (!isEntry(e)) {
        const cls = (e as { cls?: unknown })?.cls;
        if (want && typeof cls === "string" && want.has(cls) && !found.has(cls) && !newlyFound.includes(cls)) {
          out.push(unreadableAs(cls, "格式不對"));
          newlyFound.push(cls);
        }
        continue;
      }
      if (want && (!want.has(e.cls) || found.has(e.cls))) continue;
      out.push({ ...e, run: dir });
      newlyFound.push(e.cls);
    }
    // Named in its text but not found as an entry (a "cls" in some other place): not a record of it.
    newlyFound.forEach((c) => found.add(c));
  }
  return out;
}

/**
 * Pure: why an entry no longer describes the tree, or undefined when it does. `hashOf` reads the
 * tree now (repo-relative → sha256, null when absent); `tests` are the class's test files now.
 */
export function entryMismatch(
  e: PassedEntry,
  hashOf: (rel: string) => string | null,
  tests: string[],
): string | undefined {
  if (e.invalid) return e.invalid;
  if (e.partial) {
    return `上次通過時它的測試引用到的檔超過記錄的上限（類別 ${MAX_REFERENCED_CLASSES}、資源 ${MAX_REFERENCED_RESOURCES} 個），沒有全部記下，無法確認都沒變`;
  }
  const outside = Object.keys(e.files).find((rel) => !safeLedgerPath(rel));
  if (outside !== undefined) return `紀錄裡的檔案路徑 ${outside} 不在 repo 裡，這筆紀錄不能用`;
  const source = hashOf(e.cls);
  if (unreadable(source) || unreadable(e.source)) return `${path.posix.basename(e.cls)} 讀不了，無法確認它沒變`;
  if (source !== e.source) return `${path.posix.basename(e.cls)} 在上次通過之後改過`;
  for (const [rel, h] of Object.entries(e.files)) {
    const now = hashOf(rel);
    if (unreadable(now) || unreadable(h)) return `${rel} 讀不了，無法確認它沒變`;
    if (now === h) continue;
    if (now === null) return `${rel} 在上次通過之後被刪除`;
    if (h === null) return `${rel} 在上次通過之後才出現`;
    return `${rel} 在上次通過之後改過`;
  }
  const extra = tests.map(toSlash).find((t) => !(t in e.files));
  if (extra) return `多了上次通過時沒有的測試檔 ${extra}`;
  return undefined;
}

/**
 * Pure: the newest pass of `cls`, when it still describes the tree; else why not; neither when no run
 * ever passed the class. Only the newest: an older record matching again says the files it lists are
 * back as they were, not the ones a newer record added — a helper the newer pass relied on, changed
 * since, and absent from the older record.
 */
export function findPass(
  cls: string,
  entries: PassedEntry[],
  hashOf: (rel: string) => string | null,
  tests: string[],
): { entry?: PassedEntry; mismatch?: string } {
  const newest = entries.find((e) => e.cls === toSlash(cls));
  if (!newest) return {};
  const why = entryMismatch(newest, hashOf, tests);
  return why ? { mismatch: why } : { entry: newest };
}

/** Pure: a test source's class name, from its path under the module's src/test/java; undefined outside it. */
export function testClassOf(rel: string, testRootRel: string): string | undefined {
  const r = toSlash(rel);
  const root = `${toSlash(testRootRel).replace(/\/$/, "")}/`;
  if (!r.startsWith(root) || !r.endsWith(".java")) return undefined;
  return r.slice(root.length, -".java".length).replace(/\//g, ".");
}
