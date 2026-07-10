/** 子行程執行：stdout/stderr 逐行即時轉印（帶前綴），並回傳完整輸出 */
import { spawn } from "node:child_process";
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
