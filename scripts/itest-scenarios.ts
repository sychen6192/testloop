// The scenario table. Each entry is setup only — what the fixture contains, what the fake
// writer does per round, and what `mvnw` replays per invocation. Assertions live in itest.ts.
//
// Naming of mvn plans: for entry="orchestrate" the plan is consumed by the build gate alone,
// so plan[0] is round 1's build. For entry="repair" plan[0] is the baseline pre-check. For
// entry="loop" plan[0] is the baseline too.
import {
  BUILD_SUCCESS,
  CALC_JAVA,
  CALC_TEST,
  COMPILE_FAILURE,
  EXISTING_TEST,
  EXISTING_TEST_DISABLED,
  EXISTING_TEST_SHRUNK,
  JACOCO_GREEN,
  JACOCO_RED,
  Scenario,
  SUREFIRE_FAIL,
  SUREFIRE_PASS,
  SUREFIRE_TXT_BLIND,
  SUREFIRE_XML,
  REACTOR_TEST_FAILURE,
  MULTI_TEST_DIR,
  UPSTREAM_TEST_DIR,
  TEST_DIR,
  TEST_FAILURE,
} from "./itest-lib";

const CALC_TEST_PATH = `${TEST_DIR}/CalcTest.java`;
const EXISTING_PATH = `${TEST_DIR}/ExistingTest.java`;
const BROKEN_PATH = `${TEST_DIR}/BrokenTest.java`;
const PROD_PATH = "src/main/java/com/x/Calc.java";

// Distinct by length, so "the writer changed something" is detectable regardless of mtime
// resolution. Rounds that must not no-op use a fresh variant each time.
const calcTest = (n: number) => `${CALC_TEST}\n// variant ${"x".repeat(n)}\n`;

const BROKEN_TEST = `package com.x;

import org.junit.jupiter.api.Test;

class BrokenTest {

    @Test
    void div_byZero_throws() {
        log.info("this does not compile");
    }
}
`;

const FIXED_TEST = `package com.x;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertThrows;

class BrokenTest {

    @Test
    void div_byZero_throwsIllegalArgument() {
        assertThrows(IllegalArgumentException.class, () -> new Calc().div(1, 0));
    }
}
`;

const verdict = (o: {
  blockers?: string[];
  advisories?: string[];
  coverage?: number;
}) =>
  JSON.stringify({
    scores: {
      effectiveness: 8,
      coverage: o.coverage ?? 8,
      independence: 8,
      readability: 8,
      fast_reliable: 8,
      mock_appropriateness: 8,
    },
    blockers: o.blockers ?? [],
    advisories: o.advisories ?? [],
  });

const GREEN_BUILD = {
  exit: 0,
  out: BUILD_SUCCESS(4),
  cleanSurefire: true,
  surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") }],
  jacoco: JACOCO_GREEN,
};

export const SCENARIOS: Scenario[] = [
  // ── The writer's scope ─────────────────────────────────────────────────────
  {
    name: "scope-violation",
    desc: "writer 改了 production code → 整個 run 中止，且不進 build gate",
    entry: "orchestrate",
    writer: [
      {
        write: {
          [CALC_TEST_PATH]: CALC_TEST,
          [PROD_PATH]: CALC_JAVA.replace("return a + b;", "return a + b + 0;"),
        },
      },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "writer-spawn-error",
    desc: "writer 程序沒起來 → 立即中止，不重試、不建置",
    entry: "orchestrate",
    writer: [{ status: "spawn-error" }],
    mvn: [GREEN_BUILD],
  },
  {
    name: "writer-no-op",
    desc: "上輪 FAIL 後 writer 什麼都沒改 → writer-no-op 中止",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, {}],
    mvn: [
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${CALC_TEST_PATH}`), cleanSurefire: true },
    ],
  },

  // ── 防掏空 ────────────────────────────────────────────────────────────────
  {
    name: "shrink-then-recover",
    desc: "writer 刪掉既有測試 → 該輪 FAIL 不進建置；補回來後才通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [EXISTING_PATH]: EXISTING_TEST_SHRUNK, [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [EXISTING_PATH]: EXISTING_TEST, [CALC_TEST_PATH]: calcTest(5) } },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "shrink-stuck",
    desc: "連兩輪維持同樣的刪減 → stuck，不燒滿 MAX_ITER",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [EXISTING_PATH]: EXISTING_TEST_SHRUNK, [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "shrink-disabled",
    desc: "@Disabled 增加也算掏空",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [EXISTING_PATH]: EXISTING_TEST_DISABLED, [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [EXISTING_PATH]: EXISTING_TEST, [CALC_TEST_PATH]: calcTest(5) } },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "shrink-allowed",
    desc: "UT_ALLOW_TEST_SHRINK=1 只警告，照樣進建置",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_TEST_SHRINK: "1" },
    writer: [{ write: { [EXISTING_PATH]: EXISTING_TEST_SHRUNK, [CALC_TEST_PATH]: calcTest(1) } }],
    mvn: [GREEN_BUILD],
  },

  // ── build gate ────────────────────────────────────────────────────────────
  {
    name: "happy-path-module-scope",
    desc: "全綠一輪過關；build 指令永遠帶 -Djacoco.append=false、預設不帶 -Dtest",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST }, outputTokens: 123 }],
    mvn: [GREEN_BUILD],
  },
  {
    name: "zero-tests",
    desc: "BUILD SUCCESS 但 Tests run: 0 → build gate 依 fail-closed 判 FAIL",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    mvn: [
      {
        exit: 0,
        cleanSurefire: true,
        out: [
          "[INFO] Scanning for projects...",
          "[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0",
          "[INFO] BUILD SUCCESS",
          "[INFO] Finished at: {{time}}",
        ].join("\n"),
      },
    ],
  },
  {
    name: "stuck-test-failure",
    desc: "測試失敗報告只有 Time elapsed 在變 → 第二輪判 stuck（fingerprint 生效）",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
      { write: { [CALC_TEST_PATH]: calcTest(17) } },
    ],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [
          { cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <3> but was: <4>") },
        ],
      },
    ],
  },
  {
    name: "progress-not-stuck",
    desc: "每輪失敗原因不同 → 不得誤判 stuck，必須跑滿 MAX_ITER（fingerprint 不過度正規化）",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "3" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
      { write: { [CALC_TEST_PATH]: calcTest(17) } },
    ],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <3> but was: <4>") }],
      },
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <0> but was: <7>") }],
      },
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <9> but was: <2>") }],
      },
    ],
  },
  {
    name: "feedback-budget",
    desc: "巨大的失敗 log 餵回 writer 前必須被 clamp 到 UT_MAX_FEEDBACK_CHARS",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_FEEDBACK_CHARS: "800", UT_MAX_ITER: "2" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    mvn: [
      {
        exit: 1,
        cleanSurefire: true,
        out: [
          "[INFO] Scanning for projects...",
          ...Array.from(
            { length: 120 },
            (_, i) => `[ERROR] /fixture/${CALC_TEST_PATH}:[${i + 1},9] cannot find symbol number ${i}`,
          ),
          "[INFO] BUILD FAILURE",
          "[INFO] Finished at: {{time}}",
        ].join("\n"),
      },
    ],
  },

  {
    name: "nested-surefire-failure",
    desc: "@Nested 測試失敗時 .txt 摘要是 0/0，必須改讀 XML 才拿得到斷言訊息",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        // The two halves of one real surefire run: the .txt reports nothing, the XML has it all.
        surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_TXT_BLIND("com.x.CalcTest") }],
        surefireXml: [
          {
            suite: "com.x.CalcTest",
            body: SUREFIRE_XML("com.x.CalcTest", 4, [
              {
                nested: "DivByZero",
                method: "div_byZero_throwsIllegalArgument",
                message: "expected: 400 BAD_REQUEST but was: 400",
                line: 41,
              },
              {
                nested: "Add",
                method: "add_twoPositives_returnsSum",
                message: "expected: <3> but was: <4>",
                line: 17,
              },
            ]),
          },
        ],
      },
    ],
  },

  // ── coverage gate ─────────────────────────────────────────────────────────
  {
    name: "coverage-below-threshold",
    desc: "建置綠但覆蓋率不足 → coverage gate FAIL，並把未覆蓋行餵回",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    mvn: [{ ...GREEN_BUILD, jacoco: JACOCO_RED }],
  },
  {
    name: "stale-jacoco",
    desc: "報告比本輪建置舊 → 視同無報告，UT_STRICT_COV=1 判 FAIL",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_STRICT_COV: "1" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    mvn: [{ ...GREEN_BUILD, jacocoAgeMs: 600_000 }],
  },

  // ── review gate ───────────────────────────────────────────────────────────
  {
    name: "review-reject-then-pass",
    desc: "blocker 與低分維度餵回下一輪，advisories 不進 feedback",
    entry: "orchestrate",
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    review: [
      {
        text: verdict({
          blockers: ["未涵蓋 div 的除零分支"],
          advisories: ["建議把測試命名再精確一點"],
          coverage: 5,
        }),
        toolCallCount: 3,
      },
      { text: verdict({}), toolCallCount: 3 },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "review-zero-tool-calls",
    desc: "reviewer 沒讀任何檔就給滿分 → fail-closed 判 REJECT",
    entry: "orchestrate",
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    review: [
      { text: verdict({}), toolCallCount: 0 },
      { text: verdict({}), toolCallCount: 0 },
    ],
    mvn: [GREEN_BUILD],
  },

  // ── UT_TEST_SCOPE=generated ───────────────────────────────────────────────
  {
    name: "scoped-final-verify",
    desc: "限縮範圍全綠但完整模組紅 → final-verify-fail 餵回，修好才算成功",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_TEST_SCOPE: "generated" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
    ],
    mvn: [
      GREEN_BUILD, // round 1, scoped
      {
        exit: 1, // round 1, full module verification
        out: TEST_FAILURE("com.x.ExistingTest"),
        cleanSurefire: true,
        surefire: [
          { cls: "com.x.ExistingTest", body: SUREFIRE_FAIL("com.x.ExistingTest", "既有測試被新測試打壞") },
        ],
      },
      GREEN_BUILD, // round 2, scoped
      { ...GREEN_BUILD, jacoco: undefined }, // round 2, full module verification
    ],
  },

  // ── 多模組 reactor（core / common / web） ─────────────────────────────────
  {
    name: "multimodule-reactor-args",
    desc: "多模組時 build gate 必須從 repo 根跑 -pl <模組> -am，且限縮同時套用到整個 reactor",
    entry: "orchestrate",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1", UT_TEST_SCOPE: "generated" },
    writer: [{ write: { [`${MULTI_TEST_DIR}/CalcTest.java`]: CALC_TEST } }],
    mvn: [
      {
        exit: 0,
        out: BUILD_SUCCESS(4),
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        surefire: [{ cls: "com.x.web.CalcTest", body: SUREFIRE_PASS("com.x.web.CalcTest"), module: "web" }],
        jacoco: { ...JACOCO_GREEN, pkg: "com/x/web" },
        jacocoModule: "web",
      },
      {
        exit: 0,
        out: BUILD_SUCCESS(210),
        jacoco: { ...JACOCO_GREEN, pkg: "com/x/web" },
        jacocoModule: "web",
      },
    ],
  },
  {
    name: "multimodule-upstream-failure-detail",
    desc: "上游模組測試失敗時，明細在 common/target 底下——gate 必須讀得到，不能只看目標模組",
    entry: "orchestrate",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [`${MULTI_TEST_DIR}/CalcTest.java`]: calcTest(1) } },
      { write: { [`${MULTI_TEST_DIR}/CalcTest.java`]: calcTest(9) } },
    ],
    mvn: [
      {
        exit: 1,
        out: REACTOR_TEST_FAILURE("common", "com.x.common.UtilTest"),
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        // The failing module is common; its reports never land under web/target.
        surefire: [
          { cls: "com.x.common.UtilTest", body: SUREFIRE_TXT_BLIND("com.x.common.UtilTest"), module: "common" },
        ],
        surefireXml: [
          {
            suite: "com.x.common.UtilTest",
            module: "common",
            body: SUREFIRE_XML("com.x.common.UtilTest", 1, [
              {
                nested: "Trim",
                method: "trim_stripsWhitespace",
                message: "expected: <a> but was: < a >",
                line: 11,
              },
            ]),
          },
        ],
      },
    ],
  },
  {
    name: "multimodule-baseline-outside-scope",
    desc: "紅燈在上游模組時，writer 根本無權修——必須立刻中止並點名，不得進修復迴圈燒輪數",
    entry: "loop",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1" },
    api: [],
    mvn: [
      {
        exit: 1,
        out: REACTOR_TEST_FAILURE("common", "com.x.common.UtilTest"),
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        surefire: [
          { cls: "com.x.common.UtilTest", body: SUREFIRE_TXT_BLIND("com.x.common.UtilTest"), module: "common" },
        ],
        surefireXml: [
          {
            suite: "com.x.common.UtilTest",
            module: "common",
            body: SUREFIRE_XML("com.x.common.UtilTest", 1, [
              {
                nested: "Trim",
                method: "trim_stripsWhitespace",
                message: "expected: <a> but was: < a >",
                line: 11,
              },
            ]),
          },
        ],
      },
    ],
  },

  {
    name: "multimodule-upstream-compile-error",
    desc: "上游模組的測試編譯不過也一樣修不了——這條走的是檔案路徑分類，不是模組比對",
    entry: "loop",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1" },
    api: [],
    mvn: [
      {
        exit: 1,
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        out: COMPILE_FAILURE(`{{root}}/${UPSTREAM_TEST_DIR}/UtilTest.java`),
      },
    ],
  },

  // ── 既有紅燈修復迴圈 ───────────────────────────────────────────────────────
  {
    name: "repair-success",
    desc: "預檢紅燈 → 修復一輪轉綠，改過的檔案列進結果",
    entry: "repair",
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    writer: [{ write: { [BROKEN_PATH]: FIXED_TEST } }],
    mvn: [
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true },
      GREEN_BUILD,
    ],
  },
  {
    name: "repair-stuck",
    desc: "修了兩輪還是同一個紅燈 → stuck",
    entry: "repair",
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    writer: [
      { write: { [BROKEN_PATH]: `${BROKEN_TEST}// try 1\n` } },
      { write: { [BROKEN_PATH]: `${BROKEN_TEST}// try 22\n` } },
    ],
    mvn: [{ exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true }],
  },
  {
    name: "repair-scope-violation",
    desc: "修復輪也受範圍 assert 約束",
    entry: "repair",
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    writer: [
      {
        write: {
          [BROKEN_PATH]: FIXED_TEST,
          [PROD_PATH]: CALC_JAVA.replace("return a + b;", "return a + b + 0;"),
        },
      },
    ],
    mvn: [{ exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true }],
  },
  {
    name: "repair-shrink-refused",
    desc: "修復輪刪既有測試 → 該輪 FAIL 不進建置，補回來才建置",
    entry: "repair",
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    writer: [
      { write: { [EXISTING_PATH]: EXISTING_TEST_SHRUNK, [BROKEN_PATH]: FIXED_TEST } },
      { write: { [EXISTING_PATH]: EXISTING_TEST } },
    ],
    mvn: [
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true },
      GREEN_BUILD,
    ],
  },
  {
    name: "repair-max-iterations",
    desc: "UT_REPAIR_MAX_ITER 用完仍紅 → repair-max-iterations，不無限重試",
    entry: "repair",
    env: { UT_REPAIR_MAX_ITER: "2" },
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    writer: [
      { write: { [BROKEN_PATH]: `${BROKEN_TEST}// try 1\n` } },
      { write: { [BROKEN_PATH]: `${BROKEN_TEST}// try 22\n` } },
    ],
    mvn: [
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`, "log"), cleanSurefire: true },
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`, "logger"), cleanSurefire: true },
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`, "LOG"), cleanSurefire: true },
    ],
  },

  // ── loop.ts 全流程（api runner + 假端點） ─────────────────────────────────
  {
    name: "loop-happy",
    desc: "預檢綠 → 產生 → 全 gate 通過，exit 0 且 artifacts 完整",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-through-proxy",
    desc: "設了 proxy 時，api runner 的請求必須真的走它——Node 的 fetch 預設無視 HTTP_PROXY",
    entry: "loop",
    proxy: true,
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-proxy-bypassed",
    desc: "UT_NO_PROXY 含 host:port 時要繞過 proxy 直連——內網模型端點的正常設定",
    entry: "loop",
    proxy: true,
    noProxy: true,
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-dirty-baseline-abort",
    desc: "預檢紅燈且關閉自動修復 → exit 非 0，summary.json 記錄 dirty-baseline",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_REPAIR_BASELINE: "0" },
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    api: [],
    mvn: [{ exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true }],
  },
  {
    name: "loop-repair-then-generate",
    desc: "預檢紅燈 → 修復轉綠 → 才開始產生新測試，兩段都寫進 artifacts",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: BROKEN_PATH, content: FIXED_TEST } }] },
      { content: "已修好 BrokenTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true },
      GREEN_BUILD,
      GREEN_BUILD,
    ],
  },
];

export const byName = (name: string): Scenario => {
  const sc = SCENARIOS.find((s) => s.name === name);
  if (!sc) throw new Error(`未知情境：${name}`);
  return sc;
};
