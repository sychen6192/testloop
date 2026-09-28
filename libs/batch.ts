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

const JOURNAL_VERSION = 1;
/** Under the batch's artifacts directory. */
export const JOURNAL_DIR = "inflight";

/** Where a process runs: its pid means something only on the same host, since the same boot. */
export interface JournalHost {
  host: string;
  /** Boot time, in minutes since the epoch. */
  boot: number;
}

export function thisHost(): JournalHost {
  return { host: os.hostname(), boot: Math.round((Date.now() / 1000 - os.uptime()) / 60) };
}

export interface BatchJournal extends JournalHost {
  version: number;
  /** Canonical (libs/lock.ts canonicalRoot): another checkout sharing the runs directory is not ours to undo. */
  repoRoot: string;
  pid: number;
  runDir: string;
  batch: number;
  /** The batch's artifacts. */
  dir: string;
  targetClasses: string[];
  /** The test tree, absolute, and as the run shows it (repo-relative). */
  testTree: string;
  treeRel: string;
  capture: { kept: string[]; tooLarge: Record<string, string>; dirs: string[] };
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
 * owner file says whether it is this repo's to throw away. `beatMs`: for the selftest.
 */
export function openJournal(
  j: Omit<BatchJournal, "version" | "capture" | "outputs">,
  capture: TreeCapture,
  outputs: OutputCapture,
  beatMs: number,
): JournalHandle {
  const dir = path.join(j.dir, JOURNAL_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ repoRoot: j.repoRoot, pid: j.pid, host: j.host, boot: j.boot }));
  const kept: string[] = [];
  const tooLarge: Record<string, string> = {};
  for (const [rel, buf] of capture.files) {
    if (!buf) {
      tooLarge[rel] = capture.fingerprints.get(rel) ?? "";
      continue;
    }
    const dest = path.join(dir, "start", rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    kept.push(rel);
  }
  const journal: BatchJournal = {
    version: JOURNAL_VERSION,
    ...j,
    capture: { kept, tooLarge, dirs: [...capture.dirs] },
    outputs: outputs.dirs.map((d) => ({ dir: d.dir, files: [...d.files] })),
  };
  writeAtomic(path.join(dir, "journal.json"), JSON.stringify(journal));
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

/**
 * Pure: whether the run that wrote a journal may still be running. The caller holds the repo lock,
 * so a run of this repo on this machine cannot be — but a pid is only worth asking about on the host
 * and since the boot it was written on (a machine that rebooted has no run from before), and a run on
 * another host sharing the runs directory (a volume mounted into two containers) is dead only once it
 * has stopped beating. `alive(pid)`: whether a process with that pid exists here.
 */
export function mayBeRunning(
  owner: Partial<JournalHost> & { pid?: number },
  lastSeen: number,
  here: JournalHost,
  alive: (pid: number) => boolean,
  now: number,
  staleAfterMs: number,
): boolean {
  const fresh = now - lastSeen < staleAfterMs;
  if (owner.host !== here.host) return fresh;
  if (owner.boot === undefined || Math.abs(owner.boot - here.boot) > 2) return false;
  return owner.pid !== process.pid && alive(owner.pid ?? -1) && fresh;
}

/**
 * The journals this repo's earlier runs left under `runsDir`: batches whose run ended without
 * setting them aside (see mayBeRunning). Journals whose run did end (it has a summary.json) and
 * journals cut short are this repo's to throw away: `stale` lists them. Another checkout's journals
 * are left alone, and so are those of a run that may still be going: `running` counts them.
 */
export function findJournals(
  runsDir: string,
  repoRoot: string,
  alive: (pid: number) => boolean,
  here: JournalHost = thisHost(),
  now = Date.now(),
  staleAfterMs = 5 * 60_000,
): { dead: DeadBatch[]; stale: string[]; running: number } {
  const dead: DeadBatch[] = [];
  const stale: string[] = [];
  let running = 0;
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
      let owner: Partial<JournalHost> & { repoRoot?: string; pid?: number };
      try {
        owner = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
      } catch {
        continue; // none, or not this tool's: not ours to judge
      }
      if (owner.repoRoot !== repoRoot) continue;
      let journal: BatchJournal;
      try {
        journal = JSON.parse(fs.readFileSync(path.join(dir, "journal.json"), "utf8"));
      } catch {
        // Cut short while being written — or still being written, by a run that is alive.
        if (mayBeRunning(owner, mtimeOrZero(path.join(dir, "owner.json")), here, alive, now, staleAfterMs)) running++;
        else stale.push(dir);
        continue;
      }
      if (journal.version !== JOURNAL_VERSION) continue;
      const lastSeen = Math.max(mtimeOrZero(path.join(dir, "journal.json")), mtimeOrZero(path.join(dir, "trace.json")));
      if (mayBeRunning(journal, lastSeen, here, alive, now, staleAfterMs)) {
        running++;
        continue;
      }
      if (fs.existsSync(path.join(journal.runDir, "summary.json"))) {
        stale.push(dir);
        continue;
      }
      let trace: JournalTrace = { written: [] };
      try {
        trace = JSON.parse(fs.readFileSync(path.join(dir, "trace.json"), "utf8"));
      } catch {
        /* no writer session had ended or begun */
      }
      dead.push({ path: dir, journal, trace, lastSeen });
    }
  }
  return { dead, stale, running };
}

/** The tree a dead batch started from, as setAside takes it. */
export function journalCapture(d: DeadBatch): TreeCapture {
  const files = new Map<string, Buffer | null>();
  const fingerprints = new Map<string, string>();
  for (const rel of d.journal.capture.kept) {
    try {
      files.set(rel, fs.readFileSync(path.join(d.path, "start", rel)));
    } catch {
      files.set(rel, null); // lost from the journal: a change to it can only be reported
    }
  }
  for (const [rel, fp] of Object.entries(d.journal.capture.tooLarge)) {
    files.set(rel, null);
    fingerprints.set(rel, fp);
  }
  return { root: d.journal.testTree, files, fingerprints, dirs: new Set(d.journal.capture.dirs) };
}

export function journalOutputs(d: DeadBatch): OutputCapture {
  return { dirs: d.journal.outputs.map((o) => ({ dir: o.dir, files: new Set(o.files) })) };
}

/**
 * Pure: what a killed batch's writer changed — what its journal recorded, and what differs from
 * the tree its open session started with — less what changed after the run was last seen alive
 * (with `slackMs` for the heartbeat's interval): that was someone else, after it died, and stays.
 * `mtimeOf` gives a file's modification time now; undefined when it is gone.
 */
export function killedWriterChanges(
  d: Pick<DeadBatch, "trace" | "lastSeen">,
  now: TreeSnapshot,
  mtimeOf: (rel: string) => number | undefined,
  slackMs: number,
): Set<string> {
  const changed = new Set(d.trace.written);
  if (d.trace.session) for (const rel of diffSnapshots(d.trace.session, now)) changed.add(rel);
  for (const rel of [...changed]) {
    const m = mtimeOf(rel);
    if (m !== undefined && m > d.lastSeen + slackMs) changed.delete(rel);
  }
  return changed;
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
