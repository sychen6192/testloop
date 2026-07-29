// Run a child process; stream stdout/stderr line-by-line (prefixed), return the full output.
// Also owns Windows process spawning (planSpawn / explainSpawnError) for callers that spawn
// without `shell: true` — the opencode runner and doctor.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logVerbose } from "./log";

export function shLive(
  cmd: string,
  args: string[],
  linePrefix: string,
  cwd: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    logVerbose(`> 執行：${cmd} ${args.join(" ")}（cwd=${cwd}）`);
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
    });

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

    child.on("close", (code) => resolve({ code: code ?? 1, out: buf }));
    child.on("error", (err) => {
      logVerbose(`指令啟動失敗：${err.message}`);
      resolve({ code: 1, out: String(err) });
    });
  });
}

// ─── Windows process spawning ────────────────────────────────────────────────
//
// shLive above passes `shell: true`, which makes the shell resolve the command — that is why
// the build gate finds mvnw.cmd. Callers that must NOT go through a shell (the opencode
// runner streams a JSONL event stream and passes a prompt containing shell metacharacters)
// need this instead. Three distinct failures hide behind "spawn opencode failed", each
// needing a different fix, and all three are invisible on Linux/macOS.
//
// 1. ENOENT — an npm-installed CLI is `opencode.cmd` (plus `.ps1`, often an extensionless
//    bash shim). Node's spawn does NOT apply PATHEXT, so a bare `opencode` is not found —
//    even though typing the same word in cmd.exe works, because the shell does apply it.
// 2. EINVAL — the obvious fix, spawning `opencode.cmd` directly, has been an error since
//    Node 18.20.2 / 20.12.2 / 21.7.3 (the CVE-2024-27980 batch-file-injection fix). A .cmd
//    must go through a shell.
// 3. E2BIG / silent truncation — the command line is capped at 32767 chars for
//    CreateProcess and 8191 through cmd.exe. Linux allows ~2MB, so passing a prompt as an
//    argument works everywhere except the platform the user is on.

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
