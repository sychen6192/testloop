// Batching support for folder targets: splitting the target classes, and putting a failed
// batch's test tree back the way it was — its build outputs included.
//
// A folder target used to go to one writer session and one reviewer session as a whole. With
// more than a few classes that session outgrew the model's context or the agent timeout, and one
// class that could not be made green ended the run for all of them. loop.ts now runs the
// maker-checker loop per batch; these helpers are the parts of that which are not control flow.
import { createHash } from "node:crypto";
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
 * undo, and is listed as foreign instead. `leave`: paths the caller has already accounted for
 * (reported its own way): neither undone nor listed.
 */
export function rollbackTree(
  capture: TreeCapture,
  rejectedDir: string,
  rejectedPrefix = "",
  only?: Set<string>,
  leave?: Set<string>,
): RollbackReport {
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
      if (leave?.has(rel)) return;
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
    if (seen.has(rel) || leave?.has(rel)) continue;
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
// 3: the checkout identified by inode and birth time (no device number).
const JOURNAL_VERSION = 3;
/** Under the batch's artifacts directory. */
export const JOURNAL_DIR = "inflight";

/** Where a process runs: its pid means something only on the same host, since the same boot. */
export interface JournalHost {
  host: string;
  /**
   * Boot time, in minutes since the epoch — an estimate, the clock now less the uptime: a clock
   * stepped by NTP or corrected after a suspend moves it. Compared only where there is no bootId.
   */
  boot: number;
  /** Linux: the boot's own id (/proc/sys/kernel/random/boot_id), which no clock change moves. */
  bootId?: string;
  /**
   * Linux: the pid namespace (/proc/self/ns/pid). Containers on one machine can share its host name
   * and boot (host networking) and still number their processes apart: a pid written in another one
   * names nobody here. Absent where there is none to read.
   */
  pidns?: string;
}

let pidNamespace: string | null | undefined;
let bootId: string | null | undefined;

export function thisHost(): JournalHost {
  if (pidNamespace === undefined) {
    try {
      pidNamespace = process.platform === "linux" ? fs.readlinkSync("/proc/self/ns/pid") : null;
    } catch {
      pidNamespace = null;
    }
  }
  if (bootId === undefined) {
    try {
      bootId = process.platform === "linux" ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null : null;
    } catch {
      bootId = null;
    }
  }
  const here: JournalHost = { host: os.hostname(), boot: Math.round((Date.now() / 1000 - os.uptime()) / 60) };
  if (bootId) here.bootId = bootId;
  if (pidNamespace) here.pidns = pidNamespace;
  return here;
}

/**
 * Pure: whether `there` was recorded since the boot `here` is in — by the boot's id where both have
 * one; else by the estimated boot time, within two minutes.
 */
export function sameBoot(there: { boot?: unknown; bootId?: unknown }, here: JournalHost): boolean {
  if (typeof there.bootId === "string" && there.bootId && here.bootId) return there.bootId === here.bootId;
  return typeof there.boot === "number" && Math.abs(there.boot - here.boot) <= 2;
}

/** Pure: whether a pid recorded `there` still means a process here — the same host, boot and pid namespace. */
export function samePids(there: { host?: unknown; boot?: unknown; bootId?: unknown; pidns?: unknown }, here: JournalHost): boolean {
  return there.host === here.host && sameBoot(there, here) && (there.pidns ?? "") === (here.pidns ?? "");
}

/**
 * Which directory this is, beyond its path: its inode and its birth time ("<ino>@<ns>", the birth
 * time 0 where the file system keeps none). A checkout deleted and cloned again at the same path, a
 * test tree removed and recreated, is another directory — a killed batch's leftovers cannot be in
 * it. Not the device number: many file systems hand one out at mount time (overlayfs, btrfs
 * subvolumes, NFS), so after a reboot — the power cut a journal exists for — the same directory had
 * another. "" when the file system has no inode numbers to tell by.
 */
export function dirIdentity(dir: string): string {
  try {
    const st = fs.statSync(dir, { bigint: true });
    return st.ino ? `${st.ino}@${st.birthtimeNs}` : "";
  } catch {
    return "";
  }
}

/**
 * Pure: whether two dirIdentity values name the same directory — true, false, or undefined when
 * there is no telling (either has no inode number, or is in a form an earlier version wrote). The
 * same inode without a birth time on both sides is taken as the same: a re-created directory can
 * reuse the number, but then everything in it is newer than the killed run anyway.
 */
export function sameDirectory(recorded: string, now: string): boolean | undefined {
  const a = /^(\d+)@(\d+)$/.exec(recorded);
  const b = /^(\d+)@(\d+)$/.exec(now);
  if (!a || !b) return undefined;
  if (a[1] !== b[1]) return false;
  return a[2] === "0" || b[2] === "0" || a[2] === b[2];
}

/** Pure: whether two dirIdentity values prove the same directory — inode and a birth time both match. */
export function provenSameDirectory(recorded: string, now: string): boolean {
  const a = /^(\d+)@(\d+)$/.exec(recorded);
  return !!a && a[2] !== "0" && recorded === now;
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

/** Its data on the disk before anything names it: a power cut is what a journal is for. */
function writeDurable(file: string, data: string | Buffer): void {
  const fd = fs.openSync(file, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// The rename too: until the directory is on disk, the new name may not be. Windows cannot open a
// directory to sync it (NTFS journals the rename itself).
function syncDir(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* a file system that cannot: the data itself is synced */
  }
}

// Written whole or not at all, and on the disk: after a power cut ext4 and XFS can leave a file that
// was renamed into place empty when its data was never synced — a journal read as damaged, and
// thrown away without its rollback.
function writeAtomic(file: string, text: string): void {
  writeDurable(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  syncDir(path.dirname(file));
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
      ...(j.bootId ? { bootId: j.bootId } : {}),
      ...(j.pidns ? { pidns: j.pidns } : {}),
    };
    writeAtomic(path.join(dir, "owner.json"), JSON.stringify(owner));
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
      // On the disk before journal.json says where in it each file is.
      fs.fsyncSync(fd);
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
  /**
   * Its trace could not be read (damaged — by hand, or a disk that lost it): what the writer changed
   * is not known, and everything that changed since the batch started, before the run died, is taken
   * as the batch's.
   */
  traceLost?: boolean;
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

/** How long a journal's heartbeat may be silent before its run is taken for dead. */
export const JOURNAL_STALE_MS = 5 * 60_000;

/**
 * Waits while `busy()` names journals of this checkout whose run may still be going — until none
 * does, or `maxMs` has passed — and returns what is still busy then. `sleep` and `clock`: for the
 * selftest.
 */
export async function waitWhileBusy(
  busy: () => string[],
  maxMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  clock: () => number = Date.now,
): Promise<string[]> {
  const until = clock() + maxMs;
  let left = busy();
  while (left.length && clock() < until) {
    await sleep(pollMs);
    left = busy();
  }
  return left;
}

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
 * its start time says so, where the OS reports one — a start time recorded but not readable now is
 * a process that has ended (a zombie still answers a signal). Without one recorded (Windows), a live
 * pid that is still beating counts as the run. Written in another pid namespace (a container sharing
 * this machine's name), its pid names nobody here: only its heartbeat can tell.
 */
export function mayBeRunning(
  owner: { pid?: number; start?: string; boot?: number; bootId?: string; pidns?: string },
  lastSeen: number,
  here: JournalHost,
  probe: ProcessProbe,
  now: number,
  staleAfterMs: number,
): boolean {
  if (!sameBoot(owner, here)) return false;
  if ((owner.pidns ?? "") !== (here.pidns ?? "")) return now - lastSeen < staleAfterMs;
  const pid = owner.pid ?? -1;
  if (pid === process.pid) return false;
  if (owner.start) return probe.start(pid) === owner.start;
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

/** Pure: a relative path that stays inside the directory it is relative to. */
export const safeRel = (rel: string): boolean =>
  rel !== "" && !path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel) && !rel.split(/[\\/]/).includes("..");

const realOr = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/** Whether `p` is `parent` or under it, both taken as they are on disk (symlinks resolved). */
export function isInside(parent: string, p: string): boolean {
  const r = path.relative(realOr(parent), realOr(p));
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

/**
 * Whether what a journal of this checkout points at is where one can point: its test tree a module's
 * src/test inside the checkout, and every file it names inside the tree. A runs directory can be
 * shared; what someone else wrote there must not make a rollback write outside src/test. (Its
 * artifacts are taken from where it was found, and its build outputs are kept only where that
 * module's builds put tests — journalOutputDirs.)
 */
export function journalContained(j: BatchJournal, repoRoot: string): boolean {
  return (
    isInside(repoRoot, j.testTree) &&
    realOr(j.testTree) !== realOr(repoRoot) &&
    path.basename(j.testTree) === "test" &&
    path.basename(path.dirname(j.testTree)) === "src" &&
    j.outputs.every((o) => o.files.every(safeRel)) &&
    j.capture.kept.every((k) => safeRel(k[0])) &&
    Object.keys(j.capture.tooLarge).every(safeRel) &&
    j.capture.dirs.every(safeRel)
  );
}

/**
 * The build outputs a journal may name: where the module of its test tree compiles and copies tests
 * (Maven's or Gradle's). A set-aside empties an output directory the batch started without — any
 * other directory named there, src/main included, would be emptied with it.
 */
export function journalOutputDirs(testTree: string): Set<string> {
  const moduleRoot = path.dirname(path.dirname(testTree));
  return new Set([...testOutputDirs(moduleRoot, "maven"), ...testOutputDirs(moduleRoot, "gradle")].map(realOr));
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
    t.written.every(safeRel) &&
    (t.session === undefined ||
      (!!t.session &&
        typeof t.session === "object" &&
        Object.entries(t.session).every(([rel, v]) => safeRel(rel) && typeof v === "string")));
  return ok ? t : undefined;
}

/**
 * The journals this repo's earlier runs left under `runsDir`, sorted by what this run may do with
 * each. Only a journal of this checkout is ever acted on — the same directories (dirIdentity), not
 * just the same path: another machine sharing the runs directory has its own checkout at that path,
 * and applying its journal here would swap this checkout's files for that one's. Another machine's
 * is taken as this one's only when the directories are proven the same (inode and birth time: a
 * volume shared into containers that each get a new host name); with no pid of it meaning anything
 * here, only its heartbeat tells whether it is alive.
 *
 * - `dead`: a batch whose run died without setting it aside — the caller finishes it.
 * - `busy`: a batch of this checkout whose run may still be going (a container restarted within the
 *   heartbeat's window, a run that bypassed the repo lock): nothing on this checkout may start.
 * - `stale`: ours to throw away — its run ended (it has a summary.json), it was cut short while
 *   being written, it will not parse or points outside the checkout, or its checkout or test tree
 *   is not there any more (the same path now holds another).
 * - `elsewhere`: another checkout's, left alone.
 */
export function findJournals(
  runsDir: string,
  checkout: { repoRoot: string; rootId: string },
  probe: ProcessProbe,
  here: JournalHost = thisHost(),
  now = Date.now(),
  staleAfterMs = JOURNAL_STALE_MS,
): { dead: DeadBatch[]; stale: Array<{ dir: string; why: string }>; busy: string[]; elsewhere: number } {
  const dead: DeadBatch[] = [];
  const stale: Array<{ dir: string; why: string }> = [];
  const busy: string[] = [];
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
      const sameHost = owner.host === here.host;
      // Nothing of another machine's is ours to throw away: at most it is proven to be this checkout.
      const dropOrLeave = (why: string) => (sameHost ? stale.push({ dir, why }) : elsewhere++);
      const alive = (o: Partial<JournalOwner>, lastSeen: number) =>
        sameHost ? mayBeRunning(o, lastSeen, here, probe, now, staleAfterMs) : now - lastSeen < staleAfterMs;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(dir, "journal.json"), "utf8"));
      } catch (e) {
        // Cut short while being written — or still being written, by a run that is alive.
        const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
        const itsCheckout = sameDirectory(typeof owner.rootId === "string" ? owner.rootId : "", checkout.rootId) !== false;
        if (!sameHost) elsewhere++;
        else if (missing && alive(owner, mtimeOrZero(path.join(dir, "owner.json")))) itsCheckout ? busy.push(dir) : elsewhere++;
        else stale.push({ dir, why: missing ? "寫到一半就被終止" : "內容損毀" });
        continue;
      }
      if (!isJournal(raw)) {
        const v = (raw as { version?: unknown })?.version;
        if (typeof v === "number" && v !== JOURNAL_VERSION) continue; // another version's: not ours to read
        dropOrLeave("內容損毀");
        continue;
      }
      // Its artifacts are where it was found, whatever it says; its build outputs only where its
      // module's builds put tests.
      const outputDirs = journalOutputDirs(raw.testTree);
      const journal: BatchJournal = {
        ...raw,
        runDir: path.join(runsDir, run),
        dir: path.join(runsDir, run, batch),
        outputs: raw.outputs.filter((o) => isInside(checkout.repoRoot, o.dir) && outputDirs.has(realOr(o.dir))),
      };
      if (!journalContained(journal, checkout.repoRoot)) {
        dropOrLeave("內容不合法（指向這個 checkout 的測試目錄之外）");
        continue;
      }
      // Whether it describes this checkout: the directories it was written for, and the ones here now.
      const treeNow = fs.existsSync(journal.testTree) ? dirIdentity(journal.testTree) : undefined;
      const root = sameDirectory(journal.rootId, checkout.rootId);
      const tree = treeNow === undefined ? false : sameDirectory(journal.treeId, treeNow);
      const ours = root !== false && tree !== false;
      const proven = provenSameDirectory(journal.rootId, checkout.rootId) && !!treeNow && provenSameDirectory(journal.treeId, treeNow);
      if (!sameHost && !proven) {
        elsewhere++; // another machine's own checkout at the same path
        continue;
      }
      const lastSeen = Math.max(mtimeOrZero(path.join(dir, "journal.json")), mtimeOrZero(path.join(dir, "trace.json")));
      if (alive(journal, lastSeen)) {
        if (ours) busy.push(dir);
        else elsewhere++;
        continue;
      }
      if (fs.existsSync(path.join(journal.runDir, "summary.json"))) {
        stale.push({ dir, why: "那次執行有收尾" });
        continue;
      }
      if (!ours) {
        // Written in another pid namespace — a container sharing this machine's name — a different
        // checkout is that container's own at the same path, not this one cloned again: left for it.
        if (!samePids(journal, here)) elsewhere++;
        else if (root === false) stale.push({ dir, why: "這個路徑現在是另一個 checkout（重新 clone 過）" });
        else stale.push({ dir, why: `它的測試目錄 ${journal.treeRel} 已經不是那時的那一個（被刪除或重建過）` });
        continue;
      }
      const trace = readTrace(dir);
      dead.push({ path: dir, journal, trace: trace ?? { written: [] }, ...(trace ? {} : { traceLost: true }), lastSeen });
    }
  }
  return { dead, stale, busy, elsewhere };
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
 * pulled in — and is not put back: `undecided` lists those. A file gone that the batch did not start
 * with (`startedWith`) has nothing to put back and is dropped. `mtimeOf` gives a file's (or
 * directory's) modification time now; undefined when it is gone.
 */
export function killedWriterChanges(
  d: Pick<DeadBatch, "trace" | "lastSeen">,
  now: TreeSnapshot,
  mtimeOf: (rel: string) => number | undefined,
  slackMs: number,
  startedWith: (rel: string) => boolean,
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
    if (!startedWith(rel)) {
      only.delete(rel);
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

/**
 * Pure: files moved after the run died — `mv`, `git mv`, an IDE's move: a file the writer did not
 * start with, holding byte for byte the content of one the batch started with that is gone now, and
 * gone undecided (its directory changed after the death). A move keeps the file's time, so the new
 * one looks as old as the writer's own files; rolling it back and not putting the old one back
 * would leave neither in the tree. Neither is the batch's: both are left as they are. `read` gives
 * a file's content now; undefined when it cannot be read.
 */
export function movesAfterDeath(
  only: Set<string>,
  undecided: string[],
  start: TreeCapture,
  read: (rel: string) => Buffer | undefined,
): Array<{ from: string; to: string }> {
  const gone = new Map<string, string[]>();
  const digest = (b: Buffer) => createHash("sha1").update(b).digest("hex");
  for (const rel of undecided) {
    const original = start.files.get(rel);
    // An empty file says nothing about where it went: any empty file the writer made would match.
    if (!original?.length) continue;
    const k = digest(original);
    gone.set(k, [...(gone.get(k) ?? []), rel]);
  }
  const moves: Array<{ from: string; to: string }> = [];
  if (!gone.size) return moves;
  for (const rel of [...only].sort()) {
    if (start.files.has(rel)) continue;
    const content = read(rel);
    if (!content) continue;
    const from = gone.get(digest(content))?.find((g) => start.files.get(g)!.equals(content));
    if (!from) continue;
    gone.set(digest(content), gone.get(digest(content))!.filter((g) => g !== from));
    moves.push({ from, to: rel });
  }
  return moves;
}

/**
 * What a recovery decided, kept in the journal before it acts: a retry after it stopped halfway (a
 * file locked, the recovering run itself killed) decides the same — its own first attempt changed the
 * tree's times, and would read as changes made after the death.
 */
export interface RecoveryDecision {
  /** When it was decided: a file changed after it, and not put back by it, was changed by someone since. */
  at: number;
  only: string[];
  undecided: string[];
  moves: Array<{ from: string; to: string }>;
}

export function readDecision(journalDir: string): RecoveryDecision | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(journalDir, "decision.json"), "utf8")) as RecoveryDecision;
    const ok =
      !!d &&
      Number.isFinite(d.at) &&
      isStrings(d.only) &&
      d.only.every(safeRel) &&
      isStrings(d.undecided) &&
      d.undecided.every(safeRel) &&
      Array.isArray(d.moves) &&
      d.moves.every((m) => !!m && typeof m.from === "string" && typeof m.to === "string" && safeRel(m.from) && safeRel(m.to));
    return ok ? d : undefined;
  } catch {
    return undefined;
  }
}

export function writeDecision(journalDir: string, d: RecoveryDecision): void {
  writeAtomic(path.join(journalDir, "decision.json"), JSON.stringify(d));
}

/**
 * What of a killed batch is its writer's to undo (killedWriterChanges, movesAfterDeath), decided once
 * and kept in its journal before anything is changed: a retry after the recovery stopped halfway — a
 * file locked, the recovering run itself killed — decides the same (`reused`). Its own first attempt
 * moved files out and put others back, after the death, and would read as someone else's changes:
 * a file it could not put back would sit in a directory "changed after the death", and not be put
 * back at all. What someone changed after that first decision stays theirs. With its trace lost,
 * what the writer changed is unknown: everything that changed since the batch started, before the
 * run died, is the batch's (kept in rejected/ like the rest). `view` reads the test tree now.
 */
export function decideRecovery(
  d: DeadBatch,
  capture: TreeCapture,
  lastSeen: number,
  slackMs: number,
  view: { snapshot: () => TreeSnapshot; mtimeOf: (rel: string) => number | undefined; read: (rel: string) => Buffer | undefined },
  now = Date.now(),
): { decision: RecoveryDecision; reused: boolean } {
  const earlier = readDecision(d.path);
  if (earlier) {
    const only = earlier.only.filter((rel) => {
      const m = view.mtimeOf(rel);
      return m === undefined || m <= earlier.at + slackMs;
    });
    return { decision: { ...earlier, only }, reused: true };
  }
  const tree = view.snapshot();
  const trace = d.traceLost ? { written: [...new Set([...capture.files.keys(), ...Object.keys(tree)])] } : d.trace;
  const changes = killedWriterChanges({ trace, lastSeen }, tree, view.mtimeOf, slackMs, (rel) => capture.files.has(rel));
  const moves = movesAfterDeath(changes.only, changes.undecided, capture, view.read);
  for (const m of moves) changes.only.delete(m.to);
  const moved = new Set(moves.map((m) => m.from));
  const decision: RecoveryDecision = {
    at: now,
    only: [...changes.only].sort(),
    undecided: changes.undecided.filter((u) => !moved.has(u)),
    moves,
  };
  try {
    writeDecision(d.path, decision);
  } catch {
    /* read-only artifacts: a retry decides again */
  }
  return { decision, reused: false };
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
