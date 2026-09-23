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

  withAnsi,
  UNLOCATABLE_FAILURE,
  CONTEXT_FAILURE,
  COMPILE_FAILURE_2,} from "./itest-lib";

const CALC_TEST_PATH = `${TEST_DIR}/CalcTest.java`;
const EXISTING_PATH = `${TEST_DIR}/ExistingTest.java`;
const BROKEN_PATH = `${TEST_DIR}/BrokenTest.java`;
const PROD_PATH = "src/main/java/com/x/Calc.java";
const SUPPORT_PATH = "src/test/java/com/x/Support.java";

// A second and third class in the target folder, for the batch scenarios. Sorted by path, the
// batches are Calc, Greeter, Zeta.
const GREETER_PATH = "src/main/java/com/x/Greeter.java";
const GREETER_JAVA = `package com.x;

public class Greeter {
    public String greet(String name) {
        if (name == null || name.isEmpty()) {
            return "Hello, stranger";
        }
        return "Hello, " + name;
    }
}
`;
const GREETER_TEST_PATH = `${TEST_DIR}/GreeterTest.java`;
const GREETER_TEST = `package com.x;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class GreeterTest {
    @Test
    void greet_withName_saysHello() {
        assertEquals("Hello, Ada", new Greeter().greet("Ada"));
    }

    @Test
    void greet_withoutName_greetsStranger() {
        assertEquals("Hello, stranger", new Greeter().greet(""));
    }
}
`;
const ZETA_PATH = "src/main/java/com/x/Zeta.java";
const ZETA_JAVA = `package com.x;

public class Zeta {
    public int twice(int x) {
        return x * 2;
    }
}
`;
// A Spring Boot 2.1 module: its starter-test brings JUnit 4 only. What the pom implies is all the
// loop knows until a test has run; the first run's surefire report records the real classpath.
const BOOT21_POM = `<project><modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.1.4.RELEASE</version><relativePath/></parent>
  <groupId>com.x</groupId><artifactId>fixture</artifactId><version>1.0</version>
  <properties><java.version>1.8</java.version></properties>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-test</artifactId><scope>test</scope></dependency>
  </dependencies>
</project>
`;
const JUNIT4_CLASSPATH = "/m2/junit/junit/4.13.2/junit-4.13.2.jar:/m2/org/mockito/mockito-core/2.23.4/mockito-core-2.23.4.jar:/m2/org/assertj/assertj-core/3.11.1/assertj-core-3.11.1.jar";
const withClasspath = (xml: string, cp: string) =>
  xml.replace("<properties>", `<properties><property name="surefire.test.class.path" value="${cp}"/>`);
// ExistingTest as a zh-TW Windows repo keeps it: MS950 bytes, "// 中文" (中 = A4 A4, 文 = A4 E5).
const EXISTING_TEST_MS950 = [
  ...Buffer.from(EXISTING_TEST.replace("class ExistingTest {", "// ")),
  0xa4, 0xa4, 0xa4, 0xe5,
  ...Buffer.from("\nclass ExistingTest {" + EXISTING_TEST.split("class ExistingTest {")[1]),
];
const PLATFORM_MS950 =
  "[WARNING] Using platform encoding (MS950 actually) to copy filtered resources, i.e. build is platform dependent!\n";
const JACOCO_GREETER = { pkg: "com/x", file: "Greeter.java", line: [0, 4] as [number, number], branch: [0, 4] as [number, number] };
const GREETER_GREEN = {
  exit: 0,
  out: BUILD_SUCCESS(4),
  cleanSurefire: true,
  surefire: [{ cls: "com.x.GreeterTest", body: SUREFIRE_PASS("com.x.GreeterTest") }],
  jacoco: JACOCO_GREETER,
};
const MOCK_MAKER = "src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker";
// surefire's JVM dying under the tests (the OOM killer, a System.exit) belongs to the module,
// whichever class the batch was for: the same report but for that class's name and the numbers.
const FORK_CRASH = (cls: string) =>
  [
    "[INFO] Scanning for projects...",
    "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
    `[INFO] Running ${cls}`,
    "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test (default-test) on project fixture:",
    "[ERROR] ExecutionException The forked VM terminated without properly saying goodbye. VM crash or System.exit called?",
    "[ERROR] Command was /bin/sh -c cd {{root}} && java -Xmx64m -jar {{root}}/target/surefire/surefirebooter-{{elapsed}}.jar {{time}}-jvmRun1",
    "[ERROR] Process Exit Code: 137",
    "[ERROR] Crashed tests:",
    `[ERROR] ${cls}`,
    "[INFO] BUILD FAILURE",
    "[INFO] Total time:  {{elapsed}} s",
    "[INFO] Finished at: {{time}}",
  ].join("\n");

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

const LEGACY = "com.x.LegacyTest";
const LEGACY_PATH = `${TEST_DIR}/LegacyTest.java`;
const LEGACY_FIXED = `package com.x;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class LegacyTest {
    @Test
    void old_behaviour() {
        assertEquals(3, new Calc().add(1, 2));
    }
}
`;
const LEGACY_CASE = { nested: "", method: "old_behaviour", message: "已知失敗", line: 21 };
/** The module arrives with one test already failing, and it keeps failing every round. */
const LEGACY_RED = () => ({
  exit: 1,
  out: TEST_FAILURE(LEGACY),
  cleanSurefire: true,
  surefireXml: [{ suite: LEGACY, body: SUREFIRE_XML(LEGACY, 4, [LEGACY_CASE]) }],
});

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
    name: "scope-foreign-ignored-change",
    desc: "writer 執行期間，repo 裡執行中的應用程式寫了 logs/app.log（git-ignored）→ 不是 writer 越界，run 照常",
    entry: "orchestrate",
    git: true,
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { ".gitignore": "logs/\nsrc/main/resources/application-local.yml\n" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST, "logs/app.log": "INFO Started Application\n" } }],
    mvn: [GREEN_BUILD],
  },
  {
    name: "scope-ignored-under-src-still-blocked",
    desc: "被 .gitignore 的 src/main/resources 設定檔也是測試會載入的設定 → 照樣判 scope-violation",
    entry: "orchestrate",
    git: true,
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { ".gitignore": "logs/\nsrc/main/resources/application-local.yml\n" },
    writer: [
      {
        write: {
          [CALC_TEST_PATH]: CALC_TEST,
          "src/main/resources/application-local.yml": "feature.enabled: true\n",
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
    name: "shrink-assumption",
    desc: "在失敗的既有測試開頭塞 assumeTrue(false)：@Test 與斷言數都沒變，但測試變成「略過」→ 也算掏空",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      {
        write: {
          [EXISTING_PATH]: EXISTING_TEST.replace(
            "assertEquals(5, new Calc().div(5, 1));",
            "org.junit.jupiter.api.Assumptions.assumeTrue(false);\n        assertEquals(5, new Calc().div(5, 1));",
          ),
          [CALC_TEST_PATH]: calcTest(1),
        },
      },
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
    name: "review-unparseable-aborts",
    desc: "reviewer 吐不出 JSON → 重試 reviewer，用完就中止，不把它當 blocker 餵回 writer",
    entry: "orchestrate",
    env: { UT_REVIEW_MAX_RETRIES: "2" },
    // Only one writer action is scripted: if the loop ever fed this back and asked for another
    // round, the writer would run out and the scenario would end some other way.
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }],
    review: [
      { text: "我覺得這些測試看起來還不錯，但我需要再想想。" },
      { text: "" },
      { text: "抱歉，我無法提供 JSON。" },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "review-spawn-error-aborts",
    desc: "reviewer 根本跑不起來 → 立即中止；那是環境問題，餵給 writer 當 blocker 只會多燒一輪",
    entry: "orchestrate",
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }],
    review: [{ text: "", status: "spawn-error" }],
    mvn: [GREEN_BUILD],
  },
  {
    name: "scoped-dtest-keeps-writer-files",
    desc: "UT_TEST_SCOPE=generated：第 2 輪只改 helper，-Dtest 也要包含 writer 第 1 輪寫的測試類別（否則 0 個測試、被叫去另建檔）",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_TEST_SCOPE: "generated" },
    writer: [
      {
        write: {
          "src/test/java/com/x/CalcBehaviourTest.java": CALC_TEST.replace("class CalcTest", "class CalcBehaviourTest"),
          "src/test/java/com/x/CalcFixtures.java": "package com.x;\n\nclass CalcFixtures { static int two() { return 3; } }\n",
        },
      },
      { write: { "src/test/java/com/x/CalcFixtures.java": "package com.x;\n\nclass CalcFixtures { static int two() { return 2; } }\n" } },
    ],
    mvn: [
      { exit: 1, out: TEST_FAILURE("com.x.CalcBehaviourTest"), cleanSurefire: true },
      GREEN_BUILD,
    ],
  },
  {
    name: "review-unfinished-retried",
    desc: "reviewer 還沒讀檔就被逾時／provider 故障打斷 → 在 reviewer 端重試，不得變成「0 次工具呼叫」的 blocker 餵給 writer",
    entry: "orchestrate",
    env: { UT_REVIEW_MAX_RETRIES: "2" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }],
    review: [{ text: "", status: "timeout", toolCallCount: 0 }, { text: verdict({}), toolCallCount: 3 }],
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
    name: "repair-ansi-coloured-build-output",
    desc: "maven 上色時 [ERROR] 夾著色碼——解析仍須定位到檔案，否則 writer 收到空清單",
    entry: "repair",
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    writer: [{ write: { [BROKEN_PATH]: FIXED_TEST } }],
    mvn: [
      {
        exit: 1,
        out: withAnsi(COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`)),
        cleanSurefire: true,
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "repair-unlocatable-failure",
    desc: "建置紅但定位不到任何檔案 → 立刻中止，不得空燒修復輪",
    entry: "repair",
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    // The writer must never be asked: a prompt with an empty broken-file list has no target.
    writer: [{ write: { [BROKEN_PATH]: FIXED_TEST } }],
    mvn: [{ exit: 1, out: UNLOCATABLE_FAILURE, cleanSurefire: true }],
  },
  {
    name: "repair-test-failure-detail",
    desc: "修復輪的 prompt 必須帶斷言訊息——只給類別名，writer 只能翻檔案瞎猜",
    entry: "repair",
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [
          {
            cls: "com.x.CalcTest",
            body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <3> but was: <4>"),
          },
        ],
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "repair-no-progress",
    desc: "紅燈數連續不降 → repair-no-progress 早停；報告每輪都不同，fingerprint 的 stuck 抓不到",
    entry: "repair",
    extraFiles: {
      [BROKEN_PATH]: BROKEN_TEST,
      ["src/test/java/com/x/Broken2Test.java"]: BROKEN_TEST.replace("BrokenTest", "Broken2Test"),
    },
    writer: [
      { write: { [BROKEN_PATH]: `${BROKEN_TEST}// try 1\n` } },
      { write: { [BROKEN_PATH]: `${BROKEN_TEST}// try 22\n` } },
      { write: { [BROKEN_PATH]: `${BROKEN_TEST}// try 333\n` } },
    ],
    // Two files red throughout, with the symbol changing each round: the report is never
    // byte-identical, so only the count reveals that nothing is getting fixed.
    mvn: [
      { exit: 1, out: COMPILE_FAILURE_2(`{{root}}/${BROKEN_PATH}`, `{{root}}/src/test/java/com/x/Broken2Test.java`, "log"), cleanSurefire: true },
      { exit: 1, out: COMPILE_FAILURE_2(`{{root}}/${BROKEN_PATH}`, `{{root}}/src/test/java/com/x/Broken2Test.java`, "logger"), cleanSurefire: true },
      { exit: 1, out: COMPILE_FAILURE_2(`{{root}}/${BROKEN_PATH}`, `{{root}}/src/test/java/com/x/Broken2Test.java`, "LOG"), cleanSurefire: true },
    ],
  },
  // ── 修復迴圈的誤判（實地：跑到一半就中止） ─────────────────────────────────
  {
    name: "repair-resource-fix",
    desc: "修復只需要改 src/test/resources 的測試資料 → 那是 writer 的可寫範圍，不得判成 writer-no-op",
    entry: "repair",
    writer: [{ write: { "src/test/resources/expected-total.txt": "1050\n" } }],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.x.ExistingTest"),
        cleanSurefire: true,
        surefireXml: [{ suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "reads_fixture", message: "expected: <1050> but was: <1049>", line: 9 }]) }],
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "repair-revealed-errors",
    desc: "修好編譯錯誤後才冒出（沒被碰過的檔案的）測試失敗 → 那是進展，不得以 repair-no-progress 中止",
    entry: "repair",
    env: { UT_REPAIR_NO_PROGRESS_ROUNDS: "1" },
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    writer: [
      { write: { [BROKEN_PATH]: FIXED_TEST } },
      { write: { [EXISTING_PATH]: `${EXISTING_TEST}// fixed the assertion\n` } },
    ],
    mvn: [
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true },
      {
        exit: 1,
        out: TEST_FAILURE("com.x.ExistingTest"),
        cleanSurefire: true,
        surefireXml: [{ suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "old", message: "expected: <1> but was: <2>", line: 7 }]) }],
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "repair-thrash-still-stops",
    desc: "修好 A 卻在同一輪改過的 B 弄出新紅燈 → 那不是「揭露」，照樣算沒進展",
    entry: "repair",
    env: { UT_REPAIR_NO_PROGRESS_ROUNDS: "1" },
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    writer: [{ write: { [BROKEN_PATH]: FIXED_TEST, [EXISTING_PATH]: `${EXISTING_TEST}// broke it\n` } }],
    mvn: [
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true },
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${EXISTING_PATH}`), cleanSurefire: true },
    ],
  },
  {
    name: "repair-thrash-via-helper",
    desc: "每輪經由同一個共用 helper 修好 A、弄壞沒碰過的 B（B 用到那個 helper）→ 不是「揭露」，照樣算沒進展",
    entry: "repair",
    env: { UT_REPAIR_NO_PROGRESS_ROUNDS: "1", UT_REPAIR_MAX_ITER: "4" },
    extraFiles: {
      [BROKEN_PATH]: BROKEN_TEST,
      [EXISTING_PATH]: EXISTING_TEST.replace("new Calc().add(1, 2)", "Support.calc().add(1, 2)"),
      [SUPPORT_PATH]: "package com.x;\n\nclass Support {\n    static Calc calc() { return new Calc(); }\n}\n",
    },
    writer: [0, 1, 2, 3].map((k) => ({
      write: {
        [BROKEN_PATH]: FIXED_TEST,
        [SUPPORT_PATH]: `package com.x;\n\nclass Support {\n    // attempt ${k}\n    static Calc calc${k % 2 ? "" : "2"}() { return new Calc(); }\n}\n`,
      },
    })),
    mvn: [0, 1, 2, 3, 4].map((k) => ({
      exit: 1,
      out: COMPILE_FAILURE(`{{root}}/${k % 2 ? EXISTING_PATH : BROKEN_PATH}`),
      cleanSurefire: true,
    })),
  },
  {
    name: "repair-test-failure-swap",
    desc: "上一輪只有測試失敗（沒有東西被編譯錯誤擋住）→ 換成另一個測試失敗不是「揭露」，照樣算沒進展",
    entry: "repair",
    env: { UT_REPAIR_NO_PROGRESS_ROUNDS: "1", UT_REPAIR_MAX_ITER: "3" },
    // OtherTest names nothing the writer edits: only the kind of the previous red decides.
    extraFiles: { "src/test/java/com/x/OtherTest.java": EXISTING_TEST.replace("class ExistingTest", "class OtherTest") },
    writer: [0, 1, 2].map((k) => ({ write: { [EXISTING_PATH]: `${EXISTING_TEST}// attempt ${k}\n` } })),
    mvn: [0, 1, 2, 3].map((k) => {
      const cls = k % 2 ? "com.x.OtherTest" : "com.x.ExistingTest";
      return {
        exit: 1,
        out: TEST_FAILURE(cls),
        cleanSurefire: true,
        surefireXml: [{ suite: cls, body: SUREFIRE_XML(cls, 2, [{ nested: "", method: "shared_state", message: "expected: <1> but was: <2>", line: 7 }]) }],
      };
    }),
  },
  {
    name: "repair-flaky-baseline",
    desc: "預檢的紅燈是 flaky 測試：writer 正確地什麼都沒改 → 重跑一次確認後照常開始，不得以 writer-no-op 中止",
    entry: "repair",
    writer: [{ write: {} }],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.x.ExistingTest"),
        cleanSurefire: true,
        surefireXml: [{ suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "timing", message: "timeout", line: 7 }]) }],
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "repair-crashed-fork",
    desc: "既有測試呼叫 System.exit，surefire 只在 log 列出 Crashed tests、沒有報告 → 照樣定位到類別並修復",
    entry: "repair",
    writer: [{ write: { [EXISTING_PATH]: `${EXISTING_TEST}// no System.exit any more\n` } }],
    mvn: [
      {
        exit: 1,
        out: [
          "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
          "[ERROR] ExecutionException The forked VM terminated without properly saying goodbye. VM crash or System.exit called?",
          "[ERROR] Crashed tests:",
          "[ERROR] com.x.ExistingTest",
          "[INFO] BUILD FAILURE",
        ].join("\n"),
        cleanSurefire: true,
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "repair-max-iterations",
    desc: "UT_REPAIR_MAX_ITER 用完仍紅 → repair-max-iterations，不無限重試",
    entry: "repair",
    // The no-progress stop is disabled here on purpose: with both at their defaults it fires
    // first on this fixture, and this scenario exists to prove the iteration cap itself.
    env: { UT_REPAIR_MAX_ITER: "2", UT_REPAIR_NO_PROGRESS_ROUNDS: "9" },
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
    desc: "預檢紅燈且關閉自動修復 → exit 非 0，summary.json 記錄 dirty-baseline；輸出上色也一樣",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_REPAIR_BASELINE: "0" },
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    api: [],
    // Coloured on purpose: this is the shape a real corporate maven emits, and the run that
    // exposed the bug was exactly this one — a red baseline whose file could not be named.
    mvn: [
      {
        exit: 1,
        out: withAnsi(COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`)),
        cleanSurefire: true,
      },
    ],
  },
  // ── dirty baseline 下的 gate 扣除（DESIGN.md「gate 扣除既有失敗」） ────────
  //
  // 三個情境對應設計文件承諾的三道驗證：既有失敗原樣通過、新失敗被擋、
  // 同一類別裡的另一個方法失敗被擋（最後一個是「識別到方法層級」那道護欄的 mutation 目標）。
  {
    name: "loop-dirty-tolerated",
    desc: "既有失敗照樣紅，但 gate 扣除後放行 → exit 0；summary.json 留下容忍了什麼",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_BASELINE: "0" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [LEGACY_RED(), { ...LEGACY_RED(), jacoco: JACOCO_GREEN }],
  },
  {
    name: "loop-dirty-new-failure-blocked",
    desc: "扣除不等於放水：基準沒有的新失敗照樣擋下",
    entry: "loop",
    env: {
      UT_SKIP_REVIEW: "1",
      UT_ALLOW_DIRTY_BASELINE: "1",
      UT_REPAIR_BASELINE: "0",
      UT_MAX_ITER: "1",
    },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      LEGACY_RED(),
      {
        ...LEGACY_RED(),
        surefireXml: [
          { suite: LEGACY, body: SUREFIRE_XML(LEGACY, 4, [LEGACY_CASE]) },
          {
            suite: "com.x.OtherTest",
            body: SUREFIRE_XML("com.x.OtherTest", 2, [
              { nested: "", method: "broken_by_writer", message: "NPE", line: 12 },
            ]),
          },
        ],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "loop-dirty-same-class-new-method-blocked",
    desc: "同一個已失敗類別裡的另一個方法失敗也要擋——識別退回類別層級就會漏掉這個",
    entry: "loop",
    env: {
      UT_SKIP_REVIEW: "1",
      UT_ALLOW_DIRTY_BASELINE: "1",
      UT_REPAIR_BASELINE: "0",
      UT_MAX_ITER: "1",
    },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      LEGACY_RED(),
      {
        ...LEGACY_RED(),
        surefireXml: [
          {
            suite: LEGACY,
            body: SUREFIRE_XML(LEGACY, 4, [
              LEGACY_CASE,
              { nested: "", method: "save_rollsBack", message: "expected rollback", line: 40 },
            ]),
          },
        ],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "loop-skip-baseline-conflicts-dirty",
    desc: "UT_SKIP_BASELINE 與 UT_ALLOW_DIRTY_BASELINE 互斥：沒有基準就沒有可扣除的集合",
    entry: "loop",
    env: { UT_SKIP_BASELINE: "1", UT_ALLOW_DIRTY_BASELINE: "1" },
    api: [],
    mvn: [GREEN_BUILD],
  },
  {
    name: "loop-baseline-env-failure",
    desc: "預檢紅燈來自 Spring context 起不來 → 不進修復迴圈（檔案在可寫範圍內也一樣）",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [],
    // The failing class is com.x.CalcTest, inside the module's own src/test — outOfScope is
    // empty, so without the env classification the loop would happily enter repair.
    mvn: [
      {
        exit: 1,
        out: CONTEXT_FAILURE,
        cleanSurefire: true,
        surefire: [
          {
            cls: "com.x.CalcTest",
            body: SUREFIRE_FAIL("com.x.CalcTest", "Failed to load ApplicationContext"),
          },
        ],
      },
    ],
  },
  // ── api runner 的中途失敗（實地回報：跑到一半莫名其妙中斷） ──────────────
  {
    name: "loop-api-503-mid-run",
    desc: "第 2 輪 writer 一開始就遇到連續 503（模型伺服器重啟、閘道過載）→ 重試後繼續，run 不得中止",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(1) } }] },
      { content: "已建立 CalcTest.java" },
      // Three in a row: exactly what the old three-attempt budget could not absorb, at the
      // start of a session — which the old code reported as spawn-error and ended the run on.
      { status: 503, body: '{"error":{"message":"overloaded"}}' },
      { status: 503, body: '{"error":{"message":"overloaded"}}' },
      { status: 503, body: '{"error":{"message":"overloaded"}}' },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(9) } }] },
      { content: "已修正 CalcTest.java" },
    ],
    mvn: [
      GREEN_BUILD,
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <3> but was: <4>") }],
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "loop-api-outage-not-spawn-error",
    desc: "端點回應過之後持續失敗 → 如實說 writer session 沒完成，不得判成 spawn-error 叫人去裝 opencode",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_AGENT_RETRY_WINDOW_MS: "0" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(1) } }] },
      { content: "已建立 CalcTest.java" },
      // Persistent: a window of 0 still allows the one retry every failure gets.
      ...[0, 1, 2].map(() => ({ status: 503, body: '{"error":{"message":"overloaded"}}' })),
    ],
    mvn: [
      GREEN_BUILD,
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <3> but was: <4>") }],
      },
    ],
  },
  {
    name: "loop-api-context-overflow",
    desc: "writer 讀了幾個檔之後 context 滿了（vLLM 回 400）→ 縮短對話後繼續寫，不得在讀完檔之後空手結束",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "read_file", args: { path: PROD_PATH } }] },
      { toolCalls: [{ name: "read_file", args: { path: PROD_PATH } }] },
      {
        status: 400,
        body: JSON.stringify({
          object: "error",
          message:
            "This model's maximum context length is 32768 tokens. However, you requested 33100 tokens " +
            "(24908 in the messages, 8192 in the completion). Please reduce the length of the messages or completion.",
          type: "BadRequestError",
          code: 400,
        }),
      },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-api-truncated-write",
    desc: "writer 一次寫整個測試類別、超過 max_tokens → vLLM 把半截的呼叫當文字回傳；不得當成 writer 已完成",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      {
        content: `<tool_call>\n{"name": "write_file", "arguments": {"path": "${CALC_TEST_PATH}", "content": "package com.x;\\n\\nimport org.junit`,
        finishReason: "length",
      },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-api-gateway-200-error",
    desc: "閘道（LiteLLM / one-api）把上游逾時包成 HTTP 200 + {error} → 是失敗的請求要重試，不是模型的空答案",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "read_file", args: { path: PROD_PATH } }] },
      { status: 200, body: '{"error":{"message":"upstream request timeout","code":504}}' },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-review-think-verdict",
    desc: "reviewer 是推理模型、沒開 reasoning parser：判決前面有一段含大括號的 <think> → 照樣讀得到判決",
    entry: "loop",
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "read_file", args: { path: CALC_TEST_PATH } }] },
      { content: `<think>看一下 add_twoInts_returnsSum() { assertEquals(3, calc.add(1, 2)); } 的斷言……</think>\n${verdict({})}` },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-interface-in-target",
    desc: "目標資料夾裡有 interface（service 套件的常態）→ 略過它，不得讓 coverage gate 永遠過不了",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: {
      "src/main/java/com/x/CalcPort.java":
        "package com.x;\n\n/** Port for {@code Calc}. */\npublic interface CalcPort {\n    int add(int a, int b);\n}\n",
    },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    // JACOCO_GREEN lists Calc.java only, as a report without the interface would.
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-baseline-env-false-positive",
    desc: "預檢紅燈是普通的斷言失敗，只是另一個「通過」的測試印了 Spring 的 WARN → 照樣進修復迴圈，不得判成環境問題",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: LEGACY_PATH, content: LEGACY_FIXED } }] },
      { content: "已修好 LegacyTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      {
        ...LEGACY_RED(),
        // What Spring logs on every failed refresh — here from a passing ApplicationContextRunner
        // test that provokes one on purpose. It is in the build log; it is not why the build is red.
        out:
          "[INFO] Running com.x.AutoConfigTest\n" +
          "WARN 4242 --- [main] o.s.c.a.AnnotationConfigApplicationContext : Exception encountered during context " +
          "initialization - cancelling refresh attempt: org.springframework.beans.factory.UnsatisfiedDependencyException: " +
          "Error creating bean with name 'client'\n" +
          "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0 -- in com.x.AutoConfigTest\n" +
          TEST_FAILURE(LEGACY),
      },
      GREEN_BUILD,
      GREEN_BUILD,
    ],
  },
  {
    name: "loop-runs-dir-inside-repo",
    desc: "UT_RUNS_DIR 放在 repo 內（或工具 clone 在 repo 內）→ loop 自己的 writer-summary.md 不得觸發 scope-violation",
    entry: "loop",
    runsInRepo: true,
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-repo-lock-held",
    desc: "同一個 repo 已有另一個 testgen 在跑 → 啟動即拒絕，而不是兩邊跑到一半互判 scope-violation",
    entry: "loop",
    lockHeld: true,
    env: { UT_SKIP_REVIEW: "1" },
    api: [],
    mvn: [GREEN_BUILD],
  },
  {
    name: "loop-baseline-killed",
    desc: "預檢建置被 OOM killer 收掉（SIGKILL）→ 說清楚建置沒跑完，不得當成「定位不到的紅燈」進修復迴圈再猜 Lombok",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [],
    mvn: [{ exit: 1, out: "[INFO] Running com.x.HeavyTest", cleanSurefire: true, killed: true }],
  },
  {
    name: "loop-dirty-repair-scope-violation",
    desc: "修復輪 writer 改了 production code（scope-violation），就算 UT_ALLOW_DIRTY_BASELINE=1 也不得繼續跑到綠",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1" },
    extraFiles: { [BROKEN_PATH]: BROKEN_TEST },
    // The endpoint edits Calc.java itself while serving the repair turn — what an opencode writer
    // with edit reaching src/main would do; the api runner's write_file cannot.
    api: [
      {
        toolCalls: [{ name: "write_file", args: { path: BROKEN_PATH, content: FIXED_TEST } }],
        sideWrite: { [PROD_PATH]: CALC_JAVA.replace("return a + b;", "return a + b + 0;") },
      },
      { content: "修好了" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [{ exit: 1, out: COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true }, GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-dirty-repair-broke-green",
    desc: "修復失敗後帶著紅燈續跑：修復 writer 弄壞的、原本綠的測試不得被當成既有失敗容忍",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_MAX_ITER: "1", UT_MAX_ITER: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: EXISTING_PATH, content: `${EXISTING_TEST}// the repair writer changed an expectation\n` } }] },
      { content: "試著修了" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      LEGACY_RED(),
      ...[0, 1].map((k) => ({
        ...LEGACY_RED(),
        surefireXml: [
          { suite: LEGACY, body: SUREFIRE_XML(LEGACY, 4, [LEGACY_CASE]) },
          { suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "div_byOne", message: "expected: <5> but was: <6>", line: 9 }]) },
        ],
        ...(k === 1 ? { jacoco: JACOCO_GREEN } : {}),
      })),
    ],
  },
  {
    name: "loop-teststack-into-prompt",
    desc: "測試相依量測進 prompt：第 1 輪用 pom 推斷（Spring Boot 2.1 → 只有 JUnit 4）；第 1 輪跑過測試後，第 2 輪改用實際 classpath",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { "pom.xml": BOOT21_POM },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(1) } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(2) } }] },
      { content: "已修正" },
    ],
    mvn: [
      GREEN_BUILD,
      {
        exit: 1,
        out: TEST_FAILURE("com.x.CalcTest"),
        cleanSurefire: true,
        surefireXml: [
          {
            suite: "com.x.CalcTest",
            body: withClasspath(
              SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add", message: "expected: <3> but was: <4>", line: 9 }]),
              JUNIT4_CLASSPATH,
            ),
          },
        ],
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "loop-encoding-platform-ms950",
    desc: "pom 沒設編碼、Maven 用平台編碼 MS950：writer 的中文轉成 \\uXXXX；它用 UTF-8 改壞的 MS950 既有測試檔照原 bytes 還原、該輪 FAIL",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraBytes: { [EXISTING_PATH]: EXISTING_TEST_MS950 },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: `// 準備資料\n${calcTest(1)}` } },
          { name: "write_file", args: { path: EXISTING_PATH, content: `${EXISTING_TEST}// 補一個測試\n` } },
        ],
      },
      { content: "已建立 CalcTest.java，也補了 ExistingTest" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: `// 準備資料：兩數相加\n${calcTest(2)}` } }] },
      { content: "改寫在 CalcTest.java" },
    ],
    mvn: [{ ...GREEN_BUILD, out: PLATFORM_MS950 + BUILD_SUCCESS(4) }, GREEN_BUILD],
  },
  // ── Folder targets run as batches ──────────────────────────────────────────
  {
    name: "loop-batches-isolate-failure",
    desc: "資料夾目標分批：第 1 批（Calc）修不好 → 撤回它對 src/test 的變更、繼續第 2 批（Greeter）並通過",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "2" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: EXISTING_PATH, content: `${EXISTING_TEST}// the writer touched an existing test\n` } },
        ],
      },
      { content: "已建立 CalcTest.java" },
      { content: "修不好" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    mvn: [
      GREEN_BUILD,
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${CALC_TEST_PATH}`), cleanSurefire: true },
      {
        ...GREEN_BUILD,
        surefire: [{ cls: "com.x.GreeterTest", body: SUREFIRE_PASS("com.x.GreeterTest") }],
        jacoco: JACOCO_GREETER,
      },
    ],
  },
  {
    name: "loop-batches-all-pass",
    desc: "資料夾兩個類別分兩批、各自通過 → exit 0，每批一個 artifacts 目錄，沒有任何撤回",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    mvn: [
      GREEN_BUILD,
      GREEN_BUILD,
      {
        ...GREEN_BUILD,
        surefire: [{ cls: "com.x.GreeterTest", body: SUREFIRE_PASS("com.x.GreeterTest") }],
        jacoco: JACOCO_GREETER,
      },
    ],
  },
  {
    name: "loop-batch-size-covers-all",
    desc: "UT_BATCH_SIZE 不小於類別數 → 單一一批，行為與 artifacts 版面和以前一樣",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_BATCH_SIZE: "2" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } },
        ],
      },
      { content: "已建立兩個測試檔" },
    ],
    mvn: [
      GREEN_BUILD,
      {
        ...GREEN_BUILD,
        surefire: [
          { cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") },
          { cls: "com.x.GreeterTest", body: SUREFIRE_PASS("com.x.GreeterTest") },
        ],
        jacoco: [JACOCO_GREEN, JACOCO_GREETER],
      },
    ],
  },
  {
    name: "loop-batches-repeat-no-op-stops",
    desc: "連續兩批 writer 都沒有產出（writer-no-op）→ 那是模型端或權限的問題，停下而不是每一批都空轉",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "2" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, [ZETA_PATH]: ZETA_JAVA },
    api: [{ content: "略過" }, { content: "略過" }, { content: "略過" }, { content: "略過" }],
    mvn: [GREEN_BUILD, { ...GREEN_BUILD, jacoco: JACOCO_RED }, GREEN_BUILD],
  },
  {
    name: "loop-batches-spawn-error-stops",
    desc: "分批時 agent 無法執行（spawn-error）→ 整個 run 停下，不對每個類別各試一次",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [{ status: 401, body: '{"error":{"message":"invalid api key"}}' }],
    mvn: [GREEN_BUILD],
  },
  {
    name: "loop-batches-scope-violation-stops",
    desc: "分批時 writer 改了 production code → 整個 run 停下，變更原樣留給人檢視（不撤回、不跑後面的批次）",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      {
        toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }],
        sideWrite: { [PROD_PATH]: CALC_JAVA.replace("return a + b;", "return a + b + 0;") },
      },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "loop-batches-outputs-removed",
    desc: "撤回失敗批次時一併清掉它留在 target/test-classes 的編譯產物與資源——否則 surefire 在下一批照樣跑那支失敗的測試、MockMaker 開關照樣生效",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: {
      [GREETER_PATH]: GREETER_JAVA,
      // Outputs from before the run: not the batch's, and staying.
      "target/test-classes/com/x/ExistingTest.class": "compiled before the run",
    },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: MOCK_MAKER, content: "mock-maker-inline\n" } },
        ],
      },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    mvn: [
      GREEN_BUILD,
      {
        exit: 1,
        out: TEST_FAILURE("com.x.CalcTest"),
        cleanSurefire: true,
        surefireXml: [
          { suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add", message: "expected: <3> but was: <4>", line: 9 }]) },
        ],
        writeFiles: {
          "target/test-classes/com/x/CalcTest.class": "compiled",
          "target/test-classes/com/x/CalcTest$Nested.class": "compiled",
          "target/test-classes/mockito-extensions/org.mockito.plugins.MockMaker": "mock-maker-inline\n",
        },
      },
      // surefire runs every test class it finds in test-classes.
      { ...GREETER_GREEN, failIfExists: "target/test-classes/com/x/CalcTest.class", failOut: TEST_FAILURE("com.x.CalcTest") },
    ],
  },
  {
    name: "loop-batches-interrupted",
    desc: "第 2 批建置到一半按 Ctrl-C → 這批沒通過任何 gate 的測試比照失敗批次撤回，summary 寫明哪批完成、哪批中斷、哪些沒跑",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, [ZETA_PATH]: ZETA_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD, { exit: 0, interrupt: true }],
  },
  {
    name: "loop-batches-repeated-build-failure",
    desc: "連續兩批的建置以同樣的原因失敗（surefire 的 JVM 當掉，只差類別名稱與數字）→ 問題在批次之外，停下而不是每一批都燒完輪數",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, [ZETA_PATH]: ZETA_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    mvn: [
      GREEN_BUILD,
      { exit: 1, out: FORK_CRASH("com.x.CalcTest"), cleanSurefire: true },
      { exit: 1, out: FORK_CRASH("com.x.GreeterTest"), cleanSurefire: true },
    ],
  },
  {
    name: "loop-batches-distinct-failures-continue",
    desc: "連續兩批的建置各自失敗、原因不同（各自測試碼的編譯錯誤）→ 不是同一個外部問題，照常跑第 3 批",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, [ZETA_PATH]: ZETA_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
      { content: "Zeta 不需要新的測試" },
    ],
    mvn: [
      GREEN_BUILD,
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${CALC_TEST_PATH}`, "total"), cleanSurefire: true },
      { exit: 1, out: COMPILE_FAILURE(`{{root}}/${GREETER_TEST_PATH}`, "greeting"), cleanSurefire: true },
      GREEN_BUILD,
    ],
  },
  {
    name: "loop-batches-coverage-failures-continue",
    desc: "連續兩批都卡在覆蓋率、報告去掉類別名稱與數字後一模一樣 → 覆蓋率是各自類別的事，不當成外部問題，照常跑第 3 批",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, [ZETA_PATH]: ZETA_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
      { content: "Zeta 不需要新的測試" },
    ],
    mvn: [
      GREEN_BUILD,
      { ...GREEN_BUILD, jacoco: JACOCO_RED },
      { ...GREETER_GREEN, jacoco: { ...JACOCO_RED, file: "Greeter.java" } },
      GREEN_BUILD,
    ],
  },
  {
    name: "loop-batches-rollback-failed",
    desc: "失敗批次有檔案放不回去（這裡用一個放了 named pipe 的目錄佔住原位）→ src/test 已不是批次開始前的樣子，停下並點名，不在上面跑下一批",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, { exit: 1, out: TEST_FAILURE("com.x.CalcTest"), cleanSurefire: true, pipeDirAt: EXISTING_PATH }],
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
