// Run a child process; stream stdout/stderr line-by-line (prefixed), return the full output.
// Also owns Windows process spawning (planSpawn / explainSpawnError) for callers that spawn
// without `shell: true` — the opencode runner and doctor.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isatty } from "node:tty";
import { log, logVerbose } from "./log";
import { stripAnsi } from "./utils";
import { MAX_BUILD_OUTPUT_CHARS } from "../config";

// Build output grows with the module and with whatever its tests print, not with anything the
// gates need. Kept whole, one chatty test — a @SpringBootTest module logging at DEBUG, or a
// writer-generated test that prints in a loop — pushed the capture past V8's ~512M-character
// string limit, and `buf += chunk` threw inside the stream handler: RangeError, uncaught, the
// whole tool gone mid-build with no summary. So the capture is bounded: the tail (maven's
// Results block and BUILD FAILURE are at the end) plus every line the parsers read wherever it
// appeared — [ERROR] lines with javac's continuation lines, "Tests run:", gradle's
// "X.java:12: error:". What falls out of the window is announced, never silently missing.
const MAX_LINE_CHARS = 8192;
// After the build process exits, how long its stdout/stderr may stay open before we stop
// waiting. 'close' waits for every holder of the inherited pipes, and a process the build left
// behind (a daemon started with setsid, a test that inheritIO()s a server) holds them for as
// long as it lives: the build was over, the gate waited forever, and the build timeout could
// not end it because the process holding the pipe is not in the build's process group.
const SH_EXIT_DRAIN_MS = 3_000;
const MAX_KEPT_CHARS = 8 * 1024 * 1024;
const KEY_LINE = /^\[ERROR\]|Tests run: \d|\.java:\d+:\s*error:/;

/** Pure: the text shLive hands back once `dropped` leading characters fell out of the window. */
export function assembleCapture(tail: string, dropped: number, lostKeyLines: string[], max: number): string {
  if (dropped <= 0) return tail;
  return (
    `…（輸出共 ${dropped + tail.length} 字元，超過上限 ${max}；前段 ${dropped} 字元已丟棄，` +
    `其中的錯誤行與測試統計行保留如下）\n${lostKeyLines.join("\n")}\n…（以下為輸出尾端）\n${tail}`
  );
}

export function shLive(
  cmd: string,
  args: string[],
  linePrefix: string,
  cwd: string,
  timeoutMs = 0,
  maxChars = MAX_BUILD_OUTPUT_CHARS,
): Promise<{ code: number; out: string; timedOut?: boolean; signal?: NodeJS.Signals }> {
  return new Promise((resolve) => {
    logVerbose(`> 執行：${cmd} ${args.join(" ")}（cwd=${cwd}）`);
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
      detached: DETACH_CHILDREN,
    });
    trackForShutdown(child);

    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          log(`${linePrefix} [WARN] 逾時 ${timeoutMs}ms，終止程序樹`);
          killTree(child, "SIGKILL");
        }, timeoutMs)
      : undefined;

    // parts/size: the capture window. seen: every character ever received, which is what a key
    // line's position is measured in, so it can be told apart from what the tail still holds.
    let parts: string[] = [];
    let size = 0;
    let seen = 0;
    let dropped = 0;
    const keyLines: Array<{ at: number; line: string }> = [];
    let keptChars = 0;
    let warned = false;
    const trim = () => {
      const all = parts.join("");
      const cut = all.length - maxChars;
      dropped += cut;
      parts = [all.slice(cut)];
      size = maxChars;
      if (!warned) {
        warned = true;
        log(`${linePrefix} [WARN] 建置輸出超過 ${maxChars} 字元，只保留尾端與錯誤行（多半是測試大量輸出 log）`);
      }
    };
    const pipe = (stream: NodeJS.ReadableStream) => {
      let pending = "";
      let inError = false;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        // Nothing in here may throw: an exception in a stream handler is uncaught and ends the
        // process — which is exactly how the unbounded version took the whole run down.
        try {
          const at = seen;
          seen += chunk.length;
          parts.push(chunk);
          size += chunk.length;
          if (size > 2 * maxChars) trim(); // amortized: one join per maxChars of output
          // Only the new chunk is searched for a newline. Re-splitting the accumulated partial
          // line on every chunk was quadratic: 80MB printed without newlines took 87s of CPU,
          // blocking the event loop (and, through back-pressure, maven) the whole time.
          const nl = chunk.lastIndexOf("\n");
          if (nl < 0) {
            if (pending.length < MAX_LINE_CHARS) pending += chunk.slice(0, MAX_LINE_CHARS - pending.length);
            return;
          }
          const lines = (pending + chunk.slice(0, nl)).split("\n");
          pending = chunk.slice(nl + 1, nl + 1 + MAX_LINE_CHARS);
          for (const raw of lines) {
            const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
            const plain = stripAnsi(line);
            const isError = /^\[ERROR\]/.test(plain);
            const continuation = inError && /^\s+\S/.test(plain) && !/^\s*\[\w+\]/.test(plain);
            inError = isError || continuation;
            if ((isError || continuation || KEY_LINE.test(plain)) && keptChars < MAX_KEPT_CHARS) {
              keyLines.push({ at, line: plain });
              keptChars += plain.length;
            }
            if (line.trim()) logVerbose(`${linePrefix} ${line}`);
          }
        } catch (e) {
          logVerbose(`${linePrefix} [WARN] 讀取輸出時發生錯誤，略過這段：${e instanceof Error ? e.message : String(e)}`);
        }
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    const collect = (): string => {
      try {
        return collectOrThrow();
      } catch (e) {
        return `（建置輸出無法組回：${e instanceof Error ? e.message : String(e)}）`;
      }
    };
    const collectOrThrow = (): string => {
      let tail = parts.join("");
      if (tail.length > maxChars) {
        dropped += tail.length - maxChars;
        tail = tail.slice(-maxChars);
      }
      return assembleCapture(
        tail,
        dropped,
        keyLines.filter((k) => k.at < dropped).map((k) => k.line),
        maxChars,
      );
    };
    let done = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    // A signal is reported as such: a build killed by the OOM killer is not an exit-1 build,
    // and read as one it was classified as a red baseline nobody could locate.
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve({ code: code ?? 1, out: collect(), timedOut, ...(signal && !timedOut ? { signal } : {}) });
    };
    child.on("exit", (code, signal) => {
      drainTimer = setTimeout(() => {
        logVerbose(`${linePrefix} 程序已結束但輸出管線仍被其他程序占用，不再等待`);
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, SH_EXIT_DRAIN_MS);
    });
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      logVerbose(`指令啟動失敗：${err.message}`);
      resolve({ code: 1, out: String(err) });
    });
  });
}

// ─── Windows process spawning ────────────────────────────────────────────────
//
// shLive above passes `shell: true` on Windows only, which lets the shell resolve wrapper
// scripts like mvnw.cmd there. Callers that must NOT go through a shell (the opencode
// runner, which streams a JSONL event stream) need this instead. Three distinct failures hide
// behind "spawn opencode failed", each needing a different fix, and all three are invisible on
// Linux/macOS.
//
// 1. ENOENT — an npm-installed CLI is `opencode.cmd` (plus `.ps1`, often an extensionless
//    bash shim). Node's spawn does NOT apply PATHEXT, so a bare `opencode` is not found —
//    even though typing the same word in cmd.exe works, because the shell does apply it.
// 2. EINVAL — the obvious fix, spawning `opencode.cmd` directly, has been an error since
//    Node 18.20.2 / 20.12.2 / 21.7.3 (the CVE-2024-27980 batch-file-injection fix). A .cmd
//    must go through a shell.
// 3. E2BIG / silent truncation — the command line is capped at 32767 chars for
//    CreateProcess and 8191 through cmd.exe. Linux allows ~2MB, so passing a prompt as an
//    argument works everywhere except the platform the user is on. The opencode runner no
//    longer does that (the prompt goes over stdin), so the check below is a backstop for any
//    remaining caller rather than a routine branch.

const WINDOWS_ARGV_LIMIT = 32_767;
const CMD_EXE_ARGV_LIMIT = 8_191;

/** Resolves a bare command name to a real file on Windows, honouring PATHEXT. */
export function resolveWindowsCommand(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (env.PATH ?? "").split(";").filter(Boolean);

  const candidates =
    path.isAbsolute(cmd) || cmd.includes("\\") || cmd.includes("/")
      ? [cmd]
      : dirs.map((d) => path.join(d, cmd));
  for (const base of candidates) {
    // An explicit extension wins; otherwise try each PATHEXT entry, in order.
    if (path.extname(base) && fs.existsSync(base)) return base;
    for (const ext of exts) {
      const withExt = base + ext.toLowerCase();
      if (fs.existsSync(withExt)) return withExt;
    }
  }
  return undefined;
}

// Quotes one argument for cmd.exe: CommandLineToArgvW quoting so the child parses it as a
// single argument, then `^`-escaping so cmd.exe does not interpret the metacharacters itself.
function quoteForCmd(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(/[()%!^"<>&|]/g, "^$&");
}

export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Set when the command line is too long for this platform to carry. */
  error?: string;
}

/**
 * Turns (command, args) into something spawn() can actually run on this platform.
 *
 * Returns an `error` rather than throwing when the command line cannot fit: that failure has
 * to reach the user as "this argument is too long for Windows", not as a spawn errno.
 */
export function planSpawn(
  cmd: string,
  args: string[],
  platform: string = process.platform,
): SpawnPlan {
  if (platform !== "win32") return { file: cmd, args };

  const resolved = resolveWindowsCommand(cmd) ?? cmd;
  const isShim = /\.(cmd|bat)$/i.test(resolved);
  const limit = isShim ? CMD_EXE_ARGV_LIMIT : WINDOWS_ARGV_LIMIT;
  const length = [resolved, ...args].reduce((n, a) => n + a.length + 3, 0);
  if (length > limit) {
    return {
      file: resolved,
      args,
      error:
        `命令列長度 ${length} 字元，超過 ${isShim ? "cmd.exe" : "Windows"} 上限 ${limit}。` +
        (isShim ? `（${path.basename(resolved)} 是 .cmd shim，必須經 cmd.exe，上限較低）` : "") +
        "請改以檔案或 stdin 傳遞大型輸入",
    };
  }
  if (!isShim) return { file: resolved, args };

  // A .cmd/.bat cannot be spawned directly on current Node; route it through cmd.exe.
  const line = [resolved, ...args].map(quoteForCmd).join(" ");
  return {
    file: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

// ─── Killing a process tree ──────────────────────────────────────────────────
//
// `child.kill()` signals ONE process — the one we spawned. That is the wrong target whenever
// the thing doing the work is a grandchild, which on Windows it always is: an npm-installed
// `opencode.cmd` has to be run through cmd.exe (see planSpawn), so our child is the cmd.exe
// wrapper and opencode is its child. Killing the wrapper leaves opencode running, still
// holding the inherited stdout/stderr pipe handles — and Node's 'close' event waits for those
// pipes to close, so the run hangs forever instead of ending. The escalation to SIGKILL then
// targets a pid that is already a corpse and silently does nothing.
//
// Two platforms, two mechanisms:
//
// - Windows has no signals at all. Node maps every signal to TerminateProcess, so SIGTERM and
//   SIGKILL are the same hard kill and a graceful-then-forceful escalation is meaningless.
//   `taskkill /T` is the only way to reach the whole tree.
// - POSIX can signal a process group, but only if the child leads one — hence `detached: true`
//   at spawn time (DETACH_CHILDREN below). Signalling a negative pid reaches the group.

export type KillPlan =
  | { via: "taskkill"; file: string; args: string[] }
  | { via: "signal"; target: number; signal: NodeJS.Signals };

/** Pure: how to kill `pid` and its descendants on this platform. Split out so it is testable. */
export function planKill(
  pid: number,
  signal: NodeJS.Signals,
  platform: string = process.platform,
): KillPlan {
  if (platform === "win32") {
    // /T = tree, /F = force. Without /F taskkill sends WM_CLOSE, which a console process
    // never receives, so there is no gentler variant worth trying first.
    return { via: "taskkill", file: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
  }
  return { via: "signal", target: -pid, signal }; // negative pid = the process group
}

/** True on POSIX: the child must lead its own process group for planKill's group signal. */
export const DETACH_CHILDREN = process.platform !== "win32";

/** Kills `child` and everything it spawned. Never throws — the caller is already on a sad path. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  // POSIX: the leader having exited says nothing about the rest of its group. A grandchild that
  // inherited stdout (a server a plugin started, a forked JVM) keeps the group and the pipe
  // alive, and shLive waits on the pipe — so returning here made UT_BUILD_TIMEOUT_MS unable to
  // end the build at all. A group id is not reused while any member lives, and ESRCH covers an
  // empty group. Windows: taskkill /T walks the tree from a live parent, so there an exited
  // child really is the end of it.
  const leaderGone = child.exitCode !== null || child.signalCode !== null;
  if (leaderGone && process.platform === "win32") return;
  const plan = planKill(pid, signal);

  if (plan.via === "taskkill") {
    try {
      spawn(plan.file, plan.args, { stdio: "ignore", windowsHide: true }).unref();
      return;
    } catch (err) {
      logVerbose(`taskkill 啟動失敗，退回直接終止該程序：${String(err)}`);
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
      return;
    }
  }

  try {
    process.kill(plan.target, plan.signal);
  } catch (err) {
    // ESRCH just means the group is already gone. Anything else (e.g. the child was not
    // detached after all) is worth a direct-child fallback rather than a silent no-op.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH" && !leaderGone) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

// `detached: true` puts the child in its own process group, which is what makes the group kill
// above work — but it also means a Ctrl-C at the terminal no longer reaches it, because the
// shell only signals its own foreground group. Without the registry below, interrupting the
// tool would leave opencode running and holding the GPU. Windows needs none of this: children
// are not detached there, and a console Ctrl-C already goes to every process on the console.
const liveChildren = new Set<ChildProcess>();
let shutdownHooked = false;

const shutdownHooks: Array<(reason: string) => void> = [];

/** Runs synchronously on the way out after SIGINT / SIGTERM (and SIGHUP on a terminal). */
export function onShutdown(fn: (reason: string) => void): void {
  shutdownHooks.push(fn);
}

/** Takes down every child process tree still running: a writer, a build. */
export function killAll(): void {
  for (const c of liveChildren) killTree(c, "SIGKILL");
  liveChildren.clear();
}

function shutdown(reason: string, code: number): never {
  killAll();
  for (const fn of shutdownHooks.splice(0)) {
    try {
      fn(reason);
    } catch {
      /* already leaving */
    }
  }
  process.exit(code);
}

// Sampled at load, not in the handler: once a terminal has hung up, isatty() on it fails (the
// kernel swaps in hung-up file operations), and an interactive run would look detached.
const STARTED_ON_TERMINAL = process.platform !== "win32" && isatty(0);

/**
 * The process-wide signal handlers, installed once — by loop.ts at startup and again (a no-op)
 * by the first spawn, so they are in place before any child exists.
 *
 * SIGHUP needs its own rule. Node resets an inherited SIG_IGN to the default at startup, so
 * `nohup testgen … &` did NOT survive a dropped SSH session the way other programs do: the run
 * died with the terminal mid-build, printed nothing, wrote no summary, and the detached mvn
 * tree ran on as orphans. Without a terminal on stdin (nohup, setsid, cron, CI) a hangup is not
 * a request to stop, so it is ignored; on an interactive terminal it is a clean shutdown.
 */
export function installShutdownHandlers(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  // 'exit' handlers must be synchronous; process.kill is, so the POSIX path is safe here.
  process.on("exit", killAll);
  process.on("SIGINT", () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
  process.on("SIGHUP", () => {
    if (STARTED_ON_TERMINAL || process.platform === "win32") shutdown("SIGHUP", 129);
    log("[WARN] 收到 SIGHUP（終端已斷線），但 stdin 不是終端機（nohup / setsid / CI），繼續執行");
  });
}

/** Registers `child` so an interrupted run still takes its process tree down with it. */
export function trackForShutdown(child: ChildProcess): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  installShutdownHandlers();
}

/** Turns a spawn errno into its actual cause, rather than guessing one cause for all of them. */
export function explainSpawnError(err: NodeJS.ErrnoException, cmd: string): string {
  switch (err.code) {
    case "ENOENT":
      return `PATH 上找不到 ${cmd}${process.platform === "win32" ? "（已依 PATHEXT 一併尋找 .cmd/.exe）" : ""}`;
    case "EINVAL":
      return `${cmd} 無法啟動：Node 自 CVE-2024-27980 修補後拒絕直接 spawn .bat/.cmd，必須經由 cmd.exe`;
    case "E2BIG":
    case "ENAMETOOLONG":
      return `${cmd} 無法啟動：命令列超出本平台上限，請改以檔案或 stdin 傳遞大型輸入`;
    case "EACCES":
      return `${cmd} 沒有執行權限`;
    default:
      return `${cmd} 啟動失敗：${err.message}`;
  }
}
