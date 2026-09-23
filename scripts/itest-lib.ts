// Integration-test fixtures: a fake Maven repo the gates can actually run against.
//
// The point of this file is that nothing here is a mock of the code under test. The build
// gate really spawns a process, really parses its output, really reads surefire reports and
// jacoco.xml off disk. What is faked is the *environment*: `mvnw` is a node script that
// replays a scripted plan, and the writer is an object implementing AgentRunner. That keeps
// the orchestrator's wiring — scope guard, shrink guard, stuck detection, final verification
// — under test without Java, Maven or a model, and fast enough to run on every commit.
//
// Scenarios describe setup only. The assertions live in scripts/itest.ts, next to the
// artifacts they read.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repoLockFile } from "../libs/lock";

export const TESTGEN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every UT_* the tool actually reads. Two consumers: selftest asserts each one is documented,
 * itest asserts each one is pinned before a scenario runs. Both break the moment a new knob
 * is added without the paperwork, which is the point.
 *
 * config.ts is matched loosely — every UT_* token in it, whatever the syntax — because it is
 * the declared SSOT for knobs and the reader must not have to keep up with how they are read.
 * A scanner that only knew `process.env.X` and `numEnv("X")` silently missed five knobs added
 * through an `envAny([...])` helper, which is exactly the drift these asserts exist to catch.
 */
export function envKnobsInSource(): string[] {
  const files = ["config.ts", "loop.ts", "orchestrator.ts", ...["gates", "libs", "runners"].flatMap((d) =>
    fs.readdirSync(path.join(TESTGEN_ROOT, d)).map((f) => path.join(d, f)),
  )].filter((f) => f.endsWith(".ts"));
  const found = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(path.join(TESTGEN_ROOT, f), "utf8");
    const re =
      f === "config.ts"
        ? /\bUT_[A-Z0-9_]+/g
        : /process\.env\.(UT_[A-Z0-9_]+)|process\.env\["(UT_[A-Z0-9_]+)"\]|(?:num|int)Env\("(UT_[A-Z0-9_]+)"/g;
    for (const m of src.matchAll(re)) {
      found.add(m[1] ?? m[2] ?? m[3] ?? m[0]);
    }
  }
  return [...found].sort();
}

// ─── Scenario shape ──────────────────────────────────────────────────────────

/** One `mvnw` invocation. Plans are consumed in order; the last entry repeats. */
export interface MvnStep {
  exit: number;
  /** stdout. `{{time}}` is replaced per call, so consecutive runs are not byte-identical. */
  out?: string;
  /** Wipe target/surefire-reports first (a compile failure leaves no fresh reports). */
  cleanSurefire?: boolean;
  /** Extra module dirs whose surefire reports cleanSurefire should also wipe. */
  modules?: string[];
  /** Surefire .txt reports. `module` selects the reactor module; "" is the root. */
  surefire?: Array<{ cls: string; body: string; module?: string }>;
  /** Surefire XML reports written as TEST-<suite>.xml — the source the gate prefers. */
  surefireXml?: Array<{ suite: string; body: string; module?: string }>;
  /** Absent = leave jacoco.xml alone, which is how a stale report survives a build. An array
   *  writes one sourcefile per entry — several target classes in one report. */
  jacoco?: JacocoSpec | JacocoSpec[];
  /** Which module's target/ the jacoco report lands in; "" is the root. */
  jacocoModule?: string;
  /** Backdate the written report, in ms, to simulate a report bound to a later phase. */
  jacocoAgeMs?: number;
  /** The build is killed by SIGKILL after printing its output (POSIX): the OOM killer. */
  killed?: boolean;
  /** Files the build writes, repo-relative: compiled test classes, copied test resources. */
  writeFiles?: Record<string, string>;
  /** Repo-relative: when this exists, the build prints `failOut` and exits 1 instead — surefire
   *  running a test class it found in test-classes. */
  failIfExists?: string;
  failOut?: string;
  /** Sends SIGINT to the process that ran the build (the loop), then waits to be killed: Ctrl-C. */
  interrupt?: boolean;
  /** Repo-relative file the build replaces with a directory holding a named pipe (POSIX): a path
   *  a rollback cannot put a file back at, whatever its privileges. */
  pipeDirAt?: string;
}

export interface JacocoSpec {
  pkg: string;
  file: string;
  /** [missed, covered] */
  line: [number, number];
  branch: [number, number];
  /** Line numbers to mark as missed, for the uncovered-lines hint. */
  missed?: number[];
}

/** What the scripted writer does in one round. Paths are repo-relative. */
export interface WriterAction {
  write?: Record<string, string>;
  delete?: string[];
  /** The runner never started — an environment failure, not a bad answer. */
  status?: "spawn-error";
  text?: string;
  outputTokens?: number;
}

export interface ReviewAction {
  text: string;
  toolCallCount?: number;
  /** spawn-error: never ran. timeout: ran but did not finish (deadline, provider outage). */
  status?: "spawn-error" | "timeout";
}

export interface Scenario {
  name: string;
  desc: string;
  /** orchestrate/repair run in-process; loop spawns loop.ts against a fake API endpoint. */
  entry: "orchestrate" | "repair" | "loop";
  env?: Record<string, string>;
  /** Extra fixture files, repo-relative. */
  extraFiles?: Record<string, string>;
  /** Files written as raw bytes, after extraFiles — a Big5 source is not a JS string. */
  extraBytes?: Record<string, number[]>;
  /** Leave the pre-existing test out (nothing for the shrink guard to protect). */
  omitExisting?: boolean;
  /** "multi" builds a reactor with common/core/web and targets web. Default "single". */
  layout?: "single" | "multi";
  writer?: WriterAction[];
  review?: ReviewAction[];
  /** For entry=loop: the fake endpoint's scripted turns, consumed in order. */
  api?: ApiTurn[];
  /** entry=loop: run a real forward proxy and point UT_HTTP_PROXY at it. */
  proxy?: boolean;
  /** entry=loop: also set UT_NO_PROXY to the endpoint's host:port, so it bypasses. */
  noProxy?: boolean;
  /** Make the fixture a git repo (committed), so .gitignore takes effect. */
  git?: boolean;
  /** entry=loop: put UT_RUNS_DIR inside the repo instead of under the dot-dir .itest. */
  runsInRepo?: boolean;
  /** entry=loop: another live testgen already holds this repo's lock. */
  lockHeld?: boolean;
  /** Needs a JDK (the encoding transcoder); skipped where there is none. */
  jdk?: boolean;
  /** Runs with no JDK to be found: JAVA_HOME empty, PATH holding only node (POSIX). */
  noJdk?: boolean;
  mvn: MvnStep[];
}

export interface ApiTurn {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  content?: string;
  /** finish_reason to report; "length" = the completion hit max_tokens. */
  finishReason?: string;
  /** Answer this request with an HTTP error instead: an overloaded server, a full context. */
  status?: number;
  body?: string;
  /**
   * Files the endpoint writes into the fixture (relative to its root) while serving this turn.
   * Stands in for a writer runtime whose edit permission reaches past src/test — an opencode
   * agent a target repo overrode — which the api runner's own write_file can never be.
   */
  sideWrite?: Record<string, string>;
  /** Ctrl-C while the agent session is running: SIGINT to the run holding the repo's lock. */
  interrupt?: boolean;
}

// ─── Fixture contents ────────────────────────────────────────────────────────

export const POM = `<project><modelVersion>4.0.0</modelVersion>
  <groupId>com.x</groupId><artifactId>fixture</artifactId><version>1.0</version>
</project>
`;

export const CALC_JAVA = `package com.x;

public class Calc {
    public int add(int a, int b) {
        return a + b;
    }

    public int div(int a, int b) {
        if (b == 0) {
            throw new IllegalArgumentException("b must not be zero");
        }
        return a / b;
    }
}
`;

/** Pre-existing test: 2 @Test, 2 assertions, 0 @Disabled. The shrink guard's baseline. */
export const EXISTING_TEST = `package com.x;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ExistingTest {

    @Test
    void add_twoPositives_returnsSum() {
        assertEquals(3, new Calc().add(1, 2));
    }

    @Test
    void div_byOne_returnsSameValue() {
        assertEquals(5, new Calc().div(5, 1));
    }
}
`;

/** One @Test removed — what "fixing" a failing test by deleting it looks like on disk. */
export const EXISTING_TEST_SHRUNK = `package com.x;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ExistingTest {

    @Test
    void add_twoPositives_returnsSum() {
        assertEquals(3, new Calc().add(1, 2));
    }
}
`;

/** Same counts, but the second test is switched off — also a shrink. */
export const EXISTING_TEST_DISABLED = `package com.x;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ExistingTest {

    @Test
    void add_twoPositives_returnsSum() {
        assertEquals(3, new Calc().add(1, 2));
    }

    @Disabled("flaky")
    @Test
    void div_byOne_returnsSameValue() {
        assertEquals(5, new Calc().div(5, 1));
    }
}
`;

export const CALC_TEST = `package com.x;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class CalcTest {

    @Test
    void add_twoPositives_returnsSum() {
        assertEquals(3, new Calc().add(1, 2));
    }

    @Test
    void div_byZero_throwsIllegalArgument() {
        assertThrows(IllegalArgumentException.class, () -> new Calc().div(1, 0));
    }
}
`;

/** A second variant, so "the writer changed something" is visible in a tree snapshot. */
export const CALC_TEST_V2 = CALC_TEST.replace(
  "    @Test\n    void div_byZero_throwsIllegalArgument",
  "    @Test\n    void div_byZero_throwsIllegalArgumentException",
);

// ─── The fake mvnw ───────────────────────────────────────────────────────────
//
// Extensionless and CommonJS on purpose: the build gate runs `./mvnw` from the module root
// on POSIX and `mvnw` through a shell on Windows, so the fixture ships both this and a .cmd
// shim. It records every argv it is given — that log is how the -Dtest / -Djacoco.append
// assertions are made.

export const FAKE_MVNW = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const root = __dirname;
const itest = path.join(root, ".itest");
const plan = JSON.parse(fs.readFileSync(path.join(itest, "mvn-plan.json"), "utf8"));
const counter = path.join(itest, "mvn-calls");

let n = 0;
try { n = Number(fs.readFileSync(counter, "utf8")) || 0; } catch (e) { n = 0; }
n += 1;
fs.writeFileSync(counter, String(n));
fs.appendFileSync(path.join(itest, "mvn-argv.log"), JSON.stringify(process.argv.slice(2)) + "\\n");

const step = plan[Math.min(n - 1, plan.length - 1)] || { exit: 0, out: "" };
const vary = (s) => String(s)
  .replace(/{{root}}/g, root)
  .replace(/{{time}}/g, new Date(1767225600000 + n * 1013).toISOString())
  .replace(/{{elapsed}}/g, (0.01 + n * 0.003).toFixed(3));

if (step.failIfExists && fs.existsSync(path.join(root, step.failIfExists))) {
  process.stdout.write(vary(step.failOut || "") + "\\n");
  process.exit(1);
}
for (const [rel, content] of Object.entries(step.writeFiles || {})) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
if (step.pipeDirAt && process.platform !== "win32") {
  const p = path.join(root, step.pipeDirAt);
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
  require("child_process").execFileSync("mkfifo", [path.join(p, "pipe")]);
}
if (step.interrupt) {
  process.kill(process.ppid, "SIGINT");
  setTimeout(() => process.exit(0), 60000);
  return;
}

const sfDir = (mod) => path.join(root, mod || ".", "target", "surefire-reports");
if (step.cleanSurefire) {
  const mods = new Set([""].concat(
    (step.surefire || []).map((r) => r.module || ""),
    (step.surefireXml || []).map((r) => r.module || ""),
    step.modules || [],
  ));
  for (const m of mods) fs.rmSync(sfDir(m), { recursive: true, force: true });
}
for (const r of step.surefire || []) {
  const d = sfDir(r.module);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, r.cls + ".txt"), vary(r.body));
}
for (const r of step.surefireXml || []) {
  const d = sfDir(r.module);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "TEST-" + r.suite + ".xml"), vary(r.body));
}

if (step.jacoco) {
  const specs = [].concat(step.jacoco);
  const sourcefile = (j) =>
    '<sourcefile name="' + j.file + '">\\n' +
    (j.missed || []).map((nr) => '<line nr="' + nr + '" mi="1" ci="0" mb="0" cb="0"/>').join("\\n") + '\\n' +
    '<counter type="LINE" missed="' + j.line[0] + '" covered="' + j.line[1] + '"/>\\n' +
    '<counter type="BRANCH" missed="' + j.branch[0] + '" covered="' + j.branch[1] + '"/>\\n' +
    '</sourcefile>\\n';
  const pkgs = [...new Set(specs.map((j) => j.pkg))];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\\n<report name="fixture">\\n' +
    pkgs.map((p) => '<package name="' + p + '">\\n' + specs.filter((j) => j.pkg === p).map(sourcefile).join("") + '</package>\\n').join("") +
    '</report>\\n';
  const out = path.join(root, step.jacocoModule || ".", "target", "site", "jacoco", "jacoco.xml");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, xml);
  if (step.jacocoAgeMs) {
    const t = (Date.now() - step.jacocoAgeMs) / 1000;
    fs.utimesSync(out, t, t);
  }
}

process.stdout.write(vary(step.out || "") + "\\n");
// The OOM killer's way of ending a build: no exit code, no summary, just gone.
if (step.killed && process.platform !== "win32") process.kill(process.pid, "SIGKILL");
process.exit(step.exit);
`;

export const FAKE_MVNW_CMD = `@echo off\r\nnode "%~dp0mvnw" %*\r\n`;

// ─── Maven output templates ──────────────────────────────────────────────────

export const BUILD_SUCCESS = (tests = 3) =>
  [
    "[INFO] Scanning for projects...",
    "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
    `[INFO] Tests run: ${tests}, Failures: 0, Errors: 0, Skipped: 0`,
    "[INFO] BUILD SUCCESS",
    "[INFO] Total time:  {{elapsed}} s",
    "[INFO] Finished at: {{time}}",
  ].join("\n");

/** Maven's boilerplate footer sits at the end on purpose — tail() would keep it. */
/** `file` should start with `{{root}}/` — maven prints absolute paths, and the scope
 *  classification in runBaseline reads them as such. */
export const COMPILE_FAILURE = (file: string, symbol = "log") =>
  [
    "[INFO] Scanning for projects...",
    "[INFO] --- compiler:3.13.0:testCompile (default-testCompile) @ fixture ---",
    `[ERROR] ${file}:[9,9] cannot find symbol`,
    `  symbol:   variable ${symbol}`,
    "  location: class com.x.CalcTest",
    "[INFO] BUILD FAILURE",
    "[INFO] Total time:  {{elapsed}} s",
    "[INFO] Finished at: {{time}}",
    "[ERROR] Failed to execute goal compiler:testCompile on project fixture -> [Help 1]",
    "[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.",
    "[ERROR] Re-run Maven using the -X switch to enable full debug logging.",
  ].join("\n");

/** Maven colours the level WORD, so the bytes are `[<ESC>[1;31mERROR<ESC>[m]` and the literal
 *  "[ERROR]" never appears in the log. Sample taken from a real corporate Maven 3.9 run. */
const ESC = String.fromCharCode(27);
export const withAnsi = (out: string) =>
  out.replace(/\[(ERROR|INFO|WARNING)\]/g, (_m, lvl: string) => `[${ESC}[1;31m${lvl}${ESC}[m]`);

/** A @SpringBootTest whose context will not start: the test class is squarely inside the
 *  writer's scope, and nothing it can write to that file makes the module green. Shape taken
 *  from a real run (HikariDataSource failing to decrypt its password). */
export const CONTEXT_FAILURE = [
  "[INFO] Scanning for projects...",
  "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
  "[ERROR] com.x.CalcTest -- Time elapsed: 2.104 s <<< ERROR!",
  "[ERROR] java.lang.IllegalStateException: Failed to load ApplicationContext for [WebMergedContextConfiguration@1a2b3c]",
  "[ERROR] Caused by: org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'dataSource'",
  "[ERROR] Caused by: org.apache.commons.codec.DecoderException: Odd number of characters.",
  "[INFO] BUILD FAILURE",
  "[ERROR] -> [Help 1]",
].join("\n");

/** Two files red at once, so a round can change the report text without changing the count —
 *  the exact shape the fingerprint-based stuck check cannot see. */
export const COMPILE_FAILURE_2 = (fileA: string, fileB: string, symbol = "log") =>
  [
    "[INFO] Scanning for projects...",
    "[ERROR] COMPILATION ERROR :",
    `[ERROR] ${fileA}:[9,9] cannot find symbol`,
    `  symbol:   variable ${symbol}`,
    `[ERROR] ${fileB}:[11,9] cannot find symbol`,
    `  symbol:   variable ${symbol}`,
    "[INFO] BUILD FAILURE",
    "[ERROR] Failed to execute goal compiler:testCompile on project fixture -> [Help 1]",
  ].join("\n");

/** A red build that names no file and produces no surefire report: the classifier has nothing
 *  to hand the writer, so there is no repair to attempt. */
export const UNLOCATABLE_FAILURE = [
  "[INFO] Scanning for projects...",
  "[ERROR] Failed to execute goal on project fixture: Could not resolve dependencies",
  "[ERROR] dependency com.corp:missing-lib:jar:2.1 was not found in https://repo.corp/maven",
  "[INFO] BUILD FAILURE",
  "[ERROR] -> [Help 1]",
].join("\n");

export const TEST_FAILURE = (cls = "com.x.CalcTest") =>
  [
    "[INFO] Scanning for projects...",
    "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
    "[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0",
    `[ERROR] ${cls}.div_byZero_throwsIllegalArgument -- Time elapsed: {{elapsed}} s <<< FAILURE!`,
    "[INFO] BUILD FAILURE",
    "[INFO] Total time:  {{elapsed}} s",
    "[INFO] Finished at: {{time}}",
    "[ERROR] -> [Help 1]",
  ].join("\n");

export const SUREFIRE_FAIL = (cls: string, message: string) =>
  [
    `Test set: ${cls}`,
    "-------------------------------------------------------------------------------",
    `Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s <<< FAILURE!`,
    `${cls}.div_byZero_throwsIllegalArgument  Time elapsed: {{elapsed}} s  <<< FAILURE!`,
    `org.opentest4j.AssertionFailedError: ${message}`,
    "\tat com.x.CalcTest.div_byZero_throwsIllegalArgument(CalcTest.java:17)",
  ].join("\n");

/**
 * What surefire writes into the .txt for a class whose tests all live in @Nested inner
 * classes: zero of everything, however many actually failed. The XML below is the same run.
 */
export const SUREFIRE_TXT_BLIND = (cls: string) =>
  [
    `Test set: ${cls}`,
    "-------------------------------------------------------------------------------",
    `Tests run: 0, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s -- in ${cls}`,
  ].join("\n");

export interface XmlCase {
  /** @Nested container, as surefire records it in @classname. */
  nested: string;
  method: string;
  message: string;
  line: number;
}

/** A surefire TEST-*.xml with the real shape: escaped @message, CDATA stack, framework frames. */
export const SUREFIRE_XML = (suite: string, tests: number, cases: XmlCase[]) => {
  const esc = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const blocks = cases.map(
    (c) => `<testcase name="${c.method}" classname="${suite}$${c.nested}" time="0.03">
    <failure message="${esc(c.message)}" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: ${c.message}
\tat org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)
\tat org.assertj.core.api.Assertions.assertThat(Assertions.java:1)
\tat ${suite}$${c.nested}.${c.method}(${suite.split(".").pop()}.java:${c.line})
\tat java.base/java.lang.reflect.Method.invoke(Method.java:565)
]]></failure>
  </testcase>`,
  );
  const passing = Array.from(
    { length: Math.max(0, tests - cases.length) },
    (_, i) => `<testcase name="passes_${i}" classname="${suite}$Ok" time="0.01"/>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${suite}" time="0.5" tests="${tests}" errors="0" skipped="0" failures="${cases.length}" flakes="0">
  <properties><property name="java.version" value="26"/></properties>
  ${[...blocks, ...passing].join("\n  ")}
</testsuite>
`;
};

/** What a reactor build prints when an upstream module's test fails: downstream is skipped. */
export const REACTOR_TEST_FAILURE = (module: string, cls: string) =>
  [
    "[INFO] Scanning for projects...",
    "[INFO] Reactor Build Order:",
    "[INFO] common",
    "[INFO] core",
    "[INFO] web",
    `[INFO] --- surefire:3.5.6:test (default-test) @ ${module} ---`,
    "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0",
    `[ERROR] ${cls}.trim_stripsWhitespace -- Time elapsed: {{elapsed}} s <<< FAILURE!`,
    "[INFO] Reactor Summary:",
    `[INFO] ${module} .......................................... FAILURE`,
    "[INFO] core ............................................ SKIPPED",
    "[INFO] web ............................................. SKIPPED",
    "[INFO] BUILD FAILURE",
    "[INFO] Total time:  {{elapsed}} s",
    "[INFO] Finished at: {{time}}",
    "[ERROR] -> [Help 1]",
  ].join("\n");

export const SUREFIRE_PASS = (cls: string) =>
  [
    `Test set: ${cls}`,
    "-------------------------------------------------------------------------------",
    "Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s",
  ].join("\n");

/** Full coverage of Calc.java — what a passing coverage gate reads. */
export const JACOCO_GREEN: JacocoSpec = {
  pkg: "com/x",
  file: "Calc.java",
  line: [0, 10],
  branch: [0, 2],
};

/** Below both thresholds, with the uncovered lines named. */
export const JACOCO_RED: JacocoSpec = {
  pkg: "com/x",
  file: "Calc.java",
  line: [6, 4],
  branch: [2, 0],
  missed: [9, 10, 11, 13],
};

// ─── Fixture builder ─────────────────────────────────────────────────────────

export const TARGET_DIR = "src/main/java/com/x";
export const TEST_DIR = "src/test/java/com/x";
export const RUN_DIR = ".itest/run";

// Reactor layout: web depends on core depends on common — the shape the build gate meets as
// `mvn -pl web -am test`, where every upstream module compiles and tests too.
export const MULTI_MODULES = ["common", "core", "web"] as const;
export const MULTI_TARGET_DIR = "web/src/main/java/com/x/web";
export const MULTI_TEST_DIR = "web/src/test/java/com/x/web";
export const UPSTREAM_TEST_DIR = "common/src/test/java/com/x/common";

export const targetDirOf = (sc: Scenario) =>
  sc.layout === "multi" ? MULTI_TARGET_DIR : TARGET_DIR;

const REACTOR_POM = `<project><modelVersion>4.0.0</modelVersion>
  <groupId>com.x</groupId><artifactId>reactor</artifactId><version>1.0</version>
  <packaging>pom</packaging>
  <modules>
${MULTI_MODULES.map((m) => `    <module>${m}</module>`).join("\n")}
  </modules>
</project>
`;

const MODULE_POM = (name: string) => `<project><modelVersion>4.0.0</modelVersion>
  <parent><groupId>com.x</groupId><artifactId>reactor</artifactId><version>1.0</version></parent>
  <artifactId>${name}</artifactId>
</project>
`;

/** A pre-existing upstream test. The writer must never be able to reach it. */
export const UPSTREAM_TEST = `package com.x.common;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class UtilTest {

    @Test
    void trim_stripsWhitespace() {
        assertEquals("a", Util.trim(" a "));
    }
}
`;

const UPSTREAM_MAIN = `package com.x.common;

public final class Util {
    private Util() {}

    public static String trim(String s) {
        return s == null ? null : s.strip();
    }
}
`;

function write(root: string, rel: string, content: string) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** Build a single-module Maven fixture. Everything the loop needs, nothing it does not. */
export function buildFixture(root: string, sc: Scenario): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const multi = sc.layout === "multi";
  write(root, "pom.xml", multi ? REACTOR_POM : POM);
  // The fake mvnw is CommonJS; pin it so an ancestor package.json cannot flip it to ESM.
  write(root, "package.json", JSON.stringify({ name: "fixture", type: "commonjs" }, null, 2));
  write(root, "mvnw", FAKE_MVNW);
  fs.chmodSync(path.join(root, "mvnw"), 0o755);
  write(root, "mvnw.cmd", FAKE_MVNW_CMD);

  if (multi) {
    for (const m of MULTI_MODULES) write(root, `${m}/pom.xml`, MODULE_POM(m));
    write(root, "common/src/main/java/com/x/common/Util.java", UPSTREAM_MAIN);
    write(root, `${UPSTREAM_TEST_DIR}/UtilTest.java`, UPSTREAM_TEST);
    write(root, `${MULTI_TARGET_DIR}/Calc.java`, CALC_JAVA.replace("package com.x;", "package com.x.web;"));
    if (!sc.omitExisting) {
      write(root, `${MULTI_TEST_DIR}/ExistingTest.java`, EXISTING_TEST.replace("package com.x;", "package com.x.web;"));
    }
  } else {
    write(root, `${TARGET_DIR}/Calc.java`, CALC_JAVA);
    if (!sc.omitExisting) write(root, `${TEST_DIR}/ExistingTest.java`, EXISTING_TEST);
  }
  for (const [rel, content] of Object.entries(sc.extraFiles ?? {})) write(root, rel, content);
  for (const [rel, bytes] of Object.entries(sc.extraBytes ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), Buffer.from(bytes));
  }

  // .itest is a dot-directory, so the writer-scope snapshot ignores it — the plan, the call
  // counter and the argv log all change during a run without looking like a scope violation.
  write(root, ".itest/mvn-plan.json", JSON.stringify(sc.mvn, null, 2));
  write(root, ".itest/mvn-argv.log", "");
  fs.mkdirSync(path.join(root, RUN_DIR), { recursive: true });
  if (sc.git) {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    // The developer's global git config must not reach the fixture: commit signing would block on
    // a pinentry prompt, and a global pre-commit hook could fail the commit.
    const commit = ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "fixture"];
    for (const args of [["init", "-q"], ["add", "-A"], commit]) {
      execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
    }
  }
}

/** Whether a git binary answers at all; scenarios that need one are skipped, not crashed, without it. */
export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A JDK where the loop looks for one (JAVA_HOME, else PATH): javac and java both answer. */
export function jdkAvailable(): boolean {
  const home = process.env.JAVA_HOME;
  const tool = (name: string) => (home ? path.join(home, "bin", name) : name);
  try {
    execFileSync(tool("javac"), ["-version"], { stdio: "ignore" });
    execFileSync(tool("java"), ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The lock file loop.ts takes for a repo — same derivation, so a scenario can hold it. */
export function repoLockPath(root: string): string {
  return repoLockFile(fs.realpathSync.native(root));
}

/** Apply one scripted writer round to the fixture. */
export function applyWriterAction(root: string, a: WriterAction): void {
  for (const rel of a.delete ?? []) fs.rmSync(path.join(root, rel), { force: true });
  for (const [rel, content] of Object.entries(a.write ?? {})) write(root, rel, content);
}
