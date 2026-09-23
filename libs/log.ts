// Logging: every line carries [mm:ss] elapsed time so you can tell it's still alive.
import { QUIET } from "../config";

const START_TS = Date.now();

// A console that went away must not take the run with it. When the reader of a `| tee` pipe
// exits, or the terminal hangs up, Node reports EPIPE / EIO as an 'error' event on
// process.stdout — with no listener that is an uncaught exception, and it fires at the *next*
// log line, possibly minutes later, with stderr usually gone to the same dead place. The run's
// real record is runs/<ts>/; losing the console is survivable, losing the run is not.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

export function elapsed(): string {
  const s = Math.floor((Date.now() - START_TS) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function log(msg: string) {
  console.log(`[${elapsed()}] ${msg}`);
}

export function logVerbose(msg: string) {
  if (!QUIET) console.log(`[${elapsed()}] ${msg}`);
}

export function banner(title: string) {
  console.log(`\n[${elapsed()}] ========== ${title} ==========`);
}

export function die(msg: string): never {
  console.error(`[${elapsed()}] FATAL: ${msg}`);
  process.exit(1);
}

export function tail(s: string, n = 6000): string {
  return s.length > n ? `…(截斷)\n${s.slice(-n)}` : s;
}

// Heartbeat every 15s during long ops so it doesn't look hung.
export function startHeartbeat(label: string): () => void {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    console.log(`[${elapsed()}] ${label} 仍在進行中（已等待 ${ticks * 15} 秒）`);
  }, 15_000);
  return () => clearInterval(timer);
}
