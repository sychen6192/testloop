# Java Unit Test 品質標準

## 框架與相依
- 測試框架與函式庫以 pipeline 在 prompt 中列出的「本模組測試 classpath」為準（它量的是模組實際
  跑過的測試）；那份清單與下面的預設衝突時，以清單為準。沒有清單時預設為：
  JUnit 5（`org.junit.jupiter`），Mock 使用 Mockito（`@ExtendWith(MockitoExtension.class)`）
- 斷言優先使用 AssertJ（`assertThat(...)`）；classpath 上沒有 AssertJ 時使用所用測試框架內建的 assertions
- `MockitoExtension` 預設 strict stubs：沒被測試用到的 `when(...)` 會讓測試以
  `UnnecessaryStubbingException` 失敗。只 stub 該測試真的會走到的呼叫，不要在 `@BeforeEach` 裡預先
  stub 所有情境；確有需要時對單一 stub 用 `lenient()`
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
- 禁止 `Thread.sleep`、真實網路 / DB / 檔案系統 I/O
- 禁止任何會啟動 Spring context 或連上資料庫的測試手段——包含但不限於
  `@SpringBootTest`、`@DataJpaTest`、`@JdbcTest`、`@MybatisTest`、`@DataMongoTest`、
  `@AutoConfigureTestDatabase`、`@Sql`、`@Testcontainers` / `@Container`，以及
  H2 / HSQLDB / Derby 等嵌入式資料庫。單元測試不連任何資料庫，嵌入式的也不行：
  它一樣要載入 driver 與 schema，一樣會因環境而紅，只是紅得比較慢。
  Repository / Mapper / DAO / `JdbcTemplate` / `NamedParameterJdbcTemplate` /
  `EntityManager` / `DataSource` / `Connection` 一律以 `@Mock` 注入，
  原本由資料庫提供的資料改以 `when(...).thenReturn(...)` 給定
- 禁止測試之間有順序相依或共享可變靜態狀態
- 禁止為了讓測試通過而修改 production code
- 禁止用 `@Disabled`（JUnit 4 的 `@Ignore`、TestNG 的 `enabled = false`）或 `assumeTrue(false)` 之類的 assumption 略過失敗測試
- 禁止在測試碼中加入 logging（`@Slf4j`、`log.info(...)`、`System.out.println`）。斷言就是
  測試的輸出，失敗訊息由 assertion library 提供；logging 只會製造噪音，並讓測試多依賴一套
  在 test scope 未必配置正確的機制（例如 Lombok 的 annotation processor 未生效時，
  `@Slf4j` 不會產生 `log` 欄位，整個檔案編譯失敗）

## 既有測試違反上述規則時：就地改寫，不得刪除
你被允許修改既有測試檔，但只能用「改寫」的方式。pipeline 在你動手前已量下每個既有測試檔的
`@Test` 數、斷言數與略過標記數（`@Disabled`、`@Ignore`、`enabled = false`、assumption），任一項變差該輪即失敗——對建置而言，「把測試修好」和
「把測試刪掉」都是綠燈，這道計數是唯一分得出來的東西。

- **改寫**：保留原本的測試方法與其驗證意圖，只把違規的機制換掉。連資料庫的測試，改成
  `@Mock` 注入資料源、以 stub 回傳值表達原本由 DB 提供的資料
- **斷言數不得減少**：一個連資料庫撈五筆再逐筆驗證的測試，改成 mock 之後只剩三個斷言，
  會被判定為刪減並讓該輪失敗。缺的驗證要以等價的斷言補回，不是省略
- **不得**刪除測試方法、整個檔案，或改用 `@Disabled` / `@Ignore` / assumption / 註解掉來「處理」違規
- 若某個測試的意圖本來就是驗證真實 SQL、schema 或 transaction 行為（那是整合測試，不是
  單元測試的職責），不要硬改成 mock——改成 mock 只會得到一個驗證不到任何東西的空殼。
  原樣保留，並在總結中點名檔案與原因，交由人決定它該搬去哪裡

## 覆蓋率
- 目標類別 line coverage >= 80%、branch coverage >= 70%（可由環境變數調整）
- 不追求以無意義測試灌覆蓋率；每個測試都要有明確的行為意圖
