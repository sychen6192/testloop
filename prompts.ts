// Writer + reviewer prompts. Standards and rubric are injected by the loop
// (injection over discovery). Score scale matches the skill rubric (0-10 integers);
// weighted_score/grade are computed by the pipeline — the reviewer must not output them.
import * as path from "node:path";
import { ModuleInfo, REVIEW_DIMENSIONS } from "./libs/types";
import { SCORE_THRESHOLDS } from "./config";
import { expectedTestPath } from "./libs/utils";
import { TestConventions } from "./libs/conventions";

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

export function renderExistingTests(existing: ExistingTests[]): string {
  const withTests = existing.filter((e) => e.tests.length > 0);
  if (withTests.length === 0) return "";
  const rows = withTests
    .map((e) => `- ${e.cls}\n  已存在：${e.tests.join("、")}`)
    .join("\n");
  return `以下目標類別「已經有」測試檔，必須直接開啟並修改/補強這些既有檔案：
${rows}
嚴禁另建新檔（例如 <ClassName>UnitTest.java）來繞過既有測試——那會產生重複測試。
`;
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
}

export function testRootRel(mod: ModuleInfo): string {
  return path.join(mod.moduleRel, "src", "test", "java").replace(/\\/g, "/");
}

export function buildGeneratePrompt(input: GeneratePromptInput): string {
  const root = testRootRel(input.mod);
  const buildFile = input.mod.moduleRel
    ? `${input.mod.moduleRel}/pom.xml（或 build.gradle）`
    : "pom.xml（或 build.gradle）";
  return `你的任務：為以下 Java 類別撰寫單元測試（JUnit 5）。

目標模組：${input.mod.multiModule ? input.mod.moduleRel : "（單一模組專案）"}
測試檔一律放在：${root}/<對應 package>/<ClassName>Test.java
若已存在測試檔，請補強而非覆蓋掉仍有效的測試。

目標類別：
${input.targetClasses.map((c) => `- ${c}`).join("\n")}

${renderExistingTests(input.existingTests)}${renderConventions(input.conventions)}
必須嚴格遵守以下品質標準：
<standards>
${input.standards}
</standards>

${DIMENSION_ONELINERS}

流程要求：
1. 先讀取每個目標類別的原始碼與其相依介面，理解行為與邊界。
2. 參考 ${buildFile} 已宣告的測試相依，以及專案既有測試的風格。
3. 只建立/修改 ${root} 下的測試檔案。不要執行任何建置或測試指令（由外部 pipeline 負責驗證）。
4. 不得修改 production code、不得刪除仍有效的測試、不得使用 @Disabled。

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
}

export function buildFixPrompt(input: FixPromptInput): string {
  const root = testRootRel(input.mod);
  return `上一輪產生的單元測試未通過驗證 pipeline，以下是失敗報告：

<gate_report>
${input.gateReport}
</gate_report>

${renderPreExisting(input.preExisting)}${renderConventions(input.conventions)}
本次任務的目標類別（測試範圍以此為準）：
${input.targetClasses.map((c) => `- ${c}`).join("\n")}

請修正 ${root} 中相關的測試檔案，讓上述所有問題被解決。仍然嚴格遵守：
<standards>
${input.standards}
</standards>

${DIMENSION_ONELINERS}

規則：
- 只修改測試碼，不得修改 production code
- 不得刪除有效測試來規避失敗、不得使用 @Disabled
- 不要執行任何建置或測試指令（由外部 pipeline 負責驗證）

完成後以清單列出你修改的檔案。`;
}

export interface ReviewPromptInput {
  targetClasses: string[];
  rubric: string;
  mod: ModuleInfo;
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

審查依據為以下評分 rubric（分數帶與 Java 範例皆以此為準）：
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
