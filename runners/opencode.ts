// OpencodeRunner: spawn `opencode run --agent <name> --format json` and write the prompt to
// the child's stdin. The prompt is never a command-line argument — see buildInvocation.
// --format json makes stdout a JSONL event stream, parsed line-by-line for live tracing.
// No --model unless a model is set; otherwise the agent .md's model field decides.
// Wall-clock timeout backstop (SIGTERM, then SIGKILL after 10s).
// Fail-closed: on spawn failure/timeout it still returns accumulated text; the gate decides pass/fail.
// Spawning goes through planSpawn — no `shell: true` here; see libs/shell.ts for why that
// matters on Windows even now that the prompt itself is off the command line.
import { spawn } from "node:child_process";
import { AgentRunner, AgentRunOutput } from "../libs/types";
import {
  REPO_ROOT,
  WRITER_MODEL,
  REVIEWER_MODEL,
  AGENT_TIMEOUT_MS,
  AGENT_RETRY_WINDOW_MS,
  OPENCODE_BIN,
  OPENCODE_JSON_EVENTS,
  OPENCODE_SKIP_PERMS,
} from "../config";
import { log, logVerbose, startHeartbeat } from "../libs/log";
import {
  DETACH_CHILDREN,
  explainSpawnError,
  killTree,
  planSpawn,
  trackForShutdown,
} from "../libs/shell";

// After the child exits, how long to wait for its stdio pipes to close before finishing anyway.
const EXIT_DRAIN_MS = 2_000;

// One JSONL event -> readable progress; text events accumulate into finalText.
// Observed opencode structure (--format json): the real type is in part.type, hyphenated
// (step-start / step-finish / text / tool); text in part.text, tool in part.tool, status in
// part.state.status. The outer ev.type is an unreliable envelope label — trust part.type.
// Compat: accept both hyphen and underscore; fall back to ev.type when part.type is missing.
export function traceEvent(
  line: string,
  prefix: string,
  acc: { text: string; lastText: string; toolCalls?: Set<string>; outputTokens?: number },
) {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // non-JSON line (diagnostic noise), skip
  }
  // Valid JSON that is not an event — a plugin printing `null` — is noise too, and reading
  // `.part` off null threw inside the stdout handler: uncaught, the whole run gone.
  if (!ev || typeof ev !== "object") return;
  const part = (ev.part ?? {}) as Record<string, unknown>;
  const kindRaw = String(part.type ?? ev.type ?? "");
  const kind = kindRaw.replace(/_/g, "-"); // normalize step_start <-> step-start

  switch (kind) {
    case "step-start":
      logVerbose(`${prefix}  -- step 開始`);
      break;
    case "step-finish": {
      const tokens = (part.tokens ?? {}) as Record<string, unknown>;
      const out = Number(tokens.output);
      if (Number.isFinite(out)) {
        acc.outputTokens = (acc.outputTokens ?? 0) + out;
        logVerbose(`${prefix}  -- step 結束（output tokens=${out}）`);
      }
      break;
    }
    case "tool": {
      const tool = String(part.tool ?? "unknown");
      const state = (part.state ?? {}) as Record<string, unknown>;
      const status = String(state.status ?? "");
      const input = JSON.stringify(state.input ?? {});
      const shortInput = input.length > 140 ? input.slice(0, 140) + "…" : input;
      const outRaw = state.output;
      const outNote =
        typeof outRaw === "string" && outRaw.length <= 60 ? ` -> ${outRaw}` : "";
      logVerbose(`${prefix}  [tool] ${tool} [${status}] ${shortInput}${outNote}`);
      // completed tool calls, deduped by callID (reviewer must-read evidence)
      if (status === "completed" && acc.toolCalls) {
        acc.toolCalls.add(String(part.callID ?? `${tool}#${acc.toolCalls.size}`));
      }
      break;
    }
    case "text": {
      const t = String(part.text ?? "");
      if (t) {
        acc.text += t;
        acc.lastText = t; // safety: models often put the final JSON in the last complete text part
        const oneLine = t.replace(/\s+/g, " ").trim();
        if (oneLine) {
          logVerbose(
            `${prefix}  ${oneLine.length > 160 ? oneLine.slice(0, 160) + "…" : oneLine}`,
          );
        }
      }
      break;
    }
    case "error":
      logVerbose(`${prefix}  [WARN] ${JSON.stringify(ev).slice(0, 300)}`);
      break;
  }
}

/**
 * Builds the argv for one `opencode run`. The prompt is deliberately NOT in it — the runner
 * writes it to the child's stdin.
 *
 * `opencode run` reads stdin to EOF whenever stdin is not a TTY and uses it as the message
 * (appended after the positional message, if any). Passing no positional message therefore
 * makes the piped text the entire prompt.
 *
 * That is the only route that is safe on Windows. Two earlier attempts were not:
 *
 * - Positional argument: an npm-installed `opencode.cmd` must be spawned through cmd.exe
 *   (Node refuses to spawn .cmd directly since the CVE-2024-27980 fix), and cmd.exe re-parses
 *   the command line. A writer prompt full of quotes, newlines and JSON comes out shredded,
 *   and the command line is capped at 8191 chars besides.
 * - `--file <tmp>/prompt.md <instruction>`: opencode declares --file as a yargs array option,
 *   so it greedily swallows every following positional. The instruction was parsed as a
 *   second file path, giving `File not found: <the instruction text>`.
 *
 * stdin has no length limit and never passes through a shell, so this needs no
 * platform-specific branch at all.
 */
export function buildInvocation(
  agent: string,
  model: string,
  opts: { jsonEvents: boolean; skipPerms: boolean },
): string[] {
  const args = ["run", "--agent", agent];
  if (model) args.push("--model", model);
  if (opts.jsonEvents) args.push("--format", "json");
  if (opts.skipPerms) args.push("--dangerously-skip-permissions");
  return args;
}

// One opencode process, start to exit. `exited` = it ended on its own with a non-zero code or an
// unexpected signal, which is not the same thing as finishing: opencode gives up on a provider
// outage after its own retries (about 75s) and exits 1.
type Attempt =
  | { kind: "ok" | "timeout" | "spawn-error"; output: AgentRunOutput; active?: boolean }
  | { kind: "exited"; output: AgentRunOutput; why: string; active: boolean };

export interface OpencodeRunnerOptions {
  retryWindowMs?: number;
  retryDelayMs?: number;
  // Tests point these at a scripted stand-in; production uses UT_OPENCODE_BIN / UT_AGENT_TIMEOUT_MS.
  bin?: string;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Re-runs are bounded by the retry window; the count only stops a zero delay from spinning, and
// is derived from the window so that a long window is not ended early by it.
const MAX_RESPAWNS = 6;
const MAX_RESPAWN_BACKOFF_MS = 60_000;

export class OpencodeRunner implements AgentRunner {
  private readonly retryWindowMs: number;
  private readonly retryDelayMs: number;
  private readonly bin: string;
  private readonly timeoutMs: number;
  // Agents that have completed a session this run. Until one has, an abnormal exit is almost
  // always configuration (model name, provider auth) and should stop the run in seconds; after
  // it has, the same exit is an outage, and re-running the session outlasts it. Per agent,
  // because the writer and the reviewer can be on different models and providers.
  private readonly worked = new Set<string>();

  constructor(opts: OpencodeRunnerOptions = {}) {
    this.retryWindowMs = opts.retryWindowMs ?? AGENT_RETRY_WINDOW_MS;
    this.retryDelayMs = opts.retryDelayMs ?? 15_000;
    this.bin = opts.bin ?? OPENCODE_BIN;
    this.timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS;
  }

  // The exit code used to be discarded: an opencode that gave up on a 503 was logged as
  // "[OK] 完成", the writer had changed nothing, and the next round ended the run as
  // writer-no-op with a hint about permissions. Now an abnormal exit is re-run within the retry
  // window, and reported for what it is when that runs out.
  private async runAgent(
    label: string,
    agent: string,
    model: string,
    prompt: string,
    allowSkipPerms: boolean,
  ): Promise<AgentRunOutput> {
    log(`[${label}] session 啟動（agent=${agent}, model=${model || "（agent 預設）"}）`);
    const stopHeartbeat = startHeartbeat(`[${label}]`);
    const deadline = Date.now() + this.timeoutMs;
    let failingSince: number | undefined;
    try {
      for (let attempt = 1; ; attempt++) {
        const r = await this.runOnce(label, agent, model, prompt, allowSkipPerms, deadline - Date.now());
        // A session that got as far as calling tools, emitting text or reporting tokens proved the
        // model and provider work — even if it later timed out or exited on a provider error.
        if (r.kind === "ok" || r.active) this.worked.add(agent);
        if (r.kind !== "exited") return r.output;
        if (!this.worked.has(agent)) {
          log(`[FAIL] [${label}] ${r.why}`);
          return { text: "", status: "spawn-error" };
        }
        // A session that did work before it failed had a working provider until then: the outage
        // being waited out starts now, not at an earlier failure.
        if (r.active) failingSince = undefined;
        failingSince ??= Date.now();
        const delay = Math.min(this.retryDelayMs * 2 ** (attempt - 1), MAX_RESPAWN_BACKOFF_MS);
        const outOfWindow =
          this.retryWindowMs === 0 || Date.now() - failingSince + delay > this.retryWindowMs;
        const maxRespawns = MAX_RESPAWNS + Math.ceil(this.retryWindowMs / MAX_RESPAWN_BACKOFF_MS);
        if (attempt >= maxRespawns || outOfWindow || Date.now() + delay >= deadline) {
          log(`[WARN] [${label}] ${r.why}——重新執行的額度已用完，以已收到的輸出繼續`);
          return { ...r.output, status: "timeout" };
        }
        log(`[WARN] [${label}] ${r.why}——${(delay / 1000).toFixed(0)} 秒後重新執行（第 ${attempt} 次）`);
        await sleep(delay);
      }
    } finally {
      stopHeartbeat();
    }
  }

  private runOnce(
    label: string,
    agent: string,
    model: string,
    prompt: string,
    allowSkipPerms: boolean,
    timeoutMs: number,
  ): Promise<Attempt> {
    return new Promise((resolve) => {
      const started = Date.now();
      if (timeoutMs <= 0) {
        resolve({ kind: "timeout", output: { text: "", status: "timeout" } });
        return;
      }

      const skipPerms = allowSkipPerms && OPENCODE_SKIP_PERMS;
      if (skipPerms) {
        logVerbose(`[${label}] [WARN] UT_OC_SKIP_PERMS=1：已附加 --dangerously-skip-permissions`);
      }

      const args = buildInvocation(agent, model, {
        jsonEvents: OPENCODE_JSON_EVENTS,
        skipPerms,
      });
      logVerbose(`[${label}] prompt（${prompt.length} 字元）以 stdin 傳入`);

      // Windows needs the command resolved through PATHEXT, and .cmd shims routed via
      // cmd.exe — Node refuses to spawn them directly since the CVE-2024-27980 fix.
      const plan = planSpawn(this.bin, args);
      if (plan.error) {
        log(`[FAIL] [${label}] ${plan.error}`);
        resolve({ kind: "spawn-error", output: { text: "", status: "spawn-error" } });
        return;
      }

      const child = spawn(plan.file, plan.args, {
        cwd: REPO_ROOT,
        env: process.env,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"],
        // POSIX only: makes the child a process-group leader so a timeout can kill the whole
        // tree, not just the process we happen to hold. See libs/shell.ts.
        detached: DETACH_CHILDREN,
      });
      trackForShutdown(child);

      // opencode blocks on reading stdin to EOF before it prompts the model, so this has to
      // be written and closed unconditionally — a piped-but-never-closed stdin hangs the run.
      // EPIPE is expected if the child dies first (bad flag, missing auth); the close handler
      // reports that, so swallow it here rather than let it surface as an unhandled error.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt, "utf8");

      const acc = {
        text: "",
        lastText: "",
        toolCalls: new Set<string>(),
        outputTokens: undefined as number | undefined,
      };
      let rawStdout = "";
      // The current, unterminated line, as chunks. Only a chunk containing a newline triggers a
      // join: re-splitting one growing string on every chunk was quadratic in a long event line.
      let pending: string[] = [];
      let lastError = "";
      const onLine = (line: string) => {
        if (!line.trim()) return;
        traceEvent(line, `[${label}]`, acc);
        if (line.includes('"error"')) {
          try {
            const ev = JSON.parse(line) as { type?: string; error?: { name?: string; data?: { message?: string } } };
            if (ev && ev.type === "error") {
              lastError = String(ev.error?.data?.message ?? ev.error?.name ?? "").slice(0, 300);
            }
          } catch {
            /* not an event */
          }
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (!OPENCODE_JSON_EVENTS) rawStdout += chunk; // only the non-JSONL mode returns it
        const nl = chunk.lastIndexOf("\n");
        if (nl < 0) {
          pending.push(chunk);
          return;
        }
        pending.push(chunk.slice(0, nl));
        const complete = pending.join("");
        pending = [chunk.slice(nl + 1)];
        for (const line of complete.split("\n")) onLine(line);
      });

      let stderrTail = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
        for (const line of chunk.trim().split("\n")) {
          if (line.trim()) logVerbose(`[${label}] ${line}`);
        }
      });

      // Timeout: kill the whole process tree — on Windows the direct child is a cmd.exe
      // wrapper, and killing only it would leave opencode running (see libs/shell.ts).
      let timedOut = false;
      let killEscalation: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        log(
          `[WARN] [${label}] 逾時 ${this.timeoutMs}ms，終止 opencode 程序樹` +
            `（模型較慢時請調高 UT_AGENT_TIMEOUT_MS）`,
        );
        killTree(child, "SIGTERM");
        // Only POSIX has anything to escalate to: on Windows taskkill /F was already a hard
        // kill, and repeating it would just log a second failure against a dead pid.
        if (DETACH_CHILDREN) {
          killEscalation = setTimeout(() => {
            logVerbose(`[${label}] 程序樹仍在，改送 SIGKILL`);
            killTree(child, "SIGKILL");
          }, 10_000);
        }
      }, timeoutMs);

      let finished = false;
      let spawnError: string | undefined;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (killEscalation) clearTimeout(killEscalation);
        if (drainTimer) clearTimeout(drainTimer);
        // Whatever is still in the group — a grandchild that outlived opencode, or a SIGTERM
        // ignorer whose escalation was just cancelled — must not keep running: it would go on
        // writing test files while the gates judge them. POSIX only; see libs/shell.ts.
        if (DETACH_CHILDREN) killTree(child, "SIGKILL");
        if (spawnError) {
          log(`[FAIL] [${label}] ${spawnError}`);
          resolve({ kind: "spawn-error", output: { text: "", status: "spawn-error" } });
          return;
        }
        const partial = pending.join("");
        if (partial.trim()) onLine(partial); // flush the partial line
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        // JSONL mode: use accumulated text (or the last text part if empty);
        // non-JSONL (UT_OPENCODE_JSON=0): return the whole stdout — no events to count,
        // so tool/token usage is unobservable (undefined), not zero.
        const output = (status: AgentRunOutput["status"]): AgentRunOutput =>
          OPENCODE_JSON_EVENTS
            ? {
                text: acc.text.trim() ? acc.text : acc.lastText,
                status,
                toolCallCount: acc.toolCalls.size,
                outputTokens: acc.outputTokens,
              }
            : { text: rawStdout, status };
        const active = acc.toolCalls.size > 0 || (acc.outputTokens ?? 0) > 0 || acc.text.trim() !== "";
        if (!timedOut && (exitCode !== 0 || exitSignal !== null)) {
          const detail = lastError || stderrTail.trim().split("\n").pop()?.slice(0, 300) || "";
          resolve({
            kind: "exited",
            active,
            output: output("timeout"),
            why:
              `opencode 異常結束（exit=${exitCode ?? "-"}${exitSignal ? `, signal=${exitSignal}` : ""}，耗時 ${secs} 秒）` +
              (detail ? `：${detail}` : ""),
          });
          return;
        }
        // A killed run is not a completed one; say so, but still hand back what arrived —
        // fail-closed means the gate judges the partial output, not this function.
        log(
          timedOut
            ? `[WARN] [${label}] 逾時中止（耗時 ${secs} 秒），以已收到的輸出繼續`
            : `[OK] [${label}] 完成（耗時 ${secs} 秒）`,
        );
        resolve({ kind: timedOut ? "timeout" : "ok", active, output: output(timedOut ? "timeout" : "ok") });
      };

      // 'close' waits for the stdio pipes to close as well as for the process to exit, so any
      // survivor holding an inherited pipe keeps it from ever firing — that is what turned a
      // Windows timeout into a permanent hang. 'exit' always fires; let the pipes drain
      // briefly, then finish regardless. finish() is idempotent, so the usual ordering
      // ('close' first, promptly) is unaffected.
      child.on("exit", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        drainTimer = setTimeout(() => {
          logVerbose(`[${label}] 程序已結束但輸出管線未關閉，不再等待`);
          finish();
        }, EXIT_DRAIN_MS);
      });
      child.on("close", finish);
      child.on("error", (err) => {
        spawnError = `${explainSpawnError(err, this.bin)}——請確認已安裝 opencode CLI，或以 UT_OPENCODE_BIN 指定路徑`;
        finish();
      });
    });
  }

  runWriter(prompt: string): Promise<AgentRunOutput> {
    // permission contract in .opencode/agent/ut-writer.md (write/edit on, bash/web off)
    return this.runAgent("writer", "ut-writer", WRITER_MODEL, prompt, true);
  }

  runReview(prompt: string): Promise<AgentRunOutput> {
    // read-only reviewer; skip-perms never applies to the reviewer
    return this.runAgent("reviewer", "ut-reviewer", REVIEWER_MODEL, prompt, false);
  }
}
