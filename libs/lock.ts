// The per-repo run lock. Kept out of loop.ts so it can be raced in the selftest: loop.ts runs
// main() on import.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface RepoLockBusy {
  /** The live holder; absent when the lock could not be settled in time (see LOCK_WAIT_MS). */
  pid?: number;
  runDir?: string;
  lock: string;
}

// How long to try to settle the lock — past the 2s an empty lock takes to count as a crash's and
// the 10s a takeover lock does — before calling the repo busy. Giving up used to mean running
// unlocked: a count of attempts ran out while another run was still between create and write, and
// both ran.
export const LOCK_WAIT_MS = 15_000;
// The holder touches its lock this often, so that a pid that cannot be signalled (EPERM) can still
// be told apart: a live run's lock is fresh, a dead one's pid reused by another process is not.
export const LOCK_HEARTBEAT_MS = 30_000;
// Missed heartbeats before a lock counts as not fresh: a run blocked in synchronous work (a
// transcoder call, a large tree walk) skips a few.
const LOCK_FRESH_MS = 5 * LOCK_HEARTBEAT_MS;

/**
 * Pure: whether a lock's holder is a live run, from what signalling its pid said. EPERM: the pid
 * belongs to another user. That is a live run when the lock is another user's too — someone else's
 * run on the same repo path in a shared /tmp — or when it is this user's and still heartbeating:
 * on Windows a run started elevated cannot be signalled from one that is not. A lock of this user's
 * that has stopped beating was left by a run whose pid has been reused (Windows reuses them quickly,
 * often for services); treating it as alive blocked every later run until the lock was deleted.
 */
export function holderAlive(signal: string, lockIsThisUsers: boolean, sinceBeatMs: number): boolean {
  if (signal === "ok") return true;
  if (signal !== "EPERM") return false; // ESRCH: gone
  return !lockIsThisUsers || sinceBeatMs < LOCK_FRESH_MS;
}

/** The lock file for a repo, from its canonical path. */
export function repoLockFile(canonicalRoot: string): string {
  const key = createHash("sha1").update(canonicalRoot).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `testgen-${key}.lock`);
}

/**
 * One run per repo at a time. Two runs on different modules of one repo each saw the other's
 * writer output appear outside their own scope and both aborted with scope-violation, telling
 * the operator to revert the other run's work; two `-am` builds also share upstream target/.
 * The lock is keyed by REPO_ROOT and kept outside the repo, so it never shows up in a scope
 * snapshot. A lock whose pid is gone is stale and is taken over. Returns the live holder when
 * another run has the repo, undefined once this run holds the lock (or cannot lock at all:
 * an unwritable temp dir does not block the run).
 */
export function acquireRepoLock(
  repoRoot: string,
  runDir: string,
  // For the selftest, which cannot wait a quarter of a minute or half a minute to see either happen.
  timing: { waitMs: number; heartbeatMs: number } = { waitMs: LOCK_WAIT_MS, heartbeatMs: LOCK_HEARTBEAT_MS },
): RepoLockBusy | undefined {
  // Canonical path: the same repo reached through a symlink, or as a Windows 8.3 short name,
  // must map to the same lock.
  let canonical = path.resolve(repoRoot);
  try {
    canonical = fs.realpathSync.native(repoRoot);
  } catch {
    /* keep the resolved path */
  }
  const lock = repoLockFile(canonical);
  const ours = () => {
    try {
      return JSON.parse(fs.readFileSync(lock, "utf8")).pid === process.pid;
    } catch {
      return false;
    }
  };
  for (const deadline = Date.now() + timing.waitMs; Date.now() < deadline; ) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runDir }), { flag: "wx" });
      const beat = setInterval(() => {
        try {
          if (ours()) fs.utimesSync(lock, new Date(), new Date());
        } catch {
          /* best effort: a missed beat only matters after several */
        }
      }, timing.heartbeatMs);
      beat.unref();
      process.on("exit", () => {
        clearInterval(beat);
        try {
          if (ours()) fs.unlinkSync(lock);
        } catch {
          /* already gone */
        }
      });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return; // cannot lock: do not block the run
      let seen: string;
      try {
        seen = fs.readFileSync(lock, "utf8");
      } catch (err) {
        // Gone since the create failed: its holder let go, or a takeover removed it. Create again —
        // read as an empty lock, it was "stale", and the takeover below removed the lock another
        // run had written in the meantime: two runs held the repo.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        return; // unreadable: cannot tell whose it is; do not block the run
      }
      // Empty: another run between its create and its write, which takes microseconds. Only one
      // that stays empty is a crash's leftover.
      if (seen === "" && !emptyAndOld(lock)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      let holder: { pid?: number; runDir?: string } = {};
      try {
        holder = JSON.parse(seen);
      } catch {
        /* not a lock this tool wrote whole: stale */
      }
      let alive = false;
      if (holder.pid && holder.pid !== process.pid) {
        let signal = "ok";
        try {
          process.kill(holder.pid, 0);
        } catch (err) {
          signal = (err as NodeJS.ErrnoException).code ?? "error";
        }
        let sinceBeat = Infinity;
        try {
          sinceBeat = Date.now() - fs.statSync(lock).mtimeMs;
        } catch {
          /* gone: not fresh */
        }
        alive = holderAlive(signal, writtenByThisUser(lock), sinceBeat);
      }
      // A run that wrote its summary is over, whatever now holds its pid: killed before its exit
      // handler ran, with the pid since given to an unrelated process.
      if (alive && holder.runDir && fs.existsSync(path.join(holder.runDir, "summary.json"))) alive = false;
      if (alive) return { pid: holder.pid, runDir: holder.runDir, lock };
      // Stale. Two runs that both saw it stale must not both take it over: the second would
      // delete the lock the first had just written, and both would run. The takeover happens
      // under a second, exclusively created lock, and removes the lock only if it is still the
      // stale one this run read; the next attempt's exclusive create decides who holds it.
      const takeover = `${lock}.takeover`;
      try {
        fs.writeFileSync(takeover, String(process.pid), { flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") return;
        // Another run is taking over right now — that takes microseconds — or died doing it.
        try {
          if (Date.now() - fs.statSync(takeover).mtimeMs > 10_000) fs.rmSync(takeover, { force: true });
        } catch {
          /* gone already */
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      try {
        let now: string | undefined;
        try {
          now = fs.readFileSync(lock, "utf8");
        } catch {
          now = undefined; // removed meanwhile: nothing to take over
        }
        // Still the lock this run judged stale: a stale lock is only ever removed under the
        // takeover, so one with the same content is the same lock. Except an empty one — another
        // run's lock is empty for a moment after its create — so that one must still be old.
        if (now === seen && (seen !== "" || emptyAndOld(lock))) fs.rmSync(lock, { force: true });
      } catch {
        return; // cannot take over a lock we may not remove; run unlocked rather than crash
      } finally {
        try {
          fs.rmSync(takeover, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }
  // Could not settle it in time: another run is mid-create or mid-takeover, again and again. Busy,
  // with no holder to name.
  return { lock };
}

// A lock stays empty only between another run's create and its write; seconds of it is a crash.
const EMPTY_LOCK_STALE_MS = 2000;

function emptyAndOld(lock: string): boolean {
  try {
    const st = fs.statSync(lock);
    return st.size === 0 && Date.now() - st.mtimeMs > EMPTY_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// %TEMP% is per user on Windows, so a lock found there is always this user's.
function writtenByThisUser(lock: string): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  try {
    return fs.statSync(lock).uid === process.getuid();
  } catch {
    return true;
  }
}
