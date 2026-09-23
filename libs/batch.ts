// Batching support for folder targets: splitting the target classes, and putting a failed
// batch's test tree back the way it was.
//
// A folder target used to go to one writer session and one reviewer session as a whole. With
// more than a few classes that session outgrew the model's context or the agent timeout, and one
// class that could not be made green ended the run for all of them. loop.ts now runs the
// maker-checker loop per batch; these helpers are the parts of that which are not control flow.
import * as fs from "node:fs";
import * as path from "node:path";

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

/** The contents of every regular file under `root` — a batch's starting point. */
export function captureTree(root: string): TreeCapture {
  const files = new Map<string, Buffer | null>();
  const fingerprints = new Map<string, string>();
  const dirs = new Set<string>();
  let total = 0;
  walkFiles(
    root,
    (rel, abs) => {
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        return;
      }
      if (st.size > MAX_FILE_BYTES || total + st.size > MAX_TOTAL_BYTES) {
        files.set(rel, null);
        fingerprints.set(rel, fingerprint(st));
        return;
      }
      try {
        const buf = fs.readFileSync(abs);
        total += buf.length;
        files.set(rel, buf);
      } catch {
        files.set(rel, null);
        fingerprints.set(rel, fingerprint(st));
      }
    },
    (rel) => dirs.add(rel),
  );
  return { root, files, fingerprints, dirs };
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
}

/**
 * Puts the tree under `capture.root` back to the captured state and keeps what the batch wrote:
 * every file it created or changed is copied to `rejectedDir` under `rejectedPrefix/<relative
 * path>` first, so an attempt that did not pass is still there to read, and to copy back by hand.
 * Compared by content, not mtime: a file rewritten with identical bytes was not changed.
 */
export function rollbackTree(capture: TreeCapture, rejectedDir: string, rejectedPrefix = ""): RollbackReport {
  const report: RollbackReport = { created: [], restored: [], undeleted: [], unrestorable: [] };
  const keep = (rel: string, abs: string) => {
    const dest = path.join(rejectedDir, rejectedPrefix, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  };
  const seen = new Set<string>();
  const createdDirs: string[] = [];
  walkFiles(
    capture.root,
    (rel, abs) => {
      seen.add(rel);
      if (!capture.files.has(rel)) {
        keep(rel, abs);
        fs.rmSync(abs, { force: true });
        report.created.push(rel);
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
          keep(rel, abs);
          report.unrestorable.push(rel);
        }
        return;
      }
      let now: Buffer;
      try {
        now = fs.readFileSync(abs);
      } catch {
        return;
      }
      if (!now.equals(original)) {
        keep(rel, abs);
        fs.writeFileSync(abs, original);
        report.restored.push(rel);
      }
    },
    (rel) => {
      if (!capture.dirs.has(rel)) createdDirs.push(rel);
    },
  );
  for (const [rel, original] of capture.files) {
    if (seen.has(rel)) continue;
    const abs = path.join(capture.root, rel);
    if (original === null || original === undefined) {
      report.unrestorable.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, original);
    report.undeleted.push(rel);
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
