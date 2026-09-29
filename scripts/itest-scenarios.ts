// The scenario table. Each entry is setup only — what the fixture contains, what the fake
// writer does per round, and what `mvnw` replays per invocation. Assertions live in itest.ts.
//
// Naming of mvn plans: for entry="orchestrate" the plan is consumed by the build gate alone,
// so plan[0] is round 1's build. For entry="repair" plan[0] is the baseline pre-check. For
// entry="loop" plan[0] is the baseline too.
import { processStart } from "../libs/shell";
import {
  ApiTurn,
  BUILD_SUCCESS,
  CALC_JAVA,
  CALC_TEST,
  COMPILE_FAILURE,
  EXISTING_TEST,
  EXISTING_TEST_DISABLED,
  EXISTING_TEST_SHRUNK,
  JACOCO_GREEN,
  JACOCO_RED,
  JacocoSpec,
  Scenario,
  SUREFIRE_FAIL,
  SUREFIRE_PASS,
  SUREFIRE_TXT_BLIND,
  SUREFIRE_XML,
  REACTOR_TEST_FAILURE,
  MULTI_TARGET_DIR,
  MULTI_TEST_DIR,
  UPSTREAM_TEST_DIR,
  TEST_DIR,
  TEST_FAILURE,
  TEST_FAILURE_IGNORED,
  TESTS_SKIPPED,

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
// A module whose build runs JUnit 4: an existing JUnit 4 test, and CalcTest written for JUnit 4.
const OLD_STYLE = "com.x.OldStyleTest";
const OLD_STYLE_PATH = `${TEST_DIR}/OldStyleTest.java`;
const OLD_STYLE_TEST = `package com.x;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class OldStyleTest {
    @Test
    public void add_works() {
        assertEquals(3, new Calc().add(1, 2));
    }
}
`;
const CALC_TEST_JUNIT4 = `package com.x;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class CalcTest {
    @Test
    public void add_twoPositives_returnsSum() {
        assertEquals(3, new Calc().add(1, 2));
    }

    @Test(expected = IllegalArgumentException.class)
    public void div_byZero_throwsIllegalArgument() {
        new Calc().div(1, 0);
    }
}
`;
// The failing ExistingTest "repaired" into TestNG: as many @Test and assertions as before, and a
// framework this module's build does not run.
const EXISTING_AS_TESTNG = `package com.x;

import org.testng.annotations.Test;
import static org.testng.Assert.assertEquals;

public class ExistingTest {

    @Test
    public void add_twoPositives_returnsSum() {
        assertEquals(new Calc().add(1, 2), 3);
    }

    @Test
    public void div_byOne_returnsSameValue() {
        assertEquals(new Calc().div(5, 1), 5);
    }
}
`;
const DISCOVERY_FILTER = "src/test/resources/META-INF/services/org.junit.platform.launcher.PostDiscoveryFilter";
// A runner class with no test methods: JUnit 4 fails it "No runnable methods".
const BASE_SERVICE_PATH = `${TEST_DIR}/BaseServiceTest.java`;
const BASE_SERVICE_TEST = `package com.x;

import org.junit.runner.RunWith;
import org.junit.runners.BlockJUnit4ClassRunner;

@RunWith(BlockJUnit4ClassRunner.class)
public class BaseServiceTest {
    protected Calc calc = new Calc();
}
`;
const ran = (...classes: string[]) => classes.map((cls) => ({ cls, body: SUREFIRE_PASS(cls) }));
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
  ...Buffer.from(`${EXISTING_TEST.split("class ExistingTest {")[0]}// `),
  0xa4, 0xa4, 0xa4, 0xe5,
  ...Buffer.from("\nclass ExistingTest {" + EXISTING_TEST.split("class ExistingTest {")[1]),
];
const PLATFORM_MS950 =
  "[WARNING] Using platform encoding (MS950 actually) to copy filtered resources, i.e. build is platform dependent!\n";
// The target class as a zh-TW repo keeps it: "// 計算" (計 = AD70, 算 = BAE2) on its first line.
const CALC_MS950 = [...Buffer.from("// "), 0xad, 0x70, 0xba, 0xe2, ...Buffer.from(`\n${CALC_JAVA}`)];
// A pom whose parent lives outside the repo: whatever it configures, the loop cannot read.
const CORP_POM = `<project><modelVersion>4.0.0</modelVersion>
  <parent><groupId>com.corp</groupId><artifactId>corp-parent</artifactId><version>9</version><relativePath/></parent>
  <groupId>com.x</groupId><artifactId>fixture</artifactId><version>1.0</version>
</project>
`;
const EXISTING_TEST_UTF8_ZH = EXISTING_TEST.replace("class ExistingTest {", "// 中文\nclass ExistingTest {");
// What an agent tool reads of that file: every non-ASCII character as its \uXXXX escape.
const EXISTING_VIEW = EXISTING_TEST.replace("class ExistingTest {", "// \\u4e2d\\u6587\nclass ExistingTest {");
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
// A build that fails on nothing any batch wrote: a dependency the repository no longer serves.
const DEPENDENCY_FAILURE = [
  "[INFO] Scanning for projects...",
  "[ERROR] Failed to execute goal on project fixture: Could not resolve dependencies for project com.x:fixture:jar:1.0:",
  "[ERROR] Could not find artifact com.corp:corp-lib:jar:9.9-SNAPSHOT in corp (https://repo.corp.example/maven2) -> [Help 1]",
  "[ERROR] Resolution failed at {{time}}, request id {{hex}}",
  "[INFO] BUILD FAILURE",
  "[INFO] Total time:  {{elapsed}} s",
  "[INFO] Finished at: {{time}}",
].join("\n");
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

export const FIXED_TEST = `package com.x;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertThrows;

class BrokenTest {

    @Test
    void div_byZero_throwsIllegalArgument() {
        assertThrows(IllegalArgumentException.class, () -> new Calc().div(1, 0));
    }
}
`;
// BrokenTest as a zh-TW Windows repo keeps it: MS950, with a Chinese comment on its first line.
const BROKEN_MS950 = [...Buffer.from("// "), 0xa4, 0xa4, 0xa4, 0xe5, ...Buffer.from(`\n${BROKEN_TEST}`)];

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

// jacoco-maven-plugin's prepare-agent line when the pom's <append>true</append> wins over
// -Djacoco.append=false (measured on JaCoCo 0.8.8), and a green build whose agent appends there: a
// report built on an earlier build's data too reads full coverage.
const JACOCO_APPENDS = (exec: string) =>
  `[INFO] argLine set to -javaagent:/m2/org/jacoco/org.jacoco.agent/0.8.8/org.jacoco.agent-0.8.8-runtime.jar=destfile={{root}}/${exec},append=true`;
const APPENDING_GREEN_BUILD = (exec: string) => ({
  exit: 0,
  out: `${JACOCO_APPENDS(exec)}\n${BUILD_SUCCESS(4)}`,
  cleanSurefire: true,
  surefire: ran("com.x.CalcTest"),
  jacoco: JACOCO_GREEN,
  jacocoExec: exec,
  jacocoIfStale: JACOCO_GREEN,
});

const GREEN_BUILD = {
  exit: 0,
  out: BUILD_SUCCESS(4),
  cleanSurefire: true,
  surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") }],
  jacoco: JACOCO_GREEN,
};
// A build red only in ExistingTest, which the writer never touches: the writer's CalcTest passes.
// Flaky, as a test that needs a local service fails when it is slow to answer; or broken by the new
// tests, as one that reads the default Locale fails after a test changed it and left it so.
const untouchedRed = (message: string) => ({
  exit: 1,
  out: TEST_FAILURE("com.x.ExistingTest"),
  cleanSurefire: true,
  surefire: [
    { cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") },
    { cls: "com.x.ExistingTest", body: SUREFIRE_FAIL("com.x.ExistingTest", message) },
  ],
});
// Gradle with ignoreFailures = true and an existing test failing: the test task says so and succeeds.
const GRADLE_IGNORED_OUT = (failed: string) =>
  [
    "> Task :test",
    "",
    failed,
    "    java.lang.AssertionError at LegacyTest.java:21",
    "",
    "3 tests completed, 1 failed",
    "There were failing tests. See the report at: file://{{root}}/build/reports/tests/test/index.html",
    "",
    "BUILD SUCCESSFUL in 2s",
  ].join("\n");
const GRADLE_LEGACY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.x.LegacyTest" tests="2" skipped="0" failures="1" errors="0" timestamp="2026-09-28T09:41:19.030Z" hostname="vm" time="0.05">
  <properties/>
  <testcase name="still_fine()" classname="com.x.LegacyTest" time="0.01"/>
  <testcase name="old_behaviour()" classname="com.x.LegacyTest" time="0.02">
    <failure message="java.lang.AssertionError: 已知失敗" type="java.lang.AssertionError">java.lang.AssertionError: 已知失敗
\tat app//com.x.LegacyTest.old_behaviour(LegacyTest.java:21)
</failure>
  </testcase>
  <system-out><![CDATA[]]></system-out>
  <system-err><![CDATA[]]></system-err>
</testsuite>
`;
// Maven 3.9 under --fail-never with the writer's test not compiling: BUILD FAILURE, the failed goal
// in full, and exit 0.
const FAIL_NEVER_COMPILE = [
  "[INFO] --- compiler:3.13.0:testCompile (default-testCompile) @ fixture ---",
  "[ERROR] COMPILATION ERROR : ",
  `[ERROR] {{root}}/${CALC_TEST_PATH}:[9,9] cannot find symbol`,
  "  symbol:   variable log",
  "  location: class com.x.CalcTest",
  "[INFO] BUILD FAILURE",
  "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:testCompile (default-testCompile) on project fixture: Compilation failure",
  `[ERROR] {{root}}/${CALC_TEST_PATH}:[9,9] cannot find symbol`,
  "[INFO] Build failures were ignored.",
].join("\n");
// The case a writer's CalcTest fails on, and one an existing test fails on, in surefire XML.
const WRITER_CASE = { nested: "", method: "div_byZero_throwsIllegalArgument", message: "Expected IllegalArgumentException to be thrown, but nothing was thrown.", line: 17 };
const EXISTING_CASE = { nested: "", method: "div_byOne_returnsSameValue", message: "Connection refused: localhost:6379", line: 13 };
const EXISTING_FLAKY_RED = untouchedRed("Connection refused: localhost:6379");
// Gradle's test-results XML for CalcTest, in the shape Gradle 8 writes it: no CDATA around a
// failure, the method name with its parentheses.
const GRADLE_CALC_XML = (failing: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.x.CalcTest" tests="2" skipped="0" failures="${failing ? 1 : 0}" errors="0" timestamp="2026-09-28T09:41:19.030Z" hostname="vm" time="0.05">
  <properties/>
  <testcase name="add_twoPositives_returnsSum()" classname="com.x.CalcTest" time="0.01"/>
  <testcase name="div_byZero_throwsIllegalArgument()" classname="com.x.CalcTest" time="0.02">${
    failing
      ? `
    <failure message="org.opentest4j.AssertionFailedError: Expected IllegalArgumentException to be thrown, but nothing was thrown." type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: Expected IllegalArgumentException to be thrown, but nothing was thrown.
\tat app//com.x.CalcTest.div_byZero_throwsIllegalArgument(CalcTest.java:17)
</failure>
  `
      : ""
  }</testcase>
  <system-out><![CDATA[]]></system-out>
  <system-err><![CDATA[]]></system-err>
</testsuite>
`;
const GRADLE_EXISTING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.x.ExistingTest" tests="1" skipped="0" failures="0" errors="0" timestamp="2026-09-28T09:41:19.030Z" hostname="vm" time="0.01">
  <properties/>
  <testcase name="div_byOne_returnsSameValue()" classname="com.x.ExistingTest" time="0.01"/>
  <system-out><![CDATA[]]></system-out>
  <system-err><![CDATA[]]></system-err>
</testsuite>
`;
const EXISTING_BROKEN_BY_NEW = untouchedRed("expected: <1,5> but was: <1.5>（預設 Locale 被新測試改成 de_DE）");

// A @Data class with a method someone wrote. JaCoCo's lines for it, shaped as the real report is
// (JaCoCo 0.8.8, Spring Boot 2.7's Lombok): equals / hashCode / toString / setters on the @Data line,
// the getters on the fields' lines, the hand-written method on its own.
const MONEY_PATH = "src/main/java/com/x/Money.java";
const MONEY_JAVA = `package com.x;

import java.math.BigDecimal;
import lombok.Data;

@Data
public class Money {
    private BigDecimal amount;
    private String currency;

    public Money plus(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException("currency mismatch");
        }
        Money m = new Money();
        m.setAmount(amount.add(other.amount));
        m.setCurrency(currency);
        return m;
    }
}
`;
const MONEY_TEST_PATH = `${TEST_DIR}/MoneyTest.java`;
const moneyTest = (withMismatch: boolean) => `package com.x;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class MoneyTest {
    private static Money of(String amount, String currency) {
        Money m = new Money();
        m.setAmount(new BigDecimal(amount));
        m.setCurrency(currency);
        return m;
    }

    @Test
    void plus_sameCurrency_addsAmounts() {
        assertEquals(new BigDecimal("3"), of("1", "TWD").plus(of("2", "TWD")).getAmount());
    }
${withMismatch ? `
    @Test
    void plus_differentCurrency_throws() {
        assertThrows(IllegalArgumentException.class, () -> of("1", "TWD").plus(of("2", "USD")));
    }
` : ""}}
`;
const moneyJacoco = (throwCovered: boolean): JacocoSpec => ({
  pkg: "com/x",
  file: "Money.java",
  lines: [
    [6, 40, 60, 20, 6],
    [8, 0, 3, 0, 0],
    [9, 0, 3, 0, 0],
    [12, 0, 6, throwCovered ? 0 : 1, throwCovered ? 2 : 1],
    [13, throwCovered ? 0 : 5, throwCovered ? 5 : 0, 0, 0],
    [15, 0, 4, 0, 0],
    [16, 0, 8, 0, 0],
    [17, 0, 4, 0, 0],
    [18, 0, 2, 0, 0],
  ],
  line: throwCovered ? [0, 9] : [1, 8],
  branch: throwCovered ? [20, 8] : [21, 7],
});
const MONEY_BUILD = (throwCovered: boolean) => ({
  exit: 0,
  out: BUILD_SUCCESS(4),
  cleanSurefire: true,
  surefire: ran("com.x.CalcTest", "com.x.MoneyTest"),
  jacoco: [JACOCO_GREEN, moneyJacoco(throwCovered)],
});

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
/** Green, with LegacyTest among what ran — once it is repaired, every build runs it. */
const GREEN_WITH_LEGACY = {
  ...GREEN_BUILD,
  surefire: [
    { cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") },
    { cls: LEGACY, body: SUREFIRE_PASS(LEGACY) },
  ],
};
/** The module arrives with one test already failing, and it keeps failing every round. */
const LEGACY_RED = () => ({
  exit: 1,
  out: TEST_FAILURE(LEGACY),
  cleanSurefire: true,
  surefireXml: [{ suite: LEGACY, body: SUREFIRE_XML(LEGACY, 4, [LEGACY_CASE]) }],
});
/** The same, in a module whose surefire ignores test failures: logged, and the build exits 0. */
const LEGACY_RED_IGNORED = () => ({ ...LEGACY_RED(), exit: 0, out: TEST_FAILURE_IGNORED(LEGACY) });


// ── Resuming an earlier run (libs/resume.ts) ─────────────────────────────────
// Two runs of loop.ts on one fixture: the first passes Calc and records it in passed.json; the rerun
// either skips Calc or — in every scenario but the plain ones — finds its pass no longer holds.
const ZETA_TEST_PATH = `${TEST_DIR}/ZetaTest.java`;
const ZETA_TEST = `package com.x;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ZetaTest {
    @Test
    void twice_positive_doubles() {
        assertEquals(4, new Zeta().twice(2));
    }
}
`;
const JACOCO_ZETA = { pkg: "com/x", file: "Zeta.java", line: [0, 2] as [number, number], branch: [0, 2] as [number, number] };
const JACOCO_GREETER_RED = { pkg: "com/x", file: "Greeter.java", line: [4, 0] as [number, number], branch: [4, 0] as [number, number] };
/** Before CalcTest exists: only the module's own test runs. */
const BASE_EXISTING = { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") };
/** Calc's round: CalcTest and ExistingTest ran, Calc fully covered. Also the rerun's baseline once CalcTest is there. */
const CALC_BUILD = { exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, surefire: ran("com.x.CalcTest", "com.x.ExistingTest"), jacoco: JACOCO_GREEN };
/** CalcTest as a test that starts a Spring context. */
const CALC_TEST_SPRING = CALC_TEST.replace(
  "import org.junit.jupiter.api.Test;",
  "import org.junit.jupiter.api.Test;\nimport org.springframework.boot.test.context.SpringBootTest;",
).replace("class CalcTest {", "@SpringBootTest\nclass CalcTest {");
const RESUME_WRITE_CALC: ApiTurn[] = [
  { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
  { content: "已建立 CalcTest.java" },
];
/** The rerun's writer, when Calc is written again: a change to the file that is there. */
const RESUME_REWRITE_CALC: ApiTurn[] = [
  { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(3) } }] },
  { content: "已更新 CalcTest.java" },
];
const REVIEW_CALC = (v: string): ApiTurn[] => [{ toolCalls: [{ name: "read_file", args: { path: CALC_TEST_PATH } }] }, { content: v }];
const scores9 = (effectiveness: number) =>
  JSON.stringify({
    scores: { effectiveness, coverage: 9, independence: 9, readability: 9, fast_reliable: 9, mock_appropriateness: 9 },
    blockers: [],
    advisories: [],
  });
/** One class, passed by the first run: the rerun's first build is its baseline, then Calc's round if it is written again. */
const resumeCalc = (o: {
  name: string;
  desc: string;
  env?: Record<string, string>;
  firstApi?: ApiTurn[];
  rerun: NonNullable<Scenario["rerun"]>;
  rerunMvn?: Scenario["mvn"];
  mvnFirst?: Scenario["mvn"];
  extraFiles?: Record<string, string>;
}): Scenario => ({
  name: o.name,
  desc: o.desc,
  entry: "loop",
  env: { UT_SKIP_REVIEW: "1", ...o.env },
  extraFiles: o.extraFiles,
  api: o.firstApi ?? RESUME_WRITE_CALC,
  rerun: o.rerun,
  mvn: [...(o.mvnFirst ?? [BASE_EXISTING, CALC_BUILD]), ...(o.rerunMvn ?? [CALC_BUILD, CALC_BUILD])],
});


// ── A run killed outright (libs/batch.ts journal, loop.ts recoverKilledBatches) ─────────────────
// Calc passes as batch 1; batch 2's writer writes GreeterTest and edits ExistingTest, and the run is
// killed — no handler runs, nothing is set aside. The rerun finds the journal and finishes the job.
const KILLED_WRITES: ApiTurn = {
  toolCalls: [
    { name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } },
    { name: "write_file", args: { path: EXISTING_PATH, content: `${EXISTING_TEST}// the killed writer was here\n` } },
  ],
};
const GREETER_ROUND = {
  ...CALC_BUILD,
  surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"),
  jacoco: [JACOCO_GREEN, JACOCO_GREETER],
};
// How each orphan scenario's rerun finds the killed run's children record changed.
const ORPHAN_REWRITES: Record<string, Partial<NonNullable<Scenario["rerun"]>>> = {
  "loop-killed-orphan-pid-reused": { rewrite: { file: "{{firstRun}}/children.json", from: /"start":"[^"]*"(?=,"cmd":"[^"]*mvnw)/, to: '"start":"1"' } },
  "loop-killed-orphan-other-checkout": { rewrite: { file: "{{firstRun}}/children.json", from: /"repoRoot":"[^"]*"/, to: '"repoRoot":"/elsewhere"' } },
  "loop-killed-orphan-other-host": { rewrite: { file: "{{firstRun}}/children.json", from: /"host":"[^"]*"/, to: '"host":"another-machine"' } },
  "loop-killed-orphan-rebooted": {
    rewrite: [
      { file: "{{firstRun}}/children.json", from: /"boot":\d+/, to: '"boot":1' },
      { file: "{{firstRun}}/children.json", from: /"bootId":"[^"]*"/, to: '"bootId":"00000000-0000-0000-0000-000000000000"' },
    ],
  },
  // The clock stepped between the runs (NTP, a resume from suspend): the estimated boot time moved,
  // the boot did not.
  "loop-killed-orphan-clock-stepped": { rewrite: { file: "{{firstRun}}/children.json", from: /"boot":(\d+)/, to: '"boot":1$1' } },
  "loop-killed-orphan-other-container": { rewrite: { file: "{{firstRun}}/children.json", from: /"pidns":"[^"]*"/, to: '"pidns":"pid:[1]"' } },
  // Stopping a build left running says nothing about src/test: the developer's fix made after the
  // crash to a file the killed writer had touched stays theirs.
  "loop-killed-orphan-build-keeps-fix": {
    backdateMs: 600_000,
    between: { [EXISTING_PATH]: `${EXISTING_TEST}// fixed by the developer after the crash\n` },
  },
  "loop-killed-orphan-corrupt-record": { rewrite: { file: "{{firstRun}}/children.json", from: /"children":\[[^\]]*\]/, to: '"children":{"not":"a list"}' } },
  // This very process — alive, and the same process its start time says — stands in for the run.
  "loop-killed-orphan-owner-alive": {
    rewrite: {
      file: "{{firstRun}}/children.json",
      from: /"pid":\d+,"start":"[^"]*","children"/,
      to: `"pid":${process.pid},"start":"${processStart(process.pid) ?? ""}","children"`,
    },
  },
};
const killedMidWriter = (o: { name: string; desc: string; rerun?: Omit<NonNullable<Scenario["rerun"]>, "api"> }): Scenario => ({
  name: o.name,
  desc: o.desc,
  entry: "loop",
  env: { UT_SKIP_REVIEW: "1" },
  extraFiles: { [GREETER_PATH]: GREETER_JAVA },
  api: [...RESUME_WRITE_CALC, KILLED_WRITES, { kill: true }],
  rerun: {
    ...o.rerun,
    api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }],
  },
  mvn: [BASE_EXISTING, CALC_BUILD, CALC_BUILD, GREETER_ROUND],
});


// For the resume review's cases: a test that passed but did not run this time, a test that failed at
// the baseline, a helper the test reaches, and Gradle's up-to-date test task.
const SUREFIRE_ALL_SKIPPED = (cls: string) =>
  [`Test set: ${cls}`, "-------------------------------------------------------------------------------", "Tests run: 2, Failures: 0, Errors: 0, Skipped: 2, Time elapsed: {{elapsed}} s"].join("\n");
const CALC_TEST_WITH_SUPPORT = CALC_TEST.replace(
  "assertEquals(3, new Calc().add(1, 2));",
  "assertEquals(3, new Calc().add(Support.one(), 2));",
);
const SUPPORT_JAVA = "package com.x;\n\nclass Support {\n    static int one() { return 1; }\n}\n";
// A TestNG run reports one suite, TEST-TestSuite.xml: the failing case's own class is in @classname.
const TESTNG_SUITE_FAIL = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="TestSuite" time="0.5" tests="3" errors="0" skipped="0" failures="1">
  <testcase name="add_twoPositives_returnsSum" classname="com.x.CalcTest" time="0.03">
    <failure message="flaky" type="java.lang.AssertionError"><![CDATA[java.lang.AssertionError: flaky
\tat com.x.CalcTest.add_twoPositives_returnsSum(CalcTest.java:10)
]]></failure>
  </testcase>
  <testcase name="passes_0" classname="com.x.CalcTest" time="0.01"/>
  <testcase name="passes_1" classname="com.x.ExistingTest" time="0.01"/>
</testsuite>
`;
const ORDER_FIXTURE = "src/test/resources/fixtures/order.json";
const CALC_TEST_CONCAT = CALC_TEST.replace(
  "assertEquals(3, new Calc().add(1, 2));",
  'assertEquals(3, new Calc().add(1, 2));\n        String fixture = "fixtures/" + "order.json";',
);
// A concrete class with tests of its own that surefire's includes never run by itself: CalcTest's base.
const CALC_CASES_PATH = `${TEST_DIR}/CalcCases.java`;
const CALC_CASES =
  "package com.x;\n\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass CalcCases {\n    @Test\n    void add_zero_isIdentity() {\n        assertEquals(2, new Calc().add(2, 0));\n    }\n}\n";
const CALC_FIXTURE_PATH = `${TEST_DIR}/CalcFixture.java`;
const CALC_FIXTURE = "package com.x;\n\nclass CalcFixture {\n    static Calc calc() { return new Calc(); }\n}\n";
// For the resume review's fourth round: what a green baseline hides — a class skipped whole inside a
// suite report, a flake surefire re-ran, a Chinese @DisplayName no report names — and what a name in a
// test resolves to.
const TESTNG_OUT = (skipped: number) =>
  [
    "[INFO] Scanning for projects...",
    "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
    "[INFO] Running TestSuite",
    `[WARNING] Tests run: 4, Failures: 0, Errors: 0, Skipped: ${skipped}, Time elapsed: {{elapsed}} s -- in TestSuite`,
    `[WARNING] Tests run: 4, Failures: 0, Errors: 0, Skipped: ${skipped}`,
    "[INFO] BUILD SUCCESS",
  ].join("\n");
/** TestNG's one report: CalcTest's cases skipped (a SkipException in its @BeforeClass) or run. */
const TESTNG_SUITE = (calcSkipped: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="TestSuite" time="0.5" tests="4" errors="0" skipped="${calcSkipped ? 2 : 0}" failures="0">
  <testcase name="add_twoPositives_returnsSum" classname="com.x.CalcTest" time="0">${calcSkipped ? '\n    <skipped message="no database"/>\n  </testcase>' : "</testcase>"}
  <testcase name="div_byZero_throwsIllegalArgument" classname="com.x.CalcTest" time="0">${calcSkipped ? '\n    <skipped message="no database"/>\n  </testcase>' : "</testcase>"}
  <testcase name="add_twoPositives_returnsSum" classname="com.x.ExistingTest" time="0.01"/>
  <testcase name="div_byOne_returnsSameValue" classname="com.x.ExistingTest" time="0.01"/>
</testsuite>
`;
const CALC_TEST_TESTNG = CALC_TEST.replace("import org.junit.jupiter.api.Test;", "import org.testng.annotations.Test;")
  .replace("import static org.junit.jupiter.api.Assertions.assertEquals;", "import static org.testng.Assert.assertEquals;")
  .replace("import static org.junit.jupiter.api.Assertions.assertThrows;", "import static org.testng.Assert.assertThrows;")
  .replace("class CalcTest {", "public class CalcTest {")
  .replace(/    void /g, "    public void ");
const CALC_TEST_CJK = CALC_TEST.replace(
  "import org.junit.jupiter.api.Test;",
  "import org.junit.jupiter.api.DisplayName;\nimport org.junit.jupiter.api.Test;",
).replace("class CalcTest {", '@DisplayName("計算機測試")\nclass CalcTest {');
const ORDER_TEST_PATH = `${TEST_DIR}/OrderTest.java`;
const ORDER_TEST = `package com.x;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

@DisplayName("訂單測試")
class OrderTest {
    @Test
    void total() {
        assertEquals(2, new Calc().add(1, 1));
    }
}
`;
/** A green build whose console names the classes it ran (surefire's default console reporter). */
const RUNNING = (...classes: string[]) =>
  [
    "[INFO] Scanning for projects...",
    "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
    ...classes.flatMap((c) => [`[INFO] Running ${c}`, `[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s -- in ${c}`]),
    `[INFO] Tests run: ${classes.length}, Failures: 0, Errors: 0, Skipped: 0`,
    "[INFO] BUILD SUCCESS",
  ].join("\n");
/** What surefire 3.2.5's phrased JUnit 5 reporter writes: named by the @DisplayName (measured). */
const PHRASED_XML = (shown: string, method: string) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${shown}" time="0.01" tests="1" errors="0" skipped="0" failures="0">
  <testcase name="${method}" classname="${shown}" time="0.003"/>
</testsuite>
`;
/** A surefire .txt summary with its counts. */
const SUREFIRE_TXT = (cls: string, tests: number, skipped: number) =>
  [
    "-------------------------------------------------------------------------------",
    `Test set: ${cls}`,
    "-------------------------------------------------------------------------------",
    `Tests run: ${tests}, Failures: 0, Errors: 0, Skipped: ${skipped}, Time elapsed: {{elapsed}} s -- in ${cls}`,
  ].join("\n");
/** A green build's console, with each class's counts. */
const RUN_COUNTS = (...classes: Array<[string, number, number]>) =>
  [
    "[INFO] Scanning for projects...",
    "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
    ...classes.flatMap(([c, n, sk]) => [
      `[INFO] Running ${c}`,
      `[${sk ? "WARNING" : "INFO"}] Tests run: ${n}, Failures: 0, Errors: 0, Skipped: ${sk}, Time elapsed: {{elapsed}} s -- in ${c}`,
    ]),
    `[INFO] Tests run: ${classes.reduce((a, [, n]) => a + n, 0)}, Failures: 0, Errors: 0, Skipped: ${classes.reduce((a, [, , sk]) => a + sk, 0)}`,
    "[INFO] BUILD SUCCESS",
  ].join("\n");
/** Reports written elsewhere (a custom reportsDirectory): the log is all there is. A test logs "[INFO] Building …". */
const SECTION_LOG = [
  "[INFO] Scanning for projects...",
  "[INFO] ----------------------------< com.x:fixture >----------------------------",
  "[INFO] Building fixture 1.0",
  "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
  "[INFO] Using auto detected provider org.apache.maven.surefire.junitplatform.JUnitPlatformProvider",
  "[INFO] Running com.x.ExistingTest",
  "[INFO] Building monthly report for 2026-09",
  "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s -- in com.x.ExistingTest",
  "[INFO] Running com.x.CalcTest",
  "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s -- in com.x.CalcTest",
  "[INFO] ",
  "[INFO] Results:",
  "[INFO] ",
  "[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0",
  "[INFO] BUILD SUCCESS",
].join("\n");
const NOOP_EXT_PATH = `${TEST_DIR}/NoopExtension.java`;
const NOOP_EXT = "package com.x;\n\nimport org.junit.jupiter.api.extension.Extension;\n\npublic class NoopExtension implements Extension {}\n";
const ORDER_SERVICE_PATH = `${TEST_DIR}/OrderServiceTest.java`;
/** Its class-level @DisplayName comes before an annotation with an array initializer. */
const ORDER_SERVICE = (disabled: boolean, shown = "訂單服務測") => `package com.x;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import static org.junit.jupiter.api.Assertions.assertEquals;

@DisplayName("${shown}")
@ExtendWith({NoopExtension.class})
${disabled ? '@Disabled("等 DB 環境")\n' : ""}class OrderServiceTest {
    @Test
    void total() {
        assertEquals(2, new Calc().add(1, 1));
    }
}
`;
/** What surefire 3.2.5 wrote for it (measured, LANG=C: TEST-?????.xml): the display name inside, whole. */
const ORDER_SERVICE_XML = (skipped: boolean, shown = "訂單服務測") => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite version="3.0" name="${shown}" time="0.001" tests="1" errors="0" skipped="${skipped ? 1 : 0}" failures="0">
  <testcase name="total" classname="${skipped ? "com.x.OrderServiceTest" : shown}" time="0.0">${skipped ? '\n    <skipped message="等 DB 環境"/>\n  ' : ""}</testcase>
</testsuite>
`;
const CALC_PHRASED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite version="3.0" name="計算機測試" time="0.02" tests="2" errors="0" skipped="0" failures="0">
  <testcase name="add_twoPositives_returnsSum" classname="計算機測試" time="0.01"/>
  <testcase name="div_byZero_throwsIllegalArgument" classname="計算機測試" time="0.01"/>
</testsuite>
`;
/** A test that failed once and passed when surefire ran it again (rerunFailingTestsCount): a green build. */
const FLAKY_CALC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.x.CalcTest" time="0.1" tests="2" errors="0" skipped="0" failures="0">
  <testcase name="add_twoPositives_returnsSum" classname="com.x.CalcTest" time="0.03">
    <flakyFailure message="expected: &lt;3&gt; but was: &lt;4&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <3> but was: <4>
\tat com.x.CalcTest.add_twoPositives_returnsSum(CalcTest.java:10)
]]></flakyFailure>
  </testcase>
  <testcase name="div_byZero_throwsIllegalArgument" classname="com.x.CalcTest" time="0.01"/>
</testsuite>
`;
const FLAKY_OUT = [
  "[INFO] Scanning for projects...",
  "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
  "[INFO] Running com.x.CalcTest",
  "[WARNING] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Flakes: 1, Time elapsed: {{elapsed}} s -- in com.x.CalcTest",
  "[INFO] Running com.x.ExistingTest",
  "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s -- in com.x.ExistingTest",
  "[INFO] Results:",
  "[WARNING] Flakes: ",
  "[WARNING] com.x.CalcTest.add_twoPositives_returnsSum",
  "[ERROR]   Run 1: CalcTest.add_twoPositives_returnsSum:10 expected: <3> but was: <4>",
  "[INFO]   Run 2: PASS",
  "[WARNING] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Flakes: 1",
  "[INFO] BUILD SUCCESS",
].join("\n");
// Two batches share a helper: batch 2's writer extends it after batch 1 passed.
const SUPPORT_V2 = SUPPORT_JAVA.replace("}\n", "    static String name() { return \"Ada\"; }\n}\n");
const GREETER_TEST_SUPPORT = GREETER_TEST.replace('new Greeter().greet("Ada")', "new Greeter().greet(Support.name())");
const CJK_FIXTURE = "src/test/resources/fixtures/訂單.json";
const CALC_TEST_CJK_FIXTURE = CALC_TEST.replace(
  "assertEquals(3, new Calc().add(1, 2));",
  'assertEquals(3, new Calc().add(1, 2));\n        String fixture = "fixtures/訂單.json";',
);
/** Named after the test, never in a string: what Spring's @Sql loads for CalcTest with no path. */
const CALC_SQL = "src/test/resources/com/x/CalcTest.sql";
/** Another package's helper of the same simple name as com.x's Support. */
const OTHER_SUPPORT_PATH = "src/test/java/com/y/Support.java";
const OTHER_SUPPORT = SUPPORT_JAVA.replace("package com.x;", "package com.y;");
/** A class Spring's context loading finds with no test naming it. */
const TEST_CONFIG_PATH = `${TEST_DIR}/TestConfig.java`;
const TEST_CONFIG = "package com.x;\n\nimport org.springframework.boot.test.context.TestConfiguration;\n\n@TestConfiguration\nclass TestConfig {\n}\n";
const LEGACY_HELPER_PATH = `${TEST_DIR}/LegacyHelper.java`;
const LEGACY_HELPER = "package com.x;\n\nclass LegacyHelper {\n    static int three() { return 3; }\n}\n";
const GRADLE_TEST_RAN = "> Task :compileTestJava\n> Task :test\n\nBUILD SUCCESSFUL in 1s\n";
const GRADLE_TEST_UP_TO_DATE = "> Task :compileTestJava UP-TO-DATE\n> Task :test UP-TO-DATE\n\nBUILD SUCCESSFUL in 1s\n";
const gradleResults = (...classes: string[]) =>
  Object.fromEntries(
    classes.map((cls) => [
      `build/test-results/test/TEST-${cls}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${cls}" tests="1" skipped="0" failures="0" errors="0" timestamp="2026-09-28T09:41:19.030Z" hostname="vm" time="0.05">\n  <testcase name="t()" classname="${cls}" time="0.01"/>\n</testsuite>\n`,
    ]),
  );

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
    name: "shrink-silenced",
    desc: "把失敗的既有測試改成 private（JUnit 5 不執行 private 的 @Test）、另一個開頭丟 TestAbortedException：@Test 與斷言數都沒變 → 也算掏空",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      {
        write: {
          [EXISTING_PATH]: EXISTING_TEST.replace("    void div_byOne_returnsSameValue", "    private void div_byOne_returnsSameValue").replace(
            "assertEquals(3, new Calc().add(1, 2));",
            "if (true) throw new org.opentest4j.TestAbortedException(\"later\");\n        assertEquals(3, new Calc().add(1, 2));",
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
    name: "tests-not-run-framework",
    desc: "建置綠，但 writer 的 JUnit 5 測試沒被執行（這個模組跑的是 JUnit 4）→ build gate FAIL，說明要改寫成 JUnit 4；改寫後通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [OLD_STYLE_PATH]: OLD_STYLE_TEST },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }, { write: { [CALC_TEST_PATH]: CALC_TEST_JUNIT4 } }],
    mvn: [
      { exit: 0, out: BUILD_SUCCESS(1), cleanSurefire: true, surefire: ran(OLD_STYLE), jacoco: JACOCO_GREEN },
      { exit: 0, out: BUILD_SUCCESS(3), cleanSurefire: true, surefire: ran(OLD_STYLE, "com.x.CalcTest"), jacoco: JACOCO_GREEN },
    ],
  },
  {
    name: "tests-all-skipped-in-suite",
    desc: "TestNG：writer 新寫的 CalcTest 只出現在 TEST-TestSuite.xml、每個 case 都被略過（@BeforeClass 丟 SkipException）→ build gate 判 FAIL；下一輪真的跑了才通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST_TESTNG } }, { write: { [CALC_TEST_PATH]: `${CALC_TEST_TESTNG}// 不依環境略過\n` } }],
    mvn: [
      { exit: 0, out: TESTNG_OUT(2), cleanSurefire: true, surefireXml: [{ suite: "TestSuite", body: TESTNG_SUITE(true) }], jacoco: JACOCO_GREEN },
      { exit: 0, out: TESTNG_OUT(0), cleanSurefire: true, surefireXml: [{ suite: "TestSuite", body: TESTNG_SUITE(false) }], jacoco: JACOCO_GREEN },
    ],
  },
  {
    name: "tests-not-run-cjk-display-name",
    desc: "writer 新寫的 CalcTest（@DisplayName(\"計算機測試\")）沒被執行，另一個中文 display name 的既有類別有（phrased 報告，檔名 ????）→ build gate 判 FAIL；下一輪以它的名字出現才通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [ORDER_TEST_PATH]: ORDER_TEST },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST_CJK } }, { write: { [CALC_TEST_PATH]: `${CALC_TEST_CJK}// 改名以符合 includes\n` } }],
    // surefire's console still names classes by FQCN: that is how the check sees this module's reports at all.
    mvn: [
      { exit: 0, out: RUNNING("com.x.OrderTest"), cleanSurefire: true, surefireXml: [{ suite: "????", body: PHRASED_XML("訂單測試", "total") }], jacoco: JACOCO_GREEN },
      {
        exit: 0,
        out: RUNNING("com.x.OrderTest"),
        cleanSurefire: true,
        surefireXml: [
          { suite: "????", body: PHRASED_XML("訂單測試", "total") },
          { suite: "?????", body: PHRASED_XML("計算機測試", "add_twoPositives_returnsSum") },
        ],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "tests-not-run-grown",
    desc: "writer 把測試加進一個從來沒被執行的既有 JUnit 5 類別（這個模組只跑 JUnit 4）→ 綠燈但加的測試沒被執行，判 FAIL；改寫成 JUnit 4 的新類別後通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [OLD_STYLE_PATH]: OLD_STYLE_TEST },
    writer: [
      {
        write: {
          [EXISTING_PATH]: EXISTING_TEST.replace(
            "    @Test\n    void div_byOne_returnsSameValue",
            "    @Test\n    void add_negatives() {\n        assertEquals(-3, new Calc().add(-1, -2));\n    }\n\n    @Test\n    void div_byOne_returnsSameValue",
          ),
        },
      },
      { write: { [EXISTING_PATH]: EXISTING_TEST, [CALC_TEST_PATH]: CALC_TEST_JUNIT4 } },
    ],
    mvn: [
      { exit: 0, out: BUILD_SUCCESS(1), cleanSurefire: true, surefire: ran(OLD_STYLE), jacoco: JACOCO_GREEN },
      { exit: 0, out: BUILD_SUCCESS(3), cleanSurefire: true, surefire: ran(OLD_STYLE, "com.x.CalcTest"), jacoco: JACOCO_GREEN },
    ],
  },
  {
    name: "coverage-lombok-generated-lines",
    desc: "@Data 類別帶一個手寫方法，產生的 equals/hashCode 分支都沒測（JaCoCo 的分支 28.6%）→ 只算寫出來的邏輯，100% 通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [MONEY_PATH]: MONEY_JAVA },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST, [MONEY_TEST_PATH]: moneyTest(true) } }],
    mvn: [MONEY_BUILD(true)],
  },
  {
    name: "coverage-lombok-real-miss",
    desc: "同一個 @Data 類別，手寫方法裡丟例外的分支沒測到 → 照樣 FAIL，回饋只點名那一行（不點名 @Data 那行）；補上之後通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [MONEY_PATH]: MONEY_JAVA },
    writer: [
      { write: { [CALC_TEST_PATH]: CALC_TEST, [MONEY_TEST_PATH]: moneyTest(false) } },
      { write: { [MONEY_TEST_PATH]: moneyTest(true) } },
    ],
    mvn: [MONEY_BUILD(false), MONEY_BUILD(true)],
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
    name: "coverage-jacoco-append-forced",
    desc: "pom 以 <append>true</append> 蓋過 -Djacoco.append=false → 第 1 輪的覆蓋率不得算進第 2 輪（writer 刪掉的測試不能還替它過關）",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [
      { write: { [CALC_TEST_PATH]: calcTest(1) } },
      // The failing test goes, and with it the only test of div's branch.
      { write: { [CALC_TEST_PATH]: calcTest(9) } },
      { write: { [CALC_TEST_PATH]: calcTest(17) } },
    ],
    mvn: [
      {
        exit: 1,
        out: `${JACOCO_APPENDS("target/coverage-reports/jacoco-ut.exec")}\n${TEST_FAILURE()}`,
        cleanSurefire: true,
        surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <3> but was: <4>") }],
        jacocoExec: "target/coverage-reports/jacoco-ut.exec",
      },
      { ...APPENDING_GREEN_BUILD("target/coverage-reports/jacoco-ut.exec"), jacoco: JACOCO_RED },
      APPENDING_GREEN_BUILD("target/coverage-reports/jacoco-ut.exec"),
    ],
  },
  {
    name: "coverage-jacoco-exec-left-over",
    desc: "開發者自己跑過的 mvn test 留下 target/jacoco.exec、pom 又設成累加 → 第一次建置也不得把它算進覆蓋率",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { "target/jacoco.exec": "the developer's own run" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [{ ...APPENDING_GREEN_BUILD("target/jacoco.exec"), jacoco: JACOCO_RED }, APPENDING_GREEN_BUILD("target/jacoco.exec")],
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
      { ...GREEN_BUILD, surefire: [{ cls: "com.x.CalcBehaviourTest", body: SUREFIRE_PASS("com.x.CalcBehaviourTest") }] },
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
      EXISTING_BROKEN_BY_NEW, // round 1, full module verification
      EXISTING_BROKEN_BY_NEW, // round 1, its rebuild: the same red, so not flaky
      GREEN_BUILD, // round 2, scoped
      { ...GREEN_BUILD, jacoco: undefined }, // round 2, full module verification
    ],
  },
  {
    name: "scoped-final-verify-flaky",
    desc: "限縮範圍全綠、完整模組重跑時一個 writer 沒碰過的既有測試失敗、再重跑就過 → flaky：照樣通過，不浪費一輪，點名要人檢視",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_TEST_SCOPE: "generated" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }],
    mvn: [
      GREEN_BUILD, // round 1, scoped
      EXISTING_FLAKY_RED, // round 1, full module verification
      { ...GREEN_BUILD, jacoco: undefined, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") }, // its rebuild
    ],
  },
  {
    name: "build-flaky-untouched-test",
    desc: "建置只失敗在 writer 沒碰過的既有測試、重跑就過 → flaky：同一輪照常往下走，不浪費一輪、不會以 writer-no-op 收場，結果點名要人檢視",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [EXISTING_FLAKY_RED, { ...GREEN_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") }],
  },
  {
    name: "build-collateral-untouched-test",
    desc: "建置只失敗在 writer 沒碰過的既有測試、重跑仍失敗 → 被新測試連累：回饋說是 writer 寫的測試留下的共享狀態，要它別改那個既有測試",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [EXISTING_BROKEN_BY_NEW, EXISTING_BROKEN_BY_NEW, GREEN_BUILD],
  },
  {
    name: "build-untouched-broken-no-op",
    desc: "既有測試重跑仍失敗、writer 判斷不是它造成的而沒有改任何檔 → writer-no-op 收場，但說明是那些既有測試需要人檢視，不是 writer 的 context 或權限",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { text: "ExistingTest 的失敗與我寫的測試無關" }],
    mvn: [EXISTING_BROKEN_BY_NEW, EXISTING_BROKEN_BY_NEW],
  },
  {
    name: "build-collateral-then-own-red-no-op",
    desc: "第 1 輪被連累、第 2 輪是 writer 自己的測試紅、第 3 輪 writer 沒改 → writer-no-op 的說明不得沿用第 1 輪「既有測試可能本身壞了」",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "5" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }, { text: "改不動了" }],
    mvn: [
      EXISTING_BROKEN_BY_NEW,
      EXISTING_BROKEN_BY_NEW,
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <3> but was: <4>") }],
      },
    ],
  },
  {
    name: "build-compile-error-with-untouched-red-no-rerun",
    desc: "writer 的測試編不過，同一次建置裡還有它沒碰過的測試失敗（上游設了 testFailureIgnore 時會這樣）→ 編譯錯誤不會重跑就消失：照常餵回、不重跑，也不把紅燈算到那個既有測試頭上",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [{ ...EXISTING_FLAKY_RED, out: COMPILE_FAILURE(`{{root}}/${CALC_TEST_PATH}`) }, GREEN_BUILD],
  },
  {
    name: "build-crash-untouched-flaky",
    desc: "writer 沒碰過的既有測試，fork 的 JVM 中途結束（surefire 只在 log 點名、沒有報告）、重跑就過 → 一樣判 flaky",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      { exit: 1, out: FORK_CRASH("com.x.ExistingTest"), cleanSurefire: true },
      { ...GREEN_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") },
    ],
  },
  {
    name: "build-killed-no-rerun",
    desc: "建置被 SIGKILL 收掉（OOM），留下的報告只有 writer 沒碰過的既有測試失敗 → 建置沒跑完不重跑：再跑一次多半又是一樣久、一樣被收掉",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [{ ...EXISTING_FLAKY_RED, killed: true }, GREEN_BUILD],
  },
  {
    name: "build-unplaceable-failure-no-rerun",
    desc: "失敗的類別在模組裡找不到原始碼（例如以 @DisplayName 命名的報告）→ 分不出是不是 writer 的，照常餵回、不重跑",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.x.CalculatorSpecification"),
        cleanSurefire: true,
        surefire: [{ cls: "com.x.CalculatorSpecification", body: SUREFIRE_FAIL("com.x.CalculatorSpecification", "expected: <3> but was: <4>") }],
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "build-own-test-red-no-rerun",
    desc: "失敗的有 writer 自己寫的測試（連同一個它沒碰過的）→ 照常餵回，不重跑：重跑只給「全部都不是 writer 碰過的」",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE(),
        cleanSurefire: true,
        surefire: [
          { cls: "com.x.CalcTest", body: SUREFIRE_FAIL("com.x.CalcTest", "expected: <3> but was: <4>") },
          { cls: "com.x.ExistingTest", body: SUREFIRE_FAIL("com.x.ExistingTest", "Connection refused: localhost:6379") },
        ],
      },
      GREEN_BUILD,
    ],
  },

  // ── Maven 的 exit code 不是它的判定 ──────────────────────────────────────────
  {
    name: "build-test-failure-ignored",
    desc: "pom 設了 testFailureIgnore：writer 的測試失敗，Maven 仍 exit 0、BUILD SUCCESS → 照樣判紅、把失敗餵回，不能以 gates-passed 收場",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [
      {
        exit: 0,
        out: TEST_FAILURE_IGNORED(),
        cleanSurefire: true,
        surefireXml: [{ suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [WRITER_CASE]) }],
        jacoco: JACOCO_GREEN,
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "build-test-failure-ignored-reports-only",
    desc: "exit 0、log 沒有 surefire 的失敗摘要，但這次建置寫的報告記著一個 error（計數是 errors=\"1\"、failures=\"0\"）→ 以報告為準判紅",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [
      {
        exit: 0,
        out: BUILD_SUCCESS(4),
        cleanSurefire: true,
        // An error, not a failure: the counters say errors="1", failures="0".
        surefireXml: [
          {
            suite: "com.x.CalcTest",
            body:
              '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="com.x.CalcTest" time="0.5" tests="2" errors="1" skipped="0" failures="0">\n' +
              '  <testcase name="add_twoPositives_returnsSum" classname="com.x.CalcTest" time="0.01"/>\n' +
              '  <testcase name="div_byZero_throwsIllegalArgument" classname="com.x.CalcTest" time="0.03">\n' +
              '    <error message="Cannot invoke &quot;com.x.Calc.div(int, int)&quot; because &quot;this.calc&quot; is null" type="java.lang.NullPointerException">' +
              "<![CDATA[java.lang.NullPointerException: Cannot invoke \"com.x.Calc.div(int, int)\" because \"this.calc\" is null\n" +
              "\tat com.x.CalcTest.div_byZero_throwsIllegalArgument(CalcTest.java:17)\n]]></error>\n  </testcase>\n</testsuite>\n",
          },
        ],
        jacoco: JACOCO_GREEN,
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "build-test-failure-ignored-flaky",
    desc: "testFailureIgnore 下只有 writer 沒碰過的既有測試失敗、重跑就過 → 一樣判 flaky、同一輪照常往下走",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      {
        exit: 0,
        out: TEST_FAILURE_IGNORED("com.x.ExistingTest"),
        cleanSurefire: true,
        surefire: ran("com.x.CalcTest"),
        surefireXml: [{ suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [EXISTING_CASE]) }],
        jacoco: JACOCO_GREEN,
      },
      { ...GREEN_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") },
    ],
  },
  {
    name: "build-flaky-rerun-green",
    desc: "surefire 2.x 的 rerunFailingTestsCount：既有測試失敗一次、重跑通過，建置綠（Flakes: 1），報告的 failures=\"1\" 底下只有 <flakyFailure> → 不得判紅",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      {
        exit: 0,
        out: [
          "[INFO] --- maven-surefire-plugin:2.22.2:test (default-test) @ fixture ---",
          "[ERROR] div_byOne_returnsSameValue(com.x.ExistingTest)  Time elapsed: 0.015 s  <<< FAILURE!",
          "[WARNING] Flakes: ",
          "[ERROR]   Run 1: ExistingTest.div_byOne_returnsSameValue:13 Connection refused",
          "[WARNING] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Flakes: 1",
          "[INFO] BUILD SUCCESS",
        ].join("\n"),
        cleanSurefire: true,
        surefire: [
          ...ran("com.x.CalcTest"),
          // What surefire 2.22 writes into the .txt for it: indistinguishable from a real failure.
          {
            cls: "com.x.ExistingTest",
            body: [
              "Test set: com.x.ExistingTest",
              "-------------------------------------------------------------------------------",
              "Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.092 s <<< FAILURE! - in com.x.ExistingTest",
              "div_byOne_returnsSameValue(com.x.ExistingTest)  Time elapsed: 0.015 s  <<< FAILURE!",
              "java.lang.AssertionError: Connection refused",
            ].join("\n"),
          },
        ],
        surefireXml: [
          {
            suite: "com.x.ExistingTest",
            body:
              '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="com.x.ExistingTest" time="0.09" tests="3" errors="0" skipped="0" failures="1">\n' +
              '  <testcase name="add_twoPositives_returnsSum" classname="com.x.ExistingTest" time="0.001"/>\n' +
              '  <testcase name="div_byOne_returnsSameValue" classname="com.x.ExistingTest" time="0.001">\n' +
              '    <flakyFailure message="Connection refused" type="java.lang.AssertionError">\n      <stackTrace>java.lang.AssertionError: Connection refused\n</stackTrace>\n    </flakyFailure>\n' +
              "  </testcase>\n</testsuite>\n",
          },
        ],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "build-fail-never-compile-error",
    desc: "--fail-never（.mvn/maven.config 的 -fn）：writer 的測試編不過，Maven 印 BUILD FAILURE 卻 exit 0 → 判紅、餵回的是編譯錯誤，不是「沒有執行任何測試」",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [{ exit: 0, out: FAIL_NEVER_COMPILE, cleanSurefire: true }, GREEN_BUILD],
  },
  {
    name: "build-fail-never-other-plugin-green",
    desc: "--fail-never 吞掉的是別的 plugin（copy-resources）的失敗、測試全過 → 不是 writer 的事，照常綠燈（專案本來就這樣活著）",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      {
        exit: 0,
        out: [
          BUILD_SUCCESS(4).replace("[INFO] BUILD SUCCESS", "[INFO] BUILD FAILURE"),
          "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-resources-plugin:3.3.1:copy-resources (always-broken) on project fixture: The parameters 'resources', 'outputDirectory' for goal org.apache.maven.plugins:maven-resources-plugin:3.3.1:copy-resources are missing or invalid -> [Help 1]",
          "[INFO] Build failures were ignored.",
        ].join("\n"),
        cleanSurefire: true,
        surefire: ran("com.x.CalcTest"),
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "gradle-test-failure-ignored",
    desc: "Gradle 的 test 任務設了 ignoreFailures = true：writer 的測試失敗，gradle 仍 exit 0、BUILD SUCCESSFUL → 照樣判紅、把失敗餵回",
    entry: "orchestrate",
    buildTool: "gradle",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [
      {
        exit: 0,
        out: [
          "> Task :test",
          "",
          "CalcTest > div_byZero_throwsIllegalArgument() FAILED",
          "    org.opentest4j.AssertionFailedError at CalcTest.java:17",
          "",
          "2 tests completed, 1 failed",
          "There were failing tests. See the report at: file://{{root}}/build/reports/tests/test/index.html",
          "",
          "BUILD SUCCESSFUL in 2s",
        ].join("\n"),
        writeFiles: { "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(true) },
        jacoco: JACOCO_GREEN,
      },
      {
        exit: 0,
        out: "> Task :test\n\nBUILD SUCCESSFUL in 2s",
        writeFiles: { "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(false) },
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "build-quiet-green",
    desc: ".mvn/maven.config 有 -q：綠的建置什麼都不印（沒有 Tests run）→ 以這次建置的報告為準，不得判成「執行了 0 個測試」",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      {
        exit: 0,
        out: "",
        cleanSurefire: true,
        surefireXml: [{ suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, []) }],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "build-error-only-custom-reports",
    desc: "surefire 3.x、testFailureIgnore、報告寫到自訂目錄：只有 error（測試丟例外）時 log 沒有「There are test failures.」，只有 ERROR 級的 Results 總計 → 照樣判紅",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [
      {
        exit: 0,
        out: [
          "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
          "[INFO] Running com.x.CalcTest",
          "[ERROR] Tests run: 2, Failures: 0, Errors: 1, Skipped: 0, Time elapsed: {{elapsed}} s <<< FAILURE! -- in com.x.CalcTest",
          "[ERROR] com.x.CalcTest.div_byZero_throwsIllegalArgument -- Time elapsed: {{elapsed}} s <<< ERROR!",
          'java.lang.NullPointerException: Cannot invoke "com.x.Calc.div(int, int)" because "this.calc" is null',
          "[INFO] Results:",
          "[ERROR] Errors: ",
          '[ERROR]   CalcTest.div_byZero_throwsIllegalArgument:17 NullPointer Cannot invoke "com.x.Calc.div(int, int)" because "this.calc" is null',
          "[ERROR] Tests run: 2, Failures: 0, Errors: 1, Skipped: 0",
          "[ERROR] ",
          "Please refer to {{root}}/target/test-reports for the individual test results.",
          "[INFO] BUILD SUCCESS",
        ].join("\n"),
        cleanSurefire: true,
        jacoco: JACOCO_GREEN,
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "build-flaky-cdata-green",
    desc: "surefire 3.x 重跑後通過的 flaky 測試，報告在 <flakyFailure> 的 CDATA 裡留著「<error code=503>」→ 那不是失敗，不得判紅",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      {
        exit: 0,
        out: [
          "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
          "[INFO] Running com.x.ExistingTest",
          "[WARNING] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Flakes: 1, Time elapsed: {{elapsed}} s -- in com.x.ExistingTest",
          "[INFO] Results:",
          "[WARNING] Flakes: ",
          "[WARNING] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Flakes: 1",
          "[INFO] BUILD SUCCESS",
        ].join("\n"),
        cleanSurefire: true,
        surefire: ran("com.x.CalcTest"),
        surefireXml: [
          {
            suite: "com.x.ExistingTest",
            body:
              '<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="com.x.ExistingTest" time="0.06" tests="3" errors="0" skipped="0" failures="1">\n' +
              '  <testcase name="add_twoPositives_returnsSum" classname="com.x.ExistingTest" time="0.0"/>\n' +
              '  <testcase name="div_byOne_returnsSameValue" classname="com.x.ExistingTest" time="0.0">\n' +
              '    <flakyFailure message="unexpected response: &lt;error code=&quot;503&quot;&gt;busy&lt;/error&gt;" type="java.lang.AssertionError">\n' +
              '      <stackTrace><![CDATA[java.lang.AssertionError: unexpected response: <error code="503">busy</error>\n\tat com.x.ExistingTest.div_byOne_returnsSameValue(ExistingTest.java:13)\n]]></stackTrace>\n' +
              "    </flakyFailure>\n  </testcase>\n</testsuite>\n",
          },
        ],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "build-own-output-headline-green",
    desc: "測試自己印出「[ERROR] There are test failures.」（它跑了一個內嵌建置）、自己通過 → 那是測試的輸出，不是 surefire 的判定，不得判紅",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      {
        exit: 0,
        out: [
          "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
          "[INFO] Running com.x.CalcTest",
          "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0",
          "[ERROR] There are test failures.",
          "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s -- in com.x.CalcTest",
          "[INFO] Results:",
          "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0",
          "[INFO] BUILD SUCCESS",
        ].join("\n"),
        cleanSurefire: true,
        surefire: ran("com.x.CalcTest"),
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "build-quiet-upstream-only",
    desc: "-q、目標模組的測試被跳過（maven.test.skip）、上游模組的測試有跑 → 安靜模式的報告只算目標模組的：一個測試都沒跑，不得放行",
    entry: "orchestrate",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    writer: [{ write: { [`${MULTI_TEST_DIR}/CalcTest.java`]: CALC_TEST.replace("package com.x;", "package com.x.web;") } }],
    mvn: [
      {
        exit: 0,
        out: "",
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        surefireXml: [{ suite: "com.x.common.UtilTest", body: SUREFIRE_XML("com.x.common.UtilTest", 1, []), module: "common" }],
        jacoco: { ...JACOCO_GREEN, pkg: "com/x/web" },
        jacocoModule: "web",
      },
    ],
  },
  {
    name: "gradle-retry-passed-green",
    desc: "Gradle 的 test-retry plugin：ExistingTest 第一次失敗、重試通過，每一次各寫成一個 test case，建置綠——log 照樣說「1 failed」「There were failing tests」（實測 test-retry 1.6.2）→ 不得判紅",
    entry: "orchestrate",
    buildTool: "gradle",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [
      {
        exit: 0,
        out: "> Task :test\n3 tests completed, 1 failed\nThere were failing tests. See the report at: file:///w/build/reports/tests/test/index.html\n\nBUILD SUCCESSFUL in 3s",
        writeFiles: {
          "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(false),
          "build/test-results/test/TEST-com.x.ExistingTest.xml": `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.x.ExistingTest" tests="3" skipped="0" failures="1" errors="0" timestamp="2026-09-28T09:41:19.030Z" hostname="vm" time="0.05">
  <properties/>
  <testcase name="add_twoPositives_returnsSum()" classname="com.x.ExistingTest" time="0.01"/>
  <testcase name="div_byOne_returnsSameValue()" classname="com.x.ExistingTest" time="0.02">
    <failure message="java.net.ConnectException: Connection refused" type="java.net.ConnectException">java.net.ConnectException: Connection refused
</failure>
  </testcase>
  <testcase name="div_byOne_returnsSameValue()" classname="com.x.ExistingTest" time="0.02"/>
  <system-out><![CDATA[]]></system-out>
  <system-err><![CDATA[]]></system-err>
</testsuite>
`,
        },
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "gradle-up-to-date-failing",
    desc: "Gradle 的 test 任務 up-to-date（什麼都不印），測試結果裡記著失敗（ignoreFailures 下上次就失敗了）→ 照樣判紅",
    entry: "orchestrate",
    buildTool: "gradle",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: calcTest(1) } }, { write: { [CALC_TEST_PATH]: calcTest(9) } }],
    mvn: [
      {
        exit: 0,
        out: "> Task :compileTestJava UP-TO-DATE\n> Task :test UP-TO-DATE\n\nBUILD SUCCESSFUL in 827ms",
        writeFiles: { "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(true) },
        jacoco: JACOCO_GREEN,
      },
      {
        exit: 0,
        out: "> Task :test\n\nBUILD SUCCESSFUL in 2s",
        writeFiles: { "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(false) },
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "ran-check-section-not-cut-by-test-output",
    desc: "報告寫到別處（自訂 reportsDirectory），log 的 Running 行是唯一證據；ExistingTest 印了一行「[INFO] Building monthly report…」→ CalcTest 的 Running 行仍在目標模組的 surefire 區段裡，第 1 輪通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [{ exit: 0, out: SECTION_LOG, cleanSurefire: true, jacoco: JACOCO_GREEN }],
  },
  {
    name: "ran-check-lossy-report-of-disabled-class",
    desc: "phrased XML 檔名、POSIX 檔名編碼：CalcTest（「計算機測試」）有跑、2 個都過；@Disabled 的 OrderServiceTest（「訂單服務測」，寫在 @ExtendWith({…}) 之前）最後寫了同一個 TEST-?????.xml → 那份是它的，CalcTest 不算全部被略過，第 1 輪通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [NOOP_EXT_PATH]: NOOP_EXT, [ORDER_SERVICE_PATH]: ORDER_SERVICE(true) },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST_CJK } }],
    mvn: [
      {
        exit: 0,
        out: RUN_COUNTS(["com.x.CalcTest", 2, 0], ["com.x.ExistingTest", 2, 0], ["com.x.OrderServiceTest", 1, 1]),
        cleanSurefire: true,
        surefire: [
          { cls: "com.x.CalcTest", body: SUREFIRE_TXT("com.x.CalcTest", 2, 0) },
          { cls: "com.x.ExistingTest", body: SUREFIRE_TXT("com.x.ExistingTest", 2, 0) },
          { cls: "com.x.OrderServiceTest", body: SUREFIRE_TXT("com.x.OrderServiceTest", 1, 1) },
        ],
        surefireXml: [{ suite: "?????", body: ORDER_SERVICE_XML(true) }],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "ran-check-exact-report-of-disabled-class",
    desc: "phrased XML 檔名、UTF-8 檔名編碼：CalcTest 與 @Disabled 的 OrderServiceTest 都叫「服務測試」，後者最後寫了 TEST-服務測試.xml；CalcTest 有跑、2 個都過 → 以它自己的報告為準，不算全部被略過，第 1 輪通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [NOOP_EXT_PATH]: NOOP_EXT, [ORDER_SERVICE_PATH]: ORDER_SERVICE(true, "服務測試") },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST_CJK.replace("計算機測試", "服務測試") } }],
    mvn: [
      {
        exit: 0,
        out: RUN_COUNTS(["com.x.CalcTest", 2, 0], ["com.x.ExistingTest", 2, 0], ["com.x.OrderServiceTest", 1, 1]),
        cleanSurefire: true,
        surefire: [
          { cls: "com.x.CalcTest", body: SUREFIRE_TXT("com.x.CalcTest", 2, 0) },
          { cls: "com.x.ExistingTest", body: SUREFIRE_TXT("com.x.ExistingTest", 2, 0) },
          { cls: "com.x.OrderServiceTest", body: SUREFIRE_TXT("com.x.OrderServiceTest", 1, 1) },
        ],
        surefireXml: [{ suite: "服務測試", body: ORDER_SERVICE_XML(true, "服務測試") }],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "ran-check-lossy-report-credited",
    desc: "phrased XML 檔名、POSIX 檔名編碼：CalcTest（「計算機測試」）第 1 輪沒被執行；有跑的 OrderServiceTest（「訂單服務測」）寫了 TEST-?????.xml → 那不是 CalcTest 的報告：第 1 輪判 FAIL，第 2 輪 CalcTest 有跑才通過",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [NOOP_EXT_PATH]: NOOP_EXT, [ORDER_SERVICE_PATH]: ORDER_SERVICE(false) },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST_CJK } }, { write: { [CALC_TEST_PATH]: `${CALC_TEST_CJK}// 第 2 輪\n` } }],
    mvn: [
      {
        exit: 0,
        out: RUN_COUNTS(["com.x.ExistingTest", 2, 0], ["com.x.OrderServiceTest", 1, 0]),
        cleanSurefire: true,
        surefire: [
          { cls: "com.x.ExistingTest", body: SUREFIRE_TXT("com.x.ExistingTest", 2, 0) },
          { cls: "com.x.OrderServiceTest", body: SUREFIRE_TXT("com.x.OrderServiceTest", 1, 0) },
        ],
        surefireXml: [{ suite: "?????", body: ORDER_SERVICE_XML(false) }],
        jacoco: JACOCO_GREEN,
      },
      {
        exit: 0,
        out: RUN_COUNTS(["com.x.CalcTest", 2, 0], ["com.x.ExistingTest", 2, 0], ["com.x.OrderServiceTest", 1, 0]),
        cleanSurefire: true,
        surefire: [
          { cls: "com.x.CalcTest", body: SUREFIRE_TXT("com.x.CalcTest", 2, 0) },
          { cls: "com.x.ExistingTest", body: SUREFIRE_TXT("com.x.ExistingTest", 2, 0) },
          { cls: "com.x.OrderServiceTest", body: SUREFIRE_TXT("com.x.OrderServiceTest", 1, 0) },
        ],
        surefireXml: [{ suite: "?????", body: CALC_PHRASED_XML }],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "gradle-stale-results-not-evidence",
    desc: "上一次建置留在 build/test-results/test 的 TEST-com.x.CalcTest.xml（通過）；這次的建置沒有執行 CalcTest → 舊的結果不算它有跑：第 1 輪判 FAIL，第 2 輪真的執行了才通過",
    entry: "orchestrate",
    buildTool: "gradle",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(false) },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }, { write: { [CALC_TEST_PATH]: `${CALC_TEST}// 第 2 輪\n` } }],
    mvn: [
      {
        exit: 0,
        out: "> Task :test\n\nBUILD SUCCESSFUL in 2s",
        writeFiles: { "build/test-results/test/TEST-com.x.ExistingTest.xml": GRADLE_EXISTING_XML },
        jacoco: JACOCO_GREEN,
      },
      {
        exit: 0,
        out: "> Task :test\n\nBUILD SUCCESSFUL in 2s",
        writeFiles: {
          "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(false),
          "build/test-results/test/TEST-com.x.ExistingTest.xml": GRADLE_EXISTING_XML,
        },
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "build-tests-skipped",
    desc: "沒有預檢、模組的測試被設定跳過（skipTests）→ 回報說明是設定跳過了測試、該設什麼，而不是叫 writer 去建測試類別",
    entry: "orchestrate",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    writer: [{ write: { [CALC_TEST_PATH]: CALC_TEST } }],
    mvn: [{ exit: 0, out: TESTS_SKIPPED, cleanSurefire: true }],
  },

  {
    name: "loop-scoped-final-verify-not-run",
    desc: "限縮範圍下 writer 另外加了讓既有測試不再被探索到的測試資源：限縮的建置只跑新測試、看不出來 → 最終驗收的完整重跑發現 ExistingTest 沒被執行，餵回；拿掉後通過",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_TEST_SCOPE: "generated" },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: DISCOVERY_FILTER, content: "com.x.OnlyCalc\n" } },
        ],
      },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: DISCOVERY_FILTER, content: "" } }] },
      { content: "已拿掉 discovery filter" },
    ],
    mvn: [
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") }, // baseline
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.CalcTest"), jacoco: JACOCO_GREEN }, // round 1, scoped
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.CalcTest"), jacoco: JACOCO_GREEN }, // round 1, full
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.CalcTest"), jacoco: JACOCO_GREEN }, // round 2, scoped
      { exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, surefire: ran("com.x.ExistingTest", "com.x.CalcTest"), jacoco: JACOCO_GREEN }, // round 2, full
    ],
  },

  // ── 多模組 reactor（core / common / web） ─────────────────────────────────
  {
    name: "multimodule-reactor-args",
    desc: "多模組時 build gate 必須從 repo 根跑 -pl <模組> -am，且限縮同時套用到整個 reactor",
    entry: "orchestrate",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1", UT_TEST_SCOPE: "generated" },
    writer: [{ write: { [`${MULTI_TEST_DIR}/CalcTest.java`]: CALC_TEST.replace("package com.x;", "package com.x.web;") } }],
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
    desc: "上游模組測試失敗、重跑仍失敗：明細在 common/target 底下——gate 必須讀得到；writer 影響不到也不能改它，第 1 輪就停下點名，不再讓 writer 重試到 stuck",
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
    name: "multimodule-upstream-flaky",
    desc: "上游模組的測試失敗一次、重跑就過 → flaky：同一輪照常往下走，結果點名要人檢視",
    entry: "orchestrate",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1" },
    writer: [{ write: { [`${MULTI_TEST_DIR}/CalcTest.java`]: CALC_TEST.replace("package com.x;", "package com.x.web;") } }],
    mvn: [
      {
        exit: 1,
        out: REACTOR_TEST_FAILURE("common", "com.x.common.UtilTest"),
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        surefire: [{ cls: "com.x.common.UtilTest", body: SUREFIRE_FAIL("com.x.common.UtilTest", "Connection refused"), module: "common" }],
      },
      {
        exit: 0,
        out: BUILD_SUCCESS(4),
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        surefire: [
          { cls: "com.x.web.CalcTest", body: SUREFIRE_PASS("com.x.web.CalcTest"), module: "web" },
          { cls: "com.x.common.UtilTest", body: SUREFIRE_PASS("com.x.common.UtilTest"), module: "common" },
        ],
        jacoco: { ...JACOCO_GREEN, pkg: "com/x/web" },
        jacocoModule: "web",
      },
    ],
  },
  {
    name: "loop-batches-upstream-broken",
    desc: "分批時上游模組的測試在第 1 批壞掉、重跑仍壞 → 整個 run 停下（後面每一批的建置都會撞到），點名沒執行的類別",
    entry: "loop",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [`${MULTI_TARGET_DIR}/Zeta.java`]: ZETA_JAVA.replace("package com.x;", "package com.x.web;") },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: `${MULTI_TEST_DIR}/CalcTest.java`, content: CALC_TEST.replace("package com.x;", "package com.x.web;") } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      {
        exit: 0, // baseline
        out: BUILD_SUCCESS(2),
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        surefire: [{ cls: "com.x.web.ExistingTest", body: SUREFIRE_PASS("com.x.web.ExistingTest"), module: "web" }],
      },
      {
        exit: 1, // batch 1, round 1, and its rebuild: common's test is down, Maven stops before web
        out: REACTOR_TEST_FAILURE("common", "com.x.common.UtilTest"),
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        surefire: [{ cls: "com.x.common.UtilTest", body: SUREFIRE_FAIL("com.x.common.UtilTest", "Connection refused: db:5432"), module: "common" }],
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
    name: "repair-framework-switch",
    desc: "修復輪把失敗的測試改寫成這個建置不執行的框架（@Test 與斷言數都沒少，防掏空量尺看不出來）→ 綠燈但它沒被執行，不算修好",
    entry: "repair",
    extraFiles: { [OLD_STYLE_PATH]: OLD_STYLE_TEST },
    writer: [{ write: { [EXISTING_PATH]: EXISTING_AS_TESTNG } }, { write: { [EXISTING_PATH]: `${EXISTING_TEST}// fixed\n` } }],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.x.ExistingTest"),
        cleanSurefire: true,
        surefire: ran(OLD_STYLE),
        surefireXml: [{ suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "div_byOne_returnsSameValue", message: "expected: <5> but was: <4>", line: 13 }]) }],
      },
      { exit: 0, out: BUILD_SUCCESS(1), cleanSurefire: true, surefire: ran(OLD_STYLE) },
      { exit: 0, out: BUILD_SUCCESS(3), cleanSurefire: true, surefire: ran(OLD_STYLE, "com.x.ExistingTest") },
    ],
  },
  {
    name: "repair-flaky-hides-switch",
    desc: "修復輪把失敗的測試改寫成不會被執行的框架，同一次建置剛好有別的測試 flaky 紅燈（紅燈不檢查誰沒跑）；下一輪什麼都不改、重跑轉綠 → 重跑也要檢查該跑的有跑，不能當成 flaky 放行",
    entry: "repair",
    extraFiles: { [OLD_STYLE_PATH]: OLD_STYLE_TEST },
    writer: [{ write: { [EXISTING_PATH]: EXISTING_AS_TESTNG } }, {}],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.x.ExistingTest"),
        cleanSurefire: true,
        surefire: ran(OLD_STYLE),
        surefireXml: [{ suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "div_byOne_returnsSameValue", message: "expected: <5> but was: <4>", line: 13 }]) }],
      },
      {
        exit: 1,
        out: TEST_FAILURE(OLD_STYLE),
        cleanSurefire: true,
        surefireXml: [{ suite: OLD_STYLE, body: SUREFIRE_XML(OLD_STYLE, 1, [{ nested: "", method: "add_works", message: "timed out after 5 seconds", line: 9 }]) }],
      },
      { exit: 0, out: BUILD_SUCCESS(1), cleanSurefire: true, surefire: ran(OLD_STYLE) },
    ],
  },
  {
    name: "repair-abstract-refused",
    desc: "修復輪把失敗的測試類別改成 abstract：@Test 與斷言一個不少，但它的測試不會再自己執行 → 防掏空擋下，不進建置",
    entry: "repair",
    writer: [
      { write: { [EXISTING_PATH]: EXISTING_TEST.replace("class ExistingTest {", "abstract class ExistingTest {") } },
      { write: { [EXISTING_PATH]: `${EXISTING_TEST}// fixed\n` } },
    ],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.x.ExistingTest"),
        cleanSurefire: true,
        surefireXml: [{ suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "div_byOne_returnsSameValue", message: "expected: <5> but was: <4>", line: 13 }]) }],
      },
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") },
    ],
  },
  {
    name: "repair-no-runnable-methods",
    desc: "既有的 @RunWith 類別沒有任何測試方法（No runnable methods）而紅；writer 把它改成 abstract 是對的修法 → 一輪修好，不要求它「被執行」",
    entry: "repair",
    extraFiles: { [BASE_SERVICE_PATH]: BASE_SERVICE_TEST },
    writer: [{ write: { [BASE_SERVICE_PATH]: BASE_SERVICE_TEST.replace("public class BaseServiceTest", "public abstract class BaseServiceTest") } }],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.x.BaseServiceTest"),
        cleanSurefire: true,
        surefire: ran("com.x.ExistingTest"),
        surefireXml: [{ suite: "com.x.BaseServiceTest", body: SUREFIRE_XML("com.x.BaseServiceTest", 1, [{ nested: "", method: "initializationError", message: "No runnable methods", line: 1 }]) }],
      },
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") },
    ],
  },
  {
    name: "repair-framework-switch-no-op",
    desc: "修復輪把失敗的測試改寫成不會被執行的框架，被擋下後下一輪什麼都不改 → writer-no-op，不能被當成「重跑就好了」的 flaky 測試放行",
    entry: "repair",
    extraFiles: { [OLD_STYLE_PATH]: OLD_STYLE_TEST },
    writer: [{ write: { [EXISTING_PATH]: EXISTING_AS_TESTNG } }, {}],
    mvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.x.ExistingTest"),
        cleanSurefire: true,
        surefire: ran(OLD_STYLE),
        surefireXml: [{ suite: "com.x.ExistingTest", body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "div_byOne_returnsSameValue", message: "expected: <5> but was: <4>", line: 13 }]) }],
      },
      { exit: 0, out: BUILD_SUCCESS(1), cleanSurefire: true, surefire: ran(OLD_STYLE) },
      { exit: 0, out: BUILD_SUCCESS(1), cleanSurefire: true, surefire: ran(OLD_STYLE) },
    ],
  },
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
      { ...GREEN_BUILD, surefire: [{ cls: "com.x.ExistingTest", body: SUREFIRE_PASS("com.x.ExistingTest") }] },
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
      { ...GREEN_BUILD, surefire: [{ cls: "com.x.ExistingTest", body: SUREFIRE_PASS("com.x.ExistingTest") }] },
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
    name: "loop-other-tests-stop-running",
    desc: "writer 加了一個讓其他測試不被探索到的測試資源 → 綠燈但既有測試沒被執行，build gate FAIL；拿掉之後通過",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: DISCOVERY_FILTER, content: "com.x.OnlyNewTests\n" } },
        ],
      },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: DISCOVERY_FILTER, content: "" } }] },
      { content: "已拿掉 discovery filter" },
    ],
    mvn: [
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") },
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.CalcTest"), jacoco: JACOCO_GREEN },
      { exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, surefire: ran("com.x.CalcTest", "com.x.ExistingTest"), jacoco: JACOCO_GREEN },
    ],
  },
  {
    name: "loop-dirty-tolerated",
    desc: "既有失敗照樣紅，但 gate 扣除後放行 → exit 0；summary.json 留下容忍了什麼",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_BASELINE: "0" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [LEGACY_RED(), { ...LEGACY_RED(), jacoco: JACOCO_GREEN, surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") }] }],
  },
  {
    name: "loop-dirty-tolerated-failure-ignored",
    desc: "testFailureIgnore 下每次建置都 exit 0：預檢照樣認出既有失敗、gate 照樣扣除後放行，而且記錄容忍了什麼",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_BASELINE: "0" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      LEGACY_RED_IGNORED(),
      { ...LEGACY_RED_IGNORED(), jacoco: JACOCO_GREEN, surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") }] },
    ],
  },
  {
    name: "loop-dirty-new-failure-ignored-blocked",
    desc: "testFailureIgnore 下 writer 弄壞一個新的測試，Maven 仍 exit 0 → 基準沒有的新失敗照樣擋下",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_BASELINE: "0", UT_MAX_ITER: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      LEGACY_RED_IGNORED(),
      {
        ...LEGACY_RED_IGNORED(),
        surefireXml: [
          { suite: LEGACY, body: SUREFIRE_XML(LEGACY, 4, [LEGACY_CASE]) },
          { suite: "com.x.OtherTest", body: SUREFIRE_XML("com.x.OtherTest", 2, [{ nested: "", method: "broken_by_writer", message: "NPE", line: 12 }]) },
        ],
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "loop-baseline-test-failure-ignored",
    desc: "testFailureIgnore 下既有測試失敗、Maven exit 0 → 預檢不得說「乾淨」：判紅並說明為什麼 mvn 自己說 BUILD SUCCESS",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_REPAIR_BASELINE: "0" },
    api: [],
    mvn: [LEGACY_RED_IGNORED()],
  },
  {
    name: "loop-baseline-tests-skipped",
    desc: "模組的測試被設定跳過（skipTests／maven.test.skip）→ 預檢就中止、說明要設什麼，不開 writer session 白燒兩輪",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [],
    mvn: [{ exit: 0, out: TESTS_SKIPPED, cleanSurefire: true }],
  },
  {
    name: "loop-baseline-tests-skipped-no-sources",
    desc: "測試被跳過、但模組還沒有任何測試原始碼（profile 以 <missing>src/test/java</missing> 啟用 skipTests 的常見寫法）→ 不中止，writer 寫出測試後就會執行",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    omitExisting: true,
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [{ exit: 0, out: TESTS_SKIPPED, cleanSurefire: true }, GREEN_BUILD],
  },
  {
    name: "loop-gradle-dirty-tolerated",
    desc: "Gradle、ignoreFailures：既有測試失敗、gradle exit 0 → 預檢認得出是哪個測試，UT_ALLOW_DIRTY_BASELINE 照樣容忍它、放行 writer 的綠測試",
    entry: "loop",
    buildTool: "gradle",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_BASELINE: "0" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      { exit: 0, out: GRADLE_IGNORED_OUT("LegacyTest > old_behaviour() FAILED"), writeFiles: { "build/test-results/test/TEST-com.x.LegacyTest.xml": GRADLE_LEGACY_XML } },
      {
        exit: 0,
        out: GRADLE_IGNORED_OUT("LegacyTest > old_behaviour() FAILED"),
        writeFiles: {
          "build/test-results/test/TEST-com.x.LegacyTest.xml": GRADLE_LEGACY_XML,
          "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(false),
        },
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "loop-gradle-baseline-repair",
    desc: "Gradle、ignoreFailures：既有的 LegacyTest 失敗、gradle exit 0 → 預檢點得出是目標模組裡的哪個測試，進修復迴圈修好它，之後照常產生測試",
    entry: "loop",
    buildTool: "gradle",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [LEGACY_PATH]: LEGACY_FIXED.replace("assertEquals(3,", "assertEquals(4,") },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: LEGACY_PATH, content: LEGACY_FIXED } }] },
      { content: "已修好 LegacyTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      { exit: 0, out: GRADLE_IGNORED_OUT("LegacyTest > old_behaviour() FAILED"), writeFiles: { "build/test-results/test/TEST-com.x.LegacyTest.xml": GRADLE_LEGACY_XML } },
      {
        exit: 0,
        out: "> Task :test\n\nBUILD SUCCESSFUL in 2s",
        writeFiles: { "build/test-results/test/TEST-com.x.LegacyTest.xml": GRADLE_LEGACY_XML.replace(/failures="1"/, 'failures="0"').replace(/<failure[\s\S]*?<\/failure>/, "") },
      },
      {
        exit: 0,
        out: "> Task :test\n\nBUILD SUCCESSFUL in 2s",
        writeFiles: {
          "build/test-results/test/TEST-com.x.LegacyTest.xml": GRADLE_LEGACY_XML.replace(/failures="1"/, 'failures="0"').replace(/<failure[\s\S]*?<\/failure>/, ""),
          "build/test-results/test/TEST-com.x.CalcTest.xml": GRADLE_CALC_XML(false),
        },
        jacoco: JACOCO_GREEN,
      },
    ],
  },
  {
    name: "loop-dirty-flaky-not-tolerated",
    desc: "帶著容忍的紅燈續跑時，一個 writer 沒碰過的測試失敗一次、重跑就過 → 只把它列為不穩定，一直在失敗、被容忍的 LegacyTest 不列",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_BASELINE: "0" },
    extraFiles: { [LEGACY_PATH]: LEGACY_FIXED },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      LEGACY_RED(), // baseline
      {
        ...LEGACY_RED(),
        surefireXml: [
          { suite: LEGACY, body: SUREFIRE_XML(LEGACY, 4, [LEGACY_CASE]) },
          {
            suite: "com.x.ExistingTest",
            body: SUREFIRE_XML("com.x.ExistingTest", 2, [{ nested: "", method: "div_byOne_returnsSameValue", message: "Connection refused", line: 13 }]),
          },
        ],
      },
      { ...LEGACY_RED(), jacoco: JACOCO_GREEN, surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") }] }, // its rebuild
    ],
  },
  {
    name: "loop-dirty-flaky-method",
    desc: "容忍 LegacyTest 的一個方法；另一個方法失敗一次、重跑就過 → 類別仍在失敗，但照樣點名它不穩定（不能因為類別還紅就什麼都不說）",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_BASELINE: "0" },
    extraFiles: { [LEGACY_PATH]: LEGACY_FIXED },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      LEGACY_RED(), // baseline
      {
        ...LEGACY_RED(),
        surefireXml: [
          {
            suite: LEGACY,
            body: SUREFIRE_XML(LEGACY, 4, [LEGACY_CASE, { nested: "", method: "talks_to_cache", message: "Connection refused", line: 30 }]),
          },
        ],
      },
      { ...LEGACY_RED(), jacoco: JACOCO_GREEN, surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") }] }, // its rebuild
    ],
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
    name: "loop-nothing-to-test-skipped",
    desc: "目標資料夾裡有 @Data DTO、Spring Boot 進入點、常數類別（Spring Boot 專案的常態）→ 都略過，不為它們開 writer session、不讓覆蓋率 gate 卡住",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: {
      "src/main/java/com/x/UserDto.java": "package com.x;\n\nimport lombok.Data;\n\n@Data\npublic class UserDto {\n    private Long id;\n    private String name;\n}\n",
      "src/main/java/com/x/App.java":
        "package com.x;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class App {\n    public static void main(String[] args) {\n        SpringApplication.run(App.class, args);\n    }\n}\n",
      "src/main/java/com/x/Codes.java":
        'package com.x;\n\npublic final class Codes {\n    public static final String NOT_FOUND = "E404";\n\n    private Codes() {\n        throw new IllegalStateException("Utility class");\n    }\n}\n',
    },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-runner-misconfigured",
    desc: "api runner 沒設模型 → 在預檢建置之前就中止並點名缺的設定，不得先跑完建置才在第一個 writer session 失敗",
    entry: "loop",
    env: { UT_WRITER_MODEL: "", UT_REVIEWER_MODEL: "" },
    api: [],
    mvn: [GREEN_BUILD],
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
      GREEN_WITH_LEGACY,
      GREEN_WITH_LEGACY,
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
    desc: "pom 沒設編碼、Maven 用平台編碼 MS950：writer 與 reviewer 讀到 \\uXXXX 形式的既有測試；沒改的行維持 MS950 原 bytes，writer 寫的中文以 MS950 存",
    entry: "loop",
    jdk: true,
    extraBytes: { [EXISTING_PATH]: EXISTING_TEST_MS950, [PROD_PATH]: CALC_MS950 },
    api: [
      { toolCalls: [{ name: "read_file", args: { path: EXISTING_PATH } }] },
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: `// 準備資料\n${calcTest(1)}` } },
          { name: "write_file", args: { path: EXISTING_PATH, content: EXISTING_VIEW.replace(/}\n$/, "    // 補一個測試\n}\n") } },
        ],
      },
      { content: "已建立 CalcTest.java，也補了 ExistingTest" },
      // The reviewer reads the file the writer extended, through the same view.
      { toolCalls: [{ name: "read_file", args: { path: EXISTING_PATH } }] },
      { content: verdict({}) },
    ],
    mvn: [{ ...GREEN_BUILD, out: PLATFORM_MS950 + BUILD_SUCCESS(4) }, GREEN_BUILD],
  },
  {
    name: "loop-encoding-no-jdk",
    desc: "MS950 模組、找不到 JDK：無法轉換，含中文的既有測試檔不讓 writer 改（被 UTF-8 工具改壞就照原 bytes 還原、該輪 FAIL），writer 的中文轉成 \\uXXXX",
    entry: "loop",
    noJdk: true,
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
  {
    name: "loop-encoding-replacement-char",
    desc: "writer 寫進 U+FFFD（某個工具用錯編碼讀檔時就遺失的字）→ 該輪不進建置、點名檔案，連同上一輪的 gate 報告餵回",
    entry: "loop",
    jdk: true,
    env: { UT_SKIP_REVIEW: "1" },
    extraBytes: { [EXISTING_PATH]: EXISTING_TEST_MS950 },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(1) } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: `// \uFFFD\uFFFD\n${calcTest(2)}` } }] },
      { content: "已修正" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: `// 兩數相加\n${calcTest(3)}` } }] },
      { content: "已修正" },
    ],
    mvn: [
      { ...GREEN_BUILD, out: PLATFORM_MS950 + BUILD_SUCCESS(4) },
      {
        exit: 1,
        out: TEST_FAILURE("com.x.CalcTest"),
        cleanSurefire: true,
        surefireXml: [
          { suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add", message: "expected: <3> but was: <4>", line: 9 }]) },
        ],
      },
      GREEN_BUILD,
    ],
  },
  {
    name: "loop-encoding-learned-from-build",
    desc: "跳過預檢：第 1 輪只看得出原始碼不是 UTF-8（保守做法：只寫 ASCII）；第 1 輪建置的 log 說了 MS950，第 2 輪就改用 MS950 的轉換",
    entry: "loop",
    jdk: true,
    env: { UT_SKIP_REVIEW: "1", UT_SKIP_BASELINE: "1" },
    extraBytes: { [EXISTING_PATH]: EXISTING_TEST_MS950 },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(1) } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: `// 兩數相加\n${calcTest(2)}` } }] },
      { content: "已修正" },
    ],
    mvn: [
      {
        exit: 1,
        out: PLATFORM_MS950 + TEST_FAILURE("com.x.CalcTest"),
        cleanSurefire: true,
        surefireXml: [
          { suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add", message: "expected: <3> but was: <4>", line: 9 }]) },
        ],
      },
      { ...GREEN_BUILD, out: PLATFORM_MS950 + BUILD_SUCCESS(4) },
    ],
  },
  {
    name: "loop-encoding-external-parent-utf8",
    desc: "編碼設定在 repo 外的 parent、原始碼是 UTF-8、建置沒印平台編碼：當成 UTF-8——就算 JDK 的預設編碼不是 UTF-8（繁中 Windows 的 JDK 17 以前），也不拿它來猜",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", JAVA_TOOL_OPTIONS: "-Dfile.encoding=COMPAT", LANG: "C", LC_ALL: "C" },
    extraFiles: { "pom.xml": CORP_POM, [EXISTING_PATH]: EXISTING_TEST_UTF8_ZH },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: EXISTING_PATH, content: EXISTING_TEST_UTF8_ZH.replace(/}\n$/, "    // 補一個測試\n}\n") } },
          { name: "write_file", args: { path: CALC_TEST_PATH, content: `// 準備資料\n${calcTest(1)}` } },
        ],
      },
      { content: "已補測試" },
    ],
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-encoding-sniffed-external",
    desc: "編碼設定在 repo 外（parent 設了 MS950，loop 讀不到）：原始碼不是 UTF-8 → 保守做法——含中文的既有測試不讓改（被改壞就還原）、writer 的中文轉成 \\uXXXX",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { "pom.xml": CORP_POM },
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
    mvn: [GREEN_BUILD, GREEN_BUILD],
  },
  {
    name: "loop-encoding-interrupted",
    desc: "MS950 模組、writer session 進行到一半按 Ctrl-C：它已經寫的檔照常以 MS950 寫回（沒改的行維持原 bytes），不會留在 \\uXXXX 形式",
    entry: "loop",
    jdk: true,
    env: { UT_SKIP_REVIEW: "1" },
    extraBytes: { [EXISTING_PATH]: EXISTING_TEST_MS950 },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: `// 準備資料\n${calcTest(1)}` } },
          { name: "write_file", args: { path: EXISTING_PATH, content: EXISTING_VIEW.replace(/}\n$/, "    // 補一個測試\n}\n") } },
        ],
      },
      { content: "…", interrupt: true },
    ],
    mvn: [{ ...GREEN_BUILD, out: PLATFORM_MS950 + BUILD_SUCCESS(4) }, GREEN_BUILD],
  },
  {
    name: "loop-encoding-no-op-round",
    desc: "MS950 模組、修正輪 writer 什麼都沒改：視圖開了又關（檔案換成 ASCII 形式再換回來）不算它的變更 → writer-no-op，不多跑一次一樣的建置",
    entry: "loop",
    jdk: true,
    env: { UT_SKIP_REVIEW: "1" },
    extraBytes: { [EXISTING_PATH]: EXISTING_TEST_MS950 },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: calcTest(1) } }] },
      { content: "已建立 CalcTest.java" },
      { content: "我修不好" },
    ],
    mvn: [
      { ...GREEN_BUILD, out: PLATFORM_MS950 + BUILD_SUCCESS(4) },
      {
        exit: 1,
        out: TEST_FAILURE("com.x.CalcTest"),
        cleanSurefire: true,
        surefireXml: [
          { suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add", message: "expected: <3> but was: <4>", line: 9 }]) },
        ],
      },
    ],
  },
  {
    name: "loop-repair-ms950",
    desc: "預檢紅燈在一個 MS950、含中文的既有測試檔：修復 writer 讀到 \\uXXXX 形式照常修好，中文那行維持原本的 bytes",
    entry: "loop",
    jdk: true,
    env: { UT_SKIP_REVIEW: "1" },
    extraBytes: { [BROKEN_PATH]: BROKEN_MS950 },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: BROKEN_PATH, content: `// \\u4e2d\\u6587\n${FIXED_TEST}` } }] },
      { content: "已修好 BrokenTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      { exit: 1, out: PLATFORM_MS950 + COMPILE_FAILURE(`{{root}}/${BROKEN_PATH}`), cleanSurefire: true },
      GREEN_BUILD,
      GREEN_BUILD,
    ],
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
        surefire: [
          { cls: "com.x.CalcTest", body: SUREFIRE_PASS("com.x.CalcTest") },
          { cls: "com.x.GreeterTest", body: SUREFIRE_PASS("com.x.GreeterTest") },
        ],
        jacoco: JACOCO_GREETER,
      },
    ],
  },
  {
    name: "loop-flaky-single-summary",
    desc: "單一類別：建置只失敗在 writer 沒碰過的既有測試、重跑就過 → 照常通過，SUMMARY 與 summary.json 點名不穩定的測試",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") }, // baseline
      EXISTING_FLAKY_RED,
      { ...GREEN_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") }, // its rebuild
    ],
  },
  {
    name: "loop-batches-flaky-attention",
    desc: "分批：第 1 批遇到不穩定的既有測試（重跑就過）→ 兩批照樣通過，summary 的 attention 與該批的紀錄點名它",
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
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") }, // baseline
      EXISTING_FLAKY_RED, // batch 1
      { ...GREEN_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") }, // its rebuild
      { ...GREEN_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"), jacoco: JACOCO_GREETER }, // batch 2
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
    desc: "連續兩批的建置以同樣的原因失敗（相依解析失敗，報告裡沒有任何一批自己的類別）→ 問題在批次之外，停下而不是每一批都燒完輪數",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, [ZETA_PATH]: ZETA_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    mvn: [GREEN_BUILD, { exit: 1, out: DEPENDENCY_FAILURE, cleanSurefire: true }, { exit: 1, out: DEPENDENCY_FAILURE, cleanSurefire: true }],
  },
  {
    name: "loop-batches-own-crashes-continue",
    desc: "連續兩批的 fork 都當掉，但 Crashed tests 點名的是各自的測試類別（可能是它自己的 System.exit）→ 不是批次之外的問題，照常跑第 3 批",
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
      { exit: 1, out: FORK_CRASH("com.x.CalcTest"), cleanSurefire: true },
      { exit: 1, out: FORK_CRASH("com.x.GreeterTest"), cleanSurefire: true },
      GREEN_BUILD,
    ],
  },
  {
    name: "loop-batches-foreign-change-kept",
    desc: "失敗批次撤回時只動 writer 改過的檔：執行期間別的東西（這裡是測試自己）寫進 src/test 的檔留著，並列出來",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    mvn: [
      GREEN_BUILD,
      {
        exit: 1,
        out: COMPILE_FAILURE(`{{root}}/${CALC_TEST_PATH}`, "total"),
        cleanSurefire: true,
        writeFiles: { "src/test/resources/approvals/Calc.received.txt": "written by a test during the build\n" },
      },
      { ...GREETER_GREEN, surefire: [{ cls: "com.x.GreeterTest", body: SUREFIRE_PASS("com.x.GreeterTest") }] },
    ],
  },
  {
    name: "loop-batches-interrupt-mid-writer",
    desc: "writer 寫到一半（建了 CalcTest、改了 ExistingTest）按 Ctrl-C → 這個 session 寫的檔也要撤回，不是當成別人的變更留著",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: EXISTING_PATH, content: `${EXISTING_TEST}// the writer was here\n` } },
        ],
      },
      { interrupt: true, content: "還在寫" },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "loop-batches-writer-401-mid-session",
    desc: "writer 寫了檔之後，下一個請求 401（token 過期）→ runner-spawn-error 停下，但它已經寫的檔照樣撤回",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { status: 401, body: '{"error":{"message":"token expired"}}' },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "loop-batches-crash-after-writer",
    desc: "writer 的 session 結束後、這輪還沒記下它改了什麼之前 run 就當掉（寫不了 writer-summary.md）→ 它寫的檔照樣撤回",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java", breakRunDir: true },
    ],
    mvn: [GREEN_BUILD],
  },
  {
    name: "loop-batches-repeated-env-failure",
    desc: "連續兩批的建置都因為 Spring context 起不來而失敗（報告點名的是各自的測試類別）→ 環境問題，停下而不是每一批都燒完輪數",
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
      { exit: 1, out: CONTEXT_FAILURE, cleanSurefire: true },
      { exit: 1, out: CONTEXT_FAILURE.replace("com.x.CalcTest", "com.x.GreeterTest"), cleanSurefire: true },
    ],
  },
  {
    name: "loop-batches-protect-earlier",
    desc: "第 1 批通過、建立了 CalcTest；第 2 批的 writer 加了讓它不再被探索到的測試資源 → 綠燈但 CalcTest 沒被執行，第 2 批 FAIL；拿掉之後通過",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      {
        toolCalls: [
          { name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } },
          { name: "write_file", args: { path: DISCOVERY_FILTER, content: "com.x.OnlyGreeter\n" } },
        ],
      },
      { content: "已建立 GreeterTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: DISCOVERY_FILTER, content: "" } }] },
      { content: "已拿掉 discovery filter" },
    ],
    mvn: [
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") },
      { exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, surefire: ran("com.x.ExistingTest", "com.x.CalcTest"), jacoco: JACOCO_GREEN },
      { exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, surefire: ran("com.x.ExistingTest", "com.x.GreeterTest"), jacoco: JACOCO_GREETER },
      { exit: 0, out: BUILD_SUCCESS(6), cleanSurefire: true, surefire: ran("com.x.ExistingTest", "com.x.CalcTest", "com.x.GreeterTest"), jacoco: JACOCO_GREETER },
    ],
  },
  {
    name: "loop-batches-protect-earlier-scoped",
    desc: "同上，但 UT_TEST_SCOPE=generated：第 1 批只有最終驗收跑過完整模組，它記下的「有被執行的類別」也要傳給第 2 批 → 第 2 批的最終驗收發現 CalcTest 沒被執行",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_TEST_SCOPE: "generated" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
      {
        toolCalls: [
          { name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } },
          { name: "write_file", args: { path: DISCOVERY_FILTER, content: "com.x.OnlyGreeter\n" } },
        ],
      },
      { content: "已建立 GreeterTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: DISCOVERY_FILTER, content: "" } }] },
      { content: "已拿掉 discovery filter" },
    ],
    mvn: [
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.ExistingTest") }, // baseline
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.CalcTest"), jacoco: JACOCO_GREEN }, // batch 1, scoped
      { exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, surefire: ran("com.x.ExistingTest", "com.x.CalcTest"), jacoco: JACOCO_GREEN }, // batch 1, full
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.GreeterTest"), jacoco: JACOCO_GREETER }, // batch 2 round 1, scoped
      { exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, surefire: ran("com.x.ExistingTest", "com.x.GreeterTest"), jacoco: JACOCO_GREETER }, // batch 2 round 1, full
      { exit: 0, out: BUILD_SUCCESS(2), cleanSurefire: true, surefire: ran("com.x.GreeterTest"), jacoco: JACOCO_GREETER }, // batch 2 round 2, scoped
      { exit: 0, out: BUILD_SUCCESS(6), cleanSurefire: true, surefire: ran("com.x.ExistingTest", "com.x.CalcTest", "com.x.GreeterTest"), jacoco: JACOCO_GREETER }, // batch 2 round 2, full
    ],
  },
  {
    name: "loop-dirty-target-skipped",
    desc: "UT_ALLOW_DIRTY_BASELINE 下預檢的紅燈在上游模組、Maven 停在上游，目標模組根本沒被建置 → 直接中止說明，不是每一輪都「放行」一個沒編譯過的測試",
    entry: "loop",
    layout: "multi",
    env: { UT_SKIP_REVIEW: "1", UT_ALLOW_DIRTY_BASELINE: "1" },
    api: [],
    mvn: [
      {
        exit: 1,
        out: REACTOR_TEST_FAILURE("common", "com.x.common.UtilTest"),
        cleanSurefire: true,
        modules: ["web", "common", "core"],
        surefireXml: [
          {
            suite: "com.x.common.UtilTest",
            module: "common",
            body: SUREFIRE_XML("com.x.common.UtilTest", 1, [{ nested: "", method: "trim_stripsWhitespace", message: "expected: <a> but was: < a >", line: 11 }]),
          },
        ],
      },
    ],
  },
  {
    name: "loop-batches-crash-mid-batch",
    desc: "第 1 批途中 run 當掉（寫不了這輪的 artifacts）→ summary 記 crash、把那一批撤回、列出沒執行的類別",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvn: [GREEN_BUILD, { ...GREEN_BUILD, breakRunDir: true }],
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
    desc: "失敗批次有 writer 改過的檔放不回去（這裡用一個放了 named pipe 的目錄佔住原位）→ src/test 已不是批次開始前的樣子，停下並點名，不在上面跑下一批",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: EXISTING_PATH, content: `${EXISTING_TEST}// the writer touched it\n` } },
        ],
      },
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
  // ── Resuming an earlier run ────────────────────────────────────────────────
  resumeCalc({
    name: "loop-resume-all-passed",
    desc: "重跑同一個目標：上次通過的 Calc 沒變、預檢裡它的測試照樣通過、覆蓋率重新量過 → 不再找 writer，exit 0（already-passed）",
    rerun: { api: [{ content: "不應該有任何 agent 請求" }] },
    rerunMvn: [CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-test-edited",
    desc: "上次通過後有人改了 CalcTest.java → 那次的 review 沒看過現在的內容，重新產生",
    rerun: { between: { [CALC_TEST_PATH]: calcTest(1) }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-source-edited",
    desc: "上次通過後 Calc.java 改過 → 測試是對著舊的程式寫的，重新產生",
    rerun: { between: { [PROD_PATH]: CALC_JAVA.replace("public class Calc {", "// changed after the pass\npublic class Calc {") }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-new-test-file",
    desc: "上次通過後多了一個 CalcUnitTest.java → reviewer 沒看過它，重新產生",
    rerun: { between: { [`${TEST_DIR}/CalcUnitTest.java`]: CALC_TEST.replace("class CalcTest", "class CalcUnitTest") }, api: RESUME_REWRITE_CALC },
    rerunMvn: [
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.CalcUnitTest", "com.x.ExistingTest") },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.CalcUnitTest", "com.x.ExistingTest") },
    ],
  }),
  resumeCalc({
    name: "loop-resume-helper-edited",
    desc: "上次那批 writer 寫的共用 Support.java 在通過後改過 → Calc 的測試靠它，重新產生",
    firstApi: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: SUPPORT_PATH, content: "package com.x;\n\nclass Support {\n    static int one() { return 1; }\n}\n" } },
        ],
      },
      { content: "已建立 CalcTest.java 與 Support.java" },
    ],
    rerun: {
      between: { [SUPPORT_PATH]: "package com.x;\n\nclass Support {\n    static int one() { return 2; }\n}\n" },
      api: RESUME_REWRITE_CALC,
    },
  }),
  resumeCalc({
    name: "loop-resume-coverage-dropped",
    desc: "類別與測試都沒變，但這次預檢的 JaCoCo 報告裡 Calc 的覆蓋率低於門檻 → 覆蓋率重新量過才算數，重新產生",
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [{ ...CALC_BUILD, jacoco: JACOCO_RED }, CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-tests-not-run",
    desc: "CalcTest.java 還在、內容沒變，但這次的預檢建置沒有執行它 → 沒有證據它現在仍然通過，重新產生",
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [{ ...BASE_EXISTING, jacoco: JACOCO_GREEN }, CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-review-threshold-raised",
    desc: "上次 review 以 8 分通過，這次門檻調成 9 → 判決以現在的門檻重新判定，不過，重新產生",
    env: { UT_SKIP_REVIEW: "0" },
    firstApi: [...RESUME_WRITE_CALC, ...REVIEW_CALC(verdict({}))],
    rerun: { env: { UT_SCORE_THRESHOLDS: '{"effectiveness":9}' }, api: [...RESUME_REWRITE_CALC, ...REVIEW_CALC(scores9(9))] },
  }),
  resumeCalc({
    name: "loop-resume-review-was-skipped",
    desc: "上次是 UT_SKIP_REVIEW=1 通過的，這次開了 review → 它的測試沒審查過，重新產生",
    rerun: { env: { UT_SKIP_REVIEW: "0" }, api: [...RESUME_REWRITE_CALC, ...REVIEW_CALC(verdict({}))] },
  }),
  resumeCalc({
    name: "loop-resume-rubric-changed",
    desc: "上次 review 通過後，repo 換了自己的 rubric → 判決依據不同，重新產生",
    env: { UT_SKIP_REVIEW: "0" },
    firstApi: [...RESUME_WRITE_CALC, ...REVIEW_CALC(verdict({}))],
    rerun: {
      between: { ".opencode/skills/test-quality-evaluator/references/rubric.md": "# 團隊自己的 rubric\n每個測試都要有邊界值。\n" },
      api: [...RESUME_REWRITE_CALC, ...REVIEW_CALC(verdict({}))],
    },
  }),
  resumeCalc({
    name: "loop-resume-review-passed",
    desc: "上次 review 以 8 分通過、rubric 與門檻都沒變 → 判決重新判定照樣通過，不再找 writer 與 reviewer",
    env: { UT_SKIP_REVIEW: "0" },
    firstApi: [...RESUME_WRITE_CALC, ...REVIEW_CALC(verdict({}))],
    rerun: { api: [{ content: "不應該有任何 agent 請求" }] },
    rerunMvn: [CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-stale-report-strict",
    desc: "這次預檢沒有產生 JaCoCo 報告、只剩第一次留下的舊報告，UT_STRICT_COV=1 → 舊報告不算重新量過，重新產生",
    rerun: { env: { UT_STRICT_COV: "1" }, api: RESUME_REWRITE_CALC },
    rerunMvn: [{ ...CALC_BUILD, jacoco: undefined }, CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-stale-report-loose",
    desc: "同上但沒開 UT_STRICT_COV → 覆蓋率 gate 本來就不檢查，照樣接續，但不能說覆蓋率重新量過",
    rerun: { api: [{ content: "不應該有任何 agent 請求" }] },
    rerunMvn: [{ ...CALC_BUILD, jacoco: undefined }],
  }),
  resumeCalc({
    name: "loop-resume-ran-unknown",
    desc: "這次預檢沒有留下任何 surefire 報告（看不出跑了哪些測試類別）→ 無法確認 Calc 的測試有執行，重新產生",
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [{ exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, jacoco: JACOCO_GREEN }, CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-own-test-name",
    desc: "writer 把 Calc 的測試取名 CalcBehaviourTest.java（不在命名慣例裡）→ 通過紀錄仍記得它，預檢跑過它就照樣接續",
    firstApi: [
      { toolCalls: [{ name: "write_file", args: { path: `${TEST_DIR}/CalcBehaviourTest.java`, content: CALC_TEST.replace("class CalcTest", "class CalcBehaviourTest") } }] },
      { content: "已建立 CalcBehaviourTest.java" },
    ],
    rerun: { api: [{ content: "不應該有任何 agent 請求" }] },
    mvnFirst: [BASE_EXISTING, { ...CALC_BUILD, surefire: ran("com.x.CalcBehaviourTest", "com.x.ExistingTest") }],
    rerunMvn: [{ ...CALC_BUILD, surefire: ran("com.x.CalcBehaviourTest", "com.x.ExistingTest") }],
  }),
  resumeCalc({
    name: "loop-resume-touched-test-not-run",
    desc: "Calc 那批的 writer 也改了 ExistingTest；這次預檢只跑了 ExistingTest、CalcTest 沒跑 → 不能拿 ExistingTest 有跑當證據，重新產生",
    firstApi: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: EXISTING_PATH, content: `${EXISTING_TEST}// the writer touched it\n` } },
        ],
      },
      { content: "已建立 CalcTest.java" },
    ],
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [{ ...BASE_EXISTING, jacoco: JACOCO_GREEN }, CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-second-test-not-run",
    desc: "Calc 以 CalcTest 與 CalcUnitTest 通過；這次預檢只跑了 CalcUnitTest → 每一個都要跑過才算，重新產生",
    firstApi: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST } },
          { name: "write_file", args: { path: `${TEST_DIR}/CalcUnitTest.java`, content: CALC_TEST.replace("class CalcTest", "class CalcUnitTest") } },
        ],
      },
      { content: "已建立 CalcTest.java 與 CalcUnitTest.java" },
    ],
    mvnFirst: [BASE_EXISTING, { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.CalcUnitTest", "com.x.ExistingTest") }],
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [
      { ...CALC_BUILD, surefire: ran("com.x.CalcUnitTest", "com.x.ExistingTest") },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.CalcUnitTest", "com.x.ExistingTest") },
    ],
  }),
  resumeCalc({
    name: "loop-resume-tests-all-skipped",
    desc: "這次預檢裡 CalcTest 的測試全部被略過 → 被略過不算跑過，重新產生",
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [
      { ...CALC_BUILD, surefire: [{ cls: "com.x.CalcTest", body: SUREFIRE_ALL_SKIPPED("com.x.CalcTest") }, ...ran("com.x.ExistingTest")] },
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-own-test-failed",
    desc: "這次預檢時 CalcTest 失敗、重跑才過（不穩定）→ 它通過時的測試現在不是每次都過，review 的可靠度分數不再成立，重新產生",
    rerun: {
      api: [{ content: "看了一下，CalcTest 沒有要改的" }, ...RESUME_REWRITE_CALC],
    },
    rerunMvn: [
      { exit: 1, out: TEST_FAILURE("com.x.CalcTest"), cleanSurefire: true, surefireXml: [{ suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add_twoPositives_returnsSum", message: "flaky", line: 10 }]) }] },
      CALC_BUILD, // the repair's rebuild: green, nothing changed
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-referenced-helper-edited",
    desc: "CalcTest 用到既有的 Support.java（不是那批寫的）；通過後有人把 Support 改了 → 它是測試的一部分，重新產生",
    extraFiles: { [SUPPORT_PATH]: SUPPORT_JAVA },
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_WITH_SUPPORT } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { between: { [SUPPORT_PATH]: SUPPORT_JAVA.replace("return 1;", "return 1 + 0;") }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-no-test-class",
    desc: "Calc 那批的 writer 只寫了 CalcFixture（不是測試類別），覆蓋率靠既有的測試 → 通過紀錄裡沒有會被執行的測試類別，無從確認它的測試有跑，重新產生",
    firstApi: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_FIXTURE_PATH, content: CALC_FIXTURE } }] },
      { content: "已建立 CalcFixture.java" },
    ],
    rerun: { api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-repair-changed-resource",
    desc: "重跑的預檢在 LegacyTest 紅燈，修復迴圈改了一個測試資源才轉綠 → 任何測試都可能讀到它，Calc 的 review 分數不再成立，重新產生",
    rerun: {
      between: { [LEGACY_PATH]: LEGACY_FIXED },
      api: [
        { toolCalls: [{ name: "write_file", args: { path: "src/test/resources/legacy.properties", content: "mode=new\n" } }] },
        { content: "已補上 legacy.properties" },
        ...RESUME_REWRITE_CALC,
      ],
    },
    rerunMvn: [
      LEGACY_RED(),
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) },
    ],
  }),
  resumeCalc({
    name: "loop-resume-testng-suite-failed",
    desc: "TestNG 的報告只有一個 TEST-TestSuite.xml：這次預檢時 CalcTest 在裡面失敗、重跑才過 → 看的是失敗案例自己的類別，不是 suite 名：重新產生",
    rerun: { api: [{ content: "看了一下，CalcTest 沒有要改的" }, ...RESUME_REWRITE_CALC] },
    rerunMvn: [
      { exit: 1, out: TEST_FAILURE("com.x.CalcTest"), cleanSurefire: true, surefireXml: [{ suite: "TestSuite", body: TESTNG_SUITE_FAIL }] },
      CALC_BUILD,
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-package-differs-failed",
    desc: "CalcTest.java 放在 com/x 底下、宣告的卻是 package com.y；這次預檢時 com.y.CalcTest 失敗、重跑才過 → 以它宣告的類別比對，重新產生",
    firstApi: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST.replace("package com.x;", "package com.y;\n\nimport com.x.Calc;") } }] },
      { content: "已建立 CalcTest.java" },
    ],
    mvnFirst: [BASE_EXISTING, { ...CALC_BUILD, surefire: ran("com.y.CalcTest", "com.x.ExistingTest") }],
    rerun: { api: [{ content: "看了一下，CalcTest 沒有要改的" }, ...RESUME_REWRITE_CALC] },
    rerunMvn: [
      {
        exit: 1,
        out: TEST_FAILURE("com.y.CalcTest"),
        cleanSurefire: true,
        surefireXml: [{ suite: "com.y.CalcTest", body: SUREFIRE_XML("com.y.CalcTest", 3, [{ nested: "", method: "add_twoPositives_returnsSum", message: "flaky", line: 10 }]) }],
      },
      { ...CALC_BUILD, surefire: ran("com.y.CalcTest", "com.x.ExistingTest") },
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-concat-resource",
    desc: "CalcTest 以 \"fixtures/\" + \"order.json\" 點名它的 fixture；通過後有人改了那個 fixture → 它是測試的一部分，重新產生",
    extraFiles: { [ORDER_FIXTURE]: '{"total":3}\n' },
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_CONCAT } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { between: { [ORDER_FIXTURE]: "{}\n" }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-concrete-base",
    desc: "CalcTest 繼承一個自己也有 @Test、但 surefire 不會單獨執行的 CalcCases；什麼都沒變的重跑 → 照樣接續（被引用的只比對內容，不要求它自己被執行）",
    extraFiles: { [CALC_CASES_PATH]: CALC_CASES },
    firstApi: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST.replace("class CalcTest {", "class CalcTest extends CalcCases {") } }] },
      { content: "已建立 CalcTest.java" },
    ],
    rerun: { api: [{ content: "不應該有任何 agent 請求" }] },
    rerunMvn: [CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-testng-all-skipped",
    desc: "TestNG：這次預檢的 TEST-TestSuite.xml 裡 CalcTest 的每個 case 都被略過（@BeforeClass 丟 SkipException）→ 全部被略過不算跑過，重新產生",
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [
      { exit: 0, out: TESTNG_OUT(2), cleanSurefire: true, surefireXml: [{ suite: "TestSuite", body: TESTNG_SUITE(true) }], jacoco: JACOCO_GREEN },
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-cjk-display-name-not-run",
    desc: "CalcTest（@DisplayName(\"計算機測試\")）這次預檢沒有執行，另一個 @DisplayName(\"訂單測試\") 的類別有（phrased 報告，檔名在 POSIX locale 下是 ????）→ 別的類別的名字不是它的，重新產生",
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_CJK } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { between: { [ORDER_TEST_PATH]: ORDER_TEST }, api: RESUME_REWRITE_CALC },
    rerunMvn: [
      { exit: 0, out: BUILD_SUCCESS(3), cleanSurefire: true, surefire: ran("com.x.ExistingTest"), surefireXml: [{ suite: "????", body: PHRASED_XML("訂單測試", "total") }], jacoco: JACOCO_GREEN },
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-cjk-display-name-ran",
    desc: "對照：CalcTest 這次以它的 @DisplayName(\"計算機測試\") 出現在 phrased 報告（檔名 ?????）→ 算有執行，照樣接續",
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_CJK } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { between: { [ORDER_TEST_PATH]: ORDER_TEST }, api: [{ content: "不應該有任何 agent 請求" }] },
    rerunMvn: [
      {
        exit: 0,
        out: BUILD_SUCCESS(5),
        cleanSurefire: true,
        surefire: ran("com.x.ExistingTest"),
        surefireXml: [
          { suite: "????", body: PHRASED_XML("訂單測試", "total") },
          { suite: "?????", body: PHRASED_XML("計算機測試", "add_twoPositives_returnsSum") },
        ],
        jacoco: JACOCO_GREEN,
      },
    ],
  }),
  resumeCalc({
    name: "loop-resume-cjk-display-name-flaky",
    desc: "phrased 報告：這次預檢時「計算機測試」（CalcTest 的 @DisplayName）失敗一次、surefire 重跑才過 → 報告以它的名字點名，照樣認得是 CalcTest，重新產生",
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_CJK } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [
      {
        exit: 0,
        out: RUNNING("com.x.CalcTest", "com.x.ExistingTest"),
        cleanSurefire: true,
        surefire: ran("com.x.ExistingTest"),
        surefireXml: [{ suite: "?????", body: FLAKY_CALC_XML.replace(/com\.x\.CalcTest(?=")/g, "計算機測試") }],
        jacoco: JACOCO_GREEN,
      },
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-nested-display-name-flaky",
    desc: "phrased 報告：CalcTest（「計算機測試」）裡的 @Nested「加法」這次預檢失敗一次、surefire 重跑才過，報告點名「計算機測試 加法」（實測 surefire 3.2.5）→ 認得是 CalcTest 的，重新產生",
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_CJK } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [
      {
        exit: 0,
        out: RUNNING("com.x.CalcTest", "com.x.ExistingTest"),
        cleanSurefire: true,
        surefire: ran("com.x.CalcTest", "com.x.ExistingTest"),
        surefireXml: [{ suite: "計算機測試 加法", body: FLAKY_CALC_XML.replace(/com\.x\.CalcTest(?=")/g, "計算機測試 加法") }],
        jacoco: JACOCO_GREEN,
      },
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-surefire-flaky",
    desc: "這次預檢時 CalcTest 失敗一次、surefire 自己重跑才過（rerunFailingTestsCount：綠燈，報告裡是 <flakyFailure>）→ 不穩定，重新產生",
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [
      { exit: 0, out: FLAKY_OUT, cleanSurefire: true, surefire: ran("com.x.ExistingTest"), surefireXml: [{ suite: "com.x.CalcTest", body: FLAKY_CALC_XML }], jacoco: JACOCO_GREEN },
      CALC_BUILD,
    ],
  }),
  resumeCalc({
    name: "loop-resume-cjk-fixture",
    desc: "CalcTest 以 \"fixtures/訂單.json\" 點名它的 fixture（非 ASCII 的檔名）；通過後有人改了那個 fixture → 重新產生",
    extraFiles: { [CJK_FIXTURE]: '{"total":3}\n' },
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_CJK_FIXTURE } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { between: { [CJK_FIXTURE]: "{}\n" }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-prefixed-resource",
    desc: "src/test/resources/com/x/CalcTest.sql 以測試命名（@Sql 沒寫路徑時 Spring 載入的就是它，測試裡沒有字串點名它）；通過後有人改了它 → 重新產生",
    extraFiles: { [CALC_SQL]: "insert into t values (1);\n" },
    rerun: { between: { [CALC_SQL]: "insert into t values (2);\n" }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-other-package-helper",
    desc: "對照：CalcTest 用的是自己 package 的 Support；另一個 package 也有一個 Support.java，通過後它被改了 → 那不是 CalcTest 用到的，照樣接續",
    extraFiles: { [SUPPORT_PATH]: SUPPORT_JAVA, [OTHER_SUPPORT_PATH]: OTHER_SUPPORT },
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_WITH_SUPPORT } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { between: { [OTHER_SUPPORT_PATH]: OTHER_SUPPORT.replace("return 1;", "return 2;") }, api: [{ content: "不應該有任何 agent 請求" }] },
    rerunMvn: [CALC_BUILD],
  }),
  resumeCalc({
    name: "loop-resume-ledger-escape",
    desc: "passed.json 裡的檔案路徑被改成 ../ 開頭（共用的 runs 目錄）→ 不讀 repo 外的檔，那筆紀錄不能用，重新產生",
    rerun: {
      rewrite: { file: "{{firstRun}}/passed.json", from: /"src\/test\/java\/com\/x\/CalcTest\.java"/, to: '"../outside/CalcTest.java"' },
      api: RESUME_REWRITE_CALC,
    },
  }),
  resumeCalc({
    name: "loop-resume-repair-changed-config",
    desc: "重跑的預檢在 LegacyTest 紅燈，修復迴圈加了一個 @TestConfiguration 類別才轉綠 → Spring 載入 context 時自己會找到它，沒有測試點名它也一樣，Calc 的 review 分數不再成立，重新產生",
    rerun: {
      between: { [LEGACY_PATH]: LEGACY_FIXED },
      api: [
        { toolCalls: [{ name: "write_file", args: { path: TEST_CONFIG_PATH, content: TEST_CONFIG } }] },
        { content: "已補上 TestConfig" },
        ...RESUME_REWRITE_CALC,
      ],
    },
    rerunMvn: [
      LEGACY_RED(),
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) },
    ],
  }),
  resumeCalc({
    name: "loop-resume-repair-changed-helper",
    desc: "對照：修復迴圈加的是一個普通的 helper（沒有任何測試用到 Calc 的部分，也不是 Spring 會自己載入的）→ Calc 照樣接續",
    rerun: {
      between: { [LEGACY_PATH]: LEGACY_FIXED },
      api: [{ toolCalls: [{ name: "write_file", args: { path: LEGACY_HELPER_PATH, content: LEGACY_HELPER } }] }, { content: "已補上 LegacyHelper" }],
    },
    rerunMvn: [LEGACY_RED(), { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) }],
  }),
  {
    name: "loop-resume-shared-helper",
    desc: "資料夾 Calc、Greeter 兩批都通過；第 2 批的 writer 在 Calc 通過後擴充了共用的 Support.java → 當下就說 Calc 的紀錄不再相符；重跑接續 Greeter、重新產生 Calc（它的審查沒看過新的 Support）",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      {
        toolCalls: [
          { name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_WITH_SUPPORT } },
          { name: "write_file", args: { path: SUPPORT_PATH, content: SUPPORT_JAVA } },
        ],
      },
      { content: "已建立 CalcTest.java 與 Support.java" },
      {
        toolCalls: [
          { name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST_SUPPORT } },
          { name: "write_file", args: { path: SUPPORT_PATH, content: SUPPORT_V2 } },
        ],
      },
      { content: "已建立 GreeterTest.java，Support 加了 name()" },
    ],
    rerun: { api: RESUME_REWRITE_CALC },
    mvn: [BASE_EXISTING, CALC_BUILD, GREETER_ROUND, GREETER_ROUND, GREETER_ROUND],
  },
  resumeCalc({
    name: "loop-resume-repair-green-log",
    desc: "重跑的預檢紅燈、修復迴圈修好；修好的那次建置沒有 CalcTest 的報告、只在 log 說它跑了 → 以修復那次建置的 log 為準，照樣接續",
    rerun: {
      between: { [LEGACY_PATH]: LEGACY_FIXED },
      api: [{ toolCalls: [{ name: "write_file", args: { path: LEGACY_HELPER_PATH, content: LEGACY_HELPER } }] }, { content: "已補上 LegacyHelper" }],
    },
    rerunMvn: [
      LEGACY_RED(),
      { exit: 0, out: RUNNING("com.x.CalcTest", "com.x.ExistingTest", LEGACY), cleanSurefire: true, surefire: ran("com.x.ExistingTest", LEGACY), jacoco: JACOCO_GREEN },
    ],
  }),
  {
    name: "loop-resume-flaky-single-run",
    desc: "重跑接續 Calc、剩下的 Greeter 不分批（UT_BATCH_SIZE=2）；那一輪的建置失敗在 CalcTest、重跑才過 → 這次 passed.json 帶著的 Calc 紀錄標記作廢",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: {
      env: { UT_BATCH_SIZE: "2" },
      api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }],
    },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      { ...GREETER_ROUND, jacoco: [JACOCO_GREEN, JACOCO_GREETER_RED] }, // Greeter falls short: set aside
      CALC_BUILD, // the rerun's baseline
      {
        exit: 1,
        out: TEST_FAILURE("com.x.CalcTest"),
        cleanSurefire: true,
        surefire: ran("com.x.ExistingTest", "com.x.GreeterTest"),
        surefireXml: [{ suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add_twoPositives_returnsSum", message: "flaky", line: 10 }]) }],
      },
      GREETER_ROUND,
    ],
  },
  {
    name: "loop-resume-flaky-later-batch",
    desc: "資料夾 Calc、Greeter：Calc 那批通過；Greeter 那批的建置失敗在 CalcTest、重跑才過（不穩定）→ Calc 的通過紀錄作廢（留著作廢的，不是刪掉），重跑重新產生 Calc、接續 Greeter",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: { api: RESUME_REWRITE_CALC },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      {
        exit: 1,
        out: TEST_FAILURE("com.x.CalcTest"),
        cleanSurefire: true,
        surefire: ran("com.x.ExistingTest", "com.x.GreeterTest"),
        surefireXml: [{ suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add_twoPositives_returnsSum", message: "flaky", line: 10 }]) }],
      },
      GREETER_ROUND,
      GREETER_ROUND, // the rerun's baseline
      GREETER_ROUND,
    ],
  },
  {
    name: "loop-resume-last-class-set-aside",
    desc: "資料夾兩個類別：第一次 Calc 過、Greeter 沒過；重跑接續 Calc、Greeter 又沒過 → 它仍是資料夾的一批，失敗的嘗試照樣移出 src/test",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: {
      api: [
        { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
        { content: "已建立 GreeterTest.java" },
      ],
    },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER_RED] },
      CALC_BUILD, // the rerun's baseline
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER_RED] },
    ],
  },
  ...(["loop-resume-gradle", "loop-resume-gradle-up-to-date"] as const).map(
    (name): Scenario => ({
      name,
      desc:
        name === "loop-resume-gradle"
          ? "Gradle：這次預檢的 test task 真的執行了、Calc 的測試在結果裡 → 照樣接續"
          : "Gradle：這次預檢的 test task 是 UP-TO-DATE（build/test-results 是上一次留下的）→ 沒有這次的證據，重新產生",
      entry: "loop",
      buildTool: "gradle",
      env: { UT_SKIP_REVIEW: "1" },
      api: RESUME_WRITE_CALC,
      rerun: { api: name === "loop-resume-gradle" ? [{ content: "不應該有任何 agent 請求" }] : RESUME_REWRITE_CALC },
      mvn: [
        { exit: 0, out: GRADLE_TEST_RAN, writeFiles: gradleResults("com.x.ExistingTest") },
        { exit: 0, out: GRADLE_TEST_RAN, writeFiles: gradleResults("com.x.CalcTest", "com.x.ExistingTest"), jacoco: JACOCO_GREEN },
        name === "loop-resume-gradle"
          ? { exit: 0, out: GRADLE_TEST_RAN, writeFiles: gradleResults("com.x.CalcTest", "com.x.ExistingTest"), jacoco: JACOCO_GREEN }
          : { exit: 0, out: GRADLE_TEST_UP_TO_DATE },
        { exit: 0, out: GRADLE_TEST_RAN, writeFiles: gradleResults("com.x.CalcTest", "com.x.ExistingTest"), jacoco: JACOCO_GREEN },
      ],
    }),
  ),
  resumeCalc({
    name: "loop-resume-disabled",
    desc: "UT_RESUME=0 → 上次通過的也重新產生",
    rerun: { env: { UT_RESUME: "0" }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-dirty-baseline",
    desc: "這次預檢是紅的、UT_ALLOW_DIRTY_BASELINE=1 放行 → 無法確認上次通過的測試現在仍然通過，重新產生",
    rerun: { env: { UT_ALLOW_DIRTY_BASELINE: "1", UT_REPAIR_BASELINE: "0" }, api: RESUME_REWRITE_CALC },
    rerunMvn: [
      { ...LEGACY_RED(), jacoco: JACOCO_GREEN, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") },
      { ...LEGACY_RED(), jacoco: JACOCO_GREEN, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") },
    ],
  }),
  resumeCalc({
    name: "loop-resume-skip-baseline",
    desc: "這次 UT_SKIP_BASELINE=1 → 沒有預檢建置可以重新確認，上次通過的也重新產生",
    rerun: { env: { UT_SKIP_BASELINE: "1" }, api: RESUME_REWRITE_CALC },
    rerunMvn: [CALC_BUILD],
  }),
  {
    name: "loop-resume-batches",
    desc: "資料夾兩個類別：第一次 Calc 通過、Greeter 沒過 → 重跑只做 Greeter，Calc 的通過紀錄帶進這次的 passed.json",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: {
      api: [
        { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
        { content: "已建立 GreeterTest.java" },
      ],
    },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER_RED] },
      CALC_BUILD, // the rerun's baseline
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER] },
    ],
  },
  {
    name: "loop-resume-rerun-interrupted",
    desc: "重跑略過了 Calc、做 Greeter 時又被 Ctrl-C → 這次的 summary 照樣列出接續了哪些類別",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: {
      api: [
        { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
        { content: "已建立 GreeterTest.java" },
      ],
    },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER_RED] },
      CALC_BUILD, // the rerun's baseline
      { exit: 0, interrupt: true },
    ],
  },
  {
    name: "loop-resume-after-interrupt",
    desc: "第一次在第 2 批（Greeter）按 Ctrl-C → 重跑略過已通過的 Calc，只做 Greeter 與 Zeta 兩批",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, [ZETA_PATH]: ZETA_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: {
      api: [
        { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
        { content: "已建立 GreeterTest.java" },
        { toolCalls: [{ name: "write_file", args: { path: ZETA_TEST_PATH, content: ZETA_TEST } }] },
        { content: "已建立 ZetaTest.java" },
      ],
    },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      { exit: 0, interrupt: true },
      CALC_BUILD, // the rerun's baseline
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER] },
      {
        ...CALC_BUILD,
        surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest", "com.x.ZetaTest"),
        jacoco: [JACOCO_GREEN, JACOCO_GREETER, JACOCO_ZETA],
      },
    ],
  },
  // ── A run killed outright ──────────────────────────────────────────────────
  killedMidWriter({
    name: "loop-killed-mid-writer",
    desc: "第 2 批的 writer 寫到一半、run 被 SIGKILL（沒有任何收尾）→ 重跑先依復原日誌撤回那批的變更，補寫上一次的 summary，再接續",
  }),
  killedMidWriter({
    name: "loop-killed-edit-after-death",
    desc: "同上，但 run 死掉之後有人手動改了 ExistingTest.java → 那是死後才改的、不是 writer 的，留著；writer 寫的 GreeterTest 照樣撤回",
    rerun: { backdateMs: 600_000, between: { [EXISTING_PATH]: `${EXISTING_TEST}// fixed by hand after the crash\n` } },
  }),
  killedMidWriter({
    name: "loop-killed-batch-recorded",
    desc: "被終止時那批已經記進 batches.json（通過或已撤回）→ 只剩日誌，不再撤回，只補寫 summary",
    rerun: { between: { "{{firstRun}}/batches.json": '[{"batch":1,"success":true},{"batch":2,"success":true}]' } },
  }),
  killedMidWriter({
    name: "loop-killed-other-checkout",
    desc: "復原日誌屬於共用 runs 目錄的另一個 checkout（repo 路徑不同）→ 不是這個 repo 的，完全不碰",
    rerun: { between: { "{{firstRun}}/batch-2-Greeter/inflight/owner.json": '{"repoRoot":"/elsewhere","pid":1}' } },
  }),
  killedMidWriter({
    name: "loop-killed-run-ended",
    desc: "日誌還在、但那次執行其實有收尾（有 summary.json）→ 日誌是剩下的，丟掉，不撤回也不改它的 summary",
    rerun: { between: { "{{firstRun}}/summary.json": '{"success":false,"stopReason":"interrupted:SIGHUP"}' } },
  }),
  ...(
    [
      "loop-killed-orphan-build",
      "loop-killed-orphan-fork",
      "loop-killed-orphan-pid-reused",
      "loop-killed-orphan-other-checkout",
      "loop-killed-orphan-other-host",
      "loop-killed-orphan-rebooted",
      "loop-killed-orphan-clock-stepped",
      "loop-killed-orphan-other-container",
      "loop-killed-orphan-build-keeps-fix",
      "loop-killed-orphan-corrupt-record",
      "loop-killed-orphan-owner-alive",
    ] as const
  ).map(
    (name): Scenario => ({
      name,
      desc: {
        "loop-killed-orphan-build": "run 在第 2 批的建置途中被 SIGKILL，建置本身還在跑（孤兒）→ 重跑一開始就結束它，再撤回那批、接續",
        "loop-killed-orphan-fork": "同上，但建置本身已經結束、它 fork 出去的程序（像 surefire 的 JVM）還在它的程序群組裡跑 → 一樣結束",
        "loop-killed-orphan-pid-reused": "同上，但紀錄裡的啟動時間對不上現在用那個 pid 的程序（pid 被重用）→ 不是它的，不碰",
        "loop-killed-orphan-other-checkout": "同上，但那份子程序紀錄屬於共用 runs 目錄的另一個 checkout → 不碰",
        "loop-killed-orphan-other-host": "同上，但紀錄是另一台機器寫的（共用的 runs 目錄）→ 那些 pid 在這台沒有意義，不碰",
        "loop-killed-orphan-rebooted": "同上，但紀錄是重開機前寫的 → 那些程序不可能還在，現在用那些 pid 的都不是，不碰",
        "loop-killed-orphan-clock-stepped":
          "同上，但兩次執行之間時鐘被校正過（估算的開機時間差了很多）→ boot_id 相同就是同一次開機：照樣結束留下的建置",
        "loop-killed-orphan-corrupt-record": "同上，但子程序紀錄解析得了、children 卻不是清單（損毀）→ 認不出任何子程序，不碰、不當掉，照常收尾",
        "loop-killed-orphan-build-keeps-fix":
          "同上，重跑在 10 分鐘後；那之間開發者修了被終止的 writer 改過的 ExistingTest.java → 結束留下的建置不代表 writer 活到那時：開發者的修正留著",
        "loop-killed-orphan-other-container":
          "同上，但紀錄是同一台機器上另一個容器寫的（共用主機名稱與開機時間，pid namespace 不同）→ 那些 pid 在這裡是別的程序，不碰",
        "loop-killed-orphan-owner-alive": "同上，但寫紀錄的那次執行其實還活著（繞過了 repo 鎖）→ 它的子程序是它自己的，不碰",
      }[name],
      entry: "loop",
      env: { UT_SKIP_REVIEW: "1" },
      extraFiles: { [GREETER_PATH]: GREETER_JAVA },
      api: [...RESUME_WRITE_CALC, KILLED_WRITES, { content: "已建立 GreeterTest.java" }],
      rerun: {
        api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }],
        ...(ORPHAN_REWRITES[name] ?? {}),
      },
      mvn: [
        BASE_EXISTING,
        CALC_BUILD,
        { exit: 0, killLoop: true, linger: 60_000, lingerFork: name === "loop-killed-orphan-fork" },
        CALC_BUILD,
        GREETER_ROUND,
      ],
    }),
  ),
  killedMidWriter({
    name: "loop-killed-other-host",
    desc: "復原日誌是另一台機器寫的（共用 runs 目錄、同一個 repo 路徑、它自己的 checkout）→ 它的樹不是這台的，完全不碰",
    rerun: {
      rewrite: [
        { file: "{{firstRun}}/batch-2-Greeter/inflight/owner.json", from: /"host":"[^"]*"/, to: '"host":"another-machine"' },
        { file: "{{firstRun}}/batch-2-Greeter/inflight/journal.json", from: /"host":"[^"]*"/, to: '"host":"another-machine"' },
        { file: "{{firstRun}}/batch-2-Greeter/inflight/journal.json", from: /"rootId":"[^"]*"/, to: '"rootId":"1@1"' },
      ],
    },
  }),
  killedMidWriter({
    name: "loop-killed-other-host-same-checkout",
    desc: "復原日誌的主機名稱不同，但目錄證明是同一個（inode 與建立時間都相同：每次換名字的容器掛同一個 volume），心跳早已停了 → 照樣撤回",
    rerun: {
      backdateMs: 600_000,
      rewrite: [
        { file: "{{firstRun}}/batch-2-Greeter/inflight/owner.json", from: /"host":"[^"]*"/, to: '"host":"container-1234"' },
        { file: "{{firstRun}}/batch-2-Greeter/inflight/journal.json", from: /"host":"[^"]*"/, to: '"host":"container-1234"' },
      ],
    },
  }),
  killedMidWriter({
    name: "loop-killed-busy-owner-exits",
    desc: "復原日誌屬於這個 checkout 上還在跑的 testgen（它的程序還在）→ 先等它，它幾秒後結束了，再照常替它撤回、接續",
    rerun: { liveOwner: { journal: "{{firstRun}}/batch-2-Greeter/inflight", ms: 5_000 } },
  }),
  killedMidWriter({
    name: "loop-killed-busy-gives-up",
    desc: "復原日誌屬於這個 checkout 上還在跑的 testgen，等了 UT_OTHER_RUN_WAIT_MS 還在 → 不在它上面開始，以 checkout-busy 停下，日誌留著",
    rerun: { liveOwner: { journal: "{{firstRun}}/batch-2-Greeter/inflight", ms: 60_000 }, env: { UT_OTHER_RUN_WAIT_MS: "4000" } },
  }),
  killedMidWriter({
    name: "loop-killed-trace-lost",
    desc: "復原日誌的 trace.json 在斷電後是空的（讀不了）→ 不丟日誌：那批開始之後、死前的變更全部撤回",
    rerun: { rewrite: { file: "{{firstRun}}/batch-2-Greeter/inflight/trace.json", from: /^[\s\S]*$/, to: "" } },
  }),
  {
    name: "loop-killed-moved-after-death",
    desc: "run 在 writer session 途中被終止；之後開發者把 src/test/resources/fixtures 改名成 data（mv 保留時間）→ 移動不是那批的：兩邊都不動，writer 的 GreeterTest 照樣撤回",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, "src/test/resources/fixtures/order.json": '{"id":1}\n' },
    api: [...RESUME_WRITE_CALC, KILLED_WRITES, { kill: true }],
    rerun: {
      renames: [["src/test/resources/fixtures", "src/test/resources/data"]],
      api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }],
    },
    mvn: [BASE_EXISTING, CALC_BUILD, CALC_BUILD, GREETER_ROUND],
  },
  killedMidWriter({
    name: "loop-killed-recloned",
    desc: "同一個路徑現在是另一個 checkout（repo 刪掉重新 clone 過）→ 那批留下的東西不可能在這裡，丟掉日誌、不撤回",
    rerun: { rewrite: { file: "{{firstRun}}/batch-2-Greeter/inflight/journal.json", from: /"rootId":"[^"]*"/, to: '"rootId":"1@1"' } },
  }),
  killedMidWriter({
    name: "loop-killed-corrupt-journal",
    desc: "復原日誌解析得了、但欄位壞了 → 丟掉它、照常執行，不是每次啟動都當掉",
    rerun: { rewrite: { file: "{{firstRun}}/batch-2-Greeter/inflight/journal.json", from: /"capture":\{/, to: '"capture":null,"was":{' } },
  }),
  killedMidWriter({
    name: "loop-killed-deleted-after-death",
    desc: "run 死掉之後有人刪了 ExistingTest.java（分支切換、別人的刪除拉進來）→ 不知道是誰刪的，不放回，原本的內容留在那批的 deleted/",
    rerun: { backdateMs: 600_000, between: { [EXISTING_PATH]: null } },
  }),
  killedMidWriter({
    name: "loop-killed-restore-fails",
    desc: "撤回時有檔案放不回去（位置被一個放了 named pipe 的目錄佔住）→ 這次先停下、日誌留著給下一次，不在寫到一半的測試上產生新的",
    rerun: { pipeDirAt: EXISTING_PATH },
  }),
  {
    name: "loop-killed-writer-deleted",
    desc: "被終止的 writer 刪掉了既有的 ExistingTest.java（它的目錄在那之後沒被動過）→ 撤回時放回去",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }], sideDelete: [EXISTING_PATH] },
      { kill: true },
    ],
    rerun: {
      api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }],
    },
    mvn: [BASE_EXISTING, CALC_BUILD, CALC_BUILD, GREETER_ROUND],
  },
  {
    name: "loop-killed-orphan-writes-on",
    desc: "run 在建置途中被 SIGKILL，留下的程序還一直寫 GreeterTest.java；重跑時那次執行的心跳早已停了 → 寫到被結束為止的都算那批的，照樣撤回",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [...RESUME_WRITE_CALC, KILLED_WRITES, { content: "已建立 GreeterTest.java" }],
    rerun: {
      backdateMs: 600_000,
      // The process left writing is an agent session's (the fake build stands in for it): its record says so.
      rewrite: { file: "{{firstRun}}/children.json", from: /"kind":"build"/g, to: '"kind":"other"' },
      api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }],
    },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      {
        exit: 0,
        killLoop: true,
        linger: 60_000,
        lingerWrite: { file: GREETER_TEST_PATH, content: `// written by the orphan after its run died\n${GREETER_TEST}` },
      },
      CALC_BUILD,
      GREETER_ROUND,
    ],
  },
  {
    name: "loop-killed-mid-build",
    desc: "第 2 批的 writer 已經寫完、run 在建置途中被 SIGKILL → 重跑依日誌記下的 writer 變更撤回",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [...RESUME_WRITE_CALC, KILLED_WRITES, { content: "已建立 GreeterTest.java" }],
    rerun: {
      api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }],
    },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      // A test writes into src/test while it runs — then the run is killed.
      { exit: 0, killLoop: true, writeFiles: { "src/test/resources/written-by-a-test.txt": "output\n" } },
      CALC_BUILD,
      GREETER_ROUND,
    ],
  },
  // ── Round 5: resume evidence that has to outlive the run that found it, and what a record must hold ──
  {
    name: "loop-resume-flaky-redo-interrupted",
    desc: "第二次的預檢發現 CalcTest 不穩定（surefire 重跑才過）→ 排定重做 Calc，重做時被 Ctrl-C；第三次的預檢剛好沒有 flake → 不接續 Calc：第二次就把它的紀錄記成作廢了",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1" },
    api: RESUME_WRITE_CALC,
    rerun: { api: [{ interrupt: true, content: "（被中斷）" }] },
    rerun2: { api: RESUME_REWRITE_CALC },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      { exit: 0, out: FLAKY_OUT, cleanSurefire: true, surefire: ran("com.x.ExistingTest"), surefireXml: [{ suite: "com.x.CalcTest", body: FLAKY_CALC_XML }], jacoco: JACOCO_GREEN },
      CALC_BUILD,
      CALC_BUILD,
    ],
  },
  {
    name: "loop-resume-flaky-redo-failed",
    desc: "資料夾 Calc、Greeter 都通過；第二次的預檢 CalcTest 不穩定 → 重做 Calc，那批沒過、撤回（CalcTest 回到第一次的內容）；第三次的預檢剛好沒有 flake → 不接續 Calc",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: { api: RESUME_REWRITE_CALC },
    rerun2: { api: RESUME_REWRITE_CALC },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      GREETER_ROUND,
      {
        exit: 0,
        out: FLAKY_OUT,
        cleanSurefire: true,
        surefire: ran("com.x.ExistingTest", "com.x.GreeterTest"),
        surefireXml: [{ suite: "com.x.CalcTest", body: FLAKY_CALC_XML }],
        jacoco: [JACOCO_GREEN, JACOCO_GREETER],
      },
      { ...GREETER_ROUND, jacoco: [JACOCO_RED, JACOCO_GREETER] }, // Calc's redo falls short: set aside
      GREETER_ROUND, // the third run's baseline
      GREETER_ROUND,
    ],
  },
  {
    name: "loop-resume-flaky-before-pass",
    desc: "資料夾 Calc、Greeter，GreeterTest 本來就在；第 1 批（Calc）的建置失敗在 GreeterTest、重跑才過（flaky）；第 2 批 Greeter 帶著沒改的 GreeterTest 通過 → Greeter 的紀錄記成作廢，重跑不接續",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA, [GREETER_TEST_PATH]: GREETER_TEST },
    api: [
      ...RESUME_WRITE_CALC,
      {
        toolCalls: [
          {
            name: "write_file",
            args: { path: `${TEST_DIR}/GreeterEdgeTest.java`, content: GREETER_TEST.replace("class GreeterTest", "class GreeterEdgeTest") },
          },
        ],
      },
      { content: "已建立 GreeterEdgeTest.java" },
    ],
    rerun: { api: [{ toolCalls: [{ name: "write_file", args: { path: `${TEST_DIR}/GreeterEdgeTest.java`, content: `${GREETER_TEST.replace("class GreeterTest", "class GreeterEdgeTest")}// again\n` } }] }, { content: "已更新" }] },
    mvn: [
      { exit: 0, out: BUILD_SUCCESS(4), cleanSurefire: true, surefire: ran("com.x.ExistingTest", "com.x.GreeterTest") },
      {
        exit: 1,
        out: TEST_FAILURE("com.x.GreeterTest"),
        cleanSurefire: true,
        surefire: ran("com.x.CalcTest", "com.x.ExistingTest"),
        surefireXml: [{ suite: "com.x.GreeterTest", body: SUREFIRE_XML("com.x.GreeterTest", 2, [{ nested: "", method: "greet_withName_saysHello", message: "flaky", line: 9 }]) }],
      },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest") },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest", "com.x.GreeterEdgeTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER] },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest", "com.x.GreeterEdgeTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER] },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest", "com.x.GreeterEdgeTest"), jacoco: [JACOCO_GREEN, JACOCO_GREETER] },
    ],
  },
  {
    name: "loop-resume-surefire-flaky-later-batch",
    desc: "資料夾 Calc、Greeter；Calc 那批通過；Greeter 那批的建置是綠的，但 CalcTest 在報告裡是 <flakyFailure>（surefire 重跑才過）→ Calc 的紀錄記成作廢，重跑不接續",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: { api: RESUME_REWRITE_CALC },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      {
        exit: 0,
        out: FLAKY_OUT,
        cleanSurefire: true,
        surefire: ran("com.x.ExistingTest", "com.x.GreeterTest"),
        surefireXml: [{ suite: "com.x.CalcTest", body: FLAKY_CALC_XML }],
        jacoco: [JACOCO_GREEN, JACOCO_GREETER],
      },
      GREETER_ROUND,
      GREETER_ROUND,
    ],
  },
  {
    name: "loop-resume-phrased-flaky-later-batch",
    desc: "同上，但 CalcTest 有 @DisplayName(\"計算機測試\")，phrased 報告以這個名字點名重跑才過的它 → 照樣認得是 Calc 的測試：紀錄記成作廢，重跑不接續",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_CJK } }] },
      { content: "已建立 CalcTest.java" },
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
    ],
    rerun: { api: RESUME_REWRITE_CALC },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      {
        exit: 0,
        out: FLAKY_OUT,
        cleanSurefire: true,
        surefire: ran("com.x.CalcTest", "com.x.ExistingTest", "com.x.GreeterTest"),
        surefireXml: [{ suite: "計算機測試", body: FLAKY_CALC_XML.replace(/com\.x\.CalcTest(?=")/g, "計算機測試") }],
        jacoco: [JACOCO_GREEN, JACOCO_GREETER],
      },
      GREETER_ROUND,
      GREETER_ROUND,
    ],
  },
  resumeCalc({
    name: "loop-resume-spring-config-between-runs",
    desc: "CalcTest（@SpringBootTest）的 context 會載入測試目錄裡的 @Configuration（component scan，沒有測試點名它）；兩次執行之間有人改了它 → 重跑不接續",
    extraFiles: { [TEST_CONFIG_PATH]: TEST_CONFIG.replace("@TestConfiguration", "@org.springframework.context.annotation.Configuration") },
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_SPRING } }] }, { content: "已建立 CalcTest.java" }],
    rerun: {
      between: { [TEST_CONFIG_PATH]: TEST_CONFIG.replace("@TestConfiguration", "@org.springframework.context.annotation.Configuration").replace("class TestConfig {\n}", "class TestConfig {\n    // a stub bean now answers every call with a default\n}") },
      api: RESUME_REWRITE_CALC,
    },
  }),
  resumeCalc({
    name: "loop-resume-application-yml-between-runs",
    desc: "CalcTest 是 @SpringBootTest；src/test/resources/application.yml（Spring Boot 自己載入，沒有字串點名）在兩次執行之間被改 → 重跑不接續",
    extraFiles: { "src/test/resources/application.yml": "feature:\n  pricing: strict\n" },
    firstApi: [{ toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST_SPRING } }] }, { content: "已建立 CalcTest.java" }],
    rerun: { between: { "src/test/resources/application.yml": "feature:\n  pricing: off\n" }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-application-yml-not-spring",
    desc: "對照：CalcTest 不起 Spring context；application.yml 在兩次執行之間被改 → 它讀不到那個檔，照樣接續",
    extraFiles: { "src/test/resources/application.yml": "feature:\n  pricing: strict\n" },
    rerun: { between: { "src/test/resources/application.yml": "feature:\n  pricing: off\n" }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-two-top-level-types",
    desc: "CalcTest 用 Orders.one()，Orders 是 TestData.java 裡的第二個 top-level 類別；通過後 Orders 被改 → 紀錄有 TestData.java，重跑不接續",
    extraFiles: { [`${TEST_DIR}/TestData.java`]: "package com.x;\n\nclass TestData {\n}\n\nclass Orders {\n    static int one() { return 1; }\n}\n" },
    firstApi: [
      { toolCalls: [{ name: "write_file", args: { path: CALC_TEST_PATH, content: CALC_TEST.replace("assertEquals(3, new Calc().add(1, 2));", "assertEquals(3, new Calc().add(Orders.one(), 2));") } }] },
      { content: "已建立 CalcTest.java" },
    ],
    rerun: {
      between: { [`${TEST_DIR}/TestData.java`]: "package com.x;\n\nclass TestData {\n}\n\nclass Orders {\n    static int one() { return 0; }\n}\n" },
      api: RESUME_REWRITE_CALC,
    },
  }),
  resumeCalc({
    name: "loop-resume-import-folder-mismatch",
    desc: "CalcTest import com.x.support.Support，Support.java 放在 com/x/（package 與目錄不符，javac 照樣編）；通過後 Support 改了 → 紀錄有它，重跑不接續",
    extraFiles: { [SUPPORT_PATH]: "package com.x.support;\n\npublic class Support {\n    public static int one() { return 1; }\n}\n" },
    firstApi: [
      {
        toolCalls: [
          {
            name: "write_file",
            args: {
              path: CALC_TEST_PATH,
              content: CALC_TEST.replace("package com.x;", "package com.x;\n\nimport com.x.support.Support;").replace("assertEquals(3, new Calc().add(1, 2));", "assertEquals(3, new Calc().add(Support.one(), 2));"),
            },
          },
        ],
      },
      { content: "已建立 CalcTest.java" },
    ],
    rerun: {
      between: { [SUPPORT_PATH]: "package com.x.support;\n\npublic class Support {\n    public static int one() { return 2; }\n}\n" },
      api: RESUME_REWRITE_CALC,
    },
  }),
  resumeCalc({
    name: "loop-resume-red-baseline-flake-then-repair",
    desc: "重跑的預檢紅在 LegacyTest，同一次建置裡 CalcTest 失敗後 surefire 重跑才過（<flakyFailure>）；修復迴圈修好 LegacyTest → 修復那次建置的報告蓋掉了證據，但預檢一結束就記下了：重跑不接續",
    rerun: {
      between: { [LEGACY_PATH]: LEGACY_FIXED },
      api: [
        { toolCalls: [{ name: "write_file", args: { path: LEGACY_HELPER_PATH, content: LEGACY_HELPER } }] },
        { content: "已補上 LegacyHelper" },
        ...RESUME_REWRITE_CALC,
      ],
    },
    rerunMvn: [
      {
        exit: 1,
        out: `${TEST_FAILURE(LEGACY)}\n${FLAKY_OUT}`,
        cleanSurefire: true,
        surefireXml: [
          { suite: LEGACY, body: SUREFIRE_XML(LEGACY, 4, [LEGACY_CASE]) },
          { suite: "com.x.CalcTest", body: FLAKY_CALC_XML },
        ],
      },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) },
    ],
  }),
  (() => {
    // CalcTest as a zh-TW repo keeps it (MS950), its encoding set in a parent outside the repo: sniffed.
    const pre = 'package com.x;\n\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass CalcTest {\n    @Test\n    void add_twoPositives_returnsSum() {\n        assertEquals(3, new Calc().add(1, 2));\n        assertEquals("';
    const post = '", Messages.success());\n    }\n}\n';
    const calcTestMs950 = [...Buffer.from(pre), 0xb3, 0x42, 0xb2, 0x7a, 0xa6, 0xa8, 0xa5, 0x5c, ...Buffer.from(post)]; // 處理成功
    const MESSAGES_PATH = `${TEST_DIR}/Messages.java`;
    const messages = (v: string) => `package com.x;\n\nclass Messages {\n    static String success() { return "${v}"; }\n}\n`;
    const unitTest = CALC_TEST.replace("class CalcTest", "class CalcUnitTest");
    const round = { exit: 0, out: BUILD_SUCCESS(5), cleanSurefire: true, surefire: ran("com.x.CalcTest", "com.x.CalcUnitTest", "com.x.ExistingTest"), jacoco: JACOCO_GREEN };
    return {
      name: "loop-resume-sniffed-ms950-helper",
      desc: "模組編碼設在 repo 外的 parent（sniffed，名稱不明），既有的 MS950 CalcTest 在「處理成功」之後呼叫 Messages；通過後 Messages 被改 → 以雙位元組編碼讀，功 的 \\ 不會吃掉後面的程式碼：紀錄有 Messages，重跑不接續",
      entry: "loop",
      env: { UT_SKIP_REVIEW: "1" },
      extraFiles: { "pom.xml": CORP_POM, [MESSAGES_PATH]: messages("OK") },
      extraBytes: { [CALC_TEST_PATH]: calcTestMs950 },
      api: [{ toolCalls: [{ name: "write_file", args: { path: `${TEST_DIR}/CalcUnitTest.java`, content: unitTest } }] }, { content: "已建立 CalcUnitTest.java" }],
      rerun: {
        between: { [MESSAGES_PATH]: messages("") },
        api: [{ toolCalls: [{ name: "write_file", args: { path: `${TEST_DIR}/CalcUnitTest.java`, content: `${unitTest}// again\n` } }] }, { content: "已更新" }],
      },
      mvn: [{ ...round, surefire: ran("com.x.CalcTest", "com.x.ExistingTest") }, round, round, round],
    } as Scenario;
  })(),
  (() => {
    const suite = (calcFails: boolean, greeter: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="TestSuite" time="0.5" tests="${greeter ? 5 : 3}" errors="0" skipped="0" failures="${calcFails ? 1 : 0}">
  <testcase name="add_twoPositives_returnsSum" classname="com.x.CalcTest" time="0.03">${calcFails ? `
    <failure message="flaky" type="java.lang.AssertionError"><![CDATA[java.lang.AssertionError: flaky
\tat com.x.CalcTest.add_twoPositives_returnsSum(CalcTest.java:10)
]]></failure>
  ` : ""}</testcase>
  <testcase name="div_byZero_throwsIllegalArgument" classname="com.x.CalcTest" time="0.01"/>
  <testcase name="add_twoPositives_returnsSum" classname="com.x.ExistingTest" time="0.01"/>${greeter ? `
  <testcase name="greet_withName_saysHello" classname="com.x.GreeterTest" time="0.01"/>
  <testcase name="greet_withoutName_greetsStranger" classname="com.x.GreeterTest" time="0.01"/>` : ""}
</testsuite>
`;
    const out = (fail: boolean) =>
      [
        "[INFO] Scanning for projects...",
        "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
        "[INFO] Running TestSuite",
        `[${fail ? "ERROR" : "INFO"}] Tests run: 5, Failures: ${fail ? 1 : 0}, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s -- in TestSuite`,
        ...(fail
          ? ["[ERROR] Failures: ", "[ERROR]   CalcTest.add_twoPositives_returnsSum:10 flaky", "[ERROR] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0", "[INFO] BUILD FAILURE"]
          : ["[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0", "[INFO] BUILD SUCCESS"]),
      ].join("\n");
    const green = (greeter: boolean) => ({ exit: 0, out: out(false), cleanSurefire: true, surefireXml: [{ suite: "TestSuite", body: suite(false, greeter) }], jacoco: [JACOCO_GREEN, JACOCO_GREETER] });
    return {
      name: "loop-resume-testng-flake-later-batch",
      desc: "TestNG（只有 TEST-TestSuite.xml）：Calc 那批通過；Greeter 那批的建置失敗在沒碰過的 CalcTest（重跑會過）→ suite 報告裡的失敗算在 CalcTest 身上，重跑確認是 flaky，Calc 的紀錄記成作廢",
      entry: "loop",
      env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "1" },
      extraFiles: { [GREETER_PATH]: GREETER_JAVA },
      api: [
        ...RESUME_WRITE_CALC,
        { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
        { content: "已建立 GreeterTest.java" },
      ],
      rerun: { api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }, ...RESUME_REWRITE_CALC] },
      mvn: [
        BASE_EXISTING,
        green(false),
        { exit: 1, out: out(true), cleanSurefire: true, surefireXml: [{ suite: "TestSuite", body: suite(true, true) }] },
        green(true),
        green(true),
        green(true),
        green(true),
      ],
    } as Scenario;
  })(),
  resumeCalc({
    name: "loop-resume-log-only-all-skipped",
    desc: "surefire 報告寫到別處（reportsDirectory 改過），只有 log；這次預檢 CalcTest 的測試全部被略過（Skipped: 2）→ 看 log 的略過數，重跑不接續",
    rerun: { api: RESUME_REWRITE_CALC },
    rerunMvn: [
      {
        exit: 0,
        out: [
          "[INFO] Scanning for projects...",
          "[INFO] --- surefire:3.2.5:test (default-test) @ fixture ---",
          "[INFO] Running com.x.CalcTest",
          "[WARNING] Tests run: 2, Failures: 0, Errors: 0, Skipped: 2, Time elapsed: {{elapsed}} s -- in com.x.CalcTest",
          "[INFO] Running com.x.ExistingTest",
          "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: {{elapsed}} s -- in com.x.ExistingTest",
          "[WARNING] Tests run: 4, Failures: 0, Errors: 0, Skipped: 2",
          "[INFO] BUILD SUCCESS",
        ].join("\n"),
        cleanSurefire: true,
        jacoco: JACOCO_GREEN,
      },
      CALC_BUILD,
    ],
  }),
  {
    name: "loop-resume-flaky-then-interrupted",
    desc: "資料夾 Calc、Greeter；Calc 那批通過；Greeter 那批第 1 輪的建置失敗在 CalcTest、重跑才過（flaky），覆蓋率沒過，第 2 輪 writer 執行中 Ctrl-C → 判定 flaky 的當下就記下 Calc 的紀錄作廢，重跑不接續",
    entry: "loop",
    env: { UT_SKIP_REVIEW: "1", UT_MAX_ITER: "2" },
    extraFiles: { [GREETER_PATH]: GREETER_JAVA },
    api: [
      ...RESUME_WRITE_CALC,
      { toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] },
      { content: "已建立 GreeterTest.java" },
      { interrupt: true, content: "（被中斷）" },
    ],
    rerun: {
      api: [{ toolCalls: [{ name: "write_file", args: { path: GREETER_TEST_PATH, content: GREETER_TEST } }] }, { content: "已建立 GreeterTest.java" }, ...RESUME_REWRITE_CALC],
    },
    mvn: [
      BASE_EXISTING,
      CALC_BUILD,
      {
        exit: 1,
        out: TEST_FAILURE("com.x.CalcTest"),
        cleanSurefire: true,
        surefire: ran("com.x.ExistingTest", "com.x.GreeterTest"),
        surefireXml: [{ suite: "com.x.CalcTest", body: SUREFIRE_XML("com.x.CalcTest", 2, [{ nested: "", method: "add_twoPositives_returnsSum", message: "flaky", line: 10 }]) }],
      },
      { ...GREETER_ROUND, jacoco: [JACOCO_GREEN, JACOCO_GREETER_RED] },
      GREETER_ROUND, // the rerun's baseline (GreeterTest set aside by then: it only has to run what exists)
      GREETER_ROUND,
      GREETER_ROUND,
    ],
  },
  resumeCalc({
    name: "loop-resume-new-file-shadows",
    desc: "CalcTest 以 import com.y.* 用 Support（紀錄記下 com/y/Support.java，連同當時不存在的 com/x/Support.java）；通過後有人在 com/x 加了 Support.java → javac 改綁同 package 的那個：重跑不接續",
    extraFiles: { [OTHER_SUPPORT_PATH]: OTHER_SUPPORT.replace("class Support", "public class Support").replace("static int one()", "public static int one()") },
    firstApi: [
      {
        toolCalls: [
          {
            name: "write_file",
            args: { path: CALC_TEST_PATH, content: CALC_TEST_WITH_SUPPORT.replace("package com.x;", "package com.x;\n\nimport com.y.*;") },
          },
        ],
      },
      { content: "已建立 CalcTest.java" },
    ],
    rerun: { between: { [SUPPORT_PATH]: SUPPORT_JAVA.replace("return 1;", "return 0;") }, api: RESUME_REWRITE_CALC },
  }),
  resumeCalc({
    name: "loop-resume-repair-deleted-config",
    desc: "重跑的預檢在 LegacyTest 紅燈，修復迴圈（能刪檔的 writer runtime）刪掉測試目錄裡的 @Configuration 才轉綠 → 刪掉它也改變了每個 context 載入的東西：重跑不接續",
    extraFiles: { [TEST_CONFIG_PATH]: TEST_CONFIG.replace("@TestConfiguration", "@org.springframework.context.annotation.Configuration") },
    rerun: {
      between: { [LEGACY_PATH]: LEGACY_FIXED },
      api: [{ sideDelete: [TEST_CONFIG_PATH], content: "刪掉了壞掉的 TestConfig" }, ...RESUME_REWRITE_CALC],
    },
    rerunMvn: [
      LEGACY_RED(),
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) },
      { ...CALC_BUILD, surefire: ran("com.x.CalcTest", "com.x.ExistingTest", LEGACY) },
    ],
  }),
];

export const byName = (name: string): Scenario => {
  const sc = SCENARIOS.find((s) => s.name === name);
  if (!sc) throw new Error(`未知情境：${name}`);
  return sc;
};
