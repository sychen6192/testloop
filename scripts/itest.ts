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
import { spawn } from "node:child_process";
import { ApiTurn, buildFixture, envKnobsInSource, RUN_DIR, Scenario, targetDirOf, TESTGEN_ROOT } from "./itest-lib";
import { SCENARIOS } from "./itest-scenarios";
import { planSpawn } from "../libs/shell";

let passCount = 0;
let failCount = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passCount++;
    console.log(`  [OK] ${name}`);
  } else {
    failCount++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── Hermetic environment ────────────────────────────────────────────────────
//
// Every knob is pinned, and every UT_* already in the environment is dropped, because the
// tool auto-loads its own .env: an operator's UT_STRICT_COV=1 must not decide whether a
// coverage assertion here passes. The completeness check below keeps this list honest.

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
  UT_BUILD_TIMEOUT_MS: "60000",
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

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("UT_")) env[k] = v;
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

function startFakeApi(turns: ApiTurn[]): Promise<{ url: string; close: () => Promise<void> }> {
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const turn: ApiTurn = turns[i++] ?? { content: "沒有更多腳本回合了" };
      const message: Record<string, unknown> = { content: turn.content ?? "" };
      if (turn.toolCalls?.length) {
        message.tool_calls = turn.toolCalls.map((t, n) => ({
          id: `call_${i}_${n}`,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }], usage: { completion_tokens: 11 } }));
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

  if (sc.entry === "loop") {
    const api = await startFakeApi(sc.api ?? []);
    const proxy = sc.proxy ? await startProxy() : undefined;
    proxySeen = proxy?.seen;
    const apiHost = new URL(api.url).host;
    const runsBase = path.join(root, ".itest", "runs");
    out = await runTsx(
      path.join(TESTGEN_ROOT, "loop.ts"),
      [targetDirOf(sc)],
      root,
      childEnv({
        ...sc.env,
        UT_RUNNER: "api",
        UT_API_BASE_URL: api.url,
        UT_RUNS_DIR: runsBase,
        ...(proxy ? { UT_HTTP_PROXY: proxy.url } : {}),
        // Scenarios opt into the bypass by naming the endpoint's own host:port.
        ...(sc.noProxy ? { UT_NO_PROXY: apiHost } : {}),
      }),
    );
    await api.close();
    await proxy?.close();
    // RUNS_DIR = <UT_RUNS_DIR>/<repo basename>/<runId>; exactly one run per scenario.
    const repoRuns = path.join(runsBase, path.basename(root));
    const ids = fs.existsSync(repoRuns) ? fs.readdirSync(repoRuns).sort() : [];
    if (ids.length) runDir = path.join(repoRuns, ids[ids.length - 1]);
    const summary = path.join(runDir, "summary.json");
    if (fs.existsSync(summary)) result = JSON.parse(fs.readFileSync(summary, "utf8"));
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
    check("回饋點名 @Disabled 增加", fb.includes("@Disabled 0 → 1"), fb.slice(0, 300));
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
    check("限縮同時套用到整個 reactor", c.argv[0]?.includes("-Dtest=CalcTest"), JSON.stringify(c.argv[0]));
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
    check("相同失敗第 2 輪判 stuck", c.result.stopReason === "stuck", String(c.result.stopReason));
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
    check("共建置 4 次（每輪限縮 1 次 + 完整 1 次）", c.mvnCalls === 4, `mvnCalls=${c.mvnCalls}`);
    check("限縮那次帶 -Dtest=CalcTest", c.argv[0]?.includes("-Dtest=CalcTest"), JSON.stringify(c.argv[0]));
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
    check("成功那輪也做了完整驗收", c.runExists("iter-2/final-verify.log"));
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
};

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[0] 環境隔離：所有 UT_* 旋鈕都必須被釘住");
  const knobs = envKnobsInSource();
  const missing = knobs.filter((k) => !(k in BASE_ENV));
  check(
    `原始碼讀到的 ${knobs.length} 個 UT_* 全部釘在 BASE_ENV`,
    missing.length === 0,
    `未釘住：${missing.join(", ")}`,
  );

  const only = process.argv[2];
  const list = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
  if (!list.length) {
    console.error(`找不到情境：${only}`);
    process.exit(1);
  }

  for (const sc of list) {
    console.log(`\n[${sc.name}] ${sc.desc}`);
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
    // A failed scenario keeps its fixture: the artifacts, the build log and the argv log are
    // the whole diagnosis, and they are gone by the time anyone reads the output otherwise.
    if (failCount > before) console.log(`  → 保留 fixture 供診斷：${ctx.root}`);
    else fs.rmSync(ctx.root, { recursive: true, force: true });
  }

  console.log(`\n結果：${passCount} passed / ${failCount} failed`);
  if (failCount > 0) process.exit(1);
  console.log("[OK] itest 全數通過");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
