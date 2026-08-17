# Java Unit Test 品質標準

## 框架與相依
- JUnit 5（`org.junit.jupiter`），Mock 使用 Mockito（`@ExtendWith(MockitoExtension.class)`）
- 斷言優先使用 AssertJ（`assertThat(...)`）；若專案未引入 AssertJ 則使用 JUnit 5 assertions
- 不得引入未在 pom.xml / build.gradle 宣告的新相依

## 結構與命名
- 測試類別放在 `src/test/java` 相同 package 下，命名 `<ClassName>Test`
- 測試類別可見性沿用專案既有慣例。JUnit 5 本身不要求 `public`，但若專案有以
  `@SelectClasses` / `@SuiteClasses` 列舉測試類別的測試套件，跨 package 引用就需要
  `public class`，否則整個模組編譯失敗。pipeline 會掃描既有測試並在 prompt 中告知結論，
  依該結論撰寫，不要自行假設
- 測試方法命名採「方法名_情境_預期結果」，例如
  `calculateFee_whenAmountIsNegative_throwsIllegalArgumentException`
- 每個測試遵循 AAA（Arrange / Act / Assert）結構，區塊間以空行分隔
- 每個測試方法只驗證一個行為；共用前置作業抽到 `@BeforeEach` 或 private helper

## 測試內容要求
- 必須涵蓋：正常路徑、邊界條件（null、空集合、0、負數、極值）、例外路徑
- 例外驗證使用 `assertThatThrownBy` / `assertThrows`，並驗證例外型別與訊息關鍵字
- 驗證 mock 互動時使用 `verify(...)`，但不過度 verify 內部實作細節
- 斷言必須驗證「具體值」；禁止只有 `assertNotNull` / `assertTrue(true)` 這類無意義斷言

## 禁止事項
- 禁止 `Thread.sleep`、真實網路 / DB / 檔案系統 I/O（一律以 mock 或 in-memory 取代）
- 禁止測試之間有順序相依或共享可變靜態狀態
- 禁止為了讓測試通過而修改 production code
- 禁止使用 `@Disabled` 略過失敗測試
- 禁止在測試碼中加入 logging（`@Slf4j`、`log.info(...)`、`System.out.println`）。斷言就是
  測試的輸出，失敗訊息由 assertion library 提供；logging 只會製造噪音，並讓測試多依賴一套
  在 test scope 未必配置正確的機制（例如 Lombok 的 annotation processor 未生效時，
  `@Slf4j` 不會產生 `log` 欄位，整個檔案編譯失敗）

## 覆蓋率
- 目標類別 line coverage >= 80%、branch coverage >= 70%（可由環境變數調整）
- 不追求以無意義測試灌覆蓋率；每個測試都要有明確的行為意圖
