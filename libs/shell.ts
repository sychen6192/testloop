// Run a child process; stream stdout/stderr line-by-line (prefixed), return the full output.
// Also owns Windows process spawning (planSpawn / explainSpawnError) for callers that spawn
// without `shell: true` — the opencode runner and doctor.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logVerbose } from "./log";

export function shLive(
  cmd: string,
  args: string[],
  linePrefix: string,
  cwd: string,
  timeoutMs = 0,
): Promise<{ code: number; out: string; timedOut?: boolean }> {
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
          logVerbose(`${linePrefix} 逾時 ${timeoutMs}ms，終止程序樹`);
          killTree(child, "SIGKILL");
        }, timeoutMs)
      : undefined;

    let buf = "";
    const pipe = (stream: NodeJS.ReadableStream) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buf += chunk;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) logVerbose(`${linePrefix} ${line}`);
        }
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, out: buf, timedOut });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
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
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
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
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
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

/** Registers `child` so an interrupted run still takes its process tree down with it. */
export function trackForShutdown(child: ChildProcess): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  if (shutdownHooked) return;
  shutdownHooked = true;

  const killAll = () => {
    for (const c of liveChildren) killTree(c, "SIGKILL");
    liveChildren.clear();
  };
  // 'exit' handlers must be synchronous; process.kill is, so the POSIX path is safe here.
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
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
