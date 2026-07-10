// Writer + reviewer prompts. Standards and rubric are injected by the loop
// (injection over discovery). Score scale matches the skill rubric (0-10 integers);
// weighted_score/grade are computed by the pipeline — the reviewer must not output them.
import * as path from "node:path";
import { ModuleInfo, REVIEW_DIMENSIONS } from "./libs/types";
import { SCORE_THRESHOLDS } from "./config";
import { expectedTestPath } from "./libs/utils";

// Six dimensions as name + one-liner for the writer — direction only, no rubric detail (avoid teaching-to-the-test).
export const DIMENSION_ONELINERS = `你產出的測試之後會依以下六個維度被審查（評分細則由審查方持有）：
- Effectiveness：斷言驗證具體行為與值，能抓出真實錯誤
- Coverage：涵蓋正常路徑、邊界（null/空/0/負數/極值）與例外路徑
- Independence：測試彼此獨立、無順序相依、無共享可變狀態
- Readability：AAA 結構、命名「方法_情境_預期結果」、意圖清晰
- Fast & Reliable：無 sleep、無真實 I/O、結果具決定性
- Mock Appropriateness：只 mock 外部相依，不過度驗證內部實作`;

export interface GeneratePromptInput {
  targetClasses: string[];
  standards: string;
  mod: ModuleInfo;
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
}

export function buildFixPrompt(input: FixPromptInput): string {
  const root = testRootRel(input.mod);
  return `上一輪產生的單元測試未通過驗證 pipeline，以下是失敗報告：

<gate_report>
${input.gateReport}
</gate_report>

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
