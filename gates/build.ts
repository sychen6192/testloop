// Hard gate: compile + test, module-aware.
// Maven: reactor pom at REPO_ROOT -> `mvn -pl <module> -am test` from root; else `mvn test` in the module.
// Gradle: `-p <module>` for multi-module (best-effort; Maven is the primary path).
// Test reports are read from the *module's* target/build, not the repo root.
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, MAVEN_EXTRA_ARGS, ALLOW_ZERO_TESTS, BUILD_TIMEOUT_MS } from "../config";
import { tail, die, log } from "../libs/log";
import { shLive } from "../libs/shell";
import { BuildTool, GateResult, ModuleInfo } from "../libs/types";

// What the module already looked like before the writer touched anything.
// Without this the build gate cannot tell "the writer broke it" from "it arrived broken",
// and the fix prompt sends the writer chasing other people's compile errors.
export interface BaselineResult {
  clean: boolean;
  compileErrorFiles: string[];
  failingTestClasses: string[];
  summary: string;
  raw: string;
}

export function detectBuildTool(moduleRoot: string): BuildTool {
  if (fs.existsSync(path.join(moduleRoot, "pom.xml"))) return "maven";
  if (
    fs.existsSync(path.join(moduleRoot, "build.gradle")) ||
    fs.existsSync(path.join(moduleRoot, "build.gradle.kts"))
  ) {
    return "gradle";
  }
  die(`在 ${moduleRoot} 偵測不到 pom.xml 或 build.gradle`);
}

function collectSurefireFailures(moduleRoot: string): string {
  let failures = "";
  const surefireDir = path.join(moduleRoot, "target", "surefire-reports");
  if (fs.existsSync(surefireDir)) {
    for (const f of fs.readdirSync(surefireDir).filter((f) => f.endsWith(".txt"))) {
      const txt = fs.readFileSync(path.join(surefireDir, f), "utf8");
      if (/FAILURE|ERROR/i.test(txt)) failures += `\n----- ${f} -----\n${tail(txt, 2000)}`;
    }
  }
  return failures;
}

function collectGradleFailures(moduleRoot: string): string {
  let failures = "";
  const dir = path.join(moduleRoot, "build", "test-results", "test");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"))) {
      const xml = fs.readFileSync(path.join(dir, f), "utf8");
      const blocks = [
        ...(xml.match(/<failure[^>]*>[\s\S]*?<\/failure>/g) ?? []),
        ...(xml.match(/<error[^>]*>[\s\S]*?<\/error>/g) ?? []),
      ];
      for (const b of blocks) {
        const msg = b.replace(/<[^>]*>/g, "").trim();
        if (msg) failures += `\n----- ${f} -----\n${tail(msg, 1500)}`;
      }
    }
  }
  return failures;
}

// Pure: the distinct .java files the compiler reported errors in. Two shapes cover both
// build tools — Maven prefixes and bracket-wraps the position, javac (gradle) does not:
//   [ERROR] /abs/path/FooTest.java:[12,34] cannot find symbol
//   /abs/path/FooTest.java:12: error: cannot find symbol
// Order is first-seen, so the report reads in the order the compiler produced it.
export function extractCompileErrorFiles(raw: string): string[] {
  const seen = new Set<string>();
  const patterns = [/^\[ERROR\]\s+(.+?\.java):\[\d+,\d+\]/gm, /^(.+?\.java):\d+:\s*error:/gm];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) seen.add(m[1].trim().replace(/\\/g, "/"));
  }
  return [...seen];
}

// Test classes whose surefire report records a failure. Reports written before `since` are
// left over from an earlier run — counting them would blame classes this build never ran.
function collectFailingTestClasses(moduleRoot: string, since: number): string[] {
  const dir = path.join(moduleRoot, "target", "surefire-reports");
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".txt"))) {
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < since) continue;
    if (/FAILURE|ERROR/i.test(fs.readFileSync(p, "utf8"))) out.push(f.replace(/\.txt$/, ""));
  }
  return out.sort();
}

/**
 * Baseline pre-check: run the *same* command the build gate will run, before the writer
 * has written anything. A baseline computed with a cheaper command (test-compile, -Dtest=X)
 * is not a baseline — it would miss exactly the failures that later block the gate.
 *
 * Zero tests is not a baseline failure: a module with no tests yet is the normal case for
 * this tool, so the zero-test guard is suppressed here and left to the real gate.
 */
export async function runBaseline(tool: BuildTool, mod: ModuleInfo): Promise<BaselineResult> {
  const startedAt = Date.now();
  log("預檢：在 writer 介入前先建置一次，取得既有紅燈基準");
  const r = await runBuildAndTests(tool, mod, { allowZeroTests: true });

  if (r.passed) {
    return {
      clean: true,
      compileErrorFiles: [],
      failingTestClasses: [],
      summary: "預檢基準：乾淨（模組在 writer 介入前即可編譯且測試全過）。",
      raw: r.raw ?? "",
    };
  }

  const raw = r.raw ?? "";
  const compileErrorFiles = extractCompileErrorFiles(raw);
  const failingTestClasses =
    tool === "maven" ? collectFailingTestClasses(mod.moduleRoot, startedAt) : [];
  const lines = ["預檢基準：模組在 writer 介入前就已經是紅的。"];
  if (compileErrorFiles.length) {
    lines.push(`編譯失敗的檔案（${compileErrorFiles.length}）：`);
    compileErrorFiles.forEach((f) => lines.push(`  - ${f}`));
  }
  if (failingTestClasses.length) {
    lines.push(`測試失敗的類別（${failingTestClasses.length}）：`);
    failingTestClasses.forEach((c) => lines.push(`  - ${c}`));
  }
  if (!compileErrorFiles.length && !failingTestClasses.length) {
    lines.push("（無法從輸出定位到具體檔案，建置輸出節錄如下）");
    lines.push(tail(raw, 2000));
  }
  return {
    clean: false,
    compileErrorFiles,
    failingTestClasses,
    summary: lines.join("\n"),
    raw,
  };
}

// Pure: last "Tests run: N" in the maven stream = the Results-block aggregate.
// null = surefire never reported (no tests compiled/ran, or tests were skipped).
export function countTestsRun(mavenOut: string): number | null {
  const re = /Tests run: (\d+)/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(mavenOut))) last = m;
  return last ? Number(last[1]) : null;
}

// Zero-test detection on a *passing* build; returns the failure report, or null if tests ran.
// Maven parses the reactor stdout (with -am, upstream-module tests may inflate the count —
// errs lenient, never blocks a valid run). Gradle counts the module's TEST-*.xml (best-effort;
// gradle rewrites its results dir per run).
function detectZeroTests(tool: BuildTool, mod: ModuleInfo, out: string): string | null {
  let detail: string | null = null;
  if (tool === "maven") {
    const n = countTestsRun(out);
    if (n === null) detail = "surefire 未回報任何「Tests run」";
    else if (n === 0) detail = "surefire 回報 Tests run: 0";
  } else {
    const dir = path.join(mod.moduleRoot, "build", "test-results", "test");
    const hasResults =
      fs.existsSync(dir) &&
      fs.readdirSync(dir).some((f) => f.startsWith("TEST-") && f.endsWith(".xml"));
    if (!hasResults) detail = "build/test-results/test 沒有任何 TEST-*.xml";
  }
  if (!detail) return null;
  const testRoot = path
    .join(mod.moduleRel || ".", "src", "test", "java")
    .replace(/\\/g, "/");
  return (
    `編譯成功，但本輪實際執行了 0 個測試（${detail}）。依 fail-closed 原則 build gate 判 FAIL。\n` +
    `請在 ${testRoot} 對應 package 下建立 <ClassName>Test.java（類名以 Test 結尾、` +
    `至少一個 @Test 方法），並確認測試會被建置工具撿起。\n` +
    `（確定要允許零測試通過可設 UT_ALLOW_ZERO_TESTS=1）`
  );
}

export async function runBuildAndTests(
  tool: BuildTool,
  mod: ModuleInfo,
  opts: { allowZeroTests?: boolean } = {},
): Promise<GateResult> {
  const isWin = process.platform === "win32";
  let r: { code: number; out: string; timedOut?: boolean };

  if (tool === "maven") {
    const wrapper = isWin ? "mvnw.cmd" : "mvnw";
    const reactorHasPom = fs.existsSync(path.join(REPO_ROOT, "pom.xml"));
    const useReactor = mod.multiModule && reactorHasPom;
    const cwd = useReactor ? REPO_ROOT : mod.moduleRoot;
    const wrapperAt = fs.existsSync(path.join(cwd, wrapper));
    const cmd = wrapperAt ? (isWin ? wrapper : `./${wrapper}`) : "mvn";
    const args = [
      ...(useReactor ? ["-pl", mod.moduleRel, "-am"] : []),
      "-DskipITs",
      "test",
      ...MAVEN_EXTRA_ARGS,
    ];
    r = await shLive(cmd, args, "[mvn]", cwd, BUILD_TIMEOUT_MS);
  } else {
    const wrapper = isWin ? "gradlew.bat" : "gradlew";
    const wrapperAt = fs.existsSync(path.join(REPO_ROOT, wrapper));
    const cmd = wrapperAt ? (isWin ? wrapper : `./${wrapper}`) : "gradle";
    const args = [
      ...(mod.multiModule ? ["-p", mod.moduleRel] : []),
      "test",
      "--console=plain",
    ];
    r = await shLive(cmd, args, "[gradle]", REPO_ROOT, BUILD_TIMEOUT_MS);
  }

  if (r.timedOut) {
    return {
      passed: false,
      report:
        `建置/測試逾時（${BUILD_TIMEOUT_MS}ms），已終止程序樹。` +
        `常見原因：依賴解析卡住、測試含真實網路 I/O。可調整 UT_BUILD_TIMEOUT_MS。`,
      raw: r.out,
    };
  }

  if (r.code === 0) {
    const zeroReport =
      ALLOW_ZERO_TESTS || opts.allowZeroTests ? null : detectZeroTests(tool, mod, r.out);
    if (zeroReport) return { passed: false, report: zeroReport, raw: r.out };
    return { passed: true, report: "編譯與測試全數通過。", raw: r.out };
  }

  const failures =
    tool === "maven"
      ? collectSurefireFailures(mod.moduleRoot)
      : collectGradleFailures(mod.moduleRoot);

  return {
    passed: false,
    report: `編譯或測試失敗（exit=${r.code}）。\n建置輸出（節錄）：\n${tail(r.out)}\n${failures}`,
    raw: r.out,
  };
}
