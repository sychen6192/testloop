// Batching support for folder targets: splitting the target classes, and putting a failed
// batch's test tree back the way it was — its build outputs included.
//
// A folder target used to go to one writer session and one reviewer session as a whole. With
// more than a few classes that session outgrew the model's context or the agent timeout, and one
// class that could not be made green ended the run for all of them. loop.ts now runs the
// maker-checker loop per batch; these helpers are the parts of that which are not control flow.
import * as fs from "node:fs";
import * as path from "node:path";
import { BuildTool } from "./types";

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
  /** `existed`: the directory was there when the batch started, so "not in `files`" means the batch's. */
  dirs: Array<{ dir: string; files: Set<string>; existed: boolean }>;
}

/** Which output files exist — a batch's starting point, for its build outputs. */
export function captureOutputs(dirs: string[]): OutputCapture {
  return {
    dirs: dirs.map((dir) => {
      const files = new Set<string>();
      walkFiles(dir, (rel) => files.add(rel));
      return { dir, files, existed: fs.existsSync(dir) };
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
  for (const { dir, files, existed } of capture.dirs) {
    walkFiles(dir, (rel, abs) => {
      // A directory the batch's first build created holds every test's output, not only its own:
      // there only the outputs of what it put back go.
      const batchs = existed ? !files.has(rel) : false;
      if (!batchs && !compiledFrom(rel) && !resources.has(rel)) return;
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

// ─── Across batches ──────────────────────────────────────────────────────────

/**
 * Pure: what is left of a failed batch's last gate report once what is specific to it is taken out
 * — its class names, and every number (lines, counts, times). Two batches for different classes
 * whose build failed with the same remainder failed on something neither of them wrote: the
 * module, a dependency, the environment. "" when there is no report.
 */
export function batchFailureFingerprint(report: string | undefined, targetClasses: string[]): string {
  if (!report) return "";
  const names = targetClasses
    .map((c) => c.replace(/\\/g, "/").split("/").pop()!.replace(SOURCE, ""))
    .sort((a, b) => b.length - a.length);
  let s = report;
  for (const n of names) if (n) s = s.split(n).join("<target>");
  // Object hashes, dump-file stamps, ids: different on every run of the same failure.
  s = s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, "<hex>");
  return s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}
