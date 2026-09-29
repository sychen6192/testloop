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
import { codeOnly } from "./javasrc";

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
 * that both failed say nothing about whether the content is the same.
 */
export function hashFile(abs: string): string | null {
  try {
    return sha256(fs.readFileSync(abs));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : `${UNREADABLE}${code ?? "?"}`;
  }
}

// A transitive walk that could reach the whole test tree is bounded: past this many files the pass
// records what it found, and a change beyond them is one the rerun does not see — the checks it does
// run again (build, coverage) still apply.
const MAX_REFERENCED = 400;

/**
 * The files of the test tree `roots` reach: the classes of the tree they name, and the ones those
 * name, and the resources their string literals name (by file name). What a reviewer reading a test
 * also reads — the base class it extends, the fixture builder and assertion helper it calls, the JSON
 * it loads — and what the test's behaviour hangs on: a hollowed-out helper leaves the build green and
 * the coverage where it was. Repo-relative, "/" separators; `testTree` is the module's src/test.
 */
export function referencedTestFiles(roots: string[], repoRoot: string, testTree: string): string[] {
  const byClass = new Map<string, string[]>();
  const resources: Array<{ name: string; rel: string }> = [];
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
  const tree = toSlash(testTree).replace(/\/$/, "");
  walk(`${tree}/java`, (rel, name) => {
    if (!name.endsWith(".java")) return;
    const cls = name.slice(0, -".java".length);
    byClass.set(cls, [...(byClass.get(cls) ?? []), rel]);
  });
  walk(`${tree}/resources`, (rel, name) => resources.push({ name, rel }));
  const found = new Set<string>();
  const queue = roots.map(toSlash).filter((r) => r.endsWith(".java"));
  const seen = new Set(queue);
  while (queue.length && found.size < MAX_REFERENCED) {
    const rel = queue.shift()!;
    let src: string;
    try {
      src = fs.readFileSync(path.join(repoRoot, rel), "latin1");
    } catch {
      continue;
    }
    for (const id of new Set(codeOnly(src).match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      for (const f of byClass.get(id) ?? []) {
        if (seen.has(f)) continue;
        seen.add(f);
        found.add(f);
        queue.push(f);
      }
    }
    for (const r of resources) {
      if (!found.has(r.rel) && new RegExp(`["/\\\\]${r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(src)) found.add(r.rel);
    }
  }
  return [...found].sort();
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
    const rels = [...new Set([...direct, ...referencedTestFiles(direct, o.repoRoot, o.testTree)])].sort();
    return {
      cls: toSlash(cls),
      source: hashFile(path.join(o.repoRoot, cls)) ?? "",
      files: Object.fromEntries(rels.map((r) => [r, hashFile(path.join(o.repoRoot, r))])),
      rubric: o.rubric,
      verdict: o.verdict,
      dir: o.dir,
      at: o.at,
    };
  });
}

/** An entry as a ledger holds it: its own fields and nothing a reader added (the run it was read from). */
export function ledgerEntry(e: PassedEntry): PassedEntry {
  return { cls: e.cls, source: e.source, files: e.files, rubric: e.rubric, verdict: e.verdict, dir: e.dir, at: e.at };
}

/** This run's ledger, rewritten whole each time — a reader never sees half a file (rename is atomic). */
export function writeLedger(runDir: string, entries: PassedEntry[]): void {
  const file = path.join(runDir, LEDGER_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: LEDGER_VERSION, entries }, null, 2));
  fs.renameSync(tmp, file);
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
 */
export function readLedgers(runsDir: string, exceptDir?: string): Array<PassedEntry & { run: string }> {
  let runs: string[] = [];
  try {
    runs = fs.readdirSync(runsDir).sort().reverse();
  } catch {
    return [];
  }
  const out: Array<PassedEntry & { run: string }> = [];
  for (const run of runs) {
    const dir = path.join(runsDir, run);
    if (exceptDir && path.resolve(dir) === path.resolve(exceptDir)) continue;
    let doc: { version?: unknown; entries?: unknown };
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, LEDGER_FILE), "utf8"));
    } catch {
      continue;
    }
    if (doc?.version !== LEDGER_VERSION || !Array.isArray(doc.entries)) continue;
    for (const e of doc.entries) if (isEntry(e)) out.push({ ...e, run: dir });
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
