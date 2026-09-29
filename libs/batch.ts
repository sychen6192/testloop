// Batching support for folder targets: splitting the target classes, and putting a failed
// batch's test tree back the way it was — its build outputs included.
//
// A folder target used to go to one writer session and one reviewer session as a whole. With
// more than a few classes that session outgrew the model's context or the agent timeout, and one
// class that could not be made green ended the run for all of them. loop.ts now runs the
// maker-checker loop per batch; these helpers are the parts of that which are not control flow.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BuildTool } from "./types";
import { diffSnapshots, TreeSnapshot } from "./utils";

/** Pure: consecutive groups of at most `size` items, in order. */
export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

// A test tree is sources and fixtures; these bounds only keep a pathological one (generated
// resources, a checked-in binary) from holding the process's memory. What is over them is still
// listed, so a change to it is reported as not restorable instead of going unnoticed.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface TreeCapture {
  root: string;
  /** Relative path ("/" separators) → contents, or null when too large to keep. */
  files: Map<string, Buffer | null>;
  /** size:mtime of the files too large to keep — enough to tell that one was touched. */
  fingerprints: Map<string, string>;
  /** Relative directories that existed, so directories a batch created can be removed again. */
  dirs: Set<string>;
}

function walkFiles(root: string, onFile: (rel: string, abs: string) => void, onDir?: (rel: string) => void): void {
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // vanished or unreadable: nothing to capture or compare
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (e.isDirectory()) {
        onDir?.(rel);
        walk(abs);
      } else if (e.isFile()) {
        onFile(rel, abs);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
}

const fingerprint = (st: fs.Stats) => `${st.size}:${st.mtimeMs}`;

const SOURCE = /\.(?:java|kt|groovy)$/;

/**
 * The contents of every regular file under `root` — a batch's starting point. `limits` is for the
 * selftest, which cannot write a quarter of a gigabyte to reach the real bound.
 */
export function captureTree(root: string, limits = { file: MAX_FILE_BYTES, total: MAX_TOTAL_BYTES }): TreeCapture {
  const files = new Map<string, Buffer | null>();
  const fingerprints = new Map<string, string>();
  const dirs = new Set<string>();
  const found: Array<{ rel: string; abs: string; st: fs.Stats }> = [];
  walkFiles(
    root,
    (rel, abs) => {
      try {
        found.push({ rel, abs, st: fs.statSync(abs) });
      } catch {
        /* gone meanwhile */
      }
    },
    (rel) => dirs.add(rel),
  );
  // Sources first, then smallest first: the total bound is for fixtures, and a test source kept
  // out by fixtures read before it — it is what a batch changes most — could not be put back.
  found.sort((a, b) => Number(SOURCE.test(b.rel)) - Number(SOURCE.test(a.rel)) || a.st.size - b.st.size);
  let total = 0;
  for (const { rel, abs, st } of found) {
    if (st.size > limits.file || total + st.size > limits.total) {
      files.set(rel, null);
      fingerprints.set(rel, fingerprint(st));
      continue;
    }
    try {
      const buf = fs.readFileSync(abs);
      total += buf.length;
      files.set(rel, buf);
    } catch {
      files.set(rel, null);
      fingerprints.set(rel, fingerprint(st));
    }
  }
  return { root, files, fingerprints, dirs };
}

// On Windows an antivirus scan or an IDE indexer holds a file for a moment (EBUSY, EPERM): retried
// briefly before it counts as a file that could not be put back.
const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

function retrying(op: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      op();
      return;
    } catch (e) {
      if (attempt >= 4 || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
}

export interface RollbackReport {
  /** Files the batch created: moved into the rejected directory. */
  created: string[];
  /** Files the batch changed: its version copied to the rejected directory, the original restored. */
  restored: string[];
  /** Files the batch deleted: put back. */
  undeleted: string[];
  /** Changed files whose original was too large to keep: left as the batch left them. */
  unrestorable: string[];
  /** Files that could not be put back, with why: the tree is not as it was captured. */
  failed: string[];
  /** Files whose attempted version could not be kept in the rejected directory (put back anyway). */
  notKept: string[];
  /** Changed while the batch ran, but not by its writer (an editor, a test writing files): left as they are. */
  foreign: string[];
}

// What a directory the batch left where a file was holds once its created files are gone: empty
// directories, at any depth. Removed deepest first; anything else in it is an error — a file that
// could not be moved away is not deleted with it.
function removeEmptyTree(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) removeEmptyTree(p);
    else throw Object.assign(new Error(`${p} is not empty`), { code: "ENOTEMPTY" });
  }
  fs.rmdirSync(dir);
}

/**
 * Puts the tree under `capture.root` back to the captured state and keeps what the batch wrote:
 * every file it created or changed is copied to `rejectedDir` under `rejectedPrefix/<relative
 * path>` first, so an attempt that did not pass is still there to read, and to copy back by hand.
 * Compared by content, not mtime: a file rewritten with identical bytes was not changed. A file
 * that cannot be put back is reported, not thrown: the rest of the tree still is.
 *
 * `only`, when given, is what the batch's writer changed (relative paths): anything else that
 * changed meanwhile — an edit in the developer's IDE, a file a test wrote — is not the batch's to
 * undo, and is listed as foreign instead.
 */
export function rollbackTree(capture: TreeCapture, rejectedDir: string, rejectedPrefix = "", only?: Set<string>): RollbackReport {
  const report: RollbackReport = { created: [], restored: [], undeleted: [], unrestorable: [], failed: [], notKept: [], foreign: [] };
  const ours = (rel: string) => !only || only.has(rel);
  const keep = (rel: string, abs: string) => {
    try {
      const dest = path.join(rejectedDir, rejectedPrefix, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    } catch {
      report.notKept.push(rel);
    }
  };
  const putBack = (rel: string, list: string[], op: () => void) => {
    try {
      retrying(op);
      list.push(rel);
    } catch (e) {
      report.failed.push(`${rel}（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）`);
    }
  };
  const seen = new Set<string>();
  const createdDirs: string[] = [];
  walkFiles(
    capture.root,
    (rel, abs) => {
      seen.add(rel);
      if (!capture.files.has(rel)) {
        if (!ours(rel)) {
          report.foreign.push(rel);
          return;
        }
        keep(rel, abs);
        putBack(rel, report.created, () => fs.rmSync(abs, { force: true }));
        return;
      }
      const original = capture.files.get(rel);
      if (original === null || original === undefined) {
        // Too large to have kept: all that can be said is whether it looks touched.
        let st: fs.Stats | undefined;
        try {
          st = fs.statSync(abs);
        } catch {
          /* gone meanwhile */
        }
        if (st && fingerprint(st) !== capture.fingerprints.get(rel)) {
          if (!ours(rel)) {
            report.foreign.push(rel);
            return;
          }
          keep(rel, abs);
          report.unrestorable.push(rel);
        }
        return;
      }
      let now: Buffer;
      try {
        now = fs.readFileSync(abs);
      } catch (e) {
        report.failed.push(`${rel}（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）`);
        return;
      }
      if (!now.equals(original)) {
        if (!ours(rel)) {
          report.foreign.push(rel);
          return;
        }
        keep(rel, abs);
        putBack(rel, report.restored, () => fs.writeFileSync(abs, original));
      }
    },
    (rel) => {
      if (!capture.dirs.has(rel)) createdDirs.push(rel);
    },
  );
  for (const [rel, original] of capture.files) {
    if (seen.has(rel)) continue;
    if (!ours(rel)) {
      report.foreign.push(rel);
      continue;
    }
    const abs = path.join(capture.root, rel);
    if (original === null || original === undefined) {
      report.unrestorable.push(rel);
      continue;
    }
    putBack(rel, report.undeleted, () => {
      // Whatever the batch left in its place goes first: a directory (now emptied of the files
      // it created), a link, a pipe — which a write would block on.
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(abs);
      } catch {
        st = undefined;
      }
      if (st?.isDirectory()) removeEmptyTree(abs);
      else if (st) fs.rmSync(abs, { force: true });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, original);
    });
  }
  // Directories the batch created and that are now empty; deepest first.
  for (const rel of createdDirs.sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(path.join(capture.root, rel));
    } catch {
      /* not empty (something else lives there now) — leave it */
    }
  }
  for (const list of Object.values(report)) list.sort();
  return report;
}

// ─── Build outputs ───────────────────────────────────────────────────────────

/** Where the build puts compiled tests and copied test resources. */
export function testOutputDirs(moduleRoot: string, tool: BuildTool): string[] {
  return tool === "maven"
    ? [path.join(moduleRoot, "target", "test-classes")]
    : ["classes/java/test", "classes/kotlin/test", "classes/groovy/test", "resources/test"].map((d) =>
        path.join(moduleRoot, "build", ...d.split("/")),
      );
}

export interface OutputCapture {
  dirs: Array<{ dir: string; files: Set<string> }>;
}

/** Which output files exist — a batch's starting point, for its build outputs. */
export function captureOutputs(dirs: string[]): OutputCapture {
  return {
    dirs: dirs.map((dir) => {
      const files = new Set<string>();
      walkFiles(dir, (rel) => files.add(rel));
      return { dir, files };
    }),
  };
}

/**
 * After a rollback, what the batch's builds left behind. Test compilation and the resource copy
 * add and overwrite but never delete: the class of a test the rollback set aside stayed in
 * test-classes, and surefire runs the test classes it finds there — the failing test went on
 * failing every later batch's build — and a resource it added (a mockito-extensions switch)
 * went on changing their mock maker. Removed: every output file that did not exist when the batch
 * started, and the outputs of the sources the rollback put back, which the next build rebuilds
 * from them. `touched` is relative to the test tree (java/…, resources/…). Returns what was removed.
 */
export function removeBatchOutputs(capture: OutputCapture, touched: string[]): string[] {
  const stems: string[] = [];
  const resources = new Set<string>();
  for (const rel of touched) {
    const src = /^(?:java|kotlin|groovy)\/(.+)\.(?:java|kt|groovy)$/.exec(rel);
    if (src) stems.push(src[1]);
    else if (rel.startsWith("resources/")) resources.add(rel.slice("resources/".length));
  }
  // <pkg>/<Name>.java compiles to <pkg>/<Name>.class and its nested and anonymous <pkg>/<Name>$….class.
  const compiledFrom = (rel: string) =>
    rel.endsWith(".class") && stems.some((s) => rel === `${s}.class` || rel.startsWith(`${s}$`));
  const removed: string[] = [];
  // A directory that did not exist when the batch started (a module with no tests before it) is
  // all the batch's, every file in it: its builds may have compiled other tests' classes there too,
  // and they are rebuilt, but a class named after nothing that is left — a second top-level class
  // in a test the rollback took out — would otherwise stay and be run by surefire.
  for (const { dir, files } of capture.dirs) {
    walkFiles(dir, (rel, abs) => {
      if (files.has(rel) && !compiledFrom(rel) && !resources.has(rel)) return;
      try {
        retrying(() => fs.rmSync(abs, { force: true }));
        removed.push(abs);
      } catch {
        /* held open: the next build overwrites a stale output, and a new one it cannot is reported by its gate */
      }
    });
  }
  return removed.sort();
}

// ─── The journal of a batch in flight ────────────────────────────────────────
//
// A failed or interrupted batch is set aside by the process running it — when it lives to do it. A
// run killed outright (the OOM killer, a cancelled CI job, a power cut, a Windows console closed
// with more to undo than the ten seconds Windows waits) left its writer's half-written tests in
// src/test, and the next run took them for existing tests: kept by the shrink guard, handed to the
// writer as the file to edit, the baseline red on them. So while a batch runs, what its rollback
// needs is on disk: the tree it started from, its build outputs' listing, what its writer has changed
// and the tree as the open session found it. The next run on the repo finishes the job
// (loop.ts recoverKilledBatches); a batch that ends in any other way removes its journal.

// 2: the tree it started from packed into start.bin, and who wrote it with its start time and checkout.
const JOURNAL_VERSION = 2;
/** Under the batch's artifacts directory. */
export const JOURNAL_DIR = "inflight";

/** Where a process runs: its pid means something only on the same host, since the same boot. */
export interface JournalHost {
  host: string;
  /** Boot time, in minutes since the epoch. */
  boot: number;
  /**
   * Linux: the pid namespace (/proc/self/ns/pid). Containers on one machine can share its host name
   * and boot (host networking) and still number their processes apart: a pid written in another one
   * names nobody here. Absent where there is none to read.
   */
  pidns?: string;
}

let pidNamespace: string | null | undefined;

export function thisHost(): JournalHost {
  if (pidNamespace === undefined) {
    try {
      pidNamespace = process.platform === "linux" ? fs.readlinkSync("/proc/self/ns/pid") : null;
    } catch {
      pidNamespace = null;
    }
  }
  const here: JournalHost = { host: os.hostname(), boot: Math.round((Date.now() / 1000 - os.uptime()) / 60) };
  if (pidNamespace) here.pidns = pidNamespace;
  return here;
}

/** Pure: whether a pid recorded `there` still means a process here — the same host, boot and pid namespace. */
export function samePids(there: { host?: unknown; boot?: unknown; pidns?: unknown }, here: JournalHost): boolean {
  return (
    there.host === here.host &&
    typeof there.boot === "number" &&
    Math.abs(there.boot - here.boot) <= 2 &&
    (there.pidns ?? "") === (here.pidns ?? "")
  );
}

/**
 * Which directory this is, beyond its path: device and inode. A checkout deleted and cloned again at
 * the same path, a test tree removed and recreated, is another directory — a killed batch's leftovers
 * cannot be in it. "" when the file system has no inode numbers to tell by.
 */
export function dirIdentity(dir: string): string {
  try {
    const st = fs.statSync(dir, { bigint: true });
    return st.ino ? `${st.dev}:${st.ino}` : "";
  } catch {
    return "";
  }
}

/** Who wrote a journal: the run, where, and for which checkout. Written first (owner.json). */
export interface JournalOwner extends JournalHost {
  /** Canonical (libs/lock.ts canonicalRoot). */
  repoRoot: string;
  /** dirIdentity of the repo root and of the test tree when the batch started. */
  rootId: string;
  treeId: string;
  pid: number;
  /** processStart (libs/shell.ts) of the run: "" where there is no way to read it (Windows). */
  start: string;
}

export interface BatchJournal extends JournalOwner {
  version: number;
  runDir: string;
  batch: number;
  /** The batch's artifacts. */
  dir: string;
  targetClasses: string[];
  /** The test tree, absolute, and as the run shows it (repo-relative). */
  testTree: string;
  treeRel: string;
  /** The files kept as [relative path, offset, length] in start.bin; those too large, by fingerprint. */
  capture: { kept: Array<[string, number, number]>; tooLarge: Record<string, string>; dirs: string[] };
  outputs: Array<{ dir: string; files: string[] }>;
}

/** What the writer has changed so far (relative to the test tree), and the tree as its open session found it. */
export interface JournalTrace {
  written: string[];
  session?: TreeSnapshot;
}

function writeAtomic(file: string, text: string): void {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

/** An open journal: its directory, and the heartbeat that keeps its time current while the run lives. */
export interface JournalHandle {
  dir: string;
  beat: ReturnType<typeof setInterval>;
}

/**
 * Writes a batch's journal as the batch starts, and starts its heartbeat. Whose it is goes first and
 * journal.json last: a journal without journal.json was cut short while being written, and the
 * owner file says whether it is this repo's to throw away. The tree the batch starts from goes into
 * one file: thousands of small copies, per batch, were what an antivirus scanning every write made
 * slow. A journal that cannot be written completely is not left half-written. `beatMs`: for the selftest.
 */
export function openJournal(
  j: Omit<BatchJournal, "version" | "capture" | "outputs">,
  capture: TreeCapture,
  outputs: OutputCapture,
  beatMs: number,
): JournalHandle {
  const dir = path.join(j.dir, JOURNAL_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.mkdirSync(dir, { recursive: true });
    const owner: JournalOwner = {
      repoRoot: j.repoRoot,
      rootId: j.rootId,
      treeId: j.treeId,
      pid: j.pid,
      start: j.start,
      host: j.host,
      boot: j.boot,
      ...(j.pidns ? { pidns: j.pidns } : {}),
    };
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
    const kept: Array<[string, number, number]> = [];
    const tooLarge: Record<string, string> = {};
    const fd = fs.openSync(path.join(dir, "start.bin"), "w");
    try {
      let at = 0;
      for (const [rel, buf] of capture.files) {
        if (!buf) {
          tooLarge[rel] = capture.fingerprints.get(rel) ?? "";
          continue;
        }
        for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
        kept.push([rel, at, buf.length]);
        at += buf.length;
      }
    } finally {
      fs.closeSync(fd);
    }
    const journal: BatchJournal = {
      version: JOURNAL_VERSION,
      ...j,
      capture: { kept, tooLarge, dirs: [...capture.dirs] },
      outputs: outputs.dirs.map((d) => ({ dir: d.dir, files: [...d.files] })),
    };
    writeAtomic(path.join(dir, "journal.json"), JSON.stringify(journal));
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  // The run is alive: what the next run compares a change's time against, once this one is killed.
  const beat = setInterval(() => {
    const now = new Date();
    try {
      fs.utimesSync(path.join(dir, "journal.json"), now, now);
    } catch {
      /* gone: the batch has ended */
    }
  }, beatMs);
  beat.unref();
  return { dir, beat };
}

/** Records what the writer has changed so far; a session that is open says so. */
export function traceJournal(h: JournalHandle, trace: JournalTrace): void {
  writeAtomic(path.join(h.dir, "trace.json"), JSON.stringify(trace));
}

/** The batch has ended in a way its run lived through: nothing left for a later run to finish. */
export function closeJournal(h: JournalHandle | string): void {
  if (typeof h !== "string") clearInterval(h.beat);
  fs.rmSync(typeof h === "string" ? h : h.dir, { recursive: true, force: true });
}

export interface DeadBatch {
  /** The journal's directory. */
  path: string;
  journal: BatchJournal;
  trace: JournalTrace;
  /** When the run was last known alive: the journal's heartbeat, or its last trace. */
  lastSeen: number;
}

const mtimeOrZero = (p: string) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** How the caller finds out about processes on this machine (libs/shell.ts, injected for the selftest). */
export interface ProcessProbe {
  alive(pid: number): boolean;
  /** processStart: undefined when there is no such process, or no way to tell. */
  start(pid: number): string | undefined;
}

/**
 * Pure: whether the run that wrote a journal on this host may still be running. The caller holds the
 * repo lock, so it cannot be — but a pid only means something since the boot it was written in (a
 * machine that rebooted has no run from before), and is only that run while it is the same process:
 * its start time says so, where the OS reports one. Without it (Windows), a live pid that is still
 * beating counts as the run. Written in another pid namespace (a container sharing this machine's
 * name), its pid names nobody here: only its heartbeat can tell.
 */
export function mayBeRunning(
  owner: { pid?: number; start?: string; boot?: number; pidns?: string },
  lastSeen: number,
  here: JournalHost,
  probe: ProcessProbe,
  now: number,
  staleAfterMs: number,
): boolean {
  if (owner.boot === undefined || Math.abs(owner.boot - here.boot) > 2) return false;
  if ((owner.pidns ?? "") !== (here.pidns ?? "")) return now - lastSeen < staleAfterMs;
  const pid = owner.pid ?? -1;
  if (pid === process.pid) return false;
  const start = owner.start ? probe.start(pid) : undefined;
  if (start !== undefined) return start === owner.start;
  return probe.alive(pid) && now - lastSeen < staleAfterMs;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Pure: whether a parsed journal.json is one this version wrote, in every field recovery reads. */
export function isJournal(j: unknown): j is BatchJournal {
  const x = j as BatchJournal;
  return (
    !!x &&
    typeof x === "object" &&
    x.version === JOURNAL_VERSION &&
    typeof x.repoRoot === "string" &&
    typeof x.runDir === "string" &&
    typeof x.dir === "string" &&
    typeof x.testTree === "string" &&
    typeof x.treeRel === "string" &&
    Number.isInteger(x.batch) &&
    Number.isInteger(x.pid) &&
    isStrings(x.targetClasses) &&
    !!x.capture &&
    Array.isArray(x.capture.kept) &&
    x.capture.kept.every((k) => Array.isArray(k) && typeof k[0] === "string" && Number.isInteger(k[1]) && Number.isInteger(k[2])) &&
    !!x.capture.tooLarge &&
    typeof x.capture.tooLarge === "object" &&
    isStrings(x.capture.dirs) &&
    Array.isArray(x.outputs) &&
    x.outputs.every((o) => !!o && typeof o.dir === "string" && isStrings(o.files))
  );
}

function readTrace(dir: string): JournalTrace | undefined {
  let t: JournalTrace;
  try {
    t = JSON.parse(fs.readFileSync(path.join(dir, "trace.json"), "utf8"));
  } catch (e) {
    // No writer session had begun: nothing recorded yet.
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { written: [] } : undefined;
  }
  const ok =
    !!t &&
    isStrings(t.written) &&
    (t.session === undefined || (!!t.session && typeof t.session === "object" && Object.values(t.session).every((v) => typeof v === "string")));
  return ok ? t : undefined;
}

/**
 * The journals this repo's earlier runs on this machine left under `runsDir`: batches whose run ended
 * without setting them aside (see mayBeRunning). A journal is only ever this run's to act on when it
 * was written here, for this checkout: another host sharing the runs directory — the same path, its
 * own checkout — has its own tree; its journals are left for it (`elsewhere`), and so are those of
 * another container on this machine whose checkout is not this one. Ours to throw away (`stale`):
 * one whose run did end (it has a summary.json), one cut short while being written, one that will
 * not parse, and one whose checkout or test tree is not there any more (the same path now holds
 * another). A run that may still be going keeps its journals (`running`).
 */
export function findJournals(
  runsDir: string,
  checkout: { repoRoot: string; rootId: string },
  probe: ProcessProbe,
  here: JournalHost = thisHost(),
  now = Date.now(),
  staleAfterMs = 5 * 60_000,
): { dead: DeadBatch[]; stale: Array<{ dir: string; why: string }>; running: number; elsewhere: number } {
  const dead: DeadBatch[] = [];
  const stale: Array<{ dir: string; why: string }> = [];
  let running = 0;
  let elsewhere = 0;
  const list = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  };
  for (const run of list(runsDir)) {
    for (const batch of list(path.join(runsDir, run)).filter((b) => b.startsWith("batch-"))) {
      const dir = path.join(runsDir, run, batch, JOURNAL_DIR);
      let owner: Partial<JournalOwner>;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
      } catch {
        continue; // none, or not this tool's: not ours to judge
      }
      if (!owner || typeof owner !== "object" || owner.repoRoot !== checkout.repoRoot) continue;
      if (owner.host !== here.host) {
        elsewhere++;
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(dir, "journal.json"), "utf8"));
      } catch (e) {
        // Cut short while being written — or still being written, by a run that is alive.
        const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
        if (missing && mayBeRunning(owner, mtimeOrZero(path.join(dir, "owner.json")), here, probe, now, staleAfterMs)) running++;
        else stale.push({ dir, why: missing ? "寫到一半就被終止" : "內容損毀" });
        continue;
      }
      if (!isJournal(raw)) {
        const v = (raw as { version?: unknown })?.version;
        if (typeof v === "number" && v !== JOURNAL_VERSION) continue; // another version's: not ours to read
        stale.push({ dir, why: "內容損毀" });
        continue;
      }
      const journal = raw;
      const lastSeen = Math.max(mtimeOrZero(path.join(dir, "journal.json")), mtimeOrZero(path.join(dir, "trace.json")));
      if (mayBeRunning(journal, lastSeen, here, probe, now, staleAfterMs)) {
        running++;
        continue;
      }
      if (fs.existsSync(path.join(journal.runDir, "summary.json"))) {
        stale.push({ dir, why: "那次執行有收尾" });
        continue;
      }
      // Its checkout, and its test tree, must be the ones on disk now. Written in another pid namespace
      // — a container sharing this machine's name — a different one is that container's own checkout
      // at the same path, not this one cloned again: its journal is left for it.
      const theirs = (journal.pidns ?? "") !== (here.pidns ?? "");
      if (journal.rootId && checkout.rootId && journal.rootId !== checkout.rootId) {
        if (theirs) elsewhere++;
        else stale.push({ dir, why: "這個路徑現在是另一個 checkout（重新 clone 過）" });
        continue;
      }
      const treeNow = dirIdentity(journal.testTree);
      if (!fs.existsSync(journal.testTree) || (journal.treeId && treeNow && treeNow !== journal.treeId)) {
        if (theirs) elsewhere++;
        else stale.push({ dir, why: `它的測試目錄 ${journal.treeRel} 已經不是那時的那一個（被刪除或重建過）` });
        continue;
      }
      const trace = readTrace(dir);
      if (!trace) {
        stale.push({ dir, why: "內容損毀" });
        continue;
      }
      dead.push({ path: dir, journal, trace, lastSeen });
    }
  }
  return { dead, stale, running, elsewhere };
}

/** The tree a dead batch started from, as setAside takes it. */
export function journalCapture(d: DeadBatch): TreeCapture {
  const files = new Map<string, Buffer | null>();
  const fingerprints = new Map<string, string>();
  let blob: Buffer | undefined;
  try {
    blob = fs.readFileSync(path.join(d.path, "start.bin"));
  } catch {
    /* lost from the journal: a change to any of them can only be reported */
  }
  for (const [rel, at, len] of d.journal.capture.kept) {
    files.set(rel, blob && at + len <= blob.length ? blob.subarray(at, at + len) : null);
  }
  for (const [rel, fp] of Object.entries(d.journal.capture.tooLarge)) {
    files.set(rel, null);
    fingerprints.set(rel, String(fp));
  }
  return { root: d.journal.testTree, files, fingerprints, dirs: new Set(d.journal.capture.dirs) };
}

export function journalOutputs(d: DeadBatch): OutputCapture {
  return { dirs: d.journal.outputs.map((o) => ({ dir: o.dir, files: new Set(o.files) })) };
}

/**
 * Pure: what a killed batch's writer changed — what its journal recorded, and what differs from the
 * tree its open session started with — less what changed after the run was last seen alive (with
 * `slackMs` for the heartbeat's interval): that was someone else, after it died, and stays.
 * A file that is gone has no time to tell by; its directory does. One whose directory changed after
 * the death, or is gone, may have been deleted by anyone — a branch switch, a teammate's rename
 * pulled in — and is not put back: `undecided` lists those. `mtimeOf` gives a file's (or directory's)
 * modification time now; undefined when it is gone.
 */
export function killedWriterChanges(
  d: Pick<DeadBatch, "trace" | "lastSeen">,
  now: TreeSnapshot,
  mtimeOf: (rel: string) => number | undefined,
  slackMs: number,
): { only: Set<string>; undecided: string[] } {
  const only = new Set(d.trace.written);
  if (d.trace.session) for (const rel of diffSnapshots(d.trace.session, now)) only.add(rel);
  const undecided: string[] = [];
  const after = (m: number | undefined) => m !== undefined && m > d.lastSeen + slackMs;
  for (const rel of [...only]) {
    const m = mtimeOf(rel);
    if (m !== undefined) {
      if (after(m)) only.delete(rel);
      continue;
    }
    const parent = path.posix.dirname(rel);
    const dm = mtimeOf(parent === "." ? "" : parent);
    if (dm === undefined || after(dm)) {
      only.delete(rel);
      undecided.push(rel);
    }
  }
  return { only, undecided: undecided.sort() };
}

// ─── Across batches ──────────────────────────────────────────────────────────

/**
 * Pure: what is left of a failed batch's last gate report once what is specific to it is taken out
 * — its classes, where they appear as code, and every number (lines, counts, times) and generated
 * id. Two batches for different classes whose build failed with the same remainder failed on
 * something neither of them wrote: the module, a dependency, the environment. "" when there is no
 * report. A remainder that still says "<target>" names the batch's own classes: its own failure.
 */
export function batchFailureFingerprint(report: string | undefined, targetClasses: string[]): string {
  if (!report) return "";
  const names = targetClasses
    .map((c) => c.replace(/\\/g, "/").split("/").pop()!.replace(SOURCE, ""))
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
    .sort((a, b) => b.length - a.length);
  let s = report;
  // As code only — CalcTest, Calc.java, com.x.Calc$1, Calc.add( — not as a word in the prose of
  // an error message: a class named Help is in every "[Help 1]", one named Could in "Could not".
  for (const n of names) s = s.replace(new RegExp(`(?<![\\w$])${n.replace(/\$/g, "\\$")}(?=[A-Z$.(:\\[])`, "g"), "<target>");
  // Generated ids: UUIDs (whose 4-digit groups the rule after them would miss), object hashes,
  // dump-file stamps — different on every run of the same failure.
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
  s = s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, "<hex>");
  return s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}
