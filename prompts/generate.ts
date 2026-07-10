/** Writer prompt（首次產生）：standards 由 loop 注入（injection over discovery） */
import * as path from "node:path";
import { ModuleInfo } from "../libs/types";

/** 給 writer 的六維「名稱＋一句話」——只給優化方向，不給評分細則（防 teaching-to-the-test） */
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
