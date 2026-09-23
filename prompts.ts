// Writer + reviewer prompts. Standards and rubric are injected by the loop
// (injection over discovery). Score scale matches the skill rubric (0-10 integers);
// weighted_score/grade are computed by the pipeline — the reviewer must not output them.
import * as path from "node:path";
import { ModuleInfo, REVIEW_DIMENSIONS } from "./libs/types";
import { SCORE_THRESHOLDS } from "./config";
import { expectedTestPath } from "./libs/utils";
import { TestConventions } from "./libs/conventions";
import { ShrinkViolation } from "./libs/testmetrics";
import { canMockStatic, majorOf, minorOf, TestStack, versionAtLeast } from "./libs/teststack";
import { isUtf8Name, SourceEncoding } from "./libs/encoding";

// Six dimensions as name + one-liner for the writer — direction only, no rubric detail (avoid teaching-to-the-test).
export const DIMENSION_ONELINERS = `你產出的測試之後會依以下六個維度被審查（評分細則由審查方持有）：
- Effectiveness：斷言驗證具體行為與值，能抓出真實錯誤
- Coverage：涵蓋正常路徑、邊界（null/空/0/負數/極值）與例外路徑
- Independence：測試彼此獨立、無順序相依、無共享可變狀態
- Readability：AAA 結構、命名「方法_情境_預期結果」、意圖清晰
- Fast & Reliable：無 sleep、無真實 I/O、結果具決定性
- Mock Appropriateness：只 mock 外部相依，不過度驗證內部實作`;

// Test files that already exist for a target class. The loop resolves these on disk and
// names them in the prompt — "若已存在測試檔請補強" alone leaves the writer to discover them,
// and a writer that misses one creates <Class>UnitTest.java next to <Class>Test.java.
export interface ExistingTests {
  cls: string;
  tests: string[];
}

// Failures the module already had before the writer touched anything, from the baseline
// pre-check. Named so the writer can tell them apart from its own damage in the gate report.
export interface PreExistingFailures {
  compileErrorFiles: string[];
  failingTestClasses: string[];
}

// Measured project conventions -> prompt text. A class-symbol suite is a hard constraint
// (package-private breaks the build), so it is stated as a requirement; everything else is
// reported as what the module already does, for the writer to match.
export function renderConventions(c: TestConventions | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.classRefSuites.length) {
    parts.push(
      `本模組有以 @SelectClasses / @SuiteClasses 逐一列舉測試類別的測試套件：\n` +
        c.classRefSuites.map((f) => `- ${f}`).join("\n") +
        `\n跨 package 引用測試類別需要 public 可見性，因此你產生的測試類別**必須**宣告為 ` +
        `\`public class\`——package-private 會讓該套件編譯失敗（cannot find symbol）。`,
    );
  } else if (c.publicCount + c.packagePrivateCount > 0) {
    const dominant = c.publicCount >= c.packagePrivateCount ? "public" : "package-private";
    parts.push(
      `本模組既有測試類別的可見性慣例為 **${dominant}**` +
        `（public ${c.publicCount} 個、package-private ${c.packagePrivateCount} 個），請沿用。`,
    );
  }
  if (parts.length === 0) return "";
  return `專案既有慣例（由 pipeline 掃描既有測試得出，非推測）：
${parts.join("\n")}
`;
}

// ─── The measured test stack ─────────────────────────────────────────────────

const ver = (v: string | undefined) => (v ? ` ${v}` : "");

type Framework = "JUnit 5" | "JUnit 4" | "TestNG";

function frameworkKind(stack: TestStack | undefined): Framework {
  if (!stack) return "JUnit 5";
  const exact = stack.source === "surefire";
  const has5 = stack.junit5 !== undefined;
  const has4 = stack.junit4 !== undefined;
  const hasNg = stack.testng !== undefined;
  // TestNG beside JUnit: surefire runs one provider, and which one depends on its version. The
  // module's existing tests say which one they are written for.
  if (hasNg && (has5 || has4) && stack.usage) {
    const u = stack.usage;
    if (u.testng > u.junit5 + u.junit4) return "TestNG";
  }
  if (has5) return "JUnit 5";
  if (has4 && frameworkSettled(stack)) return "JUnit 4";
  if (hasNg && frameworkSettled(stack)) return "TestNG";
  // Unsettled: the module's existing tests show what its build runs. With none to go by, JUnit 5
  // fails loudest when wrong — a compile error the task line's fallback names — where a JUnit 4
  // test on a JUnit Platform without the vintage engine compiles and silently never runs.
  const u = stack.usage;
  if (u && u.junit5 === 0) {
    if (has4 && u.junit4 > 0 && u.junit4 >= u.testng) return "JUnit 4";
    if (hasNg && u.testng > 0) return "TestNG";
  }
  return "JUnit 5";
}

/**
 * Whether the declared framework is the whole story. A surefire classpath is; from a pom, a
 * declared junit:junit or testng only is when nothing outside the repo adds dependencies — a
 * corporate parent may well bring JUnit 5 — or the Spring Boot line says JUnit 4 is all there is.
 */
function frameworkSettled(stack: TestStack): boolean {
  return stack.source === "surefire" || !stack.unknownParent || !!stack.inferred?.some((l) => l.includes("只帶 JUnit 4"));
}

/** The framework new tests are written in, as the task line names it. */
export function frameworkOf(stack: TestStack | undefined): string {
  const kind = frameworkKind(stack);
  // JUnit 6 is the next Jupiter line; same annotations, new major.
  if (kind === "JUnit 5" && majorOf(stack?.junit5) >= 6) return `JUnit ${majorOf(stack?.junit5)}`;
  return kind;
}

// What the language level rules out: syntax and the APIs writers reach for most. Oldest first.
const LANGUAGE_FEATURES: Array<[number, string]> = [
  [8, "lambda 與 method reference、Stream、Optional、java.time（例外請用匿名類別或 try/fail/catch）"],
  [9, "List.of / Set.of / Map.of、Optional.ifPresentOrElse / or / stream"],
  [10, "var、List.copyOf、Optional.orElseThrow()"],
  [11, "String.isBlank / strip / repeat / lines、Optional.isEmpty、Files.readString"],
  [14, "switch expression"],
  [15, "text block（\"\"\"）"],
  [16, "record、instanceof pattern matching、Stream.toList()"],
  [17, "sealed 類別"],
  [21, "switch 的 pattern matching、record pattern、List.getFirst / getLast"],
];

/**
 * Measured test stack -> prompt text. From a surefire classpath every statement is a fact,
 * absences included; from the pom only what is declared (or what the Spring Boot line implies)
 * is said, because most of a test stack arrives transitively and an undeclared library may well
 * be there. A version that is not known never unlocks an API that needs a version.
 */
export function renderTestStack(stack: TestStack | undefined): string {
  if (!stack) return "";
  const exact = stack.source === "surefire";
  const kind = frameworkKind(stack);
  const has5 = stack.junit5 !== undefined;
  const has4 = stack.junit4 !== undefined;
  const hasNg = stack.testng !== undefined;
  const assertj = stack.assertj !== undefined;
  const lines: string[] = [];

  if (kind === "JUnit 5") {
    if (has5) {
      lines.push(
        `測試框架：${frameworkOf(stack)}${ver(stack.junit5)}` +
          (has4 ? `，另有 JUnit 4${ver(stack.junit4)}（vintage）——新測試一律用 JUnit 5` : ""),
      );
    } else if (has4 || hasNg) {
      // Declared, but not the whole story, and no existing tests to settle it.
      const declared = has4 ? `JUnit 4${ver(stack.junit4)}` : `TestNG${ver(stack.testng)}`;
      lines.push(
        `測試框架：pom 宣告了 ${declared}，但繼承 repo 外的 parent ${stack.unknownParent}，是否另有 JUnit 5 量不到。` +
          `先用 JUnit 5；若編譯錯誤說 org.junit.jupiter 不存在，改用 ${has4 ? "JUnit 4（org.junit.Test，測試類別與方法都要 public）" : "TestNG（org.testng.annotations.Test）"}`,
      );
    }
  } else if (kind === "JUnit 4") {
    const exceptions = assertj
      ? "例外用 AssertJ 的 assertThatThrownBy"
      : versionAtLeast(stack.junit4, 4, 13)
        ? "例外用 Assert.assertThrows（JUnit 4.13+）"
        : "例外用 @Test(expected = …)，或 try { …; fail(); } catch (預期的例外 e) { 驗證訊息 }（assertThrows 要 JUnit 4.13 才有）";
    // Settled, JUnit 4 is all there is; chosen from the existing tests, it is what they use — a
    // parent outside the repo might add JUnit 5, and saying "there is none" would be a guess.
    const which = frameworkSettled(stack)
      ? `**只有** JUnit 4${ver(stack.junit4)}，沒有 JUnit 5`
      : `JUnit 4${ver(stack.junit4)}——模組既有測試都用 JUnit 4（pom 繼承 repo 外的 parent ${stack.unknownParent}，是否另有 JUnit 5 量不到），新測試跟它們一樣`;
    lines.push(
      `測試框架：${which}。用 org.junit.Test、org.junit.Before、org.junit.Assert；` +
        "測試類別、@Test 與 @Before / @After 方法都必須是 public（JUnit 4 會拒絕 package-private 的測試）；" +
        `${exceptions}。` +
        "標準裡 JUnit 5 的寫法（org.junit.jupiter.*、@ExtendWith、@BeforeEach、@DisplayName、@Nested、@ParameterizedTest）一律不能用",
    );
  } else {
    lines.push(
      `測試框架：TestNG${ver(stack.testng)}。用 org.testng.annotations.Test、@BeforeMethod、org.testng.Assert；` +
        "JUnit 的 @ExtendWith(MockitoExtension.class) 在 TestNG 下沒有作用，mock 在 @BeforeMethod 裡初始化",
    );
  }
  if (hasNg && (has5 || has4)) {
    lines.push(
      stack.usage
        ? `classpath 上同時有 TestNG 與 JUnit，surefire 只會用其中一個 provider 跑測試；本模組既有測試：TestNG ${stack.usage.testng} 個、` +
            `JUnit ${stack.usage.junit5 + stack.usage.junit4} 個——新測試跟既有測試用同一個框架（${kind}）`
        : "classpath 上同時有 TestNG 與 JUnit，surefire 只會用其中一個 provider 跑測試——新測試跟模組既有的測試用同一個框架",
    );
  }

  if (stack.mockito !== undefined) {
    const parts = [`Mockito${ver(stack.mockito)}`];
    const v1 = majorOf(stack.mockito) === 1;
    if (v1) parts.push("1.x：參數匹配器在 org.mockito.Matchers（沒有 ArgumentMatchers）");
    const annotations = versionAtLeast(stack.mockito, 3, 4)
      ? "MockitoAnnotations.openMocks(this)"
      : majorOf(stack.mockito) < 3 || (majorOf(stack.mockito) === 3 && minorOf(stack.mockito) < 4)
        ? "MockitoAnnotations.initMocks(this)"
        : "MockitoAnnotations.openMocks(this)（Mockito 3.4 以前是 initMocks(this)）";
    if (kind === "JUnit 5" && stack.mockitoJupiter) {
      parts.push("可用 @ExtendWith(MockitoExtension.class)——它預設 strict stubs，沒被用到的 stub 會讓測試失敗（UnnecessaryStubbingException）");
    } else if (kind === "JUnit 5" && stack.mockitoJupiter === false) {
      parts.push(`沒有 mockito-junit-jupiter：不能用 @ExtendWith(MockitoExtension.class)，改在 @BeforeEach 呼叫 ${annotations}`);
    } else if (kind === "JUnit 4") {
      parts.push(`搭配 @RunWith(${v1 ? "org.mockito.runners" : "org.mockito.junit"}.MockitoJUnitRunner.class)`);
    } else if (kind === "TestNG") {
      parts.push(`在 @BeforeMethod 呼叫 ${annotations}`);
    }
    if (canMockStatic(stack)) {
      parts.push("可以 mock final 類別與 static 方法（Mockito.mockStatic，用 try-with-resources 關閉）");
    } else if (stack.mockitoInline) {
      parts.push(
        Number.isFinite(majorOf(stack.mockito)) && stack.mockito !== ""
          ? "可以 mock final 類別，但這個版本沒有 mockStatic（Mockito 3.4 才有）"
          : "可以 mock final 類別；mockStatic 要 Mockito 3.4 以上",
      );
    } else if (exact) {
      const hasMockStatic = versionAtLeast(stack.mockito, 3, 4);
      parts.push(
        "**不能** mock final 類別/方法與 static 方法（" +
          (hasMockStatic ? "沒有 inline mock maker——mockStatic 編得過、執行時失敗" : "這個版本沒有 mockStatic，也沒有 inline mock maker") +
          "）；遇到時改從呼叫端可注入的相依替換，或測試它的可觀察結果",
      );
    }
    lines.push(parts.join("；"));
  } else if (exact) {
    lines.push("沒有 Mockito：不能用 @Mock / mock()，需要替身時手寫簡單的 stub 或 fake 類別");
  }
  if (stack.powermock !== undefined) {
    lines.push(`有 PowerMock${ver(stack.powermock)}（既有測試在用）——新測試不要引入它`);
  }

  const hamcrest =
    stack.hamcrest === undefined
      ? ""
      : stack.hamcrestCoreOnly
        ? `hamcrest-core${ver(stack.hamcrest)}（只有 org.hamcrest.CoreMatchers，沒有 org.hamcrest.Matchers）`
        : `Hamcrest${ver(stack.hamcrest)}`;
  if (assertj) {
    lines.push(`斷言：AssertJ${ver(stack.assertj)}${hamcrest ? `、${hamcrest}` : ""}`);
  } else if (exact) {
    const builtIn = kind === "JUnit 5" ? "org.junit.jupiter.api.Assertions" : kind === "JUnit 4" ? "org.junit.Assert" : "org.testng.Assert";
    lines.push(`斷言：**沒有 AssertJ**，用 ${builtIn}${hamcrest ? `（或 ${hamcrest}）` : ""}`);
  } else if (hamcrest) {
    lines.push(`斷言：${hamcrest}`);
  }

  const release = Number(stack.javaRelease);
  if (stack.javaRelease && Number.isFinite(release)) {
    const unavailable = LANGUAGE_FEATURES.filter(([since]) => release < since).map(([, what]) => what);
    lines.push(`Java 語言層級：${stack.javaRelease}` + (unavailable.length ? `——不能用 ${unavailable.join("；")}` : ""));
  }

  if (!lines.length) return "";
  const header = exact
    ? "本模組測試 classpath 上實際有的東西（pipeline 從這個模組實際跑過的測試量得，以此為準；標準裡的預設寫法與此衝突時，以這裡為準）："
    : "本模組 pom 宣告的測試相依（pipeline 讀 pom 得出——沒有可採用的測試 classpath：模組還沒跑過測試、surefire 太舊不記錄、" +
      "或報告比 pom 舊。沒列出的不代表沒有，許多相依是間接帶進來的，請以 pom 與既有測試為準）：";
  const notes: string[] = [];
  if (stack.inferred?.length) notes.push(`由版本推斷：${stack.inferred.join("；")}`);
  if (stack.unknownParent) notes.push(`pom 繼承 repo 外的 parent ${stack.unknownParent}，它管理的相依量不到`);
  return `${header}\n${lines.map((l) => `- ${l}`).join("\n")}${notes.length ? `\n（${notes.join("。")}）` : ""}\n`;
}

// `locked`: existing test files the writer cannot edit without destroying them (non-UTF-8 files
// in a non-UTF-8 module — see renderSourceEncoding). For those, and only those, a new test class
// beside them is the way to add tests.
export function renderExistingTests(existing: ExistingTests[], locked: string[] = [], encoding = ""): string {
  const withTests = existing.filter((e) => e.tests.length > 0);
  if (withTests.length === 0) return "";
  const isLocked = new Set(locked);
  const show = (t: string, cls: string) =>
    isLocked.has(t)
      ? `${t}（${encoding} 編碼、含非 ASCII 字元——不能修改；請在同一個 package 另建 ` +
        `${path.basename(cls, ".java")}AdditionalTest.java 補測試）`
      : t;
  const rows = withTests
    .map((e) => `- ${e.cls}\n  已存在：${e.tests.map((t) => show(t, e.cls)).join("、")}`)
    .join("\n");
  const anyLocked = withTests.some((e) => e.tests.some((t) => isLocked.has(t)));
  return `以下目標類別「已經有」測試檔，必須直接開啟並修改/補強這些既有檔案：
${rows}
嚴禁另建新檔（例如 <ClassName>UnitTest.java）來繞過既有測試——那會產生重複測試。${anyLocked ? "（上面標明不能修改的檔案除外。）" : ""}
`;
}

export type EncodingMode = "transcode" | "protect";

/**
 * A module compiled from a non-UTF-8 encoding, told to the writer (libs/encoding.ts). With a JDK
 * the test sources are shown as an ASCII view and written back in the module's encoding, so the
 * writer can read and edit them like any other; this is so it does not mistake the escapes for
 * mojibake. Without one, what holds characters outside ASCII cannot be written back faithfully:
 * the writer writes ASCII and leaves those files alone.
 */
export function renderSourceEncoding(enc: SourceEncoding | undefined, locked: string[] = [], mode: EncodingMode = "transcode"): string {
  if (!enc || isUtf8Name(enc.name)) return "";
  const why = enc.source === "pom" ? "專案設定的編碼" : enc.source === "platform" ? "沒有設定，建置用了平台編碼" : "設定不在 repo 裡";
  const lockedLines = (reason: string) =>
    locked.length
      ? [
          `- 以下既有測試檔${reason}，所以**不能修改**——被改到會還原並判該輪失敗。要補測試時，在同一個 package 另建新的測試類別（例如 <ClassName>AdditionalTest.java）：`,
          ...locked.slice(0, 20).map((f) => `  - ${f}`),
          ...(locked.length > 20 ? [`  …另 ${locked.length - 20} 個`] : []),
        ]
      : [];
  const lines =
    mode === "transcode"
      ? [
          `本模組的 Java 原始碼以 **${enc.name}** 編譯（${why}），不是 UTF-8。為了讓你的工具讀寫正確，pipeline 已把測試檔裡` +
            "的非 ASCII 字元（中文註解、字串）改寫成 Java 的 \\uXXXX 跳脫——同一個字元的另一種寫法，編譯結果完全相同，不是亂碼：",
          "- 讀到的 \\uXXXX 照常引用、原樣保留；不要把它們當成亂碼去「修正」，也不要自己換成別的字",
          `- 你要寫的中文可以直接寫：結束後 pipeline 以 ${enc.name} 存檔（${enc.name} 放不下的字存成 \\uXXXX），你沒改到的行維持原本的內容`,
          ...lockedLines(`不是有效的 ${enc.name}，pipeline 無法轉換`),
        ]
      : [
          enc.source === "sniffed"
            ? "本模組的 Java 原始碼不是 UTF-8（編碼設定不在 repo 裡，pipeline 看不出是哪一種），所以無法轉換："
            : `本模組的 Java 原始碼以 **${enc.name}** 編譯（${why}），不是 UTF-8，而這台機器沒有可用的 JDK 來轉換編碼：`,
          "- 你寫的測試碼只用 ASCII：註解、@DisplayName 一律用英文；字串常值需要中文等非 ASCII 字元時寫成 \\uXXXX" +
            "（pipeline 會把殘留的非 ASCII 字元自動轉成 \\uXXXX 讓它編得過，但英文註解比一串跳脫字元好讀）",
          ...lockedLines(`以 ${enc.name} 存、含非 ASCII 字元，你的工具以 UTF-8 讀寫會破壞裡面的字元（字串常值也是）`),
        ];
  return `${lines.join("\n")}\n`;
}

/**
 * The target classes as the module's encoding reads them. Production code is never put in a view
 * on disk, and an agent tool reads its MS950 as mojibake — copied into an assertion, that is a test
 * that can never pass.
 */
export function renderTargetSources(sources: Array<{ file: string; view: string }> | undefined, enc: SourceEncoding | undefined): string {
  if (!sources?.length || !enc) return "";
  // Bounded like any other part of a prompt; the rest of each file is still there to read.
  const MAX_CHARS = 30_000;
  let used = 0;
  const blocks = sources.map((s) => {
    const room = Math.max(0, MAX_CHARS - used);
    const body = s.view.length > room ? `${s.view.slice(0, room)}\n…（以下省略 ${s.view.length - room} 字元）` : s.view;
    used += body.length;
    return `<source path="${s.file}">\n${body}\n</source>`;
  });
  return (
    `目標類別的原始碼以 ${enc.name} 存，你的工具直接讀會看到亂碼。以下是 pipeline 以 ${enc.name} 解碼的內容（非 ASCII 字元寫成 \\uXXXX）——` +
    `要引用裡面的中文字串（例外訊息、回傳值）時以這裡為準：\n${blocks.join("\n")}\n`
  );
}

/** The same, for the reviewer: what it reads is the view, not how the author wrote it. */
export function renderReviewEncoding(enc: SourceEncoding | undefined, mode: EncodingMode | undefined): string {
  if (!enc || isUtf8Name(enc.name) || !mode) return "";
  return mode === "transcode"
    ? `注意：本模組原始碼以 ${enc.name} 編譯。測試檔裡的 \\uXXXX 是 pipeline 為了讓你讀對非 ASCII 字元（中文註解、字串）` +
        "而做的跳脫，不是作者的寫法——請當成對應的字元看待，不要因此扣可讀性的分數或列為問題。\n\n"
    : `注意：本模組原始碼以 ${enc.name} 存檔，你的工具以 UTF-8 讀取，檔案裡的中文可能顯示成亂碼——那是讀取方式的問題，` +
        "不是測試本身的問題，不要因此扣分或列為問題。\n\n";
}

export function renderPreExisting(pre: PreExistingFailures | undefined): string {
  if (!pre) return "";
  const { compileErrorFiles, failingTestClasses } = pre;
  if (compileErrorFiles.length === 0 && failingTestClasses.length === 0) return "";
  const rows: string[] = [];
  if (compileErrorFiles.length) rows.push(`編譯失敗的檔案：\n${compileErrorFiles.map((f) => `- ${f}`).join("\n")}`);
  if (failingTestClasses.length) rows.push(`測試失敗的類別：\n${failingTestClasses.map((c) => `- ${c}`).join("\n")}`);
  return `注意：以下失敗在本工具介入之前就已經存在，**不是你造成的**：
<pre_existing_failures>
${rows.join("\n")}
</pre_existing_failures>
上面失敗報告中屬於這些檔案的錯誤請一律忽略，**不要嘗試修復它們**——那不在本次任務範圍內，
修它們只會浪費本輪機會。你只需要處理目標類別的測試本身的問題。
`;
}

export interface GeneratePromptInput {
  targetClasses: string[];
  standards: string;
  mod: ModuleInfo;
  existingTests: ExistingTests[];
  conventions?: TestConventions;
  testStack?: TestStack;
  sourceEncoding?: SourceEncoding;
  // Repo-relative test files the writer must not edit (see renderSourceEncoding).
  lockedFiles?: string[];
  encodingMode?: EncodingMode;
  targetSources?: Array<{ file: string; view: string }>;
}

export function testRootRel(mod: ModuleInfo): string {
  return path.join(mod.moduleRel, "src", "test", "java").replace(/\\/g, "/");
}

// The writer's whole writable tree — what the scope guard and the opencode edit permission
// grant: test sources under java/, and test resources (fixtures, expected outputs) beside them.
function testResourcesRel(mod: ModuleInfo): string {
  return path.join(mod.moduleRel, "src", "test", "resources").replace(/\\/g, "/");
}

export function buildGeneratePrompt(input: GeneratePromptInput): string {
  const root = testRootRel(input.mod);
  const buildFile = input.mod.moduleRel
    ? `${input.mod.moduleRel}/pom.xml（或 build.gradle）`
    : "pom.xml（或 build.gradle）";
  return `你的任務：為以下 Java 類別撰寫單元測試（${frameworkOf(input.testStack)}）。

目標模組：${input.mod.multiModule ? input.mod.moduleRel : "（單一模組專案）"}
測試檔一律放在：${root}/<對應 package>/<ClassName>Test.java
若已存在測試檔，請補強而非覆蓋掉仍有效的測試。

目標類別：
${input.targetClasses.map((c) => `- ${c}`).join("\n")}

${renderExistingTests(input.existingTests, input.lockedFiles, input.sourceEncoding?.name)}${renderConventions(input.conventions)}${renderTestStack(input.testStack)}${renderSourceEncoding(input.sourceEncoding, input.lockedFiles, input.encodingMode)}${renderTargetSources(input.targetSources, input.sourceEncoding)}
必須嚴格遵守以下品質標準：
<standards>
${input.standards}
</standards>

${DIMENSION_ONELINERS}

流程要求：
1. 先讀取每個目標類別的原始碼與其相依介面，理解行為與邊界。
2. 參考 ${buildFile} 已宣告的測試相依，以及專案既有測試的風格。
3. 只建立/修改 ${root} 下的測試檔案（測試需要的資料檔放 ${testResourcesRel(input.mod)}）。不要執行任何建置或測試指令（由外部 pipeline 負責驗證）。
4. 不得修改 production code、不得刪除仍有效的測試、不得用 @Disabled / @Ignore / assume… 讓測試略過。

完成後以清單列出你建立/修改的檔案。`;
}

export interface FixPromptInput {
  gateReport: string;
  standards: string;
  mod: ModuleInfo;
  // Without these, from round 2 onward the writer's only clue about scope is whatever
  // class names survive in a truncated build log.
  targetClasses: string[];
  preExisting?: PreExistingFailures;
  conventions?: TestConventions;
  testStack?: TestStack;
  sourceEncoding?: SourceEncoding;
  lockedFiles?: string[];
  encodingMode?: EncodingMode;
  targetSources?: Array<{ file: string; view: string }>;
}

export function buildFixPrompt(input: FixPromptInput): string {
  const root = testRootRel(input.mod);
  return `上一輪產生的單元測試未通過驗證 pipeline，以下是失敗報告：

<gate_report>
${input.gateReport}
</gate_report>

${renderPreExisting(input.preExisting)}${renderConventions(input.conventions)}${renderTestStack(input.testStack)}${renderSourceEncoding(input.sourceEncoding, input.lockedFiles, input.encodingMode)}${renderTargetSources(input.targetSources, input.sourceEncoding)}
本次任務的目標類別（測試範圍以此為準）：
${input.targetClasses.map((c) => `- ${c}`).join("\n")}

請修正 ${root} 中相關的測試檔案（或 ${testResourcesRel(input.mod)} 的測試資源），讓上述所有問題被解決。仍然嚴格遵守：
<standards>
${input.standards}
</standards>

${DIMENSION_ONELINERS}

規則：
- 只修改測試碼，不得修改 production code
- 不得刪除有效測試來規避失敗、不得用 @Disabled / @Ignore / assume… 讓測試略過
- 不要執行任何建置或測試指令（由外部 pipeline 負責驗證）

完成後以清單列出你修改的檔案。`;
}

export interface RepairPromptInput {
  // Repo-relative test files (compile errors) and FQCNs (failing test classes).
  brokenFiles: string[];
  // Classification + error extract from the last build.
  report: string;
  standards: string;
  mod: ModuleInfo;
  round: number;
  testStack?: TestStack;
  sourceEncoding?: SourceEncoding;
  lockedFiles?: string[];
  encodingMode?: EncodingMode;
}

// The repair loop's writer prompt. Its definition of "fixed" is the one the guards enforce:
// the build is green AND nothing was taken away to get there.
export function buildRepairPrompt(input: RepairPromptInput): string {
  const root = testRootRel(input.mod);
  return `本模組在產生任何新測試之前就已經無法通過建置。你的任務是**修復既有測試**，讓模組回到綠燈；
這一步完成之後 pipeline 才會開始產生新測試。（第 ${input.round} 輪修復）

需要修復的既有測試：
${input.brokenFiles.map((f) => `- ${f}`).join("\n")}

<build_report>
${input.report}
</build_report>

${renderTestStack(input.testStack)}${renderSourceEncoding(input.sourceEncoding, input.lockedFiles, input.encodingMode)}
修復的定義：讓測試**正確地通過**，不是讓它消失。以下由 pipeline 以確定性方式檢查，違反即判 FAIL 或中止：
- 只能修改 ${root} 下的測試檔與 ${testResourcesRel(input.mod)} 下的測試資源；不得修改 production code、pom.xml / build.gradle 或其他任何檔案
- 既有測試檔的 @Test 方法數與斷言數不得減少、不得新增讓測試略過的寫法（@Disabled、@Ignore、enabled = false、assumeTrue 之類）
- 若根因在 production code 或建置設定（例如 Lombok 的 annotation processor 未在 test scope 生效，
  導致 @Slf4j 產不出 log 欄位），以測試碼能自足的方式處理（例如移除測試碼中的 logging），
  並在總結中說明根因，讓人類決定要不要修 production 端
- 若測試失敗是因為它的預期值已與 production 行為不符，先確認 production 行為是刻意的再更新
  預期值，並在總結中明確標示每一個被更動的預期值——那是人類 review 時最需要看的地方

仍然嚴格遵守：
<standards>
${input.standards}
</standards>

不要執行任何建置或測試指令（由外部 pipeline 負責驗證）。
完成後以清單列出你修改的檔案，以及每個檔案的修法與根因。`;
}

export function renderShrinkFeedback(violations: ShrinkViolation[]): string {
  const rows = violations.map((v) =>
    v.after === null
      ? `- ${v.file}：檔案被刪除（原有 @Test ${v.before.tests}、斷言 ${v.before.assertions}）`
      : `- ${v.file}：@Test ${v.before.tests} → ${v.after.tests}、斷言 ${v.before.assertions} → ${v.after.assertions}` +
        (v.after.disabled > v.before.disabled
          ? `、略過標記（@Disabled / @Ignore / enabled = false / assume…）${v.before.disabled} → ${v.after.disabled}`
          : ""),
  );
  return `writer 刪減了既有測試，本輪判 FAIL——修復或補強是讓測試正確，不是讓它消失：
${rows.join("\n")}
請把被移除的測試方法與斷言補回來（內容可以改寫，但數量不得少於原本），並移除新增的略過標記。
若某些既有測試確實應該整併，請保留等量的行為驗證。`;
}

export interface ReviewPromptInput {
  targetClasses: string[];
  rubric: string;
  mod: ModuleInfo;
  sourceEncoding?: SourceEncoding;
  encodingMode?: EncodingMode;
  targetSources?: Array<{ file: string; view: string }>;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const pairs = input.targetClasses
    .map((c) => `- 來源：${c}\n  預期測試：${expectedTestPath(c)}`)
    .join("\n");
  const dims = REVIEW_DIMENSIONS.map((d) => `"${d}"（門檻 ${SCORE_THRESHOLDS[d]}）`).join("、");

  return `請審查以下 Java 類別對應的單元測試品質。

目標模組：${input.mod.multiModule ? input.mod.moduleRel : "（單一模組專案）"}
目標類別與預期測試檔位置：
${pairs}
（若實際測試檔名不同，請自行以 glob/grep 在該模組 src/test/java 下找到對應檔案。）

${renderReviewEncoding(input.sourceEncoding, input.encodingMode)}${renderTargetSources(input.targetSources, input.sourceEncoding)}審查依據為以下評分 rubric（分數帶與 Java 範例皆以此為準）：
<rubric>
${input.rubric}
</rubric>

要求：
- 必須實際讀取每個測試檔案內容逐條檢查，不得僅憑檔名或摘要推斷。
- 不得臆測你沒有實際讀到的內容；quantitative signals（mutation score、
  branch coverage 等）不在你的職責內，由 pipeline 的 hard gate 負責，勿推估。
- 特別注意：無意義斷言（assertNotNull / assertTrue(true) / 只驗 mock 回傳值）、
  缺漏的邊界與例外情境、AAA 結構、命名規範、Thread.sleep、真實 I/O、
  測試間相依、@Disabled、以及任何對 production code 的修改跡象。

評分與判決定義：
- 六個維度各給 0-10「整數」，依 rubric 分數帶（9-10 / 7-8 / 5-6 / 3-4 / 0-2）：${dims}
- 不要計算或輸出 weighted_score、grade——由 pipeline 依權重確定性計算。
- blockers：相當於 rubric 的 severity=high——違反標準「禁止事項」、false-negative
  或會誤導的測試（例如無意義斷言、規避失敗的手段）。每條必須具體，
  包含檔名與方法名。blockers 非空即不通過。
- advisories：相當於 severity=medium/low 的建議級改善，不擋關。

最終回覆必須是「單一 JSON 物件」，不得包含 markdown 圍欄、前言或任何其他文字。schema：
{"scores":{"effectiveness":N,"coverage":N,"independence":N,"readability":N,"fast_reliable":N,"mock_appropriateness":N},"blockers":["..."],"advisories":["..."]}`;
}
