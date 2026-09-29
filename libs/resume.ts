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
   * Why the pass no longer holds, found after it was recorded: its tests failed a later build of the
   * same run and passed its rebuild. Kept rather than dropped — the newest record is the one that
   * counts (findPass), and without it an older record of the class would count again.
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

/**
 * sha256 of a file's bytes; null when there is no file there. A file that cannot be read gets
 * `unreadable:<code>`, which entryMismatch never takes as a match — not even for itself: two reads
 * that both failed say nothing about whether the content is the same. Only a regular file is read —
 * opening a FIFO waits for a writer that never comes — and it is read in pieces, so its size is no
 * limit (a whole read fails past 2 GB).
 */
export function hashFile(abs: string): string | null {
  let fd: number | undefined;
  try {
    if (!fs.statSync(abs).isFile()) return `${UNREADABLE}not-a-file`;
    fd = fs.openSync(abs, "r");
    const hash = createHash("sha256");
    const buf = Buffer.alloc(1024 * 1024);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
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

/**
 * The files of the test tree `roots` reach: the classes of the tree they name, and the ones those
 * name, and the resources their string literals name or that are named after them. What a reviewer
 * reading a test also reads — the base class it extends, the fixture builder and assertion helper it
 * calls, the JSON it loads — and what the test's behaviour hangs on: a hollowed-out helper leaves the
 * build green and the coverage where it was. Breadth first: the nearest helpers are the ones kept
 * when a budget runs out (`partial`). Repo-relative, "/" separators; `testTree` is the module's
 * src/test, `charset` its sources' encoding (Java's name).
 *
 * A name is resolved as javac resolves it, as far as the files tell: an import names its class, and a
 * simple name is the one of the file's own package or of a package it imports on demand; only a name
 * none of those has — another class's nested one, one in a folder its package does not match — is
 * every class of that name. Every class of a name was a helper each package of a large tree has
 * (Fixtures, Builders), and the walk ran out of budget on classes no test used.
 */
export function referencedTestFiles(
  roots: string[],
  repoRoot: string,
  testTree: string,
  charset?: string,
): { files: string[]; partial: boolean } {
  const byClass = new Map<string, string[]>();
  const javaFiles = new Set<string>();
  const resources = new Map<string, string[]>();
  // A resource by every prefix of its name that ends at a separator: "CalcTest.add.approved.txt"
  // under CalcTest and CalcTest.add — Spring's CalcTest.sql and CalcTest-context.xml, an approval
  // or snapshot file: named after the test, never in a string.
  const byPrefix = new Map<string, string[]>();
  const walk = (dir: string, onFile: (rel: string, name: string) => void) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, onFile);
      else if (e.isFile()) onFile(rel, e.name);
    }
  };
  const add = (map: Map<string, string[]>, key: string, rel: string) => {
    const list = map.get(key);
    if (list) list.push(rel);
    else map.set(key, [rel]);
  };
  const addResource = (rel: string, raw: string) => {
    const name = raw.normalize("NFC");
    add(resources, name, rel);
    for (let i = 1; i < name.length; i++) if (".-_".includes(name[i])) add(byPrefix, name.slice(0, i), rel);
  };
  const tree = toSlash(testTree).replace(/\/$/, "");
  const javaRoot = `${tree}/java`;
  walk(javaRoot, (rel, name) => {
    // Beside the tests, not only under resources/: approval and snapshot files are read by path.
    if (!name.endsWith(".java")) return addResource(rel, name);
    add(byClass, name.slice(0, -".java".length), rel);
    javaFiles.add(rel);
  });
  walk(`${tree}/resources`, addResource);
  const fileOf = (fqcn: string) => {
    const rel = `${javaRoot}/${fqcn.replace(/\./g, "/")}.java`;
    return javaFiles.has(rel) ? rel : undefined;
  };
  // A qualified name's file: the longest prefix of it that is a class of the tree (a.b.Outer.Inner.x).
  const typeFile = (dotted: string, least: number) => {
    const segs = dotted.split(".");
    for (let n = segs.length; n >= least; n--) {
      const f = fileOf(segs.slice(0, n).join("."));
      if (f) return f;
    }
    return undefined;
  };
  const classes = new Set<string>();
  const named = new Set<string>();
  let partial = false;
  const queue = roots.map(toSlash).filter((r) => r.endsWith(".java"));
  const seen = new Set(queue);
  const reach = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    if (classes.size >= MAX_REFERENCED_CLASSES) {
      partial = true;
      return;
    }
    classes.add(f);
    queue.push(f);
  };
  const name = (r: string) => {
    if (named.has(r)) return;
    if (named.size >= MAX_REFERENCED_RESOURCES) {
      partial = true;
      return;
    }
    named.add(r);
  };
  while (queue.length) {
    const rel = queue.shift()!;
    let src: string;
    try {
      src = decodeJavaSource(fs.readFileSync(path.join(repoRoot, rel)), charset);
    } catch {
      continue;
    }
    const code = codeOnly(src);
    // What is left to read for simple names once the package, the imports and the qualified names
    // that name a class of the tree are read: the "Support" of com.y.Support is that one, no other.
    const rest = code.split("");
    const done = (m: RegExpMatchArray) => {
      for (let k = m.index!; k < m.index! + m[0].length; k++) if (rest[k] !== "\n" && rest[k] !== "\r") rest[k] = " ";
    };
    const pkgDecl = /^\s*package\s+([\w$]+(?:\s*\.\s*[\w$]+)*)\s*;/m.exec(code);
    const pkg = pkgDecl?.[1].replace(/\s+/g, "") ?? "";
    if (pkgDecl) done(pkgDecl);
    const single = new Set<string>();
    const onDemand: string[] = [];
    for (const m of code.matchAll(/\bimport\s+(static\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)(\s*\.\s*\*)?\s*;/g)) {
      done(m);
      const imported = m[2].replace(/\s+/g, "");
      const f = typeFile(imported, 1);
      if (f) reach(f);
      if (m[3]) onDemand.push(imported);
      else single.add(imported.split(".").pop()!);
    }
    // Qualified names in the code: com.x.support.Fixtures.load().
    const unqualified = rest.join("");
    for (const m of unqualified.matchAll(/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+/g)) {
      const f = typeFile(m[0].replace(/\s+/g, ""), 2);
      if (!f) continue;
      reach(f);
      done(m);
    }
    for (const id of new Set(rest.join("").match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      const all = byClass.get(id);
      if (!all || single.has(id)) continue;
      const scoped = [pkg, ...onDemand].map((p) => fileOf(p ? `${p}.${id}` : id)).filter((f): f is string => !!f);
      (scoped.length ? scoped : all).forEach(reach);
    }
    for (const literal of stringLiterals(src, code)) {
      const value = javaStringValue(literal);
      for (const piece of new Set([value, ...value.split(/\r?\n/)].map((p) => p.trim()).filter(Boolean))) {
        resourcesNamed(piece, resources).forEach(name);
      }
    }
    for (const r of byPrefix.get(path.posix.basename(rel, ".java").normalize("NFC")) ?? []) name(r);
  }
  return { files: [...classes, ...named].sort(), partial };
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
  return o.classes.map((cls) => {
    const others = new Set(o.classes.filter((c) => c !== cls).flatMap((c) => own.get(c) ?? []));
    const mine = own.get(cls) ?? [];
    const direct = [...new Set([...mine, ...written.filter((w) => !others.has(w) || mine.includes(w))])];
    const reach = referencedTestFiles(direct, o.repoRoot, o.testTree, o.charset);
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
    fs.writeSync(fd, JSON.stringify({ version: LEDGER_VERSION, entries }, null, 2));
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
 * the tool wrote, is left out — it can only cost a class its skip.
 *
 * `wanted`: only these classes (repo-relative, "/"), and no older ledger once each has its newest
 * entry — only the newest counts (findPass), and every run's ledger carries the passes it resumed, so
 * the newest ledger or two is usually all there is to read, however many runs the directory holds.
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
    if (want) {
      let names = false;
      for (const m of text.matchAll(/"cls"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        let cls: unknown;
        try {
          cls = JSON.parse(`"${m[1]}"`);
        } catch {
          continue;
        }
        if (typeof cls === "string" && want.has(cls) && !found.has(cls)) {
          names = true;
          break;
        }
      }
      if (!names) continue;
    }
    let doc: { version?: unknown; entries?: unknown };
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    if (doc?.version !== LEDGER_VERSION || !Array.isArray(doc.entries)) continue;
    const newlyFound: string[] = [];
    for (const e of doc.entries) {
      if (!isEntry(e) || (want && (!want.has(e.cls) || found.has(e.cls)))) continue;
      out.push({ ...e, run: dir });
      newlyFound.push(e.cls);
    }
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

/**
 * Pure: does this test source (code only: see codeOnly) declare a class Spring loads without any test
 * naming it — a stereotype that component scanning finds, a configuration class, a @TestConfiguration
 * a @SpringBootTest's search for configuration finds? Changed, it changes what every test that starts
 * a context runs with, and no reference from a test leads to it.
 */
export function springLoaded(code: string): boolean {
  return /@(?:[\w$]+\s*\.\s*)*(?:Component|ComponentScan|Service|Repository|Controller|RestController|ControllerAdvice|RestControllerAdvice|Configuration|TestConfiguration|SpringBootConfiguration|SpringBootApplication|AutoConfiguration|TestComponent|JsonComponent)\b/.test(
    code,
  );
}

/** Pure: a test source's class name, from its path under the module's src/test/java; undefined outside it. */
export function testClassOf(rel: string, testRootRel: string): string | undefined {
  const r = toSlash(rel);
  const root = `${toSlash(testRootRel).replace(/\/$/, "")}/`;
  if (!r.startsWith(root) || !r.endsWith(".java")) return undefined;
  return r.slice(root.length, -".java".length).replace(/\//g, ".");
}
