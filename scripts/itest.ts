// Integration selftest: the loop's wiring, run end to end against a fake Maven repo.
//
// scripts/selftest.ts proves the pure functions are right. This file proves they are
// *connected* — that the scope guard actually aborts the run, that the shrink guard actually
// fails the round before the build, that stuck detection actually fires. Every scenario runs
// the real orchestrator, the real gates and a real child process; only `mvnw`, the writer and
// the model endpoint are scripted. No Java, no Maven, no model, ~10s for the whole file.
//
// Run: npx tsx scripts/itest.ts [情境名稱]
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  ApiTurn,
  buildFixture,
  CALC_TEST as CALC_TEST_TEXT,
  envKnobsInSource,
  EXISTING_TEST,
  gitAvailable,
  jdkAvailable,
  repoLockPath,
  RUN_DIR,
  Scenario,
  targetDirOf,
  TESTGEN_ROOT,
} from "./itest-lib";
import { FIXED_TEST as FIXED_TEST_TEXT, SCENARIOS } from "./itest-scenarios";
import { planSpawn, processStart } from "../libs/shell";

let passCount = 0;
let failCount = 0;
// Repeated at the end with the scenario each belongs to, as in the selftest: a CI log viewer that
// shows only the tail still shows every failure.
const failures: string[] = [];
let currentScenario = "";
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passCount++;
    console.log(`  [OK] ${name}`);
  } else {
    failCount++;
    const line = `  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`;
    failures.push(`[${currentScenario}]${line.slice(1)}`);
    console.log(line);
  }
}

// ─── Hermetic environment ────────────────────────────────────────────────────
//
// Every knob is pinned, and every UT_* already in the environment is dropped, because the
// tool auto-loads its own .env: an operator's UT_STRICT_COV=1 must not decide whether a
// coverage assertion here passes. The completeness check below keeps this list honest.

// Journal owners a scenario started (rerun.liveOwner): none outlives its scenario.
const liveOwners: number[] = [];

const BASE_ENV: Record<string, string> = {
  UT_AGENT_TIMEOUT_MS: "60000",
  UT_ALLOW_DIRTY_BASELINE: "0",
  UT_ALLOW_TEST_SHRINK: "0",
  UT_ALLOW_ZERO_TESTS: "0",
  UT_API_BASE_URL: "",
  UT_API_KEY: "",
  UT_API_MAX_TOKENS: "0",
  UT_API_MAX_TOOL_RESULT_CHARS: "20000",
  UT_API_MAX_TURNS: "8",
  UT_AGENT_RETRY_WINDOW_MS: "180000",
  UT_BUILD_TIMEOUT_MS: "60000",
  // A journal unexpectedly still beating fails fast here, not after six minutes.
  UT_OTHER_RUN_WAIT_MS: "20000",
  UT_MAX_BUILD_OUTPUT_CHARS: "67108864",
  UT_CA_CERTS: "",
  UT_HTTPS_PROXY: "",
  UT_HTTP_PROXY: "",
  UT_NO_PROXY: "",
  UT_USER_AGENT: "",
  UT_JACOCO_XML: "",
  UT_MAVEN_ARGS: "",
  UT_MAX_FAILURE_BLOCKS: "5",
  UT_MAX_FAILURE_CASES: "10",
  UT_MAX_FEEDBACK_CHARS: "12000",
  UT_MAX_ITER: "5",
  UT_BATCH_SIZE: "1",
  UT_MIN_BRANCH_COV: "70",
  UT_MIN_LINE_COV: "80",
  UT_MODEL: "",
  UT_OC_SKIP_PERMS: "0",
  UT_OPENCODE_BIN: "opencode",
  UT_OPENCODE_JSON: "1",
  UT_QUIET: "1",
  UT_REPAIR_BASELINE: "1",
  UT_REPAIR_MAX_ITER: "5",
  UT_REPAIR_NO_PROGRESS_ROUNDS: "2",
  UT_REVIEWER_MODEL: "itest-reviewer",
  UT_REVIEWER_MUST_READ: "1",
  UT_REVIEW_MAX_RETRIES: "2",
  UT_RUNNER: "opencode",
  UT_RESUME: "1",
  UT_RUNS_DIR: "",
  UT_SCORE_THRESHOLDS: "",
  UT_SKILL_DIR: "",
  UT_SKIP_BASELINE: "0",
  UT_SKIP_GUARD: "1",
  UT_SKIP_REVIEW: "0",
  // Not "": STANDARDS_PATH uses ??, so an empty string would win over the default.
  UT_STANDARDS_PATH: path.join(TESTGEN_ROOT, "standards", "java-ut-standards.md"),
  UT_STRICT_COV: "0",
  UT_TEST_SCOPE: "module",
  UT_WRITER_MODEL: "itest-writer",
  UT_WRITER_TEMPERATURE: "0.2",
};

// The standard proxy variables are the fallback behind every UT_ proxy knob (config.ts envAny),
// so an empty UT_NO_PROXY does not blank a NO_PROXY the shell exports — and on a corporate
// machine, the one place the proxy scenarios matter most, the shell always exports one. With
// 127.0.0.1 in it, the fixture proxy never saw a connection and the scenario failed there.
const PROXY_ENV = /^(?:https?_proxy|no_proxy|all_proxy)$/i;

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("UT_") && !PROXY_ENV.test(k)) env[k] = v;
  }
  return { ...env, ...BASE_ENV, ...extra };
}

// ─── Child process plumbing ──────────────────────────────────────────────────

const TSX_BIN = path.join(
  TESTGEN_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function runTsx(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunOut> {
  return new Promise((resolve) => {
    const plan = planSpawn(TSX_BIN, [script, ...args]);
    const child = spawn(plan.file, plan.args, {
      cwd,
      env,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: `${stderr}\n${e.message}` }));
  });
}

// ─── Fake OpenAI-compatible endpoint (entry=loop only) ───────────────────────
//
// The api runner is the only runner that can be driven without an agent CLI, which makes it
// the seam for testing loop.ts itself. The server replays scripted turns; the runner's tool
// loop, its write-scope enforcement and its token accounting are all the real ones.

function startFakeApi(turns: ApiTurn[], root: string): Promise<{ url: string; close: () => Promise<void> }> {
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // What the model was sent — tool results included — for the checks to read.
      fs.appendFileSync(path.join(root, ".itest", "api-requests.jsonl"), `${body.replace(/\n/g, " ")}\n`);
      const turn: ApiTurn = turns[i++] ?? { content: "沒有更多腳本回合了" };
      // POSIX only, as in the fake mvnw: on Windows process.kill terminates the run outright.
      if (turn.interrupt && process.platform !== "win32") {
        try {
          process.kill(JSON.parse(fs.readFileSync(repoLockPath(root), "utf8")).pid, "SIGINT");
        } catch {
          /* no run holds the lock: the checks will say so */
        }
      }
      // A hard kill, on every platform: Windows' process.kill is TerminateProcess, which is exactly that.
      if (turn.kill) {
        try {
          process.kill(JSON.parse(fs.readFileSync(repoLockPath(root), "utf8")).pid, "SIGKILL");
        } catch {
          /* no run holds the lock: the checks will say so */
        }
      }
      for (const rel of turn.sideDelete ?? []) fs.rmSync(path.join(root, rel), { force: true });
      for (const [rel, content] of Object.entries(turn.sideWrite ?? {})) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
      }
      if (turn.breakRunDir) {
        const found: string[] = [];
        const walk = (d: string) => {
          let entries: fs.Dirent[] = [];
          try {
            entries = fs.readdirSync(d, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (/^iter-\d+$/.test(e.name)) found.push(path.join(d, e.name));
            else walk(path.join(d, e.name));
          }
        };
        walk(path.join(root, ".itest", "runs"));
        found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (found[0]) {
          fs.rmSync(found[0], { recursive: true, force: true });
          fs.writeFileSync(found[0], "not a directory any more");
        }
      }
      if (turn.status) {
        res.writeHead(turn.status, { "content-type": "application/json" });
        res.end(turn.body ?? JSON.stringify({ error: { message: "scripted failure" } }));
        return;
      }
      const message: Record<string, unknown> = { content: turn.content ?? "" };
      if (turn.toolCalls?.length) {
        message.tool_calls = turn.toolCalls.map((t, n) => ({
          id: `call_${i}_${n}`,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message, ...(turn.finishReason ? { finish_reason: turn.finishReason } : {}) }],
          usage: { completion_tokens: 11 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * A real forward proxy, so "the request went through the proxy" is observed rather than
 * asserted about a pure function. Handles CONNECT (what undici's ProxyAgent uses) and
 * absolute-form requests, and records every origin it was asked to reach.
 */
function startProxy(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const sockets = new Set<import("node:stream").Duplex>();
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    res.writeHead(502).end("this fixture proxy only tunnels");
  });
  server.on("connect", (req, clientSocket, head) => {
    seen.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    for (const s of [clientSocket, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => s.destroy());
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

// ─── Scenario execution ──────────────────────────────────────────────────────

interface Ctx {
  name: string;
  root: string;
  runDir: string;
  result: Record<string, unknown>;
  code: number;
  stdout: string;
  stderr: string;
  argv: string[][];
  mvnCalls: number;
  /** Origins the fixture proxy was asked to reach; undefined when no proxy ran. */
  proxySeen?: string[];
  /** With rerun: the first run, whose end the checks' run is the rerun of. */
  first?: { result: Record<string, unknown>; runDir: string; code: number; stdout: string };
  read(rel: string): string;
  exists(rel: string): boolean;
  runRead(rel: string): string;
  runExists(rel: string): boolean;
}

async function runScenario(sc: Scenario): Promise<Ctx> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `testgen-itest-${sc.name}-`));
  buildFixture(root, sc);

  let out: RunOut;
  let runDir = path.join(root, RUN_DIR);
  let result: Record<string, unknown> = {};
  let proxySeen: string[] | undefined;

  let first: Ctx["first"];
  if (sc.entry === "loop") {
    const runsBase = path.join(root, sc.runsInRepo ? "testgen-runs" : path.join(".itest", "runs"));
    // Held by a live process — this one — exactly as a second testgen on the same repo would see.
    const lock = sc.lockHeld ? repoLockPath(root) : undefined;
    if (lock) fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runDir: "/elsewhere" }));
    // A PATH with node on it and nothing else: no java, no javac, wherever node is installed.
    let noJdkEnv: Record<string, string> = {};
    if (sc.noJdk) {
      const bin = path.join(root, ".itest", "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
      noJdkEnv = { JAVA_HOME: "", PATH: bin };
    }
    const runLoop = async (turns: ApiTurn[], env: Record<string, string> = {}) => {
      const api = await startFakeApi(turns, root);
      const proxy = sc.proxy ? await startProxy() : undefined;
      proxySeen = proxy?.seen;
      const apiHost = new URL(api.url).host;
      const done = await runTsx(
        path.join(TESTGEN_ROOT, "loop.ts"),
        [targetDirOf(sc)],
        root,
        childEnv({
          ...sc.env,
          ...env,
          UT_RUNNER: "api",
          UT_API_BASE_URL: api.url,
          UT_RUNS_DIR: runsBase,
          ...(proxy ? { UT_HTTP_PROXY: proxy.url } : {}),
          // Scenarios opt into the bypass by naming the endpoint's own host:port.
          ...(sc.noProxy ? { UT_NO_PROXY: apiHost } : {}),
          ...noJdkEnv,
        }),
      );
      await api.close();
      await proxy?.close();
      // RUNS_DIR = <UT_RUNS_DIR>/<repo basename>/<runId>; the newest is the run that just ended.
      const repoRuns = path.join(runsBase, path.basename(root));
      const ids = fs.existsSync(repoRuns) ? fs.readdirSync(repoRuns).sort() : [];
      const dir = ids.length ? path.join(repoRuns, ids[ids.length - 1]) : path.join(root, RUN_DIR);
      const summary = path.join(dir, "summary.json");
      const res: Record<string, unknown> = fs.existsSync(summary) ? JSON.parse(fs.readFileSync(summary, "utf8")) : {};
      return { out: done, runDir: dir, result: res };
    };
    let run = await runLoop(sc.api ?? []);
    if (sc.rerun) {
      first = { result: run.result, runDir: run.runDir, code: run.out.code, stdout: run.out.stdout };
      // What the api log holds from here on is the second run's.
      fs.rmSync(path.join(root, ".itest", "api-requests.jsonl"), { force: true });
      if (sc.rerun.backdateMs) {
        const t = (Date.now() - sc.rerun.backdateMs) / 1000;
        const age = (d: string) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) age(p);
            else if (e.isFile()) fs.utimesSync(p, t, t);
          }
        };
        age(root);
      }
      const firstRel = path.relative(root, run.runDir);
      if (sc.rerun.pipeDirAt && process.platform !== "win32") {
        const p = path.join(root, sc.rerun.pipeDirAt);
        fs.rmSync(p, { recursive: true, force: true });
        fs.mkdirSync(p, { recursive: true });
        spawnSync("mkfifo", [path.join(p, "pipe")]);
      }
      // A rewrite is what the file held all along: its time stays (a journal's time is its heartbeat).
      for (const rw of [sc.rerun.rewrite ?? []].flat()) {
        const p = path.join(root, rw.file.replace("{{firstRun}}", firstRel));
        try {
          const st = fs.statSync(p);
          fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(rw.from, rw.to));
          fs.utimesSync(p, st.atimeMs / 1000, st.mtimeMs / 1000);
        } catch {
          /* not there: the checks say what is missing */
        }
      }
      for (const [from, to] of sc.rerun.renames ?? []) {
        fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
        fs.renameSync(path.join(root, from), path.join(root, to));
      }
      if (sc.rerun.liveOwner) {
        const owner = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${sc.rerun.liveOwner.ms})`], { stdio: "ignore", detached: true });
        owner.unref();
        liveOwners.push(owner.pid!);
        const start = processStart(owner.pid!) ?? "";
        const jdir = path.join(root, sc.rerun.liveOwner.journal.replace("{{firstRun}}", firstRel));
        for (const f of ["owner.json", "journal.json"]) {
          const p = path.join(jdir, f);
          try {
            fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/"pid":\d+,"start":"[^"]*"/, `"pid":${owner.pid},"start":"${start}"`));
          } catch {
            /* not there: the checks say what is missing */
          }
        }
      }
      for (const [key, content] of Object.entries(sc.rerun.between ?? {})) {
        const rel = key.replace("{{firstRun}}", firstRel);
        const p = path.join(root, rel);
        if (content === null) fs.rmSync(p, { force: true });
        else {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content);
        }
      }
      run = await runLoop(sc.rerun.api ?? [], sc.rerun.env);
    }
    if (lock) fs.rmSync(lock, { force: true });
    out = run.out;
    runDir = run.runDir;
    result = run.result;
  } else {
    out = await runTsx(
      path.join(TESTGEN_ROOT, "scripts", "itest-case.ts"),
      [sc.name],
      root,
      childEnv(sc.env),
    );
    const line = out.stdout.split("\n").find((l) => l.startsWith("ITEST_RESULT:"));
    if (line) result = JSON.parse(line.slice("ITEST_RESULT:".length));
  }

  const argvLog = path.join(root, ".itest", "mvn-argv.log");
  const argv = fs.existsSync(argvLog)
    ? fs
        .readFileSync(argvLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
    : [];

  const rd = (base: string) => (rel: string) => {
    const p = path.join(base, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  };
  const ex = (base: string) => (rel: string) => fs.existsSync(path.join(base, rel));

  return {
    name: sc.name,
    root,
    runDir,
    result,
    code: out.code,
    stdout: out.stdout,
    stderr: out.stderr,
    argv,
    mvnCalls: argv.length,
    proxySeen,
    first,
    read: rd(root),
    exists: ex(root),
    runRead: rd(runDir),
    runExists: ex(runDir),
  };
}

// ─── Assertions ──────────────────────────────────────────────────────────────

type Funnel = Array<{ iter: number; gate: string; outcome: string }>;
const funnelOf = (c: Ctx): Funnel => (c.result.funnel as Funnel) ?? [];
const gates = (c: Ctx) => funnelOf(c).map((f) => `${f.gate}/${f.outcome}`);
/** Every maven invocation the loop made, flattened for substring assertions. */
const everyCall = (c: Ctx, arg: string) => c.argv.length > 0 && c.argv.every((a) => a.includes(arg));
// A Gradle build that runs the test task whatever its last execution left: cleanTest before test,
// and the build cache off (FROM-CACHE survives cleanTest). Plain output, for the parsers.
const gradleForced = (a: string[]) =>
  a.indexOf("cleanTest") >= 0 &&
  a.indexOf("cleanTest") < a.indexOf("test") &&
  a.includes("-Dorg.gradle.caching=false") &&
  a.includes("--console=plain");
const noCall = (c: Ctx, prefix: string) =>
  c.argv.every((a) => !a.some((x) => x.startsWith(prefix)));

const CHECKS: Record<string, (c: Ctx) => void> = {
  "scope-violation": (c) => {
    check("整個 run 中止於 scope-violation", c.result.stopReason === "scope-violation", String(c.result.stopReason));
    check("不是成功", c.result.success === false);
    check("第 1 輪就停", c.result.iterations === 1, String(c.result.iterations));
    check("完全沒有進 build gate（mvn 0 次）", c.mvnCalls === 0, `mvnCalls=${c.mvnCalls}`);
    check("funnel 記為 writer/scope-violation", gates(c).join(",") === "writer/scope-violation", gates(c).join(","));
    const v = c.runRead("iter-1/scope-violations.txt");
    check("違規檔名寫進 scope-violations.txt", v.includes("src/main/java/com/x/Calc.java"), v);
    check("失敗報告說明變更未被還原", String(c.result.finalFeedback).includes("未被還原"));
    check("production code 的改動留在磁碟上交人處理", c.read("src/main/java/com/x/Calc.java").includes("a + b + 0"));
  },

  "writer-spawn-error": (c) => {
    check("判為 runner-spawn-error", c.result.stopReason === "runner-spawn-error", String(c.result.stopReason));
    check("不重試，第 1 輪結束", c.result.iterations === 1);
    check("沒有建置", c.mvnCalls === 0);
  },

  "writer-no-op": (c) => {
    check("判為 writer-no-op", c.result.stopReason === "writer-no-op", String(c.result.stopReason));
    check("第 2 輪停止", c.result.iterations === 2, String(c.result.iterations));
    check("只建置過一次（第 2 輪不浪費建置）", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("funnel：build/fail → writer/no-op", gates(c).join(",") === "build/fail,writer/no-op", gates(c).join(","));
  },

  "shrink-then-recover": (c) => {
    check("最終成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("花了 2 輪", c.result.iterations === 2, String(c.result.iterations));
    check("第 1 輪判 writer/test-shrink", gates(c)[0] === "writer/test-shrink", gates(c).join(","));
    check("刪減那輪沒有進建置（總共只建置 1 次）", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("test-shrink.txt 落地", c.runExists("iter-1/test-shrink.txt"));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋帶前後數字", fb.includes("@Test 2 → 1"), fb.slice(0, 200));
    check("既有測試最後回到原樣", c.read("src/test/java/com/x/ExistingTest.java").includes("div_byOne_returnsSameValue"));
  },

  "shrink-stuck": (c) => {
    check("判為 stuck", c.result.stopReason === "stuck", String(c.result.stopReason));
    check("第 2 輪就停，不燒滿 MAX_ITER=5", c.result.iterations === 2, String(c.result.iterations));
    check("全程沒有建置", c.mvnCalls === 0);
  },

  "shrink-disabled": (c) => {
    check("最終成功", c.result.success === true);
    check("第 1 輪因 @Disabled 判 FAIL", gates(c)[0] === "writer/test-shrink", gates(c).join(","));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋點名略過標記增加", fb.includes("略過標記") && fb.includes("0 → 1"), fb.slice(0, 300));
  },

  "shrink-assumption": (c) => {
    check("最終成功", c.result.success === true);
    check("第 1 輪因 assumeTrue(false) 判 FAIL、不進建置", gates(c)[0] === "writer/test-shrink" && c.mvnCalls === 1, `${gates(c).join(",")} mvnCalls=${c.mvnCalls}`);
  },

  "shrink-silenced": (c) => {
    check("最終成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("第 1 輪判 test-shrink、不進建置", gates(c)[0] === "writer/test-shrink" && c.mvnCalls === 1, `${gates(c).join(",")} mvnCalls=${c.mvnCalls}`);
    const report = c.runRead("iter-1/test-shrink.txt");
    check("報告點出略過標記 0 → 2", report.includes("ExistingTest.java") && report.includes("0 → 2"), report);
  },

  "shrink-allowed": (c) => {
    check("UT_ALLOW_TEST_SHRINK=1 → 一輪就過", c.result.success === true && c.result.iterations === 1, JSON.stringify(c.result));
    check("刪減被放行但仍建置", c.mvnCalls === 1);
    check("仍留下 test-shrink.txt 供事後檢視", c.runExists("iter-1/test-shrink.txt"));
  },

  "happy-path-module-scope": (c) => {
    check("一輪全綠", c.result.success === true && c.result.iterations === 1, JSON.stringify(c.result.stopReason));
    check("stopReason=gates-passed", c.result.stopReason === "gates-passed");
    check("每次建置都帶 -Djacoco.append=false", everyCall(c, "-Djacoco.append=false"), JSON.stringify(c.argv));
    check("預設範圍不帶 -Dtest", noCall(c, "-Dtest="), JSON.stringify(c.argv));
    check("單一模組不帶 -pl", noCall(c, "-pl"), JSON.stringify(c.argv));
    check("帶 -DskipITs", everyCall(c, "-DskipITs"));
    check("writer output tokens 有累計", c.result.totalOutputTokens === 123, String(c.result.totalOutputTokens));
    check("coverage 報告落地", c.runRead("iter-1/coverage.txt").includes("Calc.java"));
    check("prompt 落地", c.runExists("iter-1/prompt.md"));
  },

  "tests-all-skipped-in-suite": (c) => {
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("第 1 輪記在 build gate", gates(c)[0] === "build/fail", gates(c).join(","));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋說 CalcTest 的 2 個測試全部被略過", fb.includes("com.x.CalcTest：你新寫的測試類別，2 個測試全部被略過"), fb.slice(0, 800));
  },
  "tests-not-run-cjk-display-name": (c) => {
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("第 1 輪記在 build gate", gates(c)[0] === "build/fail", gates(c).join(","));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋點名沒被執行的 CalcTest（別的類別的中文名字不算它的）", fb.includes("com.x.CalcTest") && fb.includes("你新寫的測試類別，這次建置沒有執行它"), fb.slice(0, 800));
  },
  "tests-not-run-framework": (c) => {
    check("第 2 輪（改寫成 JUnit 4 後）才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("第 1 輪記在 build gate", gates(c)[0] === "build/fail", gates(c).join(","));
    const fb = c.runRead("iter-1/feedback.md");
    check(
      "回饋點名沒被執行的類別與它的寫法，並指出這個模組執行的是 JUnit 4、要改寫",
      fb.includes("com.x.CalcTest（JUnit 5 寫法）") && fb.includes("都是 JUnit 4 寫法") && fb.includes("org.junit.Test"),
      fb.slice(0, 800),
    );
  },

  "coverage-jacoco-append-forced": (c) => {
    check("第 3 輪才通過", c.result.success === true && c.result.iterations === 3, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check(
      "第 2 輪（刪掉 div 的測試）卡在覆蓋率，沒有被第 1 輪留下的覆蓋率放行",
      gates(c).slice(0, 2).join(",") === "build/fail,coverage/fail",
      gates(c).join(","),
    );
    const warns = c.stdout.split("\n").filter((l) => l.includes("JaCoCo 把覆蓋率累加進 target/coverage-reports/jacoco-ut.exec"));
    check("說明 exec 檔被設成累加、之後建置前會刪掉（只說一次）", warns.length === 1, c.stdout.slice(-1500));
  },

  "coverage-jacoco-exec-left-over": (c) => {
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("第 1 輪照實判覆蓋率不足，開發者留下的 exec 沒有灌水", gates(c)[0] === "coverage/fail", gates(c).join(","));
  },

  "coverage-lombok-generated-lines": (c) => {
    check("一輪通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations]));
    const cov = c.runRead("iter-1/coverage.txt");
    check("Money 只算寫出來的邏輯：100%", /Money\.java: line=100\.0%.*branch=100\.0%.*PASS/.test(cov), cov);
    check("報告列出未計入的行（@Data、欄位）", cov.includes("未計入的行：6, 8-9"), cov);
  },

  "coverage-lombok-real-miss": (c) => {
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("第 1 輪卡在覆蓋率 gate", gates(c)[0] === "coverage/fail", gates(c).join(","));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋是寫出來的邏輯的數字（branch 50%）", /Money\.java: line=83\.3%.*branch=50\.0%.*FAIL/.test(fb), fb.slice(0, 600));
    check("未覆蓋行只點名手寫的那行 13，不點名 @Data 的第 6 行", fb.includes("未覆蓋行：13\n") || /未覆蓋行：13$/m.test(fb), fb.slice(0, 600));
    check("未覆蓋分支只點名 if 那行 12，不點名 @Data 第 6 行的 20 個", /^ {2}未覆蓋分支：12（2 個分支有 1 個沒走到）$/m.test(fb), fb.slice(0, 600));
  },

  "zero-tests": (c) => {
    check("建置綠燈仍判 FAIL", c.result.success === false);
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋說明執行了 0 個測試", fb.includes("0 個測試"), fb.slice(0, 200));
    check("funnel 記在 build gate", gates(c)[0] === "build/fail", gates(c).join(","));
    check("相同報告第 2 輪判 stuck", c.result.stopReason === "stuck", String(c.result.stopReason));
  },

  "multimodule-reactor-args": (c) => {
    check("一輪全綠", c.result.success === true && c.result.iterations === 1, JSON.stringify(c.result.stopReason));
    check("從 repo 根跑 reactor：帶 -pl web -am", c.argv[0]?.includes("-pl") && c.argv[0]?.includes("web") && c.argv[0]?.includes("-am"), JSON.stringify(c.argv[0]));
    check(
      "限縮同時套用到整個 reactor，並帶上 CalcTest$*（surefire 3.0.0-M5 以前，-Dtest=類名 不會執行只有 @Nested 的類別）",
      c.argv[0]?.includes("-Dtest=CalcTest,CalcTest$*"),
      JSON.stringify(c.argv[0]),
    );
    check(
      "上游模組沒有那些類別，必須關掉 failIfNoSpecifiedTests",
      c.argv[0]?.includes("-Dsurefire.failIfNoSpecifiedTests=false"),
      JSON.stringify(c.argv[0]),
    );
    check("最終驗收跑完整 reactor，不帶 -Dtest", c.argv[1]?.includes("-am") && !c.argv[1]?.some((a) => a.startsWith("-Dtest=")), JSON.stringify(c.argv[1]));
    check("覆蓋率讀目標模組自己的報告", c.runRead("iter-1/coverage.txt").includes("Calc.java"), c.runRead("iter-1/coverage.txt"));
  },

  "multimodule-upstream-failure-detail": (c) => {
    const fb = c.runRead("iter-1/feedback.md");
    check("失敗類別點名上游模組", fb.includes("com.x.common.UtilTest"), fb.slice(0, 500));
    check(
      "斷言訊息要讀得到（報告在 common/target，不在 web/target）",
      fb.includes("expected: <a> but was: < a >"),
      fb.slice(0, 500),
    );
    check("帶到上游模組的 stack frame", fb.includes("UtilTest.java:11"), fb.slice(0, 500));
    check(
      "重跑仍失敗 → 第 1 輪就以 out-of-scope-failure 停下（writer 影響不到、也不能改上游模組），不再重試到 stuck",
      c.result.stopReason === "out-of-scope-failure" && c.result.iterations === 1 && c.mvnCalls === 2,
      JSON.stringify([c.result.stopReason, c.result.iterations, c.mvnCalls]),
    );
    check(
      "說明點名模組與類別、說 writer 影響不到它",
      String(c.result.finalFeedback).includes("common 的 com.x.common.UtilTest") && String(c.result.finalFeedback).includes("影響不到其他模組的測試"),
      String(c.result.finalFeedback).slice(0, 500),
    );
  },

  "loop-batches-upstream-broken": (c) => {
    check("exit code 2", c.code === 2, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("整個 run 停在第 1 批", c.result.stopReason === "stopped:out-of-scope-failure", String(c.result.stopReason));
    const notRun = ((c.result.notRun ?? []) as string[]).map((p) => p.replace(/\\/g, "/"));
    check("第 2 批（Zeta）列為沒執行", JSON.stringify(notRun) === JSON.stringify([`${"web/src/main/java/com/x/web"}/Zeta.java`]), JSON.stringify(c.result.notRun));
    check("建置 3 次：預檢、第 1 批的紅燈、它的重跑——第 2 批沒有再撞一次", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
  },

  "multimodule-upstream-flaky": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 2 次：上游紅一次、重跑綠", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    check("結果點名上游那個不穩定的測試", JSON.stringify(c.result.flakyTests) === '["com.x.common.UtilTest"]', JSON.stringify(c.result.flakyTests));
  },

  "multimodule-baseline-outside-scope": (c) => {
    check("以失敗結束", c.code !== 0, `code=${c.code}`);
    check(
      "不進修復迴圈——writer 對 common/src/test 沒有寫入權，修不了",
      !c.runExists("repair-1/prompt.md"),
      "repair-1 存在，代表 loop 花輪數去修一件它做不到的事",
    );
    check("stopReason 標示超出可修範圍", String(c.result.stopReason).includes("out-of-scope"), JSON.stringify(c.result.stopReason));
    check("錯誤訊息點名是哪個模組壞了", /common/.test(c.stderr), c.stderr.slice(-400));
    check("也點名具體的測試類別", c.stderr.includes("com.x.common.UtilTest"), c.stderr.slice(-400));
    check("完全沒有產生測試", !c.exists("web/src/test/java/com/x/web/CalcTest.java"));
  },

  "multimodule-upstream-compile-error": (c) => {
    check("以失敗結束", c.code !== 0, `code=${c.code}`);
    check("不進修復迴圈", !c.runExists("repair-1/prompt.md"), "repair-1 存在");
    check("stopReason 標示超出可修範圍", String(c.result.stopReason).includes("out-of-scope"), JSON.stringify(c.result.stopReason));
    check(
      "點名上游模組那個編譯不過的檔（相對 repo 根，不是絕對路徑）",
      JSON.stringify(c.result.outOfScope).includes("common/src/test/java/com/x/common/UtilTest.java"),
      JSON.stringify(c.result.outOfScope),
    );
    check("錯誤訊息看得到那個檔", c.stderr.includes("common/src/test/java/com/x/common/UtilTest.java"), c.stderr.slice(-400));
    check("只跑了預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
  },

  "nested-surefire-failure": (c) => {
    const fb = c.runRead("iter-1/feedback.md");
    // The whole point: without the XML the writer gets method names and no reason.
    check("回饋帶到斷言訊息", fb.includes("expected: 400 BAD_REQUEST but was: 400"), fb.slice(0, 400));
    check("兩個失敗案例都在", fb.includes("expected: <3> but was: <4>"), fb.slice(0, 400));
    check("保留 @Nested 容器名，定位得到程式碼", fb.includes("DivByZero.div_byZero_throwsIllegalArgument"), fb.slice(0, 400));
    check("帶到專案自己的 stack frame（檔案:行號）", fb.includes("CalcTest.java:41"), fb.slice(0, 400));
    check(
      "框架 frame 被濾掉（junit / assertj / reflect 不入報告）",
      !/AssertionFailureBuilder|org\.assertj|reflect\.Method/.test(fb),
      fb.slice(0, 400),
    );
    check("標題帶真實計數，不是 .txt 的 0/0", fb.includes("測試 4、失敗 2、錯誤 0"), fb.slice(0, 400));
    check("不再退回引用 .txt 摘要", !fb.includes("Tests run: 0, Failures: 0"), fb.slice(0, 400));
    check("相同失敗第 2 輪判 stuck（報告仍然逐輪穩定）", c.result.stopReason === "stuck", String(c.result.stopReason));
  },

  "stuck-test-failure": (c) => {
    check("判為 stuck", c.result.stopReason === "stuck", String(c.result.stopReason));
    check("第 2 輪停止，未燒滿 MAX_ITER", c.result.iterations === 2, String(c.result.iterations));
    check("只建置 2 次", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋保留真實的 Time elapsed（正規化只用於比對）", /Time elapsed:\s*0\.\d+/.test(fb), fb.slice(0, 300));
  },

  "progress-not-stuck": (c) => {
    check("失敗原因不同就不判 stuck", c.result.stopReason === "max-iterations", String(c.result.stopReason));
    check("跑滿 UT_MAX_ITER=3", c.result.iterations === 3, String(c.result.iterations));
    check("建置 3 次", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
  },

  "feedback-budget": (c) => {
    const fb = c.runRead("iter-1/feedback.md");
    // The contract clampText actually implements: MAX_FEEDBACK_CHARS of report, then a short
    // notice saying how much went missing. The notice is what puts the string over the number.
    check("報告本體被截在 UT_MAX_FEEDBACK_CHARS=800", fb.slice(0, 800).length === 800 && fb.length > 800, `len=${fb.length}`);
    check(
      "超出的部分只有截斷告示（< 100 字元）",
      fb.slice(800).startsWith("\n…（報告過長，已截斷") && fb.length - 800 < 100,
      `overshoot=${fb.length - 800}：${JSON.stringify(fb.slice(800))}`,
    );
    check("回饋非空且含編譯錯誤", fb.includes("cannot find symbol"), fb.slice(0, 120));
    check("錯誤在報告開頭，不是被樣板擠掉", fb.startsWith("編譯或測試失敗") && fb.indexOf("cannot find symbol") < 200, fb.slice(0, 120));
    check("build.log 保留完整輸出，不受回饋預算影響", c.runRead("iter-1/build.log").length > 3000);
  },

  "coverage-below-threshold": (c) => {
    check("build 綠但整體失敗", c.result.success === false);
    check("funnel 記在 coverage gate", gates(c)[0] === "coverage/fail", gates(c).join(","));
    const cov = c.runRead("iter-1/coverage.txt");
    check("報告列出未覆蓋行", cov.includes("未覆蓋行：9-11, 13"), cov);
    check("line 百分比算對（4/10=40%）", cov.includes("line=40.0%"), cov);
    check("相同缺口第 2 輪判 stuck", c.result.stopReason === "stuck", String(c.result.stopReason));
  },

  "stale-jacoco": (c) => {
    check("陳舊報告不得通過 coverage gate", c.result.success === false);
    const cov = c.runRead("iter-1/coverage.txt");
    check("訊息點名報告比本輪建置舊", cov.includes("比本輪建置還舊"), cov);
    check("funnel 記在 coverage gate", gates(c)[0] === "coverage/fail", gates(c).join(","));
  },

  "review-reject-then-pass": (c) => {
    check("第 2 輪通過", c.result.success === true && c.result.iterations === 2, JSON.stringify(c.result.stopReason));
    check("第 1 輪 funnel 記為 review/reject", gates(c)[0] === "review/reject", gates(c).join(","));
    const fb = c.runRead("iter-1/feedback.md");
    check("blocker 進回饋", fb.includes("未涵蓋 div 的除零分支"), fb);
    check("低分維度進回饋", fb.includes("coverage（5 < 門檻 7）"), fb);
    check("advisories 不進回饋（防 thrash）", !fb.includes("建議把測試命名再精確一點"), fb);
    const v = JSON.parse(c.runRead("iter-1/verdict.json"));
    check("verdict 由 pipeline 算分，不由 LLM", typeof v.weightedScore === "number" && typeof v.grade === "string", JSON.stringify(v));
    check("verdict.json 不含 raw 全文", v.raw === undefined);
    const final = c.result.finalVerdict as Record<string, unknown>;
    check("最終判決 passed=true", final?.passed === true, JSON.stringify(final));
  },

  "review-unparseable-aborts": (c) => {
    check("判為 reviewer-unparseable", c.result.stopReason === "reviewer-unparseable", String(c.result.stopReason));
    check("只跑了 1 輪——沒有拿 writer 的輪數去換", c.result.iterations === 1, String(c.result.iterations));
    check("重試落在 reviewer：3 份 raw 都落地", c.runExists("iter-1/review-raw.txt") && c.runExists("iter-1/review-raw-3.txt"));
    check("沒有第 2 輪", !c.runExists("iter-2"));
    check(
      "訊息點名這是 reviewer 端的問題，不是測試的問題",
      String(c.result.finalFeedback ?? "").includes("不是測試的問題"),
      String(c.result.finalFeedback ?? "").slice(0, 300),
    );
  },

  "review-zero-tool-calls": (c) => {
    check("0 次工具呼叫的判決不得通過", c.result.success === false);
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋說明未呼叫任何工具", fb.includes("未呼叫任何工具"), fb.slice(0, 200));
    check("連兩輪相同 → stuck", c.result.stopReason === "stuck", String(c.result.stopReason));
  },

  "scoped-final-verify": (c) => {
    check("最終成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("花了 2 輪", c.result.iterations === 2, String(c.result.iterations));
    check("第 1 輪因最終驗收失敗", gates(c)[0] === "build/final-verify-fail", gates(c).join(","));
    check("共建置 5 次（每輪限縮 1 次 + 完整 1 次，第 1 輪的完整重跑失敗在沒碰過的測試、再重跑一次確認）", c.mvnCalls === 5, `mvnCalls=${c.mvnCalls}`);
    check("限縮那次帶 -Dtest=CalcTest,CalcTest$*", c.argv[0]?.includes("-Dtest=CalcTest,CalcTest$*"), JSON.stringify(c.argv[0]));
    check(
      "限縮必須同時關掉 failIfNoSpecifiedTests",
      c.argv[0]?.includes("-Dsurefire.failIfNoSpecifiedTests=false"),
      JSON.stringify(c.argv[0]),
    );
    check("最終驗收那次不帶 -Dtest（完整模組）", !c.argv[1]?.some((a) => a.startsWith("-Dtest=")), JSON.stringify(c.argv[1]));
    check("限縮不影響 jacoco.append 設定", everyCall(c, "-Djacoco.append=false"));
    check("final-verify.log 落地", c.runExists("iter-1/final-verify.log"));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋說明打壞了既有測試", fb.includes("新測試打壞了既有測試"), fb.slice(0, 200));
    check(
      "重跑仍失敗 → 回饋點名是 writer 沒碰過的 ExistingTest、要它從自己的測試下手",
      fb.includes("你這次沒有寫過、也沒有改過的測試類別：com.x.ExistingTest") && fb.includes("不要修改上面這些類別") && c.runExists("iter-1/final-verify-rerun.log"),
      fb.slice(0, 600),
    );
    check("確認重跑也是完整模組（不帶 -Dtest）", !c.argv[2]?.some((a) => a.startsWith("-Dtest=")), JSON.stringify(c.argv[2]));
    check("不是 flaky：結果不點名不穩定的測試", c.result.flakyTests === undefined, JSON.stringify(c.result.flakyTests));
    check("成功那輪也做了完整驗收", c.runExists("iter-2/final-verify.log"));
  },

  "scoped-final-verify-flaky": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 3 次：限縮、完整（紅）、完整重跑（綠）", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    check("結果點名不穩定的 ExistingTest", JSON.stringify(c.result.flakyTests) === '["com.x.ExistingTest"]', JSON.stringify(c.result.flakyTests));
    check("紅的那次與重跑都留下 log", c.runExists("iter-1/final-verify.log") && c.runExists("iter-1/final-verify-rerun.log"));
  },

  "build-flaky-untouched-test": (c) => {
    check("第 1 輪就通過（重跑轉綠，沒有浪費一輪）", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 2 次：第一次紅、重跑綠", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    check("結果點名不穩定的 ExistingTest", JSON.stringify(c.result.flakyTests) === '["com.x.ExistingTest"]', JSON.stringify(c.result.flakyTests));
    check(
      "紅的 build.log、重跑的 build-rerun.log、flaky.txt 都留下",
      c.runExists("iter-1/build.log") && c.runExists("iter-1/build-rerun.log") && c.runRead("iter-1/flaky.txt").includes("com.x.ExistingTest"),
    );
    check("覆蓋率照重跑那次的報告判", c.runRead("iter-1/coverage.txt").includes("PASS"), c.runRead("iter-1/coverage.txt").slice(0, 300));
  },

  "build-collateral-untouched-test": (c) => {
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 3 次：紅、重跑仍紅、第 2 輪綠", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    const fb = c.runRead("iter-1/feedback.md");
    check(
      "回饋點名 writer 沒碰過的 ExistingTest、說明多半是共享狀態，列出 writer 改過的檔、要它別改 ExistingTest",
      fb.includes("你這次沒有寫過、也沒有改過的測試類別：com.x.ExistingTest") &&
        fb.includes("共享狀態") &&
        fb.includes("com/x/CalcTest.java") &&
        fb.includes("不要修改上面這些類別"),
      fb.slice(0, 700),
    );
    check("回饋仍附上失敗明細", fb.includes("預設 Locale 被新測試改成 de_DE"), fb.slice(0, 900));
    check("不是 flaky：沒有 flaky.txt、結果不點名", !c.runExists("iter-1/flaky.txt") && c.result.flakyTests === undefined);
  },

  "build-untouched-broken-no-op": (c) => {
    check("以 writer-no-op 收場", c.result.success === false && c.result.stopReason === "writer-no-op", String(c.result.stopReason));
    check(
      "說明是 writer 沒碰過、重跑仍失敗的測試需要人檢視",
      String(c.result.finalFeedback).includes("com.x.ExistingTest") && String(c.result.finalFeedback).includes("可能本身就壞了"),
      String(c.result.finalFeedback).slice(0, 600),
    );
  },

  "build-collateral-then-own-red-no-op": (c) => {
    check("第 3 輪以 writer-no-op 收場", c.result.stopReason === "writer-no-op" && c.result.iterations === 3, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check(
      "說明不沿用第 1 輪的「既有測試可能本身壞了」——上一輪紅的是 writer 自己的測試",
      !String(c.result.finalFeedback).includes("可能本身就壞了"),
      String(c.result.finalFeedback).slice(0, 600),
    );
  },

  "build-compile-error-with-untouched-red-no-rerun": (c) => {
    check("第 2 輪通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 2 次：有編譯錯誤就不重跑", c.mvnCalls === 2 && !c.runExists("iter-1/build-rerun.log"), `mvnCalls=${c.mvnCalls}`);
  },

  "build-crash-untouched-flaky": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("結果點名 JVM 中途結束的 ExistingTest", JSON.stringify(c.result.flakyTests) === '["com.x.ExistingTest"]', JSON.stringify(c.result.flakyTests));
  },

  "build-killed-no-rerun": (c) => {
    if (process.platform === "win32") return; // no SIGKILL to deliver
    check("第 2 輪通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 2 次：被收掉的那次不重跑", c.mvnCalls === 2 && !c.runExists("iter-1/build-rerun.log"), `mvnCalls=${c.mvnCalls}`);
  },

  "build-unplaceable-failure-no-rerun": (c) => {
    check("第 2 輪通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 2 次：找不到原始碼的失敗類別不重跑", c.mvnCalls === 2 && !c.runExists("iter-1/build-rerun.log"), `mvnCalls=${c.mvnCalls}`);
  },

  "build-own-test-red-no-rerun": (c) => {
    check("第 2 輪通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 2 次：writer 自己的測試紅了就不重跑", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    check("沒有 build-rerun.log", !c.runExists("iter-1/build-rerun.log"));
  },

  "loop-scoped-final-verify-not-run": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("第 1 輪記在最終驗收", gates(c)[0] === "build/final-verify-fail", gates(c).join(","));
    const fb = c.runRead("iter-1/feedback.md");
    check(
      "回饋說明是「該執行的沒被執行」並點名 ExistingTest，不是「打壞了既有測試」",
      fb.includes("有該執行的測試沒有被執行") && fb.includes("com.x.ExistingTest") && !fb.includes("新測試打壞了既有測試"),
      fb.slice(0, 800),
    );
    check("建置 5 次：預檢 + 每輪限縮 1 次 + 完整 1 次", c.mvnCalls === 5, `mvnCalls=${c.mvnCalls}`);
  },

  "repair-framework-switch": (c) => {
    check("第 1 輪的「綠燈」不算修好，第 2 輪才修好", c.result.success === true && c.result.rounds === 2, JSON.stringify(c.result));
    const fb = c.runRead("repair-1/feedback.md");
    check(
      "回饋點名它改之前有被執行、這次沒有，而且是 TestNG 寫法",
      fb.includes("com.x.ExistingTest（TestNG 寫法）") && fb.includes("改之前有被執行") && fb.includes("JUnit 4 寫法"),
      fb.slice(0, 800),
    );
    check("綠燈的建置沒有錯誤可節錄：回饋不附建置 log 的尾巴", !fb.includes("錯誤節錄"), fb.slice(-400));
    check("建置 3 次：預檢 + 兩輪修復", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
  },

  "repair-success": (c) => {
    check("修復成功", c.result.success === true, JSON.stringify(c.result));
    check("stopReason=repaired", c.result.stopReason === "repaired");
    check("一輪修好", c.result.rounds === 1, String(c.result.rounds));
    check(
      "列出改過的測試檔供人檢視 diff（路徑相對於 src/test/java）",
      JSON.stringify(c.result.changedFiles) === JSON.stringify(["com/x/BrokenTest.java"]),
      JSON.stringify(c.result.changedFiles),
    );
    check("建置 2 次：預檢 + 修復後驗證", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    check("修復輪 artifacts 落地", c.runExists("repair-1/prompt.md") && c.runExists("repair-1/build.log"));
    check("修復輪沒有 coverage / review 產物", !c.runExists("repair-1/coverage.txt") && !c.runExists("repair-1/verdict.json"));
    check("預檢與修復驗證用的是同一道指令", JSON.stringify(c.argv[0]) === JSON.stringify(c.argv[1]), JSON.stringify(c.argv));
  },

  "repair-stuck": (c) => {
    check("判為 stuck", c.result.stopReason === "stuck", String(c.result.stopReason));
    check("第 2 輪停止", c.result.rounds === 2, String(c.result.rounds));
    check("仍然紅燈的檔案有被記錄", JSON.stringify(c.result.remaining).includes("BrokenTest.java"), JSON.stringify(c.result.remaining));
  },

  "repair-scope-violation": (c) => {
    check("修復輪也擋範圍違規", c.result.stopReason === "scope-violation", String(c.result.stopReason));
    check("不是成功", c.result.success === false);
    check("只跑了預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("違規清單落地", c.runExists("repair-1/scope-violations.txt"));
  },

  "repair-shrink-refused": (c) => {
    check("最終修好", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("花了 2 輪", c.result.rounds === 2, String(c.result.rounds));
    check("刪減那輪沒有建置（預檢 1 次 + 第 2 輪 1 次）", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    check("刪減報告落地", c.runExists("repair-1/test-shrink.txt"));
  },

  "repair-ansi-coloured-build-output": (c) => {
    check("上色的輸出照樣修得好", c.result.stopReason === "repaired", String(c.result.stopReason));
    check("一輪就修好", c.result.rounds === 1, String(c.result.rounds));
    const prompt = c.runRead("repair-1/prompt.md");
    check(
      "prompt 真的點名了壞掉的檔案（空清單就是這個 bug 的樣子）",
      prompt.includes("BrokenTest.java"),
      prompt.slice(0, 400),
    );
  },

  "repair-unlocatable-failure": (c) => {
    check("判為 unlocatable-failure", c.result.stopReason === "unlocatable-failure", String(c.result.stopReason));
    check("一輪都沒跑", c.result.rounds === 0, String(c.result.rounds));
    check("連 repair-1 目錄都不該建立（writer 沒被叫過）", !c.runExists("repair-1"));
    check("只建置過預檢那一次", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    const report = String(c.result.report ?? "");
    check(
      "訊息帶出錯誤節錄，而不是一份空清單",
      report.includes("Could not resolve dependencies"),
      report.slice(0, 300),
    );
    // runBaseline's summary already embeds the extract when it can name no file; appending a
    // second copy spends the feedback budget twice on the same text.
    check(
      "錯誤節錄只出現一次（summary 已內含，不該再貼一份）",
      report.split("Could not resolve dependencies").length - 1 === 1,
      String(report.split("Could not resolve dependencies").length - 1),
    );
  },

  "repair-test-failure-detail": (c) => {
    const prompt = c.runRead("repair-1/prompt.md");
    check(
      "prompt 帶了斷言訊息（只有類別名的話 writer 沒有東西可依據）",
      prompt.includes("expected: <3> but was: <4>"),
      prompt.slice(0, 600),
    );
    check("prompt 也點名了失敗的類別", prompt.includes("com.x.CalcTest"), prompt.slice(0, 300));
    check("修得好", c.result.stopReason === "repaired", String(c.result.stopReason));
  },

  "repair-no-progress": (c) => {
    check("判為 repair-no-progress", c.result.stopReason === "repair-no-progress", String(c.result.stopReason));
    check("第 2 輪就停，沒燒到 UT_REPAIR_MAX_ITER=5", c.result.rounds === 2, String(c.result.rounds));
    check("建置 3 次：預檢 + 2 輪驗證", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    check(
      "不是 stuck：報告每輪都不同，fingerprint 抓不到",
      c.result.stopReason !== "stuck",
      String(c.result.stopReason),
    );
    check(
      "訊息說出紅燈數沒下降",
      String(c.result.report ?? "").includes("紅燈數沒有下降"),
      String(c.result.report ?? "").slice(0, 200),
    );
  },

  "repair-max-iterations": (c) => {
    check("用完輪數就停", c.result.stopReason === "repair-max-iterations", String(c.result.stopReason));
    check("剛好 UT_REPAIR_MAX_ITER=2 輪", c.result.rounds === 2, String(c.result.rounds));
    check("建置 3 次：預檢 + 每輪驗證", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-happy": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stderr.slice(-400)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("預檢 + gate 共 2 次建置", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    check("baseline artifacts 落地", c.runExists("baseline.md") && c.runExists("baseline.log"));
    const params = JSON.parse(c.runRead("params.json"));
    check("params.json 記錄工具版本戳記", typeof params.toolVersion === "string" && params.toolVersion.length > 0, JSON.stringify(params.toolVersion));
    check("params.json 記錄 runner 與 testScope", params.runner === "api" && params.testScope === "module", JSON.stringify(params));
    check("api runner 真的把測試寫進 src/test", c.exists("src/test/java/com/x/CalcTest.java"));
    check("writer 摘要落地", c.runExists("iter-1/writer-summary.md"));
  },

  "loop-through-proxy": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stderr.slice(-400)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("proxy 確實收到連線", (c.proxySeen?.length ?? 0) > 0, JSON.stringify(c.proxySeen));
    check(
      "proxy 被要求連到假端點的 host:port",
      (c.proxySeen ?? []).some((t) => /^127\.0\.0\.1:\d+$/.test(t)),
      JSON.stringify(c.proxySeen),
    );
    check("測試仍然照常產生", c.exists("src/test/java/com/x/CalcTest.java"));
  },

  "loop-proxy-bypassed": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stderr.slice(-400)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check(
      "NO_PROXY 生效：proxy 一次連線都沒收到",
      (c.proxySeen?.length ?? 0) === 0,
      JSON.stringify(c.proxySeen),
    );
    check("測試仍然照常產生", c.exists("src/test/java/com/x/CalcTest.java"));
  },

  "loop-dirty-baseline-abort": (c) => {
    check("die 以 exit 1 結束", c.code === 1, `code=${c.code}`);
    check("summary.json 記錄 dirty-baseline", c.result.stopReason === "dirty-baseline", JSON.stringify(c.result));
    check("點名編譯失敗的檔案", JSON.stringify(c.result.compileErrorFiles).includes("BrokenTest.java"), JSON.stringify(c.result.compileErrorFiles));
    check("只跑了預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("完全沒有產生測試", !c.exists("src/test/java/com/x/CalcTest.java"));
    check("錯誤訊息提示可用的旁路", c.stderr.includes("UT_ALLOW_DIRTY_BASELINE=1"), c.stderr.slice(-300));
    // The boundary strip's own job: the parsers would cope either way, but a log an operator
    // cannot read is how the original bug stayed invisible for four rounds.
    check(
      "落地的 baseline.log 不留色碼（診斷時人要讀得懂）",
      !c.runRead("baseline.log").includes(String.fromCharCode(27)),
      c.runRead("baseline.log").slice(0, 200),
    );
  },

  "loop-other-tests-stop-running": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stderr.slice(-400)}`);
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    const fb = c.runRead("iter-1/feedback.md");
    check(
      "回饋點名不再被執行的既有測試，指向測試資源裡的設定",
      fb.includes("com.x.ExistingTest") && fb.includes("writer 介入前有被執行") && fb.includes("META-INF/services"),
      fb.slice(0, 800),
    );
    check("預檢 + 兩輪 gate 共 3 次建置", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-dirty-tolerated": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stderr.slice(-400)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check(
      "既有失敗被記進 summary.json（這個綠燈要可被審計）",
      JSON.stringify(c.result.toleratedFailures ?? []).includes("com.x.LegacyTest#old_behaviour"),
      JSON.stringify(c.result.toleratedFailures),
    );
    check("測試確實產生了", c.exists("src/test/java/com/x/CalcTest.java"));
    check("預檢 + gate 共 2 次建置", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-dirty-tolerated-failure-ignored": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stderr.slice(-400)}`);
    check(
      "預檢認出 exit 0 背後的既有失敗，容忍的清單記進 summary.json",
      JSON.stringify(c.result.toleratedFailures ?? []).includes("com.x.LegacyTest#old_behaviour"),
      JSON.stringify(c.result.toleratedFailures),
    );
  },

  "loop-dirty-new-failure-ignored-blocked": (c) => {
    check("新失敗擋下 → exit 2", c.code === 2, `code=${c.code}\n${c.stdout.slice(-500)}`);
    const fb = c.runRead("iter-1/feedback.md");
    check("報告點名 writer 弄壞的那個", fb.includes("com.x.OtherTest#broken_by_writer"), fb.slice(0, 500));
  },

  "loop-baseline-test-failure-ignored": (c) => {
    check("die 以 exit 1 結束，summary.json 記錄 dirty-baseline", c.code === 1 && c.result.stopReason === "dirty-baseline", `code=${c.code} ${String(c.result.stopReason)}`);
    check("點名失敗的 LegacyTest", JSON.stringify(c.result.failingTestClasses).includes("com.x.LegacyTest"), JSON.stringify(c.result.failingTestClasses));
    const md = c.runRead("baseline.md");
    check("baseline.md 說明 Maven 為什麼說 BUILD SUCCESS", md.includes("testFailureIgnore") && !md.includes("乾淨"), md.slice(0, 500));
  },

  "loop-baseline-tests-skipped-no-sources": (c) => {
    check("exit code 0（沒有中止）", c.code === 0, `code=${c.code}\n${c.stderr.slice(-400)}`);
    check("預檢印 WARN 說明為什麼照常開始", c.stdout.includes("還沒有任何測試原始碼"), c.stdout.slice(-900));
    check("測試產生了", c.exists("src/test/java/com/x/CalcTest.java"));
  },

  "loop-gradle-dirty-tolerated": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-700)}`);
    check(
      "預檢認出 LegacyTest 的失敗，容忍清單記進 summary.json",
      JSON.stringify(c.result.toleratedFailures ?? []).includes("com.x.LegacyTest#old_behaviour()"),
      JSON.stringify(c.result.toleratedFailures),
    );
    check("跑的是 gradlew，而且強制執行 test task", c.argv.length === 2 && c.argv.every(gradleForced), JSON.stringify(c.argv));
  },

  "loop-gradle-baseline-repair": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-900)}`);
    check("預檢點名目標模組裡失敗的 LegacyTest（不是範圍外）", c.runRead("baseline.md").includes("com.x.LegacyTest") && !c.runRead("baseline.md").includes("超出 writer 可寫範圍"), c.runRead("baseline.md").slice(0, 600));
    check("進了修復迴圈、修好了", c.runExists("repair-1/prompt.md") && c.read("src/test/java/com/x/LegacyTest.java").includes("assertEquals(3,"));
    check("測試產生了", c.exists("src/test/java/com/x/CalcTest.java"));
  },

  "loop-baseline-tests-skipped": (c) => {
    check("die 以 exit 1 結束", c.code === 1, `code=${c.code}`);
    check("stopReason = tests-skipped", c.result.stopReason === "tests-skipped", String(c.result.stopReason));
    check("只跑了預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("訊息說明要設什麼", c.stderr.includes("-DskipTests=false") && c.stderr.includes("Tests are skipped"), c.stderr.slice(-600));
    check("沒有開 writer session、沒有產生測試", !c.runExists("iter-1") && !c.exists("src/test/java/com/x/CalcTest.java"));
  },

  "loop-dirty-new-failure-blocked": (c) => {
    check("新失敗擋下 → exit 2", c.code === 2, `code=${c.code}`);
    check("summary.json 判定失敗", c.result.success === false, JSON.stringify(c.result.stopReason));
    const fb = c.runRead("iter-1/feedback.md");
    check(
      "報告點名 writer 弄壞的那個，而不是只丟一堆既有失敗",
      fb.includes("com.x.OtherTest#broken_by_writer"),
      fb.slice(0, 400),
    );
    // Scoped to the "本輪造成" block itself: the pre-existing failure does appear further down,
    // in the general failure detail, and belongs there — the writer is told to ignore it.
    const blamed = fb.slice(fb.indexOf("本輪造成"), fb.indexOf("錯誤節錄"));
    check(
      "「本輪造成」那一段只列新失敗，既有失敗不該被算進去",
      blamed.includes("broken_by_writer") && !blamed.includes("old_behaviour"),
      blamed,
    );
  },

  "loop-dirty-same-class-new-method-blocked": (c) => {
    check("同類別新方法失敗擋下 → exit 2", c.code === 2, `code=${c.code}`);
    const fb = c.runRead("iter-1/feedback.md");
    check(
      "點名的是新方法，不是整個類別（識別退回類別層級時這條會紅）",
      fb.includes("com.x.LegacyTest#save_rollsBack"),
      fb.slice(0, 400),
    );
    check(
      "同類別裡的既有失敗仍被容忍，沒有一起算帳",
      !fb.includes("com.x.LegacyTest#old_behaviour"),
      fb.slice(0, 400),
    );
  },

  "loop-skip-baseline-conflicts-dirty": (c) => {
    check("兩個旗標並用 → die", c.code === 1, `code=${c.code}`);
    check("訊息說明為什麼互斥", c.stderr.includes("沒有預檢就沒有"), c.stderr.slice(-400));
    check("在建置之前就擋下，沒浪費任何一次 build", c.mvnCalls === 0, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-baseline-env-failure": (c) => {
    check("die 以 exit 1 結束", c.code === 1, `code=${c.code}`);
    check("summary.json 記為 env-failure", c.result.stopReason === "dirty-baseline:env-failure", JSON.stringify(c.result.stopReason));
    check(
      "點名環境問題（context 起不來 / 解密失敗）",
      JSON.stringify(c.result.envFailures ?? []).includes("Spring context"),
      JSON.stringify(c.result.envFailures),
    );
    check(
      "紅燈檔案其實在可寫範圍內（所以 outOfScope 擋不住，要靠這道分類）",
      JSON.stringify(c.result.outOfScope ?? []) === "[]",
      JSON.stringify(c.result.outOfScope),
    );
    check("只建置預檢那一次，沒進修復迴圈", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("完全沒有產生測試", !c.exists("src/test/java/com/x/CalcTest.java"));
    check("訊息給的是環境方向，不是叫人去修測試", c.stderr.includes("環境/設定"), c.stderr.slice(-400));
  },

  "loop-api-503-mid-run": (c) => {
    check("exit code 0——幾秒的 503 不是中止整個 run 的理由", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("不是 runner-spawn-error", c.result.stopReason !== "runner-spawn-error", String(c.result.stopReason));
    check("重試看得見（log 有 N 秒後重試）", /秒後重試/.test(c.stdout), c.stdout.slice(-800));
    check("第 2 輪的測試確實寫入", c.read("src/test/java/com/x/CalcTest.java").includes("variant xxxxxxxxx"));
    check("預檢 + 兩輪 gate 共 3 次建置", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-api-outage-not-spawn-error": (c) => {
    check("不是 runner-spawn-error——端點這個 run 已經回應過", c.result.stopReason !== "runner-spawn-error", String(c.result.stopReason));
    check("判為 writer-no-op", c.result.stopReason === "writer-no-op", String(c.result.stopReason));
    const fb = String(c.result.finalFeedback);
    check("訊息說明 writer session 沒有正常完成", fb.includes("status=timeout"), fb);
    check("訊息不再把人指去 permission / opencode", !fb.includes("permission") && !fb.includes("opencode"), fb);
    check("實際的 HTTP 錯誤印在 log 裡", c.stdout.includes("HTTP 503"), c.stdout.slice(-800));
  },

  "loop-api-context-overflow": (c) => {
    check("exit code 0——context 滿了要縮短對話，不是結束 session", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("log 說明 context 已滿並縮短後重送", /context 已滿/.test(c.stdout), c.stdout.slice(-800));
    check("測試確實產生（writer 沒有在讀完檔之後被砍掉）", c.exists("src/test/java/com/x/CalcTest.java"));
    check("只花一輪", c.result.iterations === 1, String(c.result.iterations));
  },

  "review-spawn-error-aborts": (c) => {
    check("判為 runner-spawn-error", c.result.stopReason === "runner-spawn-error", String(c.result.stopReason));
    check("第 1 輪就停，不把它當 blocker 餵給 writer", c.result.iterations === 1, String(c.result.iterations));
    check("只建置一次", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("funnel 記為 review/spawn-error", gates(c).join(",") === "review/spawn-error", gates(c).join(","));
    check("訊息點名 reviewer", String(c.result.finalFeedback).includes("reviewer"), String(c.result.finalFeedback));
  },

  "loop-api-truncated-write": (c) => {
    check("exit code 0——被 max_tokens 截斷的 write_file 不是 writer 的最終答案", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("第 1 輪就寫出測試", c.result.iterations === 1 && c.exists("src/test/java/com/x/CalcTest.java"), String(c.result.iterations));
    check("log 說明截斷並要求改小步驟", /被截斷/.test(c.stdout), c.stdout.slice(-800));
  },

  "loop-api-gateway-200-error": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("測試確實產生（writer 沒有把閘道錯誤當成完成）", c.exists("src/test/java/com/x/CalcTest.java"));
    check("log 點名閘道錯誤並重試", /upstream request timeout/.test(c.stdout) && /秒後重試/.test(c.stdout), c.stdout.slice(-800));
  },

  "loop-review-think-verdict": (c) => {
    check("exit code 0——<think> 裡的大括號不能讓判決解析失敗", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("summary.json 判定成功且只試一次", c.result.success === true && !c.runExists("iter-1/verdict-attempt-2.json"), JSON.stringify(c.result.stopReason));
  },

  "loop-interface-in-target": (c) => {
    check("exit code 0——interface 沒有程式碼可覆蓋，不能卡住 coverage gate", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    const params = JSON.parse(c.runRead("params.json") || "{}");
    const skipped = JSON.stringify(params.skippedCodeless ?? []);
    check("params.json 記錄略過的 interface", skipped.includes("CalcPort.java"), skipped);
    // listJavaClasses keeps the platform separator: backslashes on Windows.
    const targets = ((params.targetClasses ?? []) as string[]).map((p) => p.replace(/\\/g, "/"));
    check("目標只剩實作類別", JSON.stringify(targets) === JSON.stringify(["src/main/java/com/x/Calc.java"]), JSON.stringify(params.targetClasses));
    check("log 說明為什麼略過", /略過 1 個沒有需要單元測試的程式碼的型別/.test(c.stdout), c.stdout.slice(0, 1500));
  },

  "loop-runner-misconfigured": (c) => {
    check("exit code 非 0", c.code !== 0, `code=${c.code}`);
    check("沒有跑預檢建置（mvn 0 次）", c.mvnCalls === 0, `mvnCalls=${c.mvnCalls}`);
    check(
      "點名缺的兩個設定",
      c.stderr.includes("UT_WRITER_MODEL 未設定") && c.stderr.includes("UT_REVIEWER_MODEL 未設定") && c.stderr.includes("doctor.ts"),
      c.stderr.slice(-1200),
    );
    check("沒有留下 run 目錄（在鎖與 artifacts 之前就中止）", c.runRead("params.json") === "", c.runRead("params.json").slice(0, 200));
  },

  "loop-nothing-to-test-skipped": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    const params = JSON.parse(c.runRead("params.json") || "{}");
    const skipped = (params.skippedCodeless ?? []) as Array<{ cls: string; why: string }>;
    const why = (name: string) => skipped.find((x) => x.cls.replace(/\\/g, "/").endsWith(name))?.why ?? "";
    check(
      "DTO、Spring Boot 進入點、常數類別都略過，各有原因",
      /Lombok/.test(why("UserDto.java")) && /Spring Boot 進入點/.test(why("App.java")) && /常數/.test(why("Codes.java")),
      JSON.stringify(skipped),
    );
    const targets = ((params.targetClasses ?? []) as string[]).map((p) => p.replace(/\\/g, "/"));
    check("目標只剩有邏輯的 Calc", JSON.stringify(targets) === JSON.stringify(["src/main/java/com/x/Calc.java"]), JSON.stringify(params.targetClasses));
    check("只有一批：沒有為略過的類別開 writer session", c.result.batches === undefined && c.runExists("iter-1/prompt.md"));
    check("log 說明略過了哪些", /略過 3 個沒有需要單元測試的程式碼的型別/.test(c.stdout), c.stdout.slice(0, 1500));
  },

  "loop-baseline-env-false-positive": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("不是 dirty-baseline:env-failure", c.result.stopReason !== "dirty-baseline:env-failure", String(c.result.stopReason));
    const repair = c.result.repair as Record<string, unknown> | undefined;
    check("進了修復迴圈且修好", repair?.success === true, JSON.stringify(repair));
    check("預檢摘要沒有把它列為環境問題", !c.runRead("baseline.md").includes("環境/設定問題"), c.runRead("baseline.md"));
  },

  "scope-foreign-ignored-change": (c) => {
    check("最終成功——git-ignored 的 logs/ 變動不是 writer 越界", c.result.success === true, String(c.result.stopReason));
    check("log 說明有哪些檔案被當成別的程序的變動", c.stdout.includes("logs/app.log") && /git-ignored/.test(c.stdout), c.stdout.slice(-1200));
  },

  "scope-ignored-under-src-still-blocked": (c) => {
    check("src/ 底下的檔案即使被 ignore 也照樣擋", c.result.stopReason === "scope-violation", String(c.result.stopReason));
    check("違規清單點名那個設定檔", c.runRead("iter-1/scope-violations.txt").includes("src/main/resources/application-local.yml"));
  },

  "loop-runs-dir-inside-repo": (c) => {
    check("exit code 0——loop 自己寫的 artifacts 不是 writer 越界", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("artifacts 確實落在 repo 內", fs.existsSync(path.join(c.root, "testgen-runs")));
  },

  "loop-repo-lock-held": (c) => {
    check("同一個 repo 已有 testgen 在跑 → 直接拒絕", c.code === 1, `code=${c.code}`);
    check("訊息說明原因與解法", /已有另一個 testgen 在執行/.test(c.stderr) && /worktree/.test(c.stderr), c.stderr.slice(-600));
    check("一次都沒建置", c.mvnCalls === 0, `mvnCalls=${c.mvnCalls}`);
    check("被拒絕的 run 不留下 artifacts 目錄", !fs.existsSync(path.join(c.root, ".itest", "runs")), c.runDir);
  },

  "build-test-failure-ignored": (c) => {
    check("第 1 輪判紅、第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("第 1 輪記為 build/fail", gates(c)[0] === "build/fail", JSON.stringify(gates(c)));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋說明 Maven 以 exit 0 結束是因為 testFailureIgnore", fb.includes("testFailureIgnore") && fb.includes("exit=0"), fb.slice(0, 400));
    check("回饋附上失敗的測試與原因", fb.includes("div_byZero_throwsIllegalArgument") && fb.includes("nothing was thrown"), fb.slice(0, 900));
    check("writer 自己的測試失敗不重跑", c.mvnCalls === 2 && !c.runExists("iter-1/build-rerun.log"), `mvnCalls=${c.mvnCalls}`);
  },

  "build-test-failure-ignored-reports-only": (c) => {
    check("第 1 輪判紅、第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("回饋附上報告裡的錯誤", c.runRead("iter-1/feedback.md").includes("this.calc"), c.runRead("iter-1/feedback.md").slice(0, 600));
  },

  "build-test-failure-ignored-flaky": (c) => {
    check("第 1 輪就通過（重跑轉綠）", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("建置 2 次：exit 0 的紅、重跑綠", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    check("結果點名不穩定的 ExistingTest", JSON.stringify(c.result.flakyTests) === '["com.x.ExistingTest"]', JSON.stringify(c.result.flakyTests));
  },

  "build-flaky-rerun-green": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations, c.result.finalFeedback]));
    check("只建置 1 次（沒被當成紅燈重跑）", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
  },

  "build-fail-never-compile-error": (c) => {
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋說明是 --fail-never", fb.includes("--fail-never"), fb.slice(0, 400));
    check("回饋是編譯錯誤，不是「沒有執行任何測試」", fb.includes("cannot find symbol") && !fb.includes("0 個測試"), fb.slice(0, 600));
  },

  "gradle-test-failure-ignored": (c) => {
    check("第 1 輪判紅、第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations, c.result.crashed]));
    check("跑的是 gradle 的 test 任務，而且強制執行", gradleForced(c.argv[0] ?? []), JSON.stringify(c.argv[0]));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋說明是 ignoreFailures、附上失敗原因", fb.includes("ignoreFailures") && fb.includes("nothing was thrown"), fb.slice(0, 700));
  },

  "build-fail-never-other-plugin-green": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations, c.result.finalFeedback]));
  },

  "build-error-only-custom-reports": (c) => {
    check("第 1 輪判紅、第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    const fb = c.runRead("iter-1/feedback.md");
    check("回饋說明是 testFailureIgnore、附上 NPE", fb.includes("testFailureIgnore") && fb.includes("this.calc"), fb.slice(0, 600));
  },

  "build-flaky-cdata-green": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations, c.result.finalFeedback]));
    check("只建置 1 次（沒被當成紅燈重跑）", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
  },

  "build-own-output-headline-green": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations, c.result.finalFeedback]));
  },

  "build-quiet-upstream-only": (c) => {
    check("沒有通過", c.result.success === false, JSON.stringify([c.result.stopReason, c.result.iterations]));
    const fb = c.runRead("iter-1/feedback.md");
    check("回報目標模組執行了 0 個測試", fb.includes("0 個測試"), fb.slice(0, 400));
  },

  "gradle-retry-passed-green": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations, c.result.finalFeedback]));
  },

  "gradle-up-to-date-failing": (c) => {
    check("第 1 輪判紅、第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations, c.result.crashed]));
    check("回饋附上測試結果裡的失敗", c.runRead("iter-1/feedback.md").includes("nothing was thrown"), c.runRead("iter-1/feedback.md").slice(0, 600));
  },

  "build-quiet-green": (c) => {
    check("第 1 輪就通過", c.result.success === true && c.result.iterations === 1, JSON.stringify([c.result.stopReason, c.result.iterations, c.result.finalFeedback]));
  },

  "build-tests-skipped": (c) => {
    check("沒有通過", c.result.success === false, String(c.result.stopReason));
    const fb = c.runRead("iter-1/feedback.md");
    check("回報說明測試被設定跳過、要設 UT_MAVEN_ARGS", fb.includes("Tests are skipped") && fb.includes("-DskipTests=false"), fb.slice(0, 500));
    check("不叫 writer 去建測試類別", !fb.includes("<ClassName>Test.java"), fb.slice(0, 500));
  },

  "review-unfinished-retried": (c) => {
    check("最終成功", c.result.success === true, String(c.result.stopReason));
    check("只花一輪 writer（沒跑完的 reviewer 不算 writer 的帳）", c.result.iterations === 1, String(c.result.iterations));
    check("reviewer 重試的紀錄留在 artifacts", c.runExists("iter-1/verdict-attempt-2.json"));
  },

  "loop-baseline-killed": (c) => {
    if (process.platform === "win32") return; // no SIGKILL to deliver
    check("中止（exit 1）", c.code === 1, `code=${c.code}`);
    check("stopReason = baseline-aborted", c.result.stopReason === "baseline-aborted", String(c.result.stopReason));
    check("訊息說明建置被 signal 終止", /SIGKILL/.test(c.stderr) && /沒有跑完/.test(c.stderr), c.stderr.slice(-600));
    check("沒有進修復迴圈、也不猜 Lombok", !c.runExists("repair-1/prompt.md") && !/Lombok/.test(c.stderr));
  },

  "repair-resource-fix": (c) => {
    check("修復成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("改過的資源檔列進清單", JSON.stringify(c.result.changedFiles) === JSON.stringify(["resources/expected-total.txt"]), JSON.stringify(c.result.changedFiles));
  },

  "repair-revealed-errors": (c) => {
    check("修復成功（揭露出的紅燈不算沒進展）", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("兩輪修好", c.result.rounds === 2, String(c.result.rounds));
  },

  "repair-thrash-still-stops": (c) => {
    check("判為 repair-no-progress", c.result.stopReason === "repair-no-progress", String(c.result.stopReason));
    check("第 1 輪就停", c.result.rounds === 1, String(c.result.rounds));
  },

  "repair-thrash-via-helper": (c) => {
    check("stopReason = repair-no-progress", c.result.stopReason === "repair-no-progress", String(c.result.stopReason));
    check("第 1 輪就判定（B 用到這輪改過的 helper，不算揭露）", c.result.rounds === 1, String(c.result.rounds));
  },

  "repair-test-failure-swap": (c) => {
    check("stopReason = repair-no-progress", c.result.stopReason === "repair-no-progress", String(c.result.stopReason));
    check("第 1 輪就判定", c.result.rounds === 1, String(c.result.rounds));
  },

  "repair-flaky-baseline": (c) => {
    check("不中止：重跑確認紅燈不穩定", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("stopReason = flaky-baseline", c.result.stopReason === "flaky-baseline", String(c.result.stopReason));
    check("點名不穩定的測試", String(c.result.report).includes("com.x.ExistingTest"), String(c.result.report));
    check("建置 2 次：預檢 + 確認重跑", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
  },

  "repair-crashed-fork": (c) => {
    check("修復成功（Crashed tests 定位到類別）", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("不是 unlocatable-failure", c.result.stopReason !== "unlocatable-failure", String(c.result.stopReason));
  },

  "loop-dirty-repair-broke-green": (c) => {
    check("不是成功——修復 writer 弄壞的測試沒有被放行", c.result.success !== true && c.code !== 0, `code=${c.code} ${String(c.result.stopReason)}`);
    const tol = JSON.stringify(c.result.toleratedFailures ?? []);
    check("容忍集合只有 writer 介入前就失敗的", tol.includes("old_behaviour") && !tol.includes("ExistingTest"), tol);
    check("點名那是本輪之前沒有的新失敗", /新失敗：com\.x\.ExistingTest/.test(c.stdout), c.stdout.slice(-800));
  },

  "loop-dirty-repair-scope-violation": (c) => {
    check("中止（exit code ≠ 0）", c.code !== 0, `code=${c.code}`);
    check("stopReason = repair-failed:scope-violation", c.result.stopReason === "repair-failed:scope-violation", String(c.result.stopReason));
    check("沒有帶著被改過的 production code 進入產生階段", !c.runExists("iter-1/prompt.md"));
    check("只跑了預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("變更留在磁碟交人檢視", c.read("src/main/java/com/x/Calc.java").includes("a + b + 0"));
  },

  "scoped-dtest-keeps-writer-files": (c) => {
    const second = c.argv[1] ?? [];
    const dtest = second.find((a) => a.startsWith("-Dtest=")) ?? "";
    check("第 2 輪的 -Dtest 仍含 writer 第 1 輪寫的 CalcBehaviourTest", dtest.includes("CalcBehaviourTest"), dtest);
    check("最終成功", c.result.success === true, String(c.result.stopReason));
  },

  "loop-teststack-into-prompt": (c) => {
    check("最終成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    const p1 = c.runRead("iter-1/prompt.md");
    check("第 1 輪任務行寫 JUnit 4（不是寫死的 JUnit 5）", p1.includes("撰寫單元測試（JUnit 4）"), p1.slice(0, 200));
    check("第 1 輪：pom 推斷只有 JUnit 4，並標明是推斷", p1.includes("**只有** JUnit 4") && p1.includes("由版本推斷"), p1.slice(0, 1500));
    check("第 1 輪：Java 8 的限制", p1.includes("Java 語言層級：8"));
    const p2 = c.runRead("iter-2/prompt.md");
    check("第 2 輪改用實際 classpath（JUnit 4.13.2 有 assertThrows、Mockito 2 沒有 mockStatic）", p2.includes("測試 classpath 上實際有的東西") && p2.includes("4.13.2") && p2.includes("沒有 mockStatic"), p2.slice(0, 2000));
    check("量測結果落地在 project-facts.json", c.runRead("project-facts.json").includes("junit4"));
  },

  "loop-encoding-platform-ms950": (c) => {
    check("最終成功", c.result.success === true && c.code === 0, `${String(c.result.stopReason)} code=${c.code}`);
    check("量到 MS950（來自 Maven 的平台編碼警告）", c.runRead("project-facts.json").includes("MS950"), c.runRead("project-facts.json"));
    const p1 = c.runRead("iter-1/prompt.md");
    check(
      "prompt 說明 \\uXXXX 是同一個字、不是亂碼，中文可以直接寫",
      p1.includes("MS950") && p1.includes("不是亂碼") && p1.includes("可以直接寫") && !p1.includes("不能修改"),
      p1.slice(0, 2500),
    );
    check(
      "目標類別的原始碼以 MS950 解碼、寫成 \\uXXXX 附在 prompt（工具直接讀會是亂碼）",
      p1.includes('<source path="src/main/java/com/x/Calc.java">') && p1.includes("// \\u8a08\\u7b97"),
      p1.slice(0, 3000),
    );
    check(
      "writer 讀到的既有測試是 \\uXXXX 形式，不是亂碼",
      c.read(".itest/api-requests.jsonl").includes("\\\\u4e2d\\\\u6587") && !c.read(".itest/api-requests.jsonl").includes("\\ufffd"),
    );
    const raw = fs.readFileSync(path.join(c.root, "src/test/java/com/x/ExistingTest.java"));
    const big5 = new TextDecoder("big5");
    check("ExistingTest.java：writer 沒改的中文那行維持 MS950 原 bytes", raw.includes(Buffer.from([0x2f, 0x2f, 0x20, 0xa4, 0xa4, 0xa4, 0xe5])));
    check(
      "ExistingTest.java：writer 補的中文以 MS950 存（沒有殘留 \\uXXXX、沒有 UTF-8）",
      big5.decode(raw).includes("// 補一個測試") && !raw.includes(Buffer.from("\\u")) && !raw.includes(Buffer.from("補一個測試")),
      raw.toString("latin1").slice(-160),
    );
    const calc = fs.readFileSync(path.join(c.root, "src/test/java/com/x/CalcTest.java"));
    check("CalcTest.java：writer 寫的中文以 MS950 存", big5.decode(calc).startsWith("// 準備資料\n") && !calc.includes(Buffer.from("準備資料")));
    const requests = c.read(".itest/api-requests.jsonl").split("\n").filter(Boolean);
    check(
      "reviewer 讀到的也是 \\uXXXX 形式——包括 writer 剛補、已存成 MS950 的那行",
      requests.some((r) => !r.includes('"write_file"') && r.includes("\\\\u88dc\\\\u4e00\\\\u500b\\\\u6e2c\\\\u8a66")),
    );
    check("review prompt 說明 \\uXXXX 是 pipeline 的跳脫", c.runRead("iter-1/review-prompt.md").includes("不要因此扣"));
    check("建置 2 次：預檢 + 第 1 輪", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-encoding-no-jdk": (c) => {
    if (process.platform === "win32") return;
    check("最終成功", c.result.success === true && c.code === 0, `${String(c.result.stopReason)} code=${c.code}\n${c.stderr.slice(-400)}`);
    const p1 = c.runRead("iter-1/prompt.md");
    check(
      "prompt：找不到 JDK → 只用 ASCII，並點名不能改的 ExistingTest.java",
      p1.includes("MS950") && p1.includes("只用 ASCII") && p1.includes("不能修改") && p1.includes("ExistingTest.java"),
      p1.slice(0, 2500),
    );
    check("第 1 輪：改壞的 MS950 檔已還原、該輪判 FAIL 不建置", c.runRead("iter-1/encoding-report.txt").includes("ExistingTest.java"));
    const raw = fs.readFileSync(path.join(c.root, "src/test/java/com/x/ExistingTest.java"));
    check("ExistingTest.java 仍是原本的 MS950 bytes", raw.includes(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])) && !raw.includes(Buffer.from("補一個測試")));
    const calc = fs.readFileSync(path.join(c.root, "src/test/java/com/x/CalcTest.java"));
    check("CalcTest.java 全是 ASCII，中文成了 \\uXXXX", [...calc].every((b) => b < 0x80) && calc.toString().includes("\\u6e96\\u5099"), calc.toString().slice(0, 120));
    check("第 2 輪的 prompt 帶著還原報告", c.runRead("iter-2/prompt.md").includes("已還原成原本的內容"));
    check("建置 2 次：預檢 + 第 2 輪（第 1 輪沒進建置）", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-encoding-replacement-char": (c) => {
    check("最終成功", c.result.success === true, String(c.result.stopReason));
    check("第 2 輪：writer 寫進 U+FFFD → 點名檔案、不進建置", c.runRead("iter-2/encoding-report.txt").includes("CalcTest.java") && c.runRead("iter-2/encoding-report.txt").includes("U+FFFD"));
    const fb = c.runRead("iter-2/feedback.md");
    check("餵回的報告連同第 1 輪還沒修的 gate 報告（不只剩編碼問題）", fb.includes("U+FFFD") && fb.includes("上一輪 gate 的失敗報告") && fb.includes("CalcTest"), fb.slice(0, 800));
    check("建置 3 次：預檢 + 第 1 輪 + 第 3 輪", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-encoding-learned-from-build": (c) => {
    check("最終成功", c.result.success === true, String(c.result.stopReason));
    const first = c.runRead("iter-1/prompt.md");
    check("第 1 輪只看得出不是 UTF-8：保守做法（只寫 ASCII），不說是 MS950", !first.includes("MS950") && first.includes("不是 UTF-8") && first.includes("只用 ASCII"), first.slice(0, 2500));
    check("第 2 輪：第 1 輪建置的 log 說了 MS950 → prompt 改用 MS950 的說明", c.runRead("iter-2/prompt.md").includes("MS950"), c.runRead("iter-2/prompt.md").slice(0, 400));
    const calc = fs.readFileSync(path.join(c.root, "src/test/java/com/x/CalcTest.java"));
    check("第 2 輪 writer 寫的中文以 MS950 存", new TextDecoder("big5").decode(calc).startsWith("// 兩數相加\n") && !calc.includes(Buffer.from("兩數相加")));
  },

  "loop-encoding-external-parent-utf8": (c) => {
    check("最終成功", c.result.success === true && c.code === 0, `${String(c.result.stopReason)} code=${c.code}\n${c.stderr.slice(-400)}`);
    check("量不到編碼設定、原始碼是 UTF-8 → 當成 UTF-8（不拿 JDK 預設編碼猜）", JSON.parse(c.runRead("project-facts.json") || "{}").sourceEncoding === null, c.runRead("project-facts.json"));
    check("prompt 沒有編碼的段落", !c.runRead("iter-1/prompt.md").includes("不是 UTF-8"));
    const existing = fs.readFileSync(path.join(c.root, "src/test/java/com/x/ExistingTest.java"), "utf8");
    const calc = fs.readFileSync(path.join(c.root, "src/test/java/com/x/CalcTest.java"), "utf8");
    check("writer 的中文照樣是 UTF-8（沒有被存成別的編碼）", existing.includes("// 中文") && existing.includes("補一個測試") && calc.startsWith("// 準備資料"));
  },

  "loop-encoding-sniffed-external": (c) => {
    check("最終成功", c.result.success === true && c.code === 0, `${String(c.result.stopReason)} code=${c.code}\n${c.stderr.slice(-400)}`);
    check("量到「設定不在 repo 裡、原始碼不是 UTF-8」", c.runRead("project-facts.json").includes('"sniffed"'), c.runRead("project-facts.json"));
    const p1 = c.runRead("iter-1/prompt.md");
    check(
      "prompt：看不出是哪一種編碼 → 只用 ASCII，點名不能改的 ExistingTest.java",
      p1.includes("不是 UTF-8") && p1.includes("看不出") && p1.includes("只用 ASCII") && p1.includes("不能修改") && p1.includes("ExistingTest.java"),
      p1.slice(0, 2500),
    );
    check("第 1 輪：被改壞的既有檔還原、該輪判 FAIL 不建置", c.runRead("iter-1/encoding-report.txt").includes("ExistingTest.java"));
    const raw = fs.readFileSync(path.join(c.root, "src/test/java/com/x/ExistingTest.java"));
    check("ExistingTest.java 仍是原本的 bytes", raw.includes(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])) && !raw.includes(Buffer.from("補一個測試")));
    const calc = fs.readFileSync(path.join(c.root, "src/test/java/com/x/CalcTest.java"));
    check("CalcTest.java 全是 ASCII，中文成了 \\uXXXX", [...calc].every((b) => b < 0x80) && calc.toString().includes("\\u6e96\\u5099"), calc.toString().slice(0, 120));
  },

  "loop-encoding-interrupted": (c) => {
    if (process.platform === "win32") return;
    check("exit code 130（SIGINT）", c.code === 130, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("stopReason = interrupted:SIGINT", c.result.stopReason === "interrupted:SIGINT", String(c.result.stopReason));
    const big5 = new TextDecoder("big5");
    const raw = fs.readFileSync(path.join(c.root, "src/test/java/com/x/ExistingTest.java"));
    check(
      "ExistingTest.java：沒改的行維持 MS950 原 bytes、writer 補的行以 MS950 存——不是留在 \\uXXXX 形式",
      raw.includes(Buffer.from([0x2f, 0x2f, 0x20, 0xa4, 0xa4, 0xa4, 0xe5])) && big5.decode(raw).includes("// 補一個測試") && !raw.includes(Buffer.from("\\u")),
      raw.toString("latin1").slice(-200),
    );
    const calc = fs.readFileSync(path.join(c.root, "src/test/java/com/x/CalcTest.java"));
    check("CalcTest.java：writer 寫的中文以 MS950 存", big5.decode(calc).startsWith("// 準備資料\n") && !calc.includes(Buffer.from("準備資料")));
  },

  "loop-encoding-no-op-round": (c) => {
    check("第 2 輪 writer 沒改任何檔 → writer-no-op", c.result.stopReason === "writer-no-op", String(c.result.stopReason));
    check("建置 2 次：預檢 + 第 1 輪（沒有為一輪沒有變更的修正再建置一次）", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    check("既有的 MS950 檔維持原樣", fs.readFileSync(path.join(c.root, "src/test/java/com/x/ExistingTest.java")).includes(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])));
  },

  "loop-repair-ms950": (c) => {
    check("最終成功", c.result.success === true && c.code === 0, `${String(c.result.stopReason)} code=${c.code}\n${c.stderr.slice(-400)}`);
    const repair = c.result.repair as Record<string, unknown> | undefined;
    check("修復成功（MS950 檔不再是「不能改」）", repair?.success === true, JSON.stringify(repair));
    const raw = fs.readFileSync(path.join(c.root, "src/test/java/com/x/BrokenTest.java"));
    check(
      "BrokenTest.java：中文那行維持原本的 MS950 bytes，其餘是修好的內容",
      raw.subarray(0, 8).equals(Buffer.from([0x2f, 0x2f, 0x20, 0xa4, 0xa4, 0xa4, 0xe5, 0x0a])) && raw.subarray(8).toString("latin1") === FIXED_TEST_TEXT,
      raw.toString("latin1").slice(0, 200),
    );
  },

  "loop-batches-isolate-failure": (c) => {
    check("exit code 2（有一批沒過）", c.code === 2, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("stopReason = some-batches-failed", c.result.stopReason === "some-batches-failed", String(c.result.stopReason));
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check(
      "兩批都跑了：第 1 批失敗（writer-no-op）、第 2 批通過",
      b.length === 2 && b[0].success === false && b[0].stopReason === "writer-no-op" && b[1].success === true,
      JSON.stringify(b.map((x) => [x.stopReason, x.success])),
    );
    check("失敗那批新增的 CalcTest.java 已移出 src/test", !c.exists("src/test/java/com/x/CalcTest.java"));
    check("失敗那批改過的 ExistingTest.java 還原成原本的內容", c.read("src/test/java/com/x/ExistingTest.java") === EXISTING_TEST);
    check(
      "嘗試的版本依 repo 相對路徑保留在 rejected/",
      c.runExists("batch-1-Calc/rejected/src/test/java/com/x/CalcTest.java") &&
        c.runRead("batch-1-Calc/rejected/src/test/java/com/x/ExistingTest.java").includes("touched an existing test"),
    );
    check("rollback.md 列出撤回的檔案", c.runRead("batch-1-Calc/rollback.md").includes("CalcTest.java"), c.runRead("batch-1-Calc/rollback.md"));
    check("第 2 批的測試留在 src/test", c.exists("src/test/java/com/x/GreeterTest.java"));
    const p2 = c.runRead("batch-2-Greeter/iter-1/prompt.md");
    check("每批各自的 prompt 只含自己的類別", p2.includes("Greeter.java") && !p2.includes("Calc.java"), p2.slice(0, 600));
    check("建置 3 次：預檢 + 第 1 批 + 第 2 批", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    check("逐批進度落地在 batches.json", c.runRead("batches.json").includes("Greeter.java"));
    check("兩批都結束了（一批撤回、一批通過）：沒有留下復原日誌", !c.runExists("batch-1-Calc/inflight") && !c.runExists("batch-2-Greeter/inflight"));
  },

  "loop-batches-all-pass": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("summary 判定成功", c.result.success === true && c.result.stopReason === "gates-passed", String(c.result.stopReason));
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check("兩批都通過、都沒有撤回", b.length === 2 && b.every((x) => x.success === true && !x.rolledBack), JSON.stringify(b));
    check("兩個測試檔都在", c.exists("src/test/java/com/x/CalcTest.java") && c.exists("src/test/java/com/x/GreeterTest.java"));
    check("沒有 rejected 目錄", !c.runExists("batch-1-Calc/rejected") && !c.runExists("batch-2-Greeter/rejected"));
    check("通過的批次不留復原日誌", !c.runExists("batch-1-Calc/inflight") && !c.runExists("batch-2-Greeter/inflight"));
    const params = JSON.parse(c.runRead("params.json") || "{}");
    check("params.json 記錄 batchSize", params.batchSize === 1, String(params.batchSize));
  },

  "loop-dirty-flaky-not-tolerated": (c) => {
    check("exit code 0（扣除容忍的紅燈、重跑後放行）", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("建置 3 次：預檢、紅、重跑", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    check(
      "只列 ExistingTest 為不穩定，被容忍、一直失敗的 LegacyTest 不列",
      JSON.stringify(c.result.flakyTests) === '["com.x.ExistingTest"]',
      JSON.stringify(c.result.flakyTests),
    );
  },

  "loop-dirty-flaky-method": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("點名 LegacyTest 不穩定（它的一個方法失敗一次、重跑就過）", JSON.stringify(c.result.flakyTests) === '["com.x.LegacyTest"]', JSON.stringify(c.result.flakyTests));
  },

  "loop-flaky-single-summary": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check(
      "SUMMARY 以 WARN 點名要人檢視",
      c.stdout.includes("[WARN] 需要人工處理：這些測試不穩定（建置失敗、重跑通過）：com.x.ExistingTest"),
      c.stdout.slice(-900),
    );
    check("summary.json 記下 flakyTests", JSON.stringify(c.result.flakyTests) === '["com.x.ExistingTest"]', JSON.stringify(c.result.flakyTests));
  },

  "loop-batches-flaky-attention": (c) => {
    check("exit code 0，兩批都通過", c.code === 0 && c.result.stopReason === "gates-passed", `code=${c.code} ${String(c.result.stopReason)}`);
    const attention = (c.result.attention ?? []) as string[];
    check(
      "attention 點名第 1 批遇到的不穩定測試",
      attention.some((a) => a === "第 1 批遇到不穩定的測試（建置失敗、重跑通過）：com.x.ExistingTest"),
      JSON.stringify(attention),
    );
    const batches = (c.result.batches ?? []) as Array<{ flakyTests?: string[] }>;
    check(
      "第 1 批的紀錄有 flakyTests、第 2 批沒有",
      JSON.stringify(batches[0]?.flakyTests) === '["com.x.ExistingTest"]' && batches[1]?.flakyTests === undefined,
      JSON.stringify(batches.map((b) => b.flakyTests)),
    );
    check("SUMMARY 也印出來", c.stdout.includes("需要人工處理：第 1 批遇到不穩定的測試"), c.stdout.slice(-900));
  },

  "loop-batch-size-covers-all": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("單一一批：summary 沒有 batches、artifacts 在 run 目錄最上層", c.result.batches === undefined && c.runExists("iter-1/prompt.md"));
    const p = c.runRead("iter-1/prompt.md");
    check("同一個 prompt 含兩個類別", p.includes("Calc.java") && p.includes("Greeter.java"));
  },

  "loop-batches-repeat-no-op-stops": (c) => {
    check("停在第 2 批：stopReason = stopped:writer-no-op", c.result.stopReason === "stopped:writer-no-op", String(c.result.stopReason));
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check("只跑了兩批", b.length === 2, String(b.length));
    const notRun = JSON.stringify(c.result.notRun ?? []);
    check("第 3 個類別列在 notRun", notRun.includes("Zeta.java"), notRun);
    check("說明為什麼停", c.stdout.includes("連續兩批"), c.stdout.slice(-800));
    check("exit code 2", c.code === 2, `code=${c.code}`);
  },

  "loop-batches-spawn-error-stops": (c) => {
    check("stopReason = stopped:runner-spawn-error", c.result.stopReason === "stopped:runner-spawn-error", String(c.result.stopReason));
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check("只跑了第 1 批", b.length === 1, String(b.length));
    check("Greeter 列在 notRun", JSON.stringify(c.result.notRun ?? []).includes("Greeter.java"));
    check("只有預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-batches-scope-violation-stops": (c) => {
    check("stopReason = stopped:scope-violation", c.result.stopReason === "stopped:scope-violation", String(c.result.stopReason));
    check("不撤回：writer 寫的測試檔原樣留著", c.exists("src/test/java/com/x/CalcTest.java"));
    check("production 的變更留在磁碟交人檢視", c.read("src/main/java/com/x/Calc.java").includes("a + b + 0"));
    check("後面的批次不跑", JSON.stringify(c.result.notRun ?? []).includes("Greeter.java"));
    check("只有預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
    check("summary 的 attention 點名沒還原的範圍外變更", JSON.stringify(c.result.attention ?? []).includes("範圍以外"), JSON.stringify(c.result.attention));
  },

  "loop-batches-outputs-removed": (c) => {
    check("exit code 2（第 1 批沒過）", c.code === 2, `code=${c.code}\n${c.stdout.slice(-600)}`);
    const b = (c.result.batches ?? []) as Array<Record<string, any>>;
    check(
      "第 2 批沒被第 1 批留下的 CalcTest.class 拖垮：通過",
      b.length === 2 && b[0].success === false && b[1].success === true,
      JSON.stringify(b.map((x) => [x.stopReason, x.success])),
    );
    check(
      "撤回時清掉這批留在 target/test-classes 的類別（含 nested）與複製過去的 MockMaker",
      !c.exists("target/test-classes/com/x/CalcTest.class") &&
        !c.exists("target/test-classes/com/x/CalcTest$Nested.class") &&
        !c.exists("target/test-classes/mockito-extensions/org.mockito.plugins.MockMaker"),
    );
    check("run 之前就在的輸出留著", c.exists("target/test-classes/com/x/ExistingTest.class"));
    check("src/test 的 MockMaker 開關一併撤回", !c.exists("src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker"));
    check(
      "撤回紀錄寫明清掉的輸出數",
      b[0]?.rolledBack?.outputsRemoved === 3 && c.runRead("batch-1-Calc/rollback.md").includes("建置輸出"),
      JSON.stringify(b[0]?.rolledBack),
    );
  },

  "loop-batches-interrupted": (c) => {
    if (process.platform === "win32") return; // the fake build signals the loop by its pid
    check("exit code 130（SIGINT）", c.code === 130, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("stopReason = interrupted:SIGINT", c.result.stopReason === "interrupted:SIGINT", String(c.result.stopReason));
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check("完成的第 1 批留在紀錄裡", b.length === 1 && b[0].success === true, JSON.stringify(b.map((x) => [x.stopReason, x.success])));
    const ip = c.result.inProgress as Record<string, any> | undefined;
    check(
      "中斷的是第 2 批，它的 GreeterTest.java 比照失敗批次撤回",
      ip?.batch === 2 && JSON.stringify(ip?.rolledBack?.created ?? []).includes("GreeterTest.java"),
      JSON.stringify(ip),
    );
    check("src/test 只留通過 gate 的測試", c.exists("src/test/java/com/x/CalcTest.java") && !c.exists("src/test/java/com/x/GreeterTest.java"));
    check("中斷那批的嘗試保留在 rejected/", c.runExists("batch-2-Greeter/rejected/src/test/java/com/x/GreeterTest.java"));
    check("中斷那批已經撤回：它的復原日誌刪掉", !c.runExists("batch-2-Greeter/inflight") && !c.runExists("batch-1-Calc/inflight"));
    check(
      "被中斷時收掉了建置：子程序紀錄是空的（下一次執行不必再找）",
      JSON.parse(c.runRead("children.json") || '{"children":["missing"]}').children.length === 0,
      c.runRead("children.json"),
    );
    check("沒跑的 Zeta 列在 notRun", JSON.stringify(c.result.notRun ?? []).includes("Zeta.java"), JSON.stringify(c.result.notRun));
  },

  "loop-batches-own-crashes-continue": (c) => {
    check("exit code 2（有批次失敗）", c.code === 2, `code=${c.code}\n${c.stdout.slice(-600)}`);
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check(
      "三批都跑了，沒有提前停止（stopReason 不是 stopped:）",
      b.length === 3 && c.result.stopReason === "some-batches-failed",
      JSON.stringify([c.result.stopReason, b.map((x) => [x.stopReason, x.success])]),
    );
    check("建置 4 次：預檢 + 三批", c.mvnCalls === 4, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-batches-foreign-change-kept": (c) => {
    const b = (c.result.batches ?? []) as Array<Record<string, any>>;
    check("第 1 批失敗、第 2 批通過", b.length === 2 && b[0].success === false && b[1].success === true, JSON.stringify(b.map((x) => [x.stopReason, x.success])));
    check("writer 寫的 CalcTest.java 撤回了", !c.exists("src/test/java/com/x/CalcTest.java"));
    check("測試在建置時寫的檔留著", c.exists("src/test/resources/approvals/Calc.received.txt"));
    check(
      "撤回報告把它列為不是 writer 做的變更",
      JSON.stringify(b[0].rolledBack?.foreign ?? []).includes("approvals/Calc.received.txt") &&
        JSON.stringify(c.result.attention ?? []).includes("不是 writer 做的變更"),
      JSON.stringify([b[0].rolledBack, c.result.attention]),
    );
  },

  "loop-batches-crash-mid-batch": (c) => {
    check("exit code 非 0", c.code !== 0, `code=${c.code}`);
    check("summary 記 crash", c.result.stopReason === "crash", String(c.result.stopReason));
    const p = (c.result.inProgress ?? {}) as Record<string, any>;
    check(
      "當掉時正在跑的第 1 批撤回了",
      p.batch === 1 && JSON.stringify(p.rolledBack?.created ?? []).includes("CalcTest.java") && !c.exists("src/test/java/com/x/CalcTest.java"),
      JSON.stringify(p),
    );
    check("沒執行的類別列在 notRun", JSON.stringify(c.result.notRun ?? []).includes("Greeter.java"), JSON.stringify(c.result.notRun));
  },

  "loop-batches-repeated-build-failure": (c) => {
    check("exit code 2", c.code === 2, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check(
      "stopReason = stopped:repeated-build-failure",
      c.result.stopReason === "stopped:repeated-build-failure",
      String(c.result.stopReason),
    );
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check(
      "跑了兩批、都失敗，第 3 批沒跑",
      b.length === 2 && b.every((x) => x.success === false) && JSON.stringify(c.result.notRun ?? []).includes("Zeta.java"),
      JSON.stringify(b.map((x) => [x.stopReason, x.success])),
    );
    check("建置 3 次：預檢 + 兩批", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    check("停止的原因寫進 summary", String(c.result.stopMessage ?? "").includes("同樣的原因"), String(c.result.stopMessage));
  },

  "loop-batches-distinct-failures-continue": (c) => {
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check("三批都跑了", b.length === 3, JSON.stringify(b.map((x) => [x.stopReason, x.success])));
    check("stopReason = some-batches-failed（不是 stopped:）", c.result.stopReason === "some-batches-failed", String(c.result.stopReason));
  },

  "loop-batches-coverage-failures-continue": (c) => {
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check("三批都跑了", b.length === 3, JSON.stringify(b.map((x) => [x.stopReason, x.success])));
    check("stopReason = some-batches-failed", c.result.stopReason === "some-batches-failed", String(c.result.stopReason));
  },

  "loop-batches-rollback-failed": (c) => {
    if (process.platform === "win32") return; // no named pipes
    check("exit code 2", c.code === 2, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("stopReason = stopped:rollback-failed", c.result.stopReason === "stopped:rollback-failed", String(c.result.stopReason));
    const attention = JSON.stringify(c.result.attention ?? []);
    check("summary 的 attention 點名放不回去的 ExistingTest.java", attention.includes("ExistingTest.java"), attention);
    check(
      "第 2 批沒有在不完整的樹上跑",
      c.mvnCalls === 2 && JSON.stringify(c.result.notRun ?? []).includes("Greeter.java"),
      `mvnCalls=${c.mvnCalls} notRun=${JSON.stringify(c.result.notRun)}`,
    );
    check("其餘照樣撤回：CalcTest.java 已移出", !c.exists("src/test/java/com/x/CalcTest.java"));
  },

  "loop-batches-interrupt-mid-writer": (c) => {
    if (process.platform === "win32") return; // the fake endpoint signals the loop by its pid
    check("exit code 130（SIGINT）", c.code === 130, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("stopReason = interrupted:SIGINT", c.result.stopReason === "interrupted:SIGINT", String(c.result.stopReason));
    const ip = (c.result.inProgress ?? {}) as Record<string, any>;
    const rb = ip.rolledBack ?? {};
    check(
      "session 還沒結束就被中斷：它建的 CalcTest.java 與改的 ExistingTest.java 都算 writer 的，照樣撤回",
      ip.batch === 1 && JSON.stringify(rb.created ?? []).includes("CalcTest.java") && JSON.stringify(rb.restored ?? []).includes("ExistingTest.java"),
      JSON.stringify(ip),
    );
    check("沒有被當成「不是 writer 做的變更」留著", !(rb.foreign ?? []).length, JSON.stringify(rb.foreign));
    check(
      "src/test 回到 run 之前",
      !c.exists("src/test/java/com/x/CalcTest.java") && c.read("src/test/java/com/x/ExistingTest.java") === EXISTING_TEST,
    );
  },

  "loop-batches-writer-401-mid-session": (c) => {
    check("stopReason = stopped:runner-spawn-error", c.result.stopReason === "stopped:runner-spawn-error", String(c.result.stopReason));
    const b = (c.result.batches ?? []) as Array<Record<string, any>>;
    check(
      "session 失敗前寫的 CalcTest.java 算 writer 的，撤回",
      b.length === 1 && JSON.stringify(b[0].rolledBack?.created ?? []).includes("CalcTest.java") && !(b[0].rolledBack?.foreign ?? []).length,
      JSON.stringify(b.map((x) => [x.stopReason, x.rolledBack])),
    );
    check("CalcTest.java 已移出 src/test", !c.exists("src/test/java/com/x/CalcTest.java"));
    check("只有預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-batches-crash-after-writer": (c) => {
    check("exit code 非 0", c.code !== 0, `code=${c.code}`);
    check("summary 記 crash", c.result.stopReason === "crash", String(c.result.stopReason));
    const p = (c.result.inProgress ?? {}) as Record<string, any>;
    check(
      "當掉時 writer 已寫的 CalcTest.java 撤回，不是當成別人的變更留著",
      p.batch === 1 && JSON.stringify(p.rolledBack?.created ?? []).includes("CalcTest.java") && !(p.rolledBack?.foreign ?? []).length,
      JSON.stringify(p),
    );
    check("CalcTest.java 已移出 src/test", !c.exists("src/test/java/com/x/CalcTest.java"));
    check("沒有建置過（當在建置之前）", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-batches-repeated-env-failure": (c) => {
    check("exit code 2", c.code === 2, `code=${c.code}\n${c.stdout.slice(-600)}`);
    check("stopReason = stopped:repeated-env-failure", c.result.stopReason === "stopped:repeated-env-failure", String(c.result.stopReason));
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check("跑了兩批、都失敗", b.length === 2 && b.every((x) => x.success === false), JSON.stringify(b.map((x) => [x.stopReason, x.success])));
    check("第 3 批沒跑，列在 notRun", JSON.stringify(c.result.notRun ?? []).includes("Zeta.java"), JSON.stringify(c.result.notRun));
    check("建置 3 次：預檢 + 兩批", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    check("停止的原因點名環境問題", String(c.result.stopMessage ?? "").includes("Spring context"), String(c.result.stopMessage));
  },

  "loop-batches-protect-earlier": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check(
      "兩批都通過，第 2 批花了兩輪",
      b.length === 2 && b.every((x) => x.success === true) && b[1].iterations === 2,
      JSON.stringify(b.map((x) => [x.stopReason, x.success, x.iterations])),
    );
    const fb = c.runRead("batch-2-Greeter/iter-1/feedback.md");
    check(
      "第 2 批第 1 輪：綠燈但第 1 批建立的 CalcTest 沒被執行 → FAIL，回饋點名它",
      fb.includes("com.x.CalcTest") && fb.includes("writer 介入前有被執行"),
      fb.slice(0, 800),
    );
    check("兩個測試檔都在、filter 已清空", c.exists("src/test/java/com/x/CalcTest.java") && c.exists("src/test/java/com/x/GreeterTest.java"));
  },

  "loop-batches-protect-earlier-scoped": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stdout.slice(-600)}`);
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check(
      "兩批都通過，第 2 批花了兩輪",
      b.length === 2 && b.every((x) => x.success === true) && b[1].iterations === 2,
      JSON.stringify(b.map((x) => [x.stopReason, x.success, x.iterations])),
    );
    const fb = c.runRead("batch-2-Greeter/iter-1/feedback.md");
    check("第 2 批第 1 輪的最終驗收點名第 1 批的 CalcTest 沒被執行", fb.includes("com.x.CalcTest") && fb.includes("有該執行的測試沒有被執行"), fb.slice(0, 800));
    check("建置 7 次：預檢 + 第 1 批 2 次 + 第 2 批 4 次", c.mvnCalls === 7, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-dirty-target-skipped": (c) => {
    check("die 以 exit 1 結束", c.code === 1, `code=${c.code}\n${c.stdout.slice(-400)}`);
    check("說明目標模組根本沒被建置", c.stderr.includes("根本沒有被建置"), c.stderr.slice(-600));
    check("只跑了預檢那一次建置", c.mvnCalls === 1, `mvnCalls=${c.mvnCalls}`);
  },

  "repair-abstract-refused": (c) => {
    check("最終修好", c.result.success === true, JSON.stringify(c.result.stopReason));
    check("花了 2 輪", c.result.rounds === 2, String(c.result.rounds));
    check("改成 abstract 那輪沒有建置（預檢 1 次 + 第 2 輪 1 次）", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
    const report = c.runRead("repair-1/test-shrink.txt");
    check("刪減報告點名會自己執行的 @Test 變少", report.includes("會自己執行的 @Test 2 → 0"), report);
  },

  "repair-no-runnable-methods": (c) => {
    check("一輪修好", c.result.success === true && c.result.rounds === 1, JSON.stringify([c.result.stopReason, c.result.rounds]));
    check("stopReason = repaired", c.result.stopReason === "repaired", String(c.result.stopReason));
    check("改成 abstract 的基底類別不要求被執行", !c.runExists("repair-1/feedback.md"), c.runRead("repair-1/feedback.md").slice(0, 400));
  },

  "repair-framework-switch-no-op": (c) => {
    check("不成功", c.result.success === false, JSON.stringify(c.result.stopReason));
    check(
      "stopReason = writer-no-op（「沒被執行」重建也不會變，不是 flaky）",
      c.result.stopReason === "writer-no-op",
      String(c.result.stopReason),
    );
    check("沒有為了確認 flaky 重跑建置（預檢 + 第 1 輪）", c.mvnCalls === 2, `mvnCalls=${c.mvnCalls}`);
  },

  "repair-flaky-hides-switch": (c) => {
    check("不成功", c.result.success === false, JSON.stringify(c.result.stopReason));
    check("stopReason = writer-no-op（不是 flaky-baseline）", c.result.stopReason === "writer-no-op", String(c.result.stopReason));
    check("確實重跑了一次：預檢 + 第 1 輪 + 確認重跑", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    check("確認重跑的 log 落地", c.runExists("repair-2/recheck-build.log"));
    check(
      "停止的原因帶出重跑發現的事：改寫成 TestNG 的 ExistingTest 沒被執行",
      String(c.result.report).includes("com.x.ExistingTest") && String(c.result.report).includes("沒有真的被執行"),
      String(c.result.report).slice(0, 800),
    );
    check("remaining 是重跑後的狀態", JSON.stringify(c.result.remaining).includes("com.x.ExistingTest"), JSON.stringify(c.result.remaining));
  },

  "tests-not-run-grown": (c) => {
    check("第 2 輪才通過", c.result.success === true && c.result.iterations === 2, JSON.stringify([c.result.stopReason, c.result.iterations]));
    check("第 1 輪記在 build gate", gates(c)[0] === "build/fail", gates(c).join(","));
    const fb = c.runRead("iter-1/feedback.md");
    check(
      "回饋點名加了測試卻沒被執行的既有類別",
      fb.includes("com.x.ExistingTest") && fb.includes("加在這裡的測試不會被執行"),
      fb.slice(0, 800),
    );
  },

  "loop-repair-then-generate": (c) => {
    check("exit code 0", c.code === 0, `code=${c.code}\n${c.stderr.slice(-400)}`);
    check("summary.json 判定成功", c.result.success === true, JSON.stringify(c.result.stopReason));
    const repair = c.result.repair as Record<string, unknown> | undefined;
    check("summary.json 內含修復結果", repair?.success === true, JSON.stringify(repair));
    check("repair-summary.md 列出改過的檔", c.runRead("repair-summary.md").includes("BrokenTest.java"), c.runRead("repair-summary.md"));
    check("先修復後產生：修復輪先於 iter-1", c.runExists("repair-1/prompt.md") && c.runExists("iter-1/prompt.md"));
    check("建置 3 次：預檢 + 修復驗證 + gate", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
    check("新測試確實產生", c.exists("src/test/java/com/x/CalcTest.java"));
  },

  // ── Resuming an earlier run ────────────────────────────────────────────────
  "loop-resume-all-passed": (c) => {
    resumedCalc(c);
    check("不再找 agent（重跑沒有任何 api 請求）", apiRequests(c).length === 0, apiRequests(c).join("\n").slice(0, 400));
  },

  "loop-resume-review-passed": (c) => {
    resumedCalc(c);
    check("不再找 writer 與 reviewer", apiRequests(c).length === 0, apiRequests(c).join("\n").slice(0, 400));
    check("說明 review 分數以現在的門檻重新判定過", c.stdout.includes("review 分數以現在的門檻重新判定"), c.stdout.slice(-800));
    const e = ledgerOf(c.first?.runDir ?? "").find((x) => x.cls === "src/main/java/com/x/Calc.java");
    check("第一次的通過紀錄留下 reviewer 的分數", e?.verdict?.scores?.effectiveness === 8, JSON.stringify(e?.verdict));
  },

  "loop-resume-stale-report-strict": (c) => redone(c, "覆蓋率重新量測沒有通過：（"),
  "loop-resume-stale-report-loose": (c) => {
    resumedCalc(c);
    check("沒有這次的報告就不說覆蓋率重新量過", c.stdout.includes("沒有這次建置的 JaCoCo 報告") && !c.stdout.includes("重新量過"), c.stdout.slice(-800));
  },
  "loop-resume-ran-unknown": (c) => redone(c, "這次的預檢建置認不出執行了哪些測試類別"),
  "loop-resume-own-test-name": (c) => {
    resumedCalc(c, "src/test/java/com/x/CalcBehaviourTest.java");
    check("不再找 agent", apiRequests(c).length === 0, apiRequests(c).join("\n").slice(0, 400));
  },
  "loop-resume-test-edited": (c) => redone(c, "src/test/java/com/x/CalcTest.java 在上次通過之後改過"),
  "loop-resume-touched-test-not-run": (c) => redone(c, "它的測試（com.x.CalcTest）沒有在這次的預檢建置中執行"),
  "loop-resume-second-test-not-run": (c) => redone(c, "它的測試（com.x.CalcTest）沒有在這次的預檢建置中執行"),
  "loop-resume-tests-all-skipped": (c) => redone(c, "com.x.CalcTest（全部被略過）"),
  "loop-resume-own-test-failed": (c) => redone(c, "它的測試（CalcTest）在這次的預檢建置中失敗過"),
  "loop-resume-testng-suite-failed": (c) => redone(c, "它的測試（CalcTest）在這次的預檢建置中失敗過"),
  "loop-resume-package-differs-failed": (c) => redone(c, "它的測試（CalcTest）在這次的預檢建置中失敗過"),
  "loop-resume-concat-resource": (c) => {
    check(
      "第一次的通過紀錄記下 CalcTest 以字串相加點名的 fixture",
      Object.keys(ledgerOf(c.first?.runDir ?? "")[0]?.files ?? {}).includes("src/test/resources/fixtures/order.json"),
      JSON.stringify(Object.keys(ledgerOf(c.first?.runDir ?? "")[0]?.files ?? {})),
    );
    redone(c, "src/test/resources/fixtures/order.json 在上次通過之後改過");
  },
  "loop-resume-concrete-base": (c) => {
    resumedCalc(c, undefined, CALC_TEST_TEXT.replace("class CalcTest {", "class CalcTest extends CalcCases {"));
    check("沒有找 agent", apiRequests(c).length === 0, `${apiRequests(c).length} 個請求`);
  },
  "loop-resume-no-test-class": (c) => redone(c, "上次通過時的檔案裡找不到會被執行的測試類別"),
  "loop-resume-repair-changed-resource": (c) => {
    check("重跑的預檢紅燈、修復迴圈改了測試資源後轉綠", c.stdout.includes("修復") && c.exists("src/test/resources/legacy.properties"), c.stdout.slice(0, 1500));
    redone(c, "修復迴圈改過測試資源或 Spring 會自己載入的類別（resources/legacy.properties），任何測試都可能讀到它");
  },
  "loop-resume-repair-changed-config": (c) => {
    check("重跑的預檢紅燈、修復迴圈加了 @TestConfiguration 後轉綠", c.stdout.includes("修復") && c.exists("src/test/java/com/x/TestConfig.java"), c.stdout.slice(0, 1500));
    redone(c, "修復迴圈改過測試資源或 Spring 會自己載入的類別（com/x/TestConfig.java），任何測試都可能讀到它");
  },
  "loop-resume-repair-changed-helper": (c) => {
    check("第一次執行通過", c.first?.code === 0 && c.first?.result.success === true, `first=${c.first?.code} ${String(c.first?.result.stopReason)}`);
    check("重跑的預檢紅燈、修復迴圈加了 LegacyHelper 後轉綠", c.stdout.includes("修復") && c.exists("src/test/java/com/x/LegacyHelper.java"), c.stdout.slice(0, 1500));
    check(
      "重跑 exit 0：修復之後照樣接續 Calc（普通的 helper 不是任何測試都會讀到的東西）",
      c.code === 0 && c.result.stopReason === "already-passed" && JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]',
      `code=${c.code} ${String(c.result.stopReason)} resumed=${JSON.stringify(c.result.resumed)}\n${c.stdout.slice(-900)}`,
    );
    check("重跑只有預檢與修復那兩次建置", c.mvnCalls === 4, `mvnCalls=${c.mvnCalls}`);
  },
  "loop-resume-testng-all-skipped": (c) => redone(c, "com.x.CalcTest（全部被略過）"),
  "loop-resume-cjk-display-name-not-run": (c) => redone(c, "它的測試（com.x.CalcTest）沒有在這次的預檢建置中執行"),
  "loop-resume-cjk-display-name-ran": (c) => {
    resumedCalc(c, undefined, CALC_TEST_CJK_TEXT);
    check("沒有找 agent", apiRequests(c).length === 0, `${apiRequests(c).length} 個請求`);
  },
  "loop-resume-cjk-display-name-flaky": (c) => redone(c, "它的測試（CalcTest）在這次的預檢建置中不穩定：失敗之後重跑才通過"),
  "loop-resume-surefire-flaky": (c) => redone(c, "它的測試（CalcTest）在這次的預檢建置中不穩定：失敗之後重跑才通過"),
  "loop-resume-cjk-fixture": (c) => {
    check(
      "第一次的通過紀錄記下 CalcTest 點名的 fixtures/訂單.json",
      Object.keys(ledgerOf(c.first?.runDir ?? "")[0]?.files ?? {}).includes("src/test/resources/fixtures/訂單.json"),
      JSON.stringify(Object.keys(ledgerOf(c.first?.runDir ?? "")[0]?.files ?? {})),
    );
    redone(c, "src/test/resources/fixtures/訂單.json 在上次通過之後改過");
  },
  "loop-resume-prefixed-resource": (c) => {
    check(
      "第一次的通過紀錄記下以測試命名的 CalcTest.sql（測試裡沒有字串點名它）",
      Object.keys(ledgerOf(c.first?.runDir ?? "")[0]?.files ?? {}).includes("src/test/resources/com/x/CalcTest.sql"),
      JSON.stringify(Object.keys(ledgerOf(c.first?.runDir ?? "")[0]?.files ?? {})),
    );
    redone(c, "src/test/resources/com/x/CalcTest.sql 在上次通過之後改過");
  },
  "loop-resume-other-package-helper": (c) => {
    const files = Object.keys(ledgerOf(c.first?.runDir ?? "")[0]?.files ?? {});
    check(
      "通過紀錄記下自己 package 的 Support，沒有記別的 package 的同名類別",
      files.includes("src/test/java/com/x/Support.java") && !files.includes("src/test/java/com/y/Support.java"),
      JSON.stringify(files),
    );
    resumedCalc(c, undefined, CALC_TEST_TEXT.replace("assertEquals(3, new Calc().add(1, 2));", "assertEquals(3, new Calc().add(Support.one(), 2));"));
  },
  "loop-resume-ledger-escape": (c) => redone(c, "紀錄裡的檔案路徑 ../outside/CalcTest.java 不在 repo 裡，這筆紀錄不能用"),
  "loop-resume-shared-helper": (c) => {
    check("第一次：兩批都通過", c.first?.code === 0 && c.first?.result.success === true, `first=${c.first?.code} ${String(c.first?.result.stopReason)}`);
    check(
      "第一次在第 2 批通過時就說 Calc 的紀錄不再相符、為什麼",
      (c.first?.stdout ?? "").includes("第 2 批改了 src/test/java/com/x/Support.java：Calc 的通過紀錄不再相符"),
      (c.first?.stdout ?? "").split("\n").filter((l) => l.includes("接續")).join("\n").slice(-800),
    );
    check("重跑接續 Greeter", JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Greeter.java"]', JSON.stringify(c.result.resumed));
    check(
      "重跑重新產生 Calc，說明是 Support.java 改過",
      c.stdout.includes("src/test/java/com/x/Support.java 在上次通過之後改過") && c.code === 0 && c.result.success === true,
      `code=${c.code} ${String(c.result.stopReason)}\n${c.stdout.split("\n").filter((l) => l.includes("接續") || l.startsWith("  - ")).join("\n").slice(-900)}`,
    );
  },
  "loop-resume-repair-green-log": (c) => {
    check("第一次執行通過", c.first?.code === 0 && c.first?.result.success === true, `first=${c.first?.code} ${String(c.first?.result.stopReason)}`);
    check("重跑的預檢紅燈、修復迴圈修好", c.stdout.includes("修復") && c.exists("src/test/java/com/x/LegacyHelper.java"), c.stdout.slice(0, 1500));
    check(
      "重跑 exit 0：修復那次建置的 log 說 CalcTest 跑了 → 接續 Calc",
      c.code === 0 && c.result.stopReason === "already-passed" && JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]',
      `code=${c.code} ${String(c.result.stopReason)} resumed=${JSON.stringify(c.result.resumed)}\n${c.stdout.slice(-900)}`,
    );
  },
  "loop-resume-flaky-single-run": (c) => {
    check("第一次：Calc 通過、Greeter 沒過", c.first?.code === 2 && c.first?.result.stopReason === "some-batches-failed", `code=${c.first?.code} ${String(c.first?.result.stopReason)}`);
    check("重跑接續 Calc、Greeter 通過", c.code === 0 && JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]', `code=${c.code} ${String(c.result.stopReason)} ${JSON.stringify(c.result.resumed)}`);
    check("重跑不分批（一個 run 做剩下的類別）", !c.result.batches, JSON.stringify(Object.keys(c.result)));
    const ledger = ledgerOf(c.runDir) as Array<LedgerEntry & { invalid?: string }>;
    const calc = ledger.find((e) => e.cls === "src/main/java/com/x/Calc.java");
    check(
      "這次的 passed.json 裡帶過來的 Calc 紀錄標記作廢；Greeter 的照常",
      /CalcTest/.test(calc?.invalid ?? "") && ledger.some((e) => e.cls === "src/main/java/com/x/Greeter.java" && !e.invalid),
      JSON.stringify(ledger.map((e) => [e.cls, e.invalid ?? null])),
    );
  },
  "loop-resume-flaky-later-batch": (c) => {
    check("第一次：兩批都通過", c.first?.code === 0 && c.first?.result.success === true, `first=${c.first?.code} ${String(c.first?.result.stopReason)}`);
    const calc = ledgerOf(c.first?.runDir ?? "").find((e) => e.cls === "src/main/java/com/x/Calc.java") as (LedgerEntry & { invalid?: string }) | undefined;
    check(
      "第一次的 passed.json 留著 Calc 的紀錄、標記作廢（不是刪掉——刪掉會讓更舊的紀錄又算數）",
      !!calc && /CalcTest/.test(calc.invalid ?? "") && /不穩定/.test(calc.invalid ?? ""),
      JSON.stringify(calc),
    );
    check("第一次說出 Calc 的紀錄作廢", (c.first?.stdout ?? "").includes("Calc 的通過紀錄作廢"), (c.first?.stdout ?? "").slice(-900));
    check("重跑接續 Greeter", JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Greeter.java"]', JSON.stringify(c.result.resumed));
    check(
      "重跑重新產生 Calc，說明它的測試不穩定",
      /Calc\.java：它的測試 com\.x\.CalcTest 在 \S+ 的執行中不穩定/.test(c.stdout) && c.code === 0 && c.result.success === true,
      `code=${c.code} ${String(c.result.stopReason)}\n${c.stdout.split("\n").filter((l) => l.includes("接續") || l.startsWith("  - ")).join("\n").slice(-900)}`,
    );
  },
  "loop-resume-referenced-helper-edited": (c) => {
    const e = ledgerOf(c.first?.runDir ?? "").find((x) => x.cls === "src/main/java/com/x/Calc.java");
    check("通過紀錄記下 CalcTest 用到的既有 Support.java", !!e && "src/test/java/com/x/Support.java" in e.files, JSON.stringify(e?.files));
    redone(c, "src/test/java/com/x/Support.java 在上次通過之後改過");
  },
  "loop-resume-last-class-set-aside": (c) => {
    check("第一次：Calc 過、Greeter 沒過", c.first?.result.stopReason === "some-batches-failed", String(c.first?.result.stopReason));
    check("重跑接續 Calc", JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]', JSON.stringify(c.result.resumed));
    const b = (c.result.batches ?? []) as Array<Record<string, any>>;
    check(
      "重跑時 Greeter 仍是資料夾的一批：沒過就撤回，嘗試的版本在 rejected/",
      b.length === 1 && b[0].success === false && JSON.stringify(b[0].rolledBack?.created ?? []).includes("GreeterTest.java"),
      JSON.stringify(b.map((x) => [x.stopReason, x.rolledBack?.created])),
    );
    check("src/test 不留下沒通過的 GreeterTest.java", !c.exists("src/test/java/com/x/GreeterTest.java"));
  },
  "loop-resume-gradle": (c) => {
    resumedCalc(c);
    check("不再找 agent", apiRequests(c).length === 0, apiRequests(c).join("\n").slice(0, 400));
    check("兩次執行的每一次建置都強制執行 test task", c.argv.length >= 3 && c.argv.every(gradleForced), JSON.stringify(c.argv));
  },
  "loop-resume-gradle-up-to-date": (c) => redone(c, "Gradle 的 test task 沒有實際執行"),
  "loop-resume-source-edited": (c) => redone(c, "Calc.java 在上次通過之後改過"),
  "loop-resume-new-test-file": (c) => redone(c, "多了上次通過時沒有的測試檔 src/test/java/com/x/CalcUnitTest.java"),
  "loop-resume-helper-edited": (c) => {
    const e = ledgerOf(c.first?.runDir ?? "").find((x) => x.cls === "src/main/java/com/x/Calc.java");
    check(
      "第一次的通過紀錄連同那批 writer 寫的 Support.java 一起記下",
      !!e && "src/test/java/com/x/Support.java" in e.files && "src/test/java/com/x/CalcTest.java" in e.files,
      JSON.stringify(e?.files),
    );
    redone(c, "src/test/java/com/x/Support.java 在上次通過之後改過");
  },
  "loop-resume-coverage-dropped": (c) => redone(c, "覆蓋率重新量測沒有通過：- Calc.java: line=40.0%"),
  "loop-resume-tests-not-run": (c) => redone(c, "它的測試（com.x.CalcTest）沒有在這次的預檢建置中執行"),
  "loop-resume-review-threshold-raised": (c) => redone(c, "上次的 review 判決以現在的門檻不通過（effectiveness（8 < 門檻 9））"),
  "loop-resume-review-was-skipped": (c) => redone(c, "上次通過時 review gate 是關閉的"),
  "loop-resume-rubric-changed": (c) => redone(c, "review 的 rubric 在上次通過之後改過"),
  "loop-resume-dirty-baseline": (c) => redone(c, "但這次的預檢建置是紅的（UT_ALLOW_DIRTY_BASELINE=1 放行）"),
  "loop-resume-skip-baseline": (c) => redone(c, "但這次沒有跑預檢建置（UT_SKIP_BASELINE=1）"),
  "loop-resume-disabled": (c) => {
    redone(c, "");
    check("UT_RESUME=0 時不看先前的紀錄", !c.stdout.includes("[接續]"), c.stdout.slice(-800));
    check("params.json 記錄 resume=false", JSON.parse(c.runRead("params.json") || "{}").resume === false);
  },

  "loop-resume-batches": (c) => {
    check("第一次：Calc 通過、Greeter 沒過", c.first?.code === 2 && c.first?.result.stopReason === "some-batches-failed", `code=${c.first?.code} ${String(c.first?.result.stopReason)}`);
    check("重跑 exit 0", c.code === 0 && c.result.success === true, `code=${c.code} ${String(c.result.stopReason)}\n${c.stdout.slice(-800)}`);
    check("重跑略過 Calc", JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]', JSON.stringify(c.result.resumed));
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check(
      "重跑只剩一個類別，仍是資料夾目標的分批（沒過會撤回、執行中有復原日誌），不是單一類別的 run",
      JSON.stringify(c.result.targetClasses) === '["src/main/java/com/x/Greeter.java"]' && b.length === 1 && b[0].success === true,
      JSON.stringify([c.result.targetClasses, b.map((x) => x.targetClasses)]),
    );
    const prompt = c.runRead("batch-1-Greeter/iter-1/prompt.md");
    check("writer 的 prompt 只有 Greeter", prompt.includes("Greeter.java") && !prompt.includes("com/x/Calc.java"), prompt.slice(0, 600));
    const ledger = ledgerOf(c.runDir);
    const calc = ledger.find((e) => e.cls === "src/main/java/com/x/Calc.java");
    check(
      "這次的 passed.json 帶著 Calc 的通過紀錄（指向第一次那批）與 Greeter 這次的",
      !!calc && calc.dir.startsWith(c.first?.runDir ?? "?") && ledger.some((e) => e.cls === "src/main/java/com/x/Greeter.java"),
      JSON.stringify(ledger.map((e) => [e.cls, e.dir])),
    );
    check("建置 5 次：第一次 3 次、重跑 2 次（預檢 + Greeter）", c.mvnCalls === 5, `mvnCalls=${c.mvnCalls}`);
  },

  "loop-resume-rerun-interrupted": (c) => {
    if (process.platform === "win32") return; // the fake build signals the loop by its pid
    check("重跑在 Greeter 被 Ctrl-C 中斷", c.result.stopReason === "interrupted:SIGINT", String(c.result.stopReason));
    check("被中斷的 summary 照樣列出接續的 Calc", JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]', JSON.stringify(c.result.resumed));
    check("Calc 的通過紀錄已帶進這次的 passed.json", ledgerOf(c.runDir).some((e) => e.cls === "src/main/java/com/x/Calc.java"));
  },

  // ── A run killed outright ──────────────────────────────────────────────────
  "loop-killed-mid-writer": (c) => {
    killedRecovered(c, { restored: true });
    const rb = firstSummary(c)?.inProgress?.rolledBack ?? {};
    check("它改過的 ExistingTest.java 也算在撤回裡", (rb.restored ?? []).includes("java/com/x/ExistingTest.java"), JSON.stringify(rb));
  },
  "loop-killed-orphan-build": (c) => {
    if (process.platform === "win32") return; // the fake build kills its parent by pid, and on Windows that is cmd.exe
    const pid = Number(c.read(".itest/orphan.pid"));
    try {
      check("第一次被終止時，建置本身還在跑（孤兒）", pid > 0, c.read(".itest/orphan.pid"));
      check("重跑一開始就結束它", pid > 0 && !pidAlive(pid), `pid ${pid} 還在`);
      check("log 說明結束了上一次留下的子程序", c.stdout.includes("上一次執行被強制終止時留下 1 個還在跑的子程序"), c.stdout.slice(0, 2000));
      const stoppedAt = c.stdout.indexOf("還在跑的子程序");
      const rolledBackAt = c.stdout.indexOf("被強制終止，沒來得及撤回");
      check(
        "先結束還在跑的子程序、才撤回那批（還在寫檔的建置或 agent 會跟撤回搶）",
        stoppedAt >= 0 && rolledBackAt > stoppedAt,
        `stop@${stoppedAt} rollback@${rolledBackAt}`,
      );
      check("處理過的子程序紀錄移除（之後那些 pid 可能是任何人的）", !fs.existsSync(firstRunFile(c, "children.json")));
      killedRecovered(c, { restored: true });
      check("這次執行結束時，自己的子程序紀錄是空的", JSON.parse(c.runRead("children.json") || "{}").children?.length === 0, c.runRead("children.json"));
    } finally {
      stopPid(pid);
    }
  },
  "loop-killed-orphan-fork": (c) => {
    if (process.platform === "win32") return;
    const pid = Number(c.read(".itest/orphan.pid"));
    try {
      check("建置自己結束了，它 fork 出去的程序還在它的程序群組裡", pid > 0, c.read(".itest/orphan.pid"));
      check("重跑結束了那個程序群組", pid > 0 && !pidAlive(pid), `pid ${pid} 還在`);
      check("log 說明結束了上一次留下的子程序", c.stdout.includes("上一次執行被強制終止時留下 1 個還在跑的子程序"), c.stdout.slice(0, 2000));
    } finally {
      stopPid(pid);
    }
  },
  "loop-killed-orphan-pid-reused": (c) => orphanLeftAlone(c, { recordKept: false }),
  "loop-killed-orphan-other-checkout": (c) => orphanLeftAlone(c, { recordKept: true }),
  "loop-killed-orphan-other-host": (c) => orphanLeftAlone(c, { recordKept: true }),
  "loop-killed-orphan-rebooted": (c) => orphanLeftAlone(c, { recordKept: true }),
  "loop-killed-orphan-clock-stepped": (c) => {
    if (process.platform !== "linux") return; // a boot id is Linux's; elsewhere the estimate is all there is
    const pid = Number(c.read(".itest/orphan.pid"));
    try {
      check("時鐘校正不影響：留下的建置照樣被結束", pid > 0 && !pidAlive(pid), `pid ${pid}`);
      check("log 說明結束了上一次留下的子程序", c.stdout.includes("上一次執行被強制終止時留下 1 個還在跑的子程序"), c.stdout.slice(0, 2000));
    } finally {
      stopPid(pid);
    }
  },
  "loop-killed-orphan-corrupt-record": (c) => {
    if (process.platform === "win32") return; // the fake build kills its parent by pid, and on Windows that is cmd.exe
    check("損毀的子程序紀錄不讓重跑當掉：照常撤回那批、接續到通過", c.code === 0 && c.result.success === true, `code=${c.code} ${String(c.result.stopReason)}\n${c.stderr.slice(-600)}`);
    orphanLeftAlone(c, { recordKept: false });
  },
  "loop-killed-orphan-build-keeps-fix": (c) => {
    if (process.platform === "win32") return; // the fake build kills its parent by pid, and on Windows that is cmd.exe
    const pid = Number(c.read(".itest/orphan.pid"));
    try {
      check("留下的建置被結束", pid > 0 && !pidAlive(pid), `pid ${pid}`);
      const rb = firstSummary(c)?.inProgress?.rolledBack ?? {};
      check(
        "開發者在那之後修的 ExistingTest.java 留著，列為別人的變更",
        c.read("src/test/java/com/x/ExistingTest.java").includes("fixed by the developer") && (rb.foreign ?? []).includes("java/com/x/ExistingTest.java"),
        JSON.stringify(rb),
      );
      check("writer 新增的 GreeterTest.java 照樣撤回", (rb.created ?? []).includes("java/com/x/GreeterTest.java"), JSON.stringify(rb));
    } finally {
      stopPid(pid);
    }
  },
  "loop-killed-orphan-other-container": (c) => {
    if (process.platform !== "linux") return; // a pid namespace is Linux's
    check("子程序紀錄帶著寫它的 pid namespace", /"pidns":"pid:\[1\]"/.test(firstRunRead(c, "children.json")), firstRunRead(c, "children.json") || "(紀錄不見了)");
    orphanLeftAlone(c, { recordKept: true });
  },
  // Its record is that run's own, still in use: not ours to remove either.
  "loop-killed-orphan-owner-alive": (c) => orphanLeftAlone(c, { recordKept: true }),
  "loop-killed-other-host": (c) => {
    killedLeftAlone(c);
    check("別台機器的日誌原樣留著", fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight/journal.json")));
    check("也不替它寫 summary", firstSummary(c) === undefined, JSON.stringify(firstSummary(c)));
    check("log 說明有別台機器的日誌、不處理", c.stdout.includes("是別台機器或別的容器留下的"), c.stdout.slice(0, 2000));
  },
  "loop-killed-other-host-same-checkout": (c) => killedRecovered(c, { restored: true }),
  "loop-killed-busy-owner-exits": (c) => {
    if (process.platform === "win32") return; // no start times to tell the owner by
    check("先說明這個 checkout 上可能還有 testgen 在跑、等它", c.stdout.includes("可能還在執行的 testgen") && c.stdout.includes("它已經停止"), c.stdout.slice(0, 2000));
    killedRecovered(c, { restored: true });
  },
  "loop-killed-busy-gives-up": (c) => {
    if (process.platform === "win32") return; // no start times to tell the owner by
    check("等不到它停止 → 以 checkout-busy 停下", c.code !== 0 && c.result.stopReason === "checkout-busy", `code=${c.code} ${JSON.stringify(c.result)}`);
    check("說明原因與怎麼辦", (c.stdout + c.stderr).includes("可能還有另一個 testgen 在執行"), (c.stdout + c.stderr).slice(-1500));
    check("它的日誌留著", fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight/journal.json")));
    check("沒有撤回、也沒有替它寫 summary（它可能還在跑）", firstSummary(c) === undefined && c.read("src/test/java/com/x/ExistingTest.java").includes(KILLED_LINE));
    check("沒有開始產生測試（沒找 writer）", apiRequests(c).length === 0);
  },
  "loop-killed-trace-lost": (c) => {
    check("說明 trace 讀不了、改用那批開始之後的所有變更", c.stdout.includes("trace.json 讀不了"), c.stdout.slice(0, 2500));
    killedRecovered(c, { restored: true });
  },
  "loop-killed-moved-after-death": (c) => {
    killedRecovered(c, { restored: true });
    check("開發者的移動留著：data/order.json 在、fixtures/order.json 沒被放回", c.exists("src/test/resources/data/order.json") && !c.exists("src/test/resources/fixtures/order.json"));
    const rb = firstSummary(c)?.inProgress?.rolledBack ?? {};
    check(
      "移動的兩邊都不算那批的，也不列成別人的變更",
      ![...(rb.created ?? []), ...(rb.undeleted ?? []), ...(rb.foreign ?? [])].some((f: string) => /order\.json$/.test(f)),
      JSON.stringify(rb),
    );
    check("log 說明是之後的移動", c.stdout.includes("被移動過") && c.stdout.includes("data/order.json"), c.stdout.slice(0, 2500));
    check(
      "移走的原檔不當成「無法判斷誰刪的」（不點名、不存進 deleted/）",
      !c.stdout.includes("無法判斷是被終止的 writer") && !fs.existsSync(firstRunFile(c, "batch-2-Greeter/deleted")),
      c.stdout.slice(0, 2500),
    );
  },
  "loop-killed-recloned": (c) => {
    killedLeftAlone(c);
    check("不屬於這個 checkout 的日誌丟掉，並說明", !fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight")) && c.stdout.includes("重新 clone"), c.stdout.slice(0, 2000));
  },
  "loop-killed-corrupt-journal": (c) => {
    killedLeftAlone(c);
    check("損毀的日誌丟掉，並說明", !fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight")) && c.stdout.includes("內容損毀"), c.stdout.slice(0, 2000));
  },
  "loop-killed-deleted-after-death": (c) => {
    check("第一次執行被強制終止", !c.first?.result.stopReason);
    check("死後才被刪掉的 ExistingTest.java 沒有被放回", !c.exists("src/test/java/com/x/ExistingTest.java"));
    check(
      "它原本的內容保留在那批的 deleted/",
      firstRunRead(c, "batch-2-Greeter/deleted/src/test/java/com/x/ExistingTest.java") === EXISTING_TEST,
      firstRunRead(c, "batch-2-Greeter/deleted/src/test/java/com/x/ExistingTest.java"),
    );
    check("log 說明無法判斷是誰刪的", c.stdout.includes("無法判斷是被終止的 writer") && c.stdout.includes("ExistingTest.java"), c.stdout.slice(0, 2500));
    const rb = firstSummary(c)?.inProgress?.rolledBack ?? {};
    check("writer 新增的 GreeterTest.java 照樣移出", (rb.created ?? []).includes("java/com/x/GreeterTest.java"), JSON.stringify(rb));
    check("重跑照常完成", c.code === 0 && c.result.success === true, `code=${c.code} ${String(c.result.stopReason)}\n${c.stdout.slice(-600)}`);
  },
  "loop-killed-restore-fails": (c) => {
    if (process.platform === "win32") return; // mkfifo
    check("撤回時有檔案放不回去 → 這次停下（不在寫到一半的測試上產生新的）", c.code !== 0 && c.result.stopReason === "killed-batch-not-restored", `code=${c.code} ${JSON.stringify(c.result)}`);
    check("日誌留著，給下一次執行再試", fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight/journal.json")));
    check("說明原因與怎麼辦", c.stdout.includes("沒辦法完整撤回") || c.stderr.includes("沒辦法完整撤回"), (c.stdout + c.stderr).slice(-1500));
    check("沒有開始產生測試（沒找 writer）", apiRequests(c).length === 0);
  },
  "loop-killed-writer-deleted": (c) => {
    killedRecovered(c, { restored: false });
    const rb = firstSummary(c)?.inProgress?.rolledBack ?? {};
    check(
      "被終止的 writer 刪掉的 ExistingTest.java 放回原本的內容",
      (rb.undeleted ?? []).includes("java/com/x/ExistingTest.java") && c.read("src/test/java/com/x/ExistingTest.java") === EXISTING_TEST,
      JSON.stringify(rb),
    );
  },
  "loop-killed-orphan-writes-on": (c) => {
    if (process.platform === "win32") return; // the fake build kills its parent by pid, and on Windows that is cmd.exe
    const pid = Number(c.read(".itest/orphan.pid"));
    try {
      check("留下的程序被結束", pid > 0 && !pidAlive(pid), `pid ${pid}`);
      const rb = firstSummary(c)?.inProgress?.rolledBack ?? {};
      check(
        "它在心跳停了之後才寫的 GreeterTest.java 仍算那批的：撤回、嘗試的版本留在 rejected/",
        (rb.created ?? []).includes("java/com/x/GreeterTest.java") &&
          firstRunRead(c, "batch-2-Greeter/rejected/src/test/java/com/x/GreeterTest.java").includes("written by the orphan"),
        JSON.stringify(rb),
      );
      check("最後的 GreeterTest.java 是這次的 writer 寫的", !c.read("src/test/java/com/x/GreeterTest.java").includes("written by the orphan"));
    } finally {
      stopPid(pid);
    }
  },
  "loop-killed-mid-build": (c) => {
    if (process.platform === "win32") return; // the fake build kills its parent by pid, and on Windows that is cmd.exe
    killedRecovered(c, { restored: true });
    const rb = firstSummary(c)?.inProgress?.rolledBack ?? {};
    check(
      "建置時測試寫進 src/test 的檔不是 writer 的：留著，列為別人的變更",
      c.exists("src/test/resources/written-by-a-test.txt") && (rb.foreign ?? []).includes("resources/written-by-a-test.txt"),
      JSON.stringify(rb),
    );
  },
  "loop-killed-edit-after-death": (c) => {
    killedRecovered(c, { restored: false });
    const rb = firstSummary(c)?.inProgress?.rolledBack ?? {};
    check(
      "rollback.md 說它是那次執行被終止之後才改的",
      firstRunRead(c, "batch-2-Greeter/rollback.md").includes("在那次執行被終止之後才改過"),
    );
    check(
      "死後才改的 ExistingTest.java 不是 writer 的：留著，列為別人的變更",
      c.read("src/test/java/com/x/ExistingTest.java").includes("fixed by hand after the crash") &&
        (rb.foreign ?? []).includes("java/com/x/ExistingTest.java") &&
        !(rb.restored ?? []).includes("java/com/x/ExistingTest.java"),
      JSON.stringify(rb),
    );
  },
  "loop-killed-batch-recorded": (c) => {
    killedLeftAlone(c);
    const sum = firstSummary(c);
    check("仍然補寫 summary：killed，但沒有 inProgress（那批已經有紀錄）", sum?.stopReason === "killed" && !sum?.inProgress, JSON.stringify(sum));
    check("日誌用完就移除", !fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight")));
  },
  "loop-killed-other-checkout": (c) => {
    killedLeftAlone(c);
    check("另一個 checkout 的日誌原樣留著", fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight/journal.json")));
    check("也不替它寫 summary", firstSummary(c) === undefined, JSON.stringify(firstSummary(c)));
  },
  "loop-killed-run-ended": (c) => {
    killedLeftAlone(c);
    check("那次執行自己的 summary 不動", firstSummary(c)?.stopReason === "interrupted:SIGHUP", JSON.stringify(firstSummary(c)));
    check("剩下的日誌丟掉", !fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight")));
  },

  "loop-resume-after-interrupt": (c) => {
    if (process.platform === "win32") return; // the fake build signals the loop by its pid
    check("第一次在第 2 批被 Ctrl-C 中斷", c.first?.result.stopReason === "interrupted:SIGINT", String(c.first?.result.stopReason));
    check("第一次的 passed.json 已經有第 1 批的 Calc", ledgerOf(c.first?.runDir ?? "").some((e) => e.cls === "src/main/java/com/x/Calc.java"));
    check("重跑 exit 0", c.code === 0 && c.result.success === true, `code=${c.code} ${String(c.result.stopReason)}\n${c.stdout.slice(-800)}`);
    check("重跑略過 Calc", JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]', JSON.stringify(c.result.resumed));
    const b = (c.result.batches ?? []) as Array<Record<string, unknown>>;
    check(
      "重跑分兩批：Greeter、Zeta",
      JSON.stringify(b.map((x) => (x.targetClasses as string[]).map((t) => t.replace(/\\/g, "/")))) ===
        '[["src/main/java/com/x/Greeter.java"],["src/main/java/com/x/Zeta.java"]]',
      JSON.stringify(b.map((x) => x.targetClasses)),
    );
    check("SUMMARY 列出接續的類別", c.stdout.includes("[接續] Calc（先前的執行已通過"), c.stdout.slice(-800));
    check("三個測試檔都在", ["CalcTest", "GreeterTest", "ZetaTest"].every((t) => c.exists(`src/test/java/com/x/${t}.java`)));
  },
};

// ─── Killed-run helpers ──────────────────────────────────────────────────────

// Running: there, and not a zombie — a killed orphan waits to be reaped by a pid 1 that may be slow to.
const pidAlive = (pid: number) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^[ZX]$/.test(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch {
    /* no such process — or no /proc: ask the kernel */
  }
  try {
    process.kill(pid, 0);
    return process.platform !== "linux";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
/** The rerun had no business stopping the process the killed run's record names: it is still running. */
function orphanLeftAlone(c: Ctx, o: { recordKept: boolean }): void {
  if (process.platform === "win32") return; // the fake build kills its parent by pid, and on Windows that is cmd.exe
  const pid = Number(c.read(".itest/orphan.pid"));
  try {
    check("那個程序沒有被結束：還活著", pid > 0 && pidAlive(pid), `pid ${pid}`);
    check("沒有說結束了什麼", !c.stdout.includes("還在跑的子程序"), c.stdout.slice(0, 2000));
    check(
      o.recordKept ? "不是這次能處理的紀錄（別的 checkout、機器、容器、開機，或主人還活著）：原樣留著" : "看過的紀錄移除（之後那些 pid 可能是任何人的）",
      fs.existsSync(firstRunFile(c, "children.json")) === o.recordKept,
    );
  } finally {
    stopPid(pid);
  }
}

/** A scenario's orphan does not outlive its checks, whatever they found. */
const stopPid = (pid: number) => {
  try {
    if (pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
};

const KILLED_LINE = "the killed writer was here";
const firstRunFile = (c: Ctx, rel: string) => path.join(c.first?.runDir ?? "/nonexistent", rel);
const firstRunRead = (c: Ctx, rel: string) => {
  try {
    return fs.readFileSync(firstRunFile(c, rel), "utf8");
  } catch {
    return "";
  }
};
const firstSummary = (c: Ctx): Record<string, any> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(firstRunFile(c, "summary.json"), "utf8"));
  } catch {
    return undefined;
  }
};

/** The rerun set the killed batch aside from its journal, then went on as usual. */
function killedRecovered(c: Ctx, o: { restored: boolean }): void {
  check("第一次執行被強制終止：它自己沒有留下 summary", !c.first?.result.stopReason, JSON.stringify(c.first?.result));
  const sum = firstSummary(c);
  check(
    "重跑替它補寫 summary：stopReason=killed、由這次執行收尾、被終止的是第 2 批",
    sum?.stopReason === "killed" && sum?.recoveredBy === c.runDir && sum?.inProgress?.batch === 2,
    JSON.stringify(sum),
  );
  const rb = sum?.inProgress?.rolledBack ?? {};
  check("writer 新增的 GreeterTest.java 移出 src/test", (rb.created ?? []).includes("java/com/x/GreeterTest.java"), JSON.stringify(rb));
  check(
    "嘗試的版本保留在那批的 rejected/",
    fs.existsSync(firstRunFile(c, "batch-2-Greeter/rejected/src/test/java/com/x/GreeterTest.java")),
  );
  if (o.restored) {
    check("writer 改過的 ExistingTest.java 還原成原本的內容", c.read("src/test/java/com/x/ExistingTest.java") === EXISTING_TEST, c.read("src/test/java/com/x/ExistingTest.java"));
  }
  check(
    "rollback.md 寫在那批的 artifacts，說明是被強制終止後由下一次執行撤回的",
    firstRunRead(c, "batch-2-Greeter/rollback.md").includes("被強制終止"),
  );
  check("復原日誌用完就移除", !fs.existsSync(firstRunFile(c, "batch-2-Greeter/inflight")));
  check("log 說明撤回了哪一次的哪一批", c.stdout.includes("第 2 批（Greeter）被強制終止"), c.stdout.slice(0, 1500));
  check("重跑照常接續 Calc、完成 Greeter", c.code === 0 && c.result.success === true && JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]', `code=${c.code} ${String(c.result.stopReason)} ${JSON.stringify(c.result.resumed)}\n${c.stdout.slice(-600)}`);
}

/** The journal was not this rerun's to act on: nothing of the killed batch was undone. */
function killedLeftAlone(c: Ctx): void {
  check("被終止那批改過的 ExistingTest.java 沒有被撤回", c.read("src/test/java/com/x/ExistingTest.java").includes(KILLED_LINE));
  check("沒有撤回：那批沒有 rollback.md", !fs.existsSync(firstRunFile(c, "batch-2-Greeter/rollback.md")));
  check("沒有說撤回了什麼", !c.stdout.includes("被強制終止"), c.stdout.slice(0, 1500));
  check("重跑照常完成", c.code === 0 && c.result.success === true, `code=${c.code} ${String(c.result.stopReason)}\n${c.stdout.slice(-600)}`);
}

// ─── Resume helpers ──────────────────────────────────────────────────────────

type LedgerEntry = { cls: string; dir: string; files: Record<string, string | null>; verdict: { scores: Record<string, number> } | null };
const ledgerOf = (runDir: string): LedgerEntry[] => {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "passed.json"), "utf8")).entries ?? [];
  } catch {
    return [];
  }
};
const resumedOf = (c: Ctx) => ((c.result.resumed ?? []) as Array<{ cls: string }>).map((r) => r.cls.replace(/\\/g, "/"));
const apiRequests = (c: Ctx) => c.read(".itest/api-requests.jsonl").split("\n").filter(Boolean);

/** CalcTest with a Chinese class-level @DisplayName, as the resume scenarios write it. */
const CALC_TEST_CJK_TEXT = CALC_TEST_TEXT.replace(
  "import org.junit.jupiter.api.Test;",
  "import org.junit.jupiter.api.DisplayName;\nimport org.junit.jupiter.api.Test;",
).replace("class CalcTest {", '@DisplayName("計算機測試")\nclass CalcTest {');

/** The rerun found Calc's pass still holding: nothing left to write. */
function resumedCalc(c: Ctx, testFile = "src/test/java/com/x/CalcTest.java", content?: string): void {
  check("第一次執行通過", c.first?.code === 0 && c.first?.result.success === true, `first=${c.first?.code} ${String(c.first?.result.stopReason)}`);
  check("第一次留下 passed.json，記著 Calc", ledgerOf(c.first?.runDir ?? "").some((e) => e.cls === "src/main/java/com/x/Calc.java"));
  check("重跑 exit 0，stopReason = already-passed", c.code === 0 && c.result.success === true && c.result.stopReason === "already-passed", `code=${c.code} ${String(c.result.stopReason)}\n${c.stdout.slice(-800)}`);
  check("summary 列出接續的 Calc", JSON.stringify(resumedOf(c)) === '["src/main/java/com/x/Calc.java"]', JSON.stringify(c.result.resumed));
  check("重跑只建置一次：預檢", c.mvnCalls === 3, `mvnCalls=${c.mvnCalls}`);
  check("說明略過了什麼、依據是什麼", c.stdout.includes("[接續] 1 個類別在先前的執行已通過所有 gate"), c.stdout.slice(-800));
  const carried = ledgerOf(c.runDir).find((e) => e.cls === "src/main/java/com/x/Calc.java");
  check(
    "這次的 passed.json 帶著 Calc 的通過紀錄，指向第一次的 artifacts，只有紀錄自己的欄位",
    !!carried && carried.dir === c.first?.runDir && !("run" in carried),
    JSON.stringify(carried),
  );
  check(
    `${path.basename(testFile)} 還是第一次通過時的內容`,
    c.read(testFile) === (content ?? CALC_TEST_TEXT.replace("class CalcTest", `class ${path.basename(testFile, ".java")}`)),
  );
}

/** The rerun found Calc's pass no longer holding, said why, and wrote Calc again. */
function redone(c: Ctx, why: string): void {
  check("第一次執行通過", c.first?.code === 0 && c.first?.result.success === true, `first=${c.first?.code} ${String(c.first?.result.stopReason)}`);
  check("重跑沒有略過 Calc", resumedOf(c).length === 0, JSON.stringify(c.result.resumed));
  if (why) {
    check(`說明為什麼要重新產生：${why}`, c.stdout.includes(why), c.stdout.split("\n").filter((l) => l.includes("接續") || l.startsWith("  - ")).join("\n").slice(-1200));
  }
  check(
    "重跑照常產生並通過",
    c.code === 0 && c.result.success === true && c.result.stopReason === "gates-passed",
    `code=${c.code} ${String(c.result.stopReason)}\n${c.stdout.slice(-800)}`,
  );
  check("writer 被叫來重寫", apiRequests(c).length > 0);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  currentScenario = "0 環境隔離";
  console.log("[0] 環境隔離：所有 UT_* 旋鈕都必須被釘住");
  const knobs = envKnobsInSource();
  const missing = knobs.filter((k) => !(k in BASE_ENV));
  check(
    `原始碼讀到的 ${knobs.length} 個 UT_* 全部釘在 BASE_ENV`,
    missing.length === 0,
    `未釘住：${missing.join(", ")}`,
  );

  // One scenario by name, or a group by a prefix ending in "*" (loop-resume-*).
  const only = process.argv[2];
  const list = only
    ? SCENARIOS.filter((s) => (only.endsWith("*") ? s.name.startsWith(only.slice(0, -1)) : s.name === only))
    : SCENARIOS;
  if (!list.length) {
    console.error(`找不到情境：${only}`);
    process.exit(1);
  }

  const haveGit = gitAvailable();
  const haveJdk = jdkAvailable();
  for (const sc of list) {
    currentScenario = sc.name;
    console.log(`\n[${sc.name}] ${sc.desc}`);
    if (sc.git && !haveGit) {
      console.log("  [SKIP] 找不到 git——這個情境要一個真的 git repo 才測得到 .gitignore 的效果");
      continue;
    }
    if (sc.jdk && !haveJdk) {
      console.log("  [SKIP] 找不到 JDK——這個情境要真的 JDK 做編碼轉換");
      continue;
    }
    if (sc.noJdk && process.platform === "win32") {
      console.log("  [SKIP] Windows：「只有 node 的 PATH」這個情境只在 POSIX 上搭得出來");
      continue;
    }
    const ctx = await runScenario(sc);
    if (ctx.result.crashed) {
      check(`${sc.name} 執行未崩潰`, false, String(ctx.result.crashed).slice(0, 800));
      continue;
    }
    const fn = CHECKS[sc.name];
    if (!fn) {
      check(`${sc.name} 有對應的斷言`, false, "CHECKS 缺少此情境");
      continue;
    }
    const before = failCount;
    try {
      fn(ctx);
    } catch (e) {
      check(`${sc.name} 斷言未拋錯`, false, `${String(e)}\nstderr: ${ctx.stderr.slice(-500)}`);
    }
    for (const pid of liveOwners.splice(0)) stopPid(pid);
    // A failed scenario keeps its fixture: the artifacts, the build log and the argv log are
    // the whole diagnosis, and they are gone by the time anyone reads the output otherwise.
    if (failCount > before) console.log(`  → 保留 fixture 供診斷：${ctx.root}`);
    else fs.rmSync(ctx.root, { recursive: true, force: true });
  }

  if (failures.length) console.log(`\n失敗的檢查（${failures.length}）：\n${failures.map((f) => `  ${f.slice(0, 600)}`).join("\n")}`);
  console.log(`\n結果：${passCount} passed / ${failCount} failed`);
  if (failCount > 0) process.exit(1);
  console.log("[OK] itest 全數通過");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
