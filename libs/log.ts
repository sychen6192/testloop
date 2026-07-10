/** Logging：所有輸出帶 [mm:ss] 經過時間，方便判斷是否還在跑 */
import { QUIET } from "../config";

const START_TS = Date.now();

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

/** 長時間操作期間每 15 秒印一次心跳，避免看起來像卡死 */
export function startHeartbeat(label: string): () => void {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    console.log(`[${elapsed()}] ${label} 仍在進行中（已等待 ${ticks * 15} 秒）`);
  }, 15_000);
  return () => clearInterval(timer);
}
