/**
 * Reviewer prompt：rubric 由 loop 讀檔注入（不靠 skill 機制觸發）。
 * 分數量表對齊 skill rubric（0-10 整數、分數帶 9-10/7-8/5-6/3-4/0-2）。
 * weighted_score 與 grade 由 pipeline 確定性計算，reviewer 不得輸出。
 */
import { ModuleInfo, REVIEW_DIMENSIONS } from "../libs/types";
import { SCORE_THRESHOLDS } from "../config";
import { expectedTestPath } from "../libs/utils";

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
