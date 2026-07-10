/** Writer prompt（修正輪）：帶上一輪 gate 失敗報告 */
import { ModuleInfo } from "../libs/types";
import { DIMENSION_ONELINERS, testRootRel } from "./generate";

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
