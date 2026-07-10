# Java Unit Test 品質標準

## 框架與相依
- JUnit 5（`org.junit.jupiter`），Mock 使用 Mockito（`@ExtendWith(MockitoExtension.class)`）
- 斷言優先使用 AssertJ（`assertThat(...)`）；若專案未引入 AssertJ 則使用 JUnit 5 assertions
- 不得引入未在 pom.xml / build.gradle 宣告的新相依

## 結構與命名
- 測試類別放在 `src/test/java` 相同 package 下，命名 `<ClassName>Test`
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

## 覆蓋率
- 目標類別 line coverage >= 80%、branch coverage >= 70%（可由環境變數調整）
- 不追求以無意義測試灌覆蓋率；每個測試都要有明確的行為意圖
