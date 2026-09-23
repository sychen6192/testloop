# Changelog

使用者可見的變更記錄。更新方式：`git pull && npm install && npm run setup`。

## [Unreleased]

依實地使用回報修正兩個範圍問題：build gate 涵蓋整個模組，但 writer 的職責只有目標類別，
兩者之間的落差先前完全由 prompt 措辭承擔。

### Added
- **資料夾目標自動分批（`UT_BATCH_SIZE`，預設 1）。** 目標是資料夾時，所有類別原本交給同一個 writer
  session 寫、同一個 reviewer session 審、共用一份輪數；類別一多就超出模型的 context 與 agent 逾時
  （README 因此建議一次只做一個類別），而且只要一個類別修不綠，整個 run 就停下、其他類別一起卡在半路。
  現在依路徑排序、每批一個類別，各自跑完整的 writer → gate 迴圈（新的 session、自己的輪數、自己的
  `batch-NN-<類別>/` artifacts）。沒通過的批次撤回它對 `src/test` 的所有變更——新增的移走、改過的還原、
  刪掉的放回——嘗試的版本保留在該批的 `rejected/`（清單在 `rollback.md`），連同它留在 `target/test-classes`
  的編譯產物與資源（不清的話 surefire 在下一批照樣跑那支撤回的失敗測試、`mockito-extensions` 開關照樣生效），
  所以下一批從一個編得過的模組開始，`src/test` 最後只留下通過所有 gate 的測試。被 Ctrl-C 或 crash 中斷時，
  正在跑的那一批比照撤回，summary 寫明 `inProgress` 與 `notRun`。agent 無法執行、writer 改了範圍外的檔案
  （不撤回、原樣交給人檢視）、連續兩批以同一個 `writer-no-op` / `reviewer-unparseable` 結束、連續兩批的建置
  以同樣的原因失敗（去掉類別名稱與數字後逐字相同）、或撤回時有檔案放不回去時提前停止，summary 列出沒執行的
  類別與需要人工處理的東西（`attention`）。每批跑完就更新 `batches.json`。只有一批時行為、artifacts 版面與
  以前完全相同。
- **量測目標模組的測試相依，當成事實寫進 prompt。** standards 寫死 JUnit 5 + `MockitoExtension` + AssertJ，
  prompt 的第一行也寫死「（JUnit 5）」；在只有 JUnit 4 的模組（Spring Boot 2.2 以前）每個 JUnit 5 import
  都編不過，沒有 `mockito-junit-jupiter` 就沒有 `MockitoExtension`，沒有 inline mock maker 的 `mockStatic`
  在執行時失敗——writer 每輪撞一個，而它照著改的 prompt 寫的正是失敗的寫法。現在從目標模組 surefire 報告
  的 `surefire.test.class.path` 量出 JUnit 4/5、TestNG、Mockito 版本與能力、AssertJ / Hamcrest，連同
  Java 語言層級（編譯 log 或 pom）寫進 generate / fix / repair prompt；模組還沒跑過測試時退回讀 pom
  （含 Spring Boot 版本推斷，明說是推斷、不宣稱「沒有」），第一次有測試跑過就改用實際 classpath。
  說成事實的必須是事實，所以只採用可信的 classpath：surefire 2.21 以前的報告記的是 Maven 自己的
  `java.class.path`（plexus-classworlds），當成測試 classpath 會說出「沒有 Mockito、沒有 AssertJ」；比 pom
  舊的報告描述的是 pom 改之前的相依，也不採用。讀 pom 時不算 profile 裡的設定，吃 `junit.version` /
  `mockito.version` 等 Boot 覆寫屬性與 exclusions（Initializr 排除 vintage engine）；繼承 repo 外的公司
  parent 時不斷定框架，改看既有測試用哪一個。版本不明時不開放需要版本的 API（`mockStatic` 要 inline mock
  maker 且 Mockito 3.4+、`openMocks` 要 3.4+、JUnit 4 的 `assertThrows` 要 4.13+，Mockito 1.x 的匹配器在
  `org.mockito.Matchers`）。以真的 Maven 專案驗證：JUnit 5 + Mockito 5 的專案與 JUnit 4.12 + Mockito 2 +
  surefire 2.22 的老專案都量得對。
  standards 改為「以量到的 classpath 為準」，並補上 `MockitoExtension` 預設 strict stubs 的提醒
  （`UnnecessaryStubbingException` 是 LLM 寫的測試最常見的失敗之一）。結果記在 `project-facts.json`。
- **原始碼編碼不是 UTF-8 的模組（MS950 等）。** writer 以 UTF-8 寫的中文在 MS950 模組裡依工具鏈有兩種
  下場：單獨的 javac 直接報 error、編不過；maven-compiler-plugin 3.13 + JDK 21 則印出
  `[ERROR] unmappable character` 後照樣 BUILD SUCCESS，`"含稅金額"` 編成 8 個亂碼字元——斷言中文訊息的
  測試永遠對不上，writer 從失敗報告抄回正確的中文、再以 UTF-8 寫回，又是亂碼，以 stuck 收場（以真的
  Maven 專案重現）。而 prompt 是中文，writer 寫中文註解、字串或 `@DisplayName` 是常態。pom 沒設 `project.build.sourceEncoding` 的專案在繁中 Windows、JDK 17 以前也是
  MS950。更糟的是 agent 的編輯工具以 UTF-8 讀寫：改一個 MS950 既有測試檔，會把裡面的中文（字串常值
  也是）默默換成別的字，而檔案照樣編得過。現在 loop 量出 javac 實際用的編碼（pom 或 `build.gradle` 的設定，
  屬性間接設定也解得開；退回 Maven 在建置 log 裡寫的平台編碼——多模組時取目標模組那一段；再退回 JDK 預設
  編碼），不是 UTF-8 時，每個 writer 與 reviewer session 前把 `src/test/java` 的非 ASCII 字元改寫成 `\uXXXX`
  的 ASCII 形式（javac 最先處理這種跳脫，語意完全相同），session 後沒改的檔照原 bytes 與修改時間放回，改過的檔
  沒改的行維持原 bytes、writer 寫的行由 JDK（與 javac 同一套 charset）存成 MS950。所以 writer 可以照常補強
  既有的中文測試檔、修復迴圈也修得了 MS950 的紅燈檔，git diff 只有它改的行。以真的 Maven 專案驗證：
  `sourceEncoding=MS950`、production code 丟出中文例外訊息，writer 讀既有測試（讀到 `\uXXXX`）、以 UTF-8
  補一個斷言中文訊息的測試——轉存成 MS950 後真的 javac 編出來相等，`gates-passed`，diff 只有 12 行新增。
  writer 寫進 U+FFFD（某個工具讀錯編碼時就遺失的字）時該輪不進建置、點名檔案，連同上一輪還沒修的 gate
  報告一起餵回；U+FFFD 一律以 `\ufffd` 存，之後 writer 寫過的檔裡還有就每輪再點名。目標類別的 production code
  不改寫，解碼後以 `\uXXXX` 形式附在 prompt（writer 直接讀是亂碼，抄進斷言的中文永遠對不上）。量不到編碼設定
  時**不拿 JDK 預設編碼猜**——建置沒印平台編碼表示有設定（多半在 repo 外的 parent；Spring Boot parent 設 UTF-8），
  而繁中 Windows 的 JDK 17 預設 MS950，猜下去會把 UTF-8 模組當成 MS950——改看原始碼本身：不是 UTF-8 才保守處理。
  沒有可用的 JDK 時退回保守做法（含非 ASCII 的既有檔不讓改，writer 的輸出轉成 `\uXXXX`；writer 自己寫的檔不在此列）。
  Ctrl-C 或 crash 時視圖照常關閉；被 SIGKILL 的由下一次執行從使用者快取目錄裡的復原日誌放回。轉碼器編譯後快取
  在使用者自己的目錄並檢查擁有者（共用 /tmp 裡預先放好的 class 就是以執行者身分跑的程式碼），回應加上標記
  （`-Xlog` 之類印在 stdout 的東西不會被當成回應），「裝不裝得下」以 encode 再 decode 比對（Shift_JIS 把 ¥ 存成
  0x5C、javac 讀回來是反斜線）。UTF-8 或量不到時完全不介入。
- **公司網路支援：proxy 與 TLS 攔截**（`libs/proxy.ts`、`libs/tls.ts`，作法參考姊妹專案
  prloop 的實戰版本）。Node 內建的 fetch **完全無視** `HTTP_PROXY` / `HTTPS_PROXY`——curl、
  git、mvn 都吃，它不吃——所以在只能經 proxy 出去的網路上，症狀是一個沒頭沒尾的
  `ECONNREFUSED`，完全看不出跟 proxy 有關。現在自己讀標準變數並交給 undici 的 dispatcher。
  `UT_NO_PROXY` 支援 `host:port` 形式，這是內網模型端點唯一寫得對的方式；少了它，
  `NO_PROXY=llm.corp:8080` 會靜默地什麼都不匹配，流量照樣送去 proxy。CA 在**執行時**載入交給
  dispatcher，而不是靠 `NODE_EXTRA_CA_CERTS`——後者只在 node 啟動前就 export 才有效，等於
  `npx tsx loop.ts` 直接跑時完全失效。傳 `ca` 會**取代**信任庫而非附加，所以一定串上
  `tls.rootCertificates`，否則設了公司 CA 之後所有公開 HTTPS 都會壞。新增
  `UT_HTTPS_PROXY` / `UT_HTTP_PROXY` / `UT_NO_PROXY` / `UT_CA_CERTS` / `UT_USER_AGENT`，
  `testgen doctor` 會列出 proxy 與 CA 狀態（帳密遮蔽），端點連不上時的訊息會依是否設了 proxy
  給不同的下一步。新增第一個 runtime dependency：`undici`。
- **`UT_TEST_SCOPE=generated`**：迭代期間 surefire 只跑目標類別的測試（`-Dtest=<那幾個>`），
  所有 gate 通過後、宣告成功前再以完整模組範圍重跑一次驗收（`final-verify.log`），失敗以
  `final-verify-fail` 餵回下一輪。build gate 的承諾有兩半——「新測試會過」與「沒打壞別人」
  ——後者只有完整重跑證明得了，所以這次重跑是**延後**不是省略。200 隻既有測試（模擬 Spring
  context）實測：每輪 build 23.3s → 4.0s，2 輪總時間 70.5s → 56.0s，省下的量隨輪數放大。
  只限縮執行不限縮編譯，既有編譯錯誤照樣擋。附帶好處是覆蓋率更準——JaCoCo 只記錄目標測試造成
  的覆蓋，不會被別的測試順帶碰到而灌水。預設 `module` 維持原行為；Maven only，Gradle 警告後退回。
- **api runner（`UT_RUNNER=api`）**：不經任何 agent CLI，直接對 OpenAI-compatible 的
  `/v1/chat/completions` 做 tool calling，tool loop 由本工具自己跑（`runners/api.ts` +
  `runners/api-tools.ts`）。權限就是工具清單——writer 拿到 read/list/search/write/replace，
  沒有 bash 可給；reviewer 只有唯讀三個；`write_file` 只接受目標模組 `src/test/`，其他路徑
  回錯誤給模型自己修正。沒有 opencode 的 session 固定開銷、不需要 ripgrep 與 `npm run setup`、
  Windows 沒有 spawn 問題。tool call 精確計數（reviewer must-read guard）、output tokens 從
  `usage` 累計、429/5xx 重試、4xx 直接判 spawn-error、回合與逾時預算。角色契約仍讀 agent
  `.md` 本文，解析順序同 opencode，最後退回工具內建。`testgen doctor` 在此模式改檢查端點、
  模型與角色契約。新增 `UT_API_BASE_URL` / `UT_API_KEY` / `UT_API_MAX_TURNS` /
  `UT_API_MAX_TOKENS` / `UT_API_MAX_TOOL_RESULT_CHARS` / `UT_WRITER_TEMPERATURE`
  （reviewer 溫度固定 0）。
- **預檢基準（baseline pre-check）**：第一輪之前先跑一次與 build gate 完全相同的指令，
  取得「writer 介入前」的紅燈基準。build gate 跑的是 `mvn -pl <module> -am test`，整個模組
  連同上游模組的測試原始碼都要編得過，所以一個本工具沒碰過的壞檔就足以擋掉每一輪；先前
  writer 會把迭代次數花在修別人的檔案上。預設在紅燈時中止並列出具體檔案，
  `UT_ALLOW_DIRTY_BASELINE=1` 可帶著已知紅燈續跑——那些檔案會被標記為 pre-existing 寫進
  修正 prompt，並明確要求 writer 不要碰。`UT_SKIP_BASELINE=1` 可完全跳過（省一次 build）。
  基準寫入 `runs/<repo>/<ts>/baseline.md` 與 `baseline.log`。
- **既有測試偵測**：loop 啟動時以確定性方式解析每個目標類別的既有測試檔（正規
  `<Class>Test.java` 與 `<Class>UnitTest.java` / `Tests` / `Test<Class>` 等變體），把檔名
  直接寫進 generate prompt 並禁止另建新檔。先前只有一句「若已存在測試檔請補強」，writer
  沒發現既有檔案就會產生 `<Class>UnitTest.java` 與既有測試重複。清單同時進 params.json。

- **專案慣例掃描**：loop 啟動時掃描模組既有測試，得出測試類別可見性慣例，以及是否存在以
  `@SelectClasses` / `@SuiteClasses` 逐一列舉測試類別的測試套件，結論寫進 writer 的兩段
  prompt。可見性沒有放諸四海皆準的規則——JUnit 5 不要求 `public`、Sonar S5786 還會標記它，
  但跨 package 的 class-symbol 套件（常見於 `SonarTestSuite`）沒有 `public` 就會
  `cannot find symbol` 讓整個模組編不過。所以由 pipeline 量測該 repo 後給結論，而非在
  standards 裡押一邊。
- **既有紅燈自動修復**：預檢基準紅燈時不再中止，改進入 `repairBaseline` 修復迴圈——同一個
  writer、同樣的範圍與防掏空 guard、同一道建置指令，修到綠才開始產生新測試；修不好才中止
  （stopReason=`repair-failed:<原因>`），`UT_ALLOW_DIRTY_BASELINE=1` 仍可硬跑。修復輪沒有
  coverage / review gate（它們的範圍是目標類別），要證明的只有「模組綠了、而且沒有東西被
  拿掉」。每輪 artifacts 在 `repair-N/`，修了哪些檔列在 `repair-summary.md`——那是 writer
  對別人測試的改動，commit 前該看 diff。`UT_REPAIR_BASELINE=0` 回到直接中止，
  `UT_REPAIR_MAX_ITER` 控制輪數。
- **防掏空 guard**：build gate 分不出「修好失敗的測試」和「刪掉失敗的測試」——兩者都是綠燈。
  loop 現在在第一輪前量下每個既有測試檔的 `@Test` 數、斷言數與略過標記數（`@Disabled`、JUnit 4 的
  `@Ignore`、TestNG 的 `enabled = false`、assumption——`assumeTrue(false)` 讓失敗的測試以「略過」結束，
  數量卻一個不少），任一檔案數量減少或略過標記增加，該輪即 FAIL 並把前後數字餵回，不進建置；主迴圈與修復迴圈
  共用。刻意用數量不用方法名——standards 要求「方法_情境_預期」命名，writer 補強既有檔案時
  本來就會改名重寫。`UT_ALLOW_TEST_SHRINK=1` 只警告。
- **writer 範圍 assert**：orchestrator 每輪在 writer 前後對整個 repo 拍快照（扣除目標模組
  `src/test/`、`target`/`build`/`node_modules` 與 dot-dirs），production code、`pom.xml`
  或其他模組有任何新增／修改／刪除即中止（stopReason=scope-violation），清單寫入
  `iter-N/scope-violations.txt`。先前這條只靠 prompt 的「嚴禁修改 production code」，實測
  writer 往 production 加一個 method，loop 照樣 gates-passed 零警告——被改過的 production
  code 會讓後面每個 gate 都在驗證錯的東西。不自動還原：沒有內容快照，而 `git checkout`
  會連操作者自己未提交的改動一起清掉，所以停下來交人處理。
- **回饋預算**：每輪餵回 writer 的失敗報告受 `UT_MAX_FEEDBACK_CHARS`（預設 12000）約束，
  由 orchestrator 統一 clamp，與產生報告的是哪個 gate 無關；surefire 明細另受
  `UT_MAX_FAILURE_BLOCKS`（預設 5）限制，超出的類別數會據實標明而非靜默丟棄。

### Fixed
- **分批撤回只動 writer 改過的檔，也不再把各批自己的失敗當成外部問題。** 撤回原本把整個 `src/test` 還原成
  批次開始時的樣子：執行期間你在 IDE 裡改的測試、測試在建置時寫進 `src/test` 的檔，會一起被搬進 `rejected/`。
  現在只撤回 writer 在它的 session 裡改過的檔（中斷時也一樣），其他的原樣留著，列在 `rollback.md` 與 summary
  的 `attention`。「連續兩批的建置以同樣的原因失敗 → 停止」只看沒提到該批自己類別的失敗——兩個 writer 的
  測試以同樣的方式失敗（同一種斷言、各自的 `System.exit` 讓 fork 當掉）是兩批各自的事，停下會讓後面的類別
  白白沒跑；比對前另外拿掉十六進位的 id（物件 hash、request id），否則同一個外部失敗每次都不一樣、永遠停不下來。
  撤回時，原本是檔案、被換成好幾層目錄的位置照樣放得回去；輸出目錄在批次開始時還不存在（全新 clone 的第一批）
  時，只清撤回的原始碼的輸出，不把其他測試的 `.class` 全部刪掉。不在 promise 鏈上的例外也走 crash 收尾（先結束
  子行程、再撤回那一批、寫 summary），太大沒有備份的檔與中斷時的撤回結果也進 `attention`。
- **防掏空的計數不再誤判，也不再漏掉讓測試不執行的寫法。** 計數前清掉註解與字串的方式改成照 lexer 的順序
  一次掃過（`libs/javasrc.ts`）：舊的做法先刪區塊註解、再刪字串，字串裡的 `"**/*.java"` 會一路吃到下一個
  註解，中間的測試全數消失——writer 只是加了一段 Javadoc，就會被判「刪減了既有測試」；行尾註解
  `// assertEquals(...)` 也會被算成斷言。TestNG 的 `enabled = false` 只在 `@Test(…)` 裡算，測試裡的
  `boolean enabled = false;` 不再被當成略過標記。另外補上原本數不到的略過方式：`Assumptions.abort()`、
  丟 `SkipException` / `TestAbortedException` / `AssumptionViolatedException`，以及 JUnit 5 一聲不響跳過的
  private / static / 有回傳值的 `@Test` 方法——`@Test` 還在、測試已經不會執行。全限定名的
  `@org.junit.jupiter.api.Test` 也照樣算。
- **沒被執行的測試不再算過關。** 以真的 Maven 實測：surefire 2.22.2、classpath 上只有 `junit-jupiter-api`
  （沒有 engine）的模組，writer 寫的 JUnit 5 測試編得過、一個都沒執行，BUILD SUCCESS；既有的 JUnit 4 測試
  剛好覆蓋滿目標類別，coverage gate 也過——一個沒執行過的測試以 gates-passed 收場。反過來，修復迴圈的
  writer 把失敗的測試改寫成不會被執行的框架，`@Test` 與斷言一個不少，防掏空量尺看不出來，模組卻綠了。
  現在綠燈的建置必須真的執行了：writer 新寫的測試類別、它改過且介入前有執行的類別，以及跑完整模組時
  writer 介入前有執行的每一個類別（讓其他測試不被探索到的測試資源也擋得到）——以這次建置的 surefire
  報告（TestNG 的單一 `TEST-TestSuite.xml`、`@Nested` 的 `$內部類別` 報告、reportNameSuffix 都認得）或 log
  的 `Running` 行為準；writer 新寫的類別測試全部 skipped 也不算。沒執行時該輪 FAIL，回饋點名類別與它的寫法、
  這次實際執行了哪些類別各是什麼框架、類名是否符合 surefire 的 includes、是否類別層級停用。看不出來時
  （報告關了、寫到別處、以 `@DisplayName` 命名）只印 WARN、不判。修復迴圈同樣套用。
- **測試相依不再把「classpath 上有 JUnit 5」當成「JUnit 5 會被執行」。** surefire 3.0.0-M4 起才會替只有
  API 的模組補 engine，而補上的 engine 不記在 `surefire.test.class.path`——兩種情況的 classpath 一模一樣
  （實測 3.2.5 與 2.22.2）。現在另從建置 log 讀 surefire 版本、從 pom 讀 plugin 自己的相依（2.19–2.21 時代的
  provider 設定），JUnit 5 不會被執行時告訴 writer 用 JUnit 4，並說明原因。pom 來源不再宣稱「只有 JUnit 4、
  沒有 JUnit 5」——宣告了 junit:junit 不代表沒有間接帶進來的 JUnit 5；只有 Spring Boot 版本推斷、且沒有其他
  repo 外的 parent 時例外。沒有既有測試可看時改用 pom 宣告的框架（以前預設 JUnit 5）。classpath 上看不到
  inline mock maker 時說「看不到」並建議避開，不再斷言「不能」（開關檔也可能在相依的 jar 裡）。
- **修復迴圈被防掏空擋下的那一輪，下一輪 writer 看不到還有哪些紅燈。** 刪減報告取代了建置的失敗報告，
  writer 補回被刪的測試之後，對原本要修的紅燈一無所知。現在兩份一起餵回。
- **次數、上限這類設定給了小數時照單全收。** `UT_API_MAX_TOKENS=4096.5` 原封不動送到模型端點，被當成不合法
  的 `max_tokens` 拒絕；`UT_BATCH_SIZE=1.5` 則默默變成一批一個。現在 12 個整數設定給了小數就在啟動時 FATAL。
- **幾個 run 同時碰到同一個過期的 repo 鎖時，偶爾有兩個都執行。** 接手時讀到的鎖若剛好不存在（上一個
  接手者刪掉舊鎖、還沒建好新鎖的瞬間），會被當成「空的過期鎖」，接手區段隨後把別的 run 剛寫好的鎖刪掉——
  兩個 run 都以為自己持有這個 repo，互相把對方的輸出判成 scope-violation。8 個 run 同時搶的壓測約每 8 次
  出現一次（selftest 也偶爾紅）。現在讀不到的鎖直接重新建立，剛建立、還沒寫入內容的鎖等它寫完，空了好幾秒
  的才當成當機留下的；修正後 80 次壓測（8 與 16 個 run）沒有一次兩個都執行。
- **目標類別的順序在不同機器上不一樣。** 資料夾裡的類別依檔案系統的 readdir 順序列出（ext4 是雜湊順序），
  prompt 裡的順序、分批的順序都因此不可重現。現在依路徑排序，並一律以 `/` 比較——`\` 排在大寫字母之後、
  `/` 排在之前，用原生分隔符排序的話同一個資料夾在 Windows 與 Linux 會分出不同的批次。
- **跑到一半「莫名其妙中斷」：實測重現出五個成因，全部修掉。** 以真的 Maven 專案（JUnit 5 +
  Mockito + JaCoCo）加一個行為像模型的假 OpenAI 端點，完整跑 `loop.ts`，把真實環境會遇到的狀況
  逐一注入。五個都能讓 run 在第 N 輪突然停下，而且停下時的訊息都指向錯的地方：
  - **幾秒鐘的 503 就結束整個 run，還叫你去裝 opencode。** api runner 把「任何一個 writer session
    的第一個請求失敗」都當成 spawn-error，orchestrator 見到 spawn-error 就判定是環境壞了、立即中止，
    訊息是「writer 程序未能啟動…請確認 opencode CLI 可用」——即使你用的是 api runner、上一輪才剛
    成功。實測：第 2 輪開頭連續 3 次 503（模型伺服器重啟、閘道過載的典型樣子，前後 3 秒）→
    `stop=runner-spawn-error`。重試原本只有 3 次、間隔 1 秒與 2 秒。現在分兩段：端點**這個 run
    從未回應過**時照舊快速試 3 次就判定設定錯誤（網址、proxy 設錯要秒報）；**回應過之後**，連線錯誤、
    408/425/429/5xx、以及不是 JSON 的 2xx 會以指數退避持續重試到 `UT_AGENT_RETRY_WINDOW_MS`（預設
    3 分鐘，**從這一波第一次失敗起算**，不是從 session 開始；`0` = 不重試），以 `Retry-After` 為最短等待，每次重試都印一行
    `[WARN] … N 秒後重試`，不再靜默。401/403/404
    仍然立即判 spawn-error——金鑰與模型名稱是設定問題。重試窗用盡時回報的是 `timeout`（session
    沒完成）而不是 spawn-error，runner-spawn-error 的訊息也依 runner 改寫，不再對 api runner 使用者提
    opencode。重試次數的上限由重試窗推得，設長的窗（例如撐過 15 分鐘的 vLLM 重啟）不會被寫死的次數提早結束。
  - **context 滿了，writer 讀完檔就空手結束。** api runner 把每次讀檔的結果都留在對話裡；本地模型
    （vLLM 的 `max_model_len`、32k 很常見）在 prompt + `max_tokens` 超過上限時回 HTTP 400，舊版把它
    當成請求失敗直接結束 session——writer 讀完檔、還沒開始寫——下一輪就以 `writer-no-op` 中止，
    訊息還說「常見原因：permission 被擋」。現在認得各家伺服器的 context 超限訊息（vLLM 新舊兩版、
    OpenAI、TGI、llama.cpp、SGLang、LM Studio），先把**較早**的工具結果與已落地的 write_file 內容
    換成一行說明（模型需要可以重讀；最近一輪的結果、system 與任務 prompt、tool_call_id 配對一律不動），
    沒有可省的才把 `max_tokens` 降到伺服器說得下的量；兩者都不行才結束，並說明要調哪個旋鈕。
    唯讀的 reviewer session 不做前一步——被換掉的是它讀過的程式碼，拿省略過的內容評分等於沒讀；它只降
    `max_tokens`，不夠就以 reviewer 未完成收場、由 review gate 重試。
  - **寫大測試檔超過 `max_tokens`，writer 被當成「完成」。** 一次 write_file 整個測試類別，輸出被
    `max_tokens` 截斷時，vLLM 把半截的 tool call 當**文字**回傳、`tool_calls` 為空、
    `finish_reason=length`；舊版把它當 writer 的最終答案，log 印 `[OK] [writer] 完成`，檔案一個字都
    沒寫，下一輪 `writer-no-op` 中止。現在截斷（或伺服器沒解析出來、以文字送出的工具呼叫）會以
    user 訊息告訴模型發生了什麼、要它拆成 write_file + replace_in_file 的小步驟（reviewer 則是要它直接
    輸出較短的 JSON 判決），**連續**最多 3 次；
    tool call 的 arguments 被截成壞 JSON 時，錯誤訊息也會說明是截斷。
  - **回應 body 卡住就永遠掛著。** 請求逾時的計時器在收到 header 時就被清掉，之後讀 body 沒有任何
    期限（undici 的 `bodyTimeout` 先前為了修 300 秒問題已關閉）；連線在回應途中斷掉而沒有 RST
    （VPN 重連、筆電休眠、NAT 逾時）時，run 會一直印「仍在進行中」直到天荒地老。現在 session 期限
    涵蓋整個 body。實測 `UT_AGENT_TIMEOUT_MS=20000`：舊版 60 秒以上仍在等，新版 20 秒逾時後繼續。
  - **目標資料夾裡有 interface，coverage gate 永遠過不了。** service 套件的常態是
    `FooService`（interface）加 `FooServiceImpl`。只有抽象方法的 interface 沒有任何可執行的
    bytecode，JaCoCo 把它寫成自我閉合的 `<sourcefile name="FooService.java"/>`，而 gate 的正則只認
    `<sourcefile …>…</sourcefile>`，於是回報「在 JaCoCo 報告中找不到」、每輪一模一樣，第 3 輪判
    `stuck` 中止。`<class>` 的退路更糟：自我閉合的 `<class …/>` 會一路配對到**下一個**類別的
    `</class>`，把別人的覆蓋率算成自己的。現在兩條路徑都正確處理自我閉合元素（無計數器 = 沒有
    可執行的程式碼，不列入門檻；以 `-g:none` 編譯、沒有 LINE 計數器的類別改用 INSTRUCTION 計數）；loop 啟動時也會以保守的原始碼判斷略過只有抽象方法的 interface
    與 annotation（列在 log 與 `params.json` 的 `skippedCodeless`），不再要 writer 替它們寫測試、
    也不讓 reviewer 為了缺測試擋關。目標只有這類型別時直接說明並中止。
  每一項都有對應的整合情境（`loop-api-503-mid-run`、`loop-api-outage-not-spawn-error`、
  `loop-api-context-overflow`、`loop-api-truncated-write`、`loop-interface-in-target`），並確認在修改前
  的程式碼上會紅。api runner 的重試、context 縮短與截斷處理改動了 `runners/` 對模型端的呼叫方式（AGENTS.md 高風險項，已取得使用者確認）。
- **建置輸出太大，整個工具中途崩潰。** build gate 把 maven 的全部輸出串成一個字串，超過 V8 的字串
  上限（約 5.4 億字元）時 `buf += chunk` 在 stream handler 裡丟出 `RangeError: Invalid string length`
  ——uncaught，整個程序直接結束，沒有 summary.json。surefire 預設把測試的 stdout 轉到 maven 主控台，
  所以一個 DEBUG log 的 `@SpringBootTest` 模組、或 writer 寫出會迴圈印 log 的測試就會撞到。實測 600MB
  輸出：舊版崩潰，新版 exit 0（失敗的斷言照樣被找出來餵回）。現在只在記憶體保留尾端
  （`UT_MAX_BUILD_OUTPUT_CHARS`，預設 64M 字元、上限 2 億）加上被丟棄前段裡的 `[ERROR]` 行、javac 接續行與
  `Tests run:` 行，並明說丟了多少；同一處的斷行也從每個 chunk 重切整段（O(n²)，80MB 無換行輸出要
  87 秒 CPU、期間 event loop 全卡）改為只看新 chunk。
- **`redirectTestOutputToFile` 的專案，大量測試輸出讓報告解析崩潰。** 讀 surefire `.txt` 摘要時
  `-output.txt`（測試的整份 stdout）也被當摘要讀，600MB 的檔案直接 `ERR_STRING_TOO_LONG`。現在只讀
  真正的摘要、有大小上限；過大的 `TEST-*.xml` 改為分段讀並跳過 `<system-out>`，失敗案例照樣讀得到
  （先前是靜默消失）。
- **預檢把普通的斷言失敗誤判成「環境問題」而中止。** 環境失敗（Spring context 起不來、連線池、解密）
  的偵測原本掃**整份建置 log**——包含**通過的**測試的輸出；Spring 每次 refresh 失敗都會印的 WARN
  （`ApplicationContextRunner` 的 `hasFailed()` 測試就是故意觸發它）讓一個本來修得動的紅燈在第 1 輪前
  就被判成環境問題、修復迴圈根本沒跑。現在有 surefire XML 時只看**失敗測試自己的**訊息與 cause 鏈，
  沒有 XML 才退回掃 log（`loop-baseline-env-false-positive`）。
- **通過的測試被報成失敗。** surefire XML 會保留通過測試的 stdout，裡面若印了含 `<error` / `<failure`
  的 XML/SOAP，那個測試就被當成失敗餵給 writer、也進了 dirty-baseline 的容忍集合。現在先去掉
  `<system-out>` / `<system-err>` 再判斷。
- **repo 裡有目錄在跑到一半消失、讀不到、或是 Big5 檔名，整個 run 以 FATAL 結束。** writer 範圍快照
  每輪兩次走訪整個 repo，任何一個目錄 `readdirSync` 失敗就丟例外：IDE／dev server 重建輸出時刪掉的
  目錄（ENOENT）、docker volume 掛出來的 `pgdata`（EACCES）、Big5 命名的目錄（Node 解碼後路徑不存在）、
  超過 PATH_MAX 的深度。現在消失的目錄當作不存在、讀不到的記錄其狀態（之後才變成讀不到的一樣算變動），
  防掏空量尺與慣例掃描同樣處理；在 baseline 或修復迴圈中崩潰時也一定寫出 summary.json。
- **別的程序在 repo 裡寫檔，被當成 writer 越界而中止。** writer 執行期間 repo 內任何檔案有變動都算
  writer 的：執行中的應用程式寫 `logs/app.log`、IDE 自己建置到 `out/`，都會在某個隨機的輪次以
  `scope-violation` 結束 run，還叫你「git diff 檢視並還原」——但 diff 什麼都沒有。現在**被 git ignore、
  不在任何 `src/` 底下、不是建置檔、而且形狀是輸出**（`logs/`、`out/`、`bin/`、`tmp/`、`*.log`、本機 DB
  檔等——刻意用 allowlist：Spring Boot 會從模組根載入被 ignore 的 `./config/application.yml`）的檔案視為
  別的程序的變動，只印 `[WARN]` 清單不中止；tracked 檔案、
  `src/` 底下的一切（被 ignore 的 `application-local.yml` 一樣是測試會載入的設定）、`pom.xml` /
  `*.gradle` / `lombok.config` 等建置檔、不是 git repo、以及 repo 本身被上層 repo 整個 ignore 掉的情況，
  guard 強度不變（`scope-foreign-ignored-change`、`scope-ignored-under-src-still-blocked`）。這放寬了
  AGENTS.md 機制 1 的範圍 assert（AGENTS.md 高風險項，已取得使用者確認）。違規清單改為最多列 20 筆。
- **同一個 repo 同時跑兩個 testgen，兩邊都在第 1 輪中止。** 各自把對方 writer 寫的測試檔當成自己越界，
  叫你還原對方的成果。現在每個 repo 同時只允許一個 run，第二個啟動即以清楚的訊息拒絕
  （鎖檔在系統暫存目錄、不在 repo 內；持有者已結束的鎖會自動接手，別的使用者的程序持有的鎖視為仍在執行）。
  幾個 run 同時發現同一個過期的鎖時只有一個接手（接手在另一個互斥鎖下進行，實測舊寫法 8 個裡有 2–3 個
  同時跑起來）；持有者的 pid 被別的程序重用（Windows 很快就重用，常給系統服務）時，由鎖檔的擁有者與
  持有者 run 的 `summary.json` 判斷它其實已經結束，不會從此擋住每一個 run。
- **`UT_RUNS_DIR` 設在 repo 內（或工具 clone 在 repo 內）時，每個 run 第 1 輪就 scope-violation。**
  loop 自己寫的 `writer-summary.md` 被當成 writer 越界。現在 runs 目錄不列入範圍檢查。
- **（Windows / macOS）指定目標時的大小寫與磁碟上不同，writer 寫的測試在第 1 輪就被判越界。** 範圍快照
  走訪到的是磁碟上的名稱（`modA/src/test`），可寫範圍卻是從使用者輸入的路徑算的（`moda/src/test`）；
  不分大小寫的檔案系統上兩者指向同一處，比對卻不相等，於是 writer 在自己的範圍內寫的檔案全被當成越界。
  runs 目錄、以及經 symlink 指定的模組同理。現在兩端都取磁碟上的實際路徑再比對。
- **（Windows）模組自己的測試有編譯錯誤，預檢判定「不在可寫範圍內」、不進修復就中止。** Windows 上
  maven-compiler-plugin 印出的是 URI 形狀的路徑 `/C:/repo/src/test/...`，照字面解析會變成
  `C:\C:\repo\...`，落在範圍外。現在還原成磁碟路徑。
- **api runner 的 read_file 讀到 FIFO 會讓整個程序永遠卡住**（readFileSync 卡住 event loop，連逾時與
  心跳都不會觸發）；search 遇到一個讀不到的檔案整個搜尋就變成錯誤。現在只讀一般檔案、有大小上限，
  search 跳過讀不到的檔案。
- **（opencode runner）opencode 因 provider 故障結束，被當成「完成」。** opencode 對 429/5xx 會自己重試
  約 75 秒，放棄時印一個 `type:error` 事件後 **exit 1**；runner 原本丟掉 exit code，只要不是逾時就是
  `[OK] 完成`——writer 什麼都沒寫，下一輪 `writer-no-op` 中止，訊息還猜 permission。實測真的 opencode
  1.18.32：舊版 94 秒後 exit 2；新版印出 `opencode 異常結束（exit=1）：fake 503——15 秒後重新執行`，
  重跑後三輪全過、exit 0。語意與 api runner 一致：**同一個 agent 這個 run 從沒完成過 session、這一次也
  什麼都沒做**（沒有工具呼叫、沒有輸出）時照舊判 spawn-error（模型名稱、provider 認證設錯要秒報，writer
  與 reviewer 分開算，因為兩者可以是不同模型）；做過事之後在 `UT_AGENT_RETRY_WINDOW_MS` 內重新執行（從第一次
  失敗起算），用完才回報 session 未完成。這改動了 `runners/` 的 CLI 呼叫方式（AGENTS.md 高風險項，已取得使用者確認）。
- **reviewer 沒跑完，被算成「沒讀檔就給判決」並餵給 writer。** reviewer 在第一次工具呼叫前就被逾時或
  provider 故障打斷時，`toolCallCount` 是 0，落進 fail-closed 的「0 次工具呼叫」判定——那是給「答得出來
  但沒讀檔」的 reviewer 用的 blocker，會餵給 writer；writer 無從讓 reviewer 跑完，於是 hard gate 全綠的
  run 以 `writer-no-op` 收場。現在 reviewer session 沒正常完成時一律視為解析不出、在 reviewer 端重試
  （`UT_REVIEW_MAX_RETRIES`），用完以 `reviewer-unparseable` 點名 reviewer（`review-unfinished-retried`）。
  沒跑完的 session 留下的文字**即使看起來是完整判決也不採用**——那可能是模型在同一回合讀到工具結果之前
  寫的草稿。這改動了 review gate 的判定流程（AGENTS.md 高風險項，已取得使用者確認）。
- **（opencode runner）讀一次 repo 外的檔案就結束整個 session。** opencode 的 `external_directory` 預設是
  `ask`，`opencode run` 非互動時自動拒絕，而**拒絕會結束 session**：模型讀 `~/.m2` 裡依賴的原始碼、或
  stack trace 上的絕對路徑，writer 就空手結束、下一輪 `writer-no-op`。兩個 agent 改為 `deny`——模型拿到
  工具錯誤後繼續。實測真的 opencode：舊版 36 秒 exit 2，新版三輪全過。agent `.md` 權限變更（AGENTS.md 高風險項，已取得使用者確認）。
- **（opencode runner）writer 改 `pom.xml` 加依賴，整個 run 以 scope-violation 中止。** writer 的 `edit`
  原本對所有路徑 `allow`，只靠事後快照攔截並中止；api runner 則是在工具層拒絕、session 繼續。現在
  opencode 也在權限層只允許 `src/test/**`，其餘 `deny`（快照 guard 照舊是 assert）。實測真的 opencode：
  pom.xml 的 edit 被拒、模型繼續寫測試、三輪全過、pom.xml 未變。agent `.md` 權限變更（AGENTS.md 高風險項，已取得使用者確認）。
- **writer 與「唯讀」reviewer 都拿得到 opencode 的 `task` 工具。** `task` 開出的 subagent 拿的是預設工具組
  ——**含 bash 與寫檔**——實測 reviewer 經由它跑了 shell 指令，runner 只看得到 `[tool] task [completed]`；
  subagent 的 bash 還以 detached 方式執行，逾時的整樹終止收不到它。這直接違反 AGENTS.md 硬規則 2、3
  與「禁止 Task tool delegation」，而 startup guard 照樣報通過。兩個 agent 改為 `tools.task: false` +
  `permission.task: deny`，guard 新增 `task: false` 契約。**升級後請重跑 `npm run setup`**，自訂的
  repo 層 agent 也要補上 `task: false`，否則啟動時 guard 會 FATAL（訊息會點名）。agent 權限與 guard
  契約變更（AGENTS.md 高風險項，已取得使用者確認）。
- **build gate 逾時收不掉抓著 stdout 的孫程序，一直掛著。** `killTree` 在直接子程序已結束時就不做事，
  但 POSIX 上整個 process group 可能還在（外掛或測試啟動的背景 server），`shLive` 等的是 pipe 關閉，
  於是 `UT_BUILD_TIMEOUT_MS` 到了也結束不了。現在 POSIX 一律對 group 送訊號；opencode session 結束時也把
  殘留的子孫收掉，避免它在 gate 判完之後還在改測試檔（opencode 部分屬 `runners/` 呼叫方式變更，
  AGENTS.md 高風險項，已取得使用者確認）。
- **`nohup testgen … &` 之後登出或 SSH 斷線，run 在建置中途無聲無息地死掉。** Node 啟動時會把繼承來的
  「忽略 SIGHUP」重設回預設，所以 `nohup` 對它無效：終端一斷，log 停在某一行 `[mvn]`、沒有 FATAL、沒有
  summary.json，detached 的 mvn / surefire 還成了孤兒繼續寫 `target/`——重量級模組每輪 8–15 分鐘，丟到
  背景再登出是最自然的用法，也最像「跑到一半莫名其妙中斷」。現在 stdin 不是終端機（nohup、setsid、
  cron、CI）時 SIGHUP 只印 `[WARN]` 並繼續執行；互動式終端斷線則與 Ctrl-C 一樣收掉整棵程序樹、寫出
  summary.json 後結束（exit 129）。實測：pty 裡 `nohup bin/testgen … &` 後斷線，舊版當場死掉並留下 3 個
  孤兒，新版 3 分 40 秒後 `gates-passed`。`bin/testgen` 也改成單一 node 程序（tsx 以 `--import` 載入）
  ——tsx CLI 會多一個只轉送 SIGINT/SIGTERM 的父程序，斷線時它自己先死，shell 回報 129 而 run 其實還在跑。
  `--import` 要 Node 20.6 以上（`engines` 允許 20.0），所以先試一次，不支援時照舊走 tsx CLI。
- **`testgen … | tee log` 的 tee 結束、或終端斷線後，下一行 log 讓整個 run 崩潰。** stdout 的讀取端消失時
  Node 以 `EPIPE` / `EIO` 的 error 事件回報，沒有 listener 就是未捕捉例外——而且發生在**下一行 log**，
  可能是幾分鐘後，看起來完全隨機。現在 console 失效時照常執行（紀錄本來就在 `runs/`）。
- **預檢建置逾時或被 OOM killer 收掉，被說成「定位不到的紅燈」再猜 Lombok。** 被 signal 終止的建置原本
  看起來跟 exit 1 一樣，逾時的預檢也沒有任何測試失敗可定位，於是進修復迴圈、立刻以
  `unlocatable-failure` 放棄，訊息卻說「根因在 production code 或 pom.xml 的 Lombok」。現在預檢／修復
  驗證的建置沒跑完時直接說明（`建置程序被 SIGKILL 終止，沒有跑完——常見原因：記憶體不足`、或逾時與
  `UT_BUILD_TIMEOUT_MS`），stopReason 為 `baseline-aborted` / `build-aborted`（`loop-baseline-killed`）。
- **建置結束後，被它啟動的背景程序抓著 stdout，build gate 永遠等下去。** 等的是 pipe 關閉，而 setsid 過的
  程序不在建置的 process group 裡，逾時也收不到。現在建置程序結束 3 秒後不再等待 pipe。
- **Ctrl-C / SIGTERM 中斷時也寫出 summary.json**（`interrupted:SIGINT` 等），不再留下一個看起來還在跑的
  artifacts 目錄；程序樹的收尾照舊。
- **opencode 的 stdout 出現一行 `null` 就讓整個程序崩潰**（`JSON.parse("null")` 成功、接著讀 `.part`）；
  長 JSONL 行的切行也改為線性。
- **（api runner）閘道回 HTTP 200 包著錯誤，writer 被當成「完成」。** LiteLLM、one-api、OpenRouter 這類閘道
  把上游逾時／過載包成 **200 + `{"error": …}`** 或空的 `choices`；舊版照樣當 completion 讀，得到一則空訊息，
  再拿**前幾回合說過的話**當最終答案回報 `[OK]`——writer 什麼都沒寫，下一輪 `writer-no-op`；首輪時甚至以
  `gates-passed` 收場而**一個測試都沒產生**。現在這種回應是失敗的請求，與 5xx 一樣重試並點名閘道的錯誤
  訊息（`loop-api-gateway-200-error`）。閘道強制串流（即使請求 `stream: false`）時也把 SSE 拼回一則訊息；
  串流裡的 `error` 事件、或沒有 `finish_reason` 也沒有 `[DONE]` 就斷掉的串流，同樣是失敗的請求，不會把
  半截的回覆當成答案。
- **reviewer 的判決前面有 `<think>` 或草稿，連續三次解析失敗而中止。** 判決原本取「第一個 `{` 到最後一個
  `}`」；沒開 reasoning parser 的推理模型（Qwen3、QwQ、R1 蒸餾版）把思考過程放在 content 裡，談的是 Java
  程式碼、滿是大括號；判決後加一段帶大括號的註解也一樣。temperature 0 的重試每次輸出相同，於是
  `reviewer-unparseable`。現在先去掉 `<think>…</think>`（Qwen3 模板只留下 `</think>` 也處理），逐一找出
  平衡的頂層物件（字串內的大括號不算），取帶 `scores` 的那一個。**有兩個內容不同的判決物件**（草稿加
  最終版、每個測試檔一個、一個陣列）時照樣 fail-closed、重試 reviewer——挑其中一個可能丟掉另一個提出的
  blocker。只改擷取，判定不變（`loop-review-think-verdict`）。`gates/review.ts` 變更（AGENTS.md 高風險項，已取得使用者確認）。
- **（api runner）一個格式不對的 tool call 讓後面每個請求都被拒。** 模型送出的 tool call 原樣回送給伺服器；
  arguments 不是合法 JSON（Java 原始碼放在 JSON 字串裡很容易漏逃脫引號，或被 `max_tokens` 截斷）、或沒有
  `id` 時，vLLM 0.11 以前會對**這段對話之後的每一個請求**回 400，writer 空手結束。現在回送前補上 `id`、
  `type`，壞掉的 arguments 以 `{}` 回送（錯誤照樣告訴模型），`functions.write_file` 這類工具名稱也正規化。
  參數**持續**被截斷時最多提示 3 次就結束並點名 `UT_API_MAX_TOKENS`，不再燒完 60 回合。
- **（api runner）答案放在 `message.reasoning` 的模型被當成「沒說話」。** 新版 vLLM、Ollama、OpenRouter 用的
  欄位名是 `reasoning`（`reasoning_content` 是舊名）；陣列形式的 `content` 也一併讀取。
- **修復迴圈把「修好了」「還在修」「修不動」分錯，在第一輪之前或中途就中止。** 以真的 Maven 專案逐一重現：
  - **只改 `src/test/resources` 的修復被當成 writer 什麼都沒改。** writer 的可寫範圍是整個 `src/test`，
    「有沒有改東西」卻只看 `src/test/java`，修正測試資料檔的一輪以 `writer-no-op` 中止（產生階段也一樣）。
    writer 的 prompt 與 agent 定義原本也只說 `src/test/java`，照做的模型根本不會去改測試資料檔；現在三者
    一致寫明 `src/test/resources` 的測試資源也在範圍內。
  - **呼叫 `System.exit` 的既有測試「定位不到」。** fork 的 JVM 中途結束時 surefire 不寫報告，只在 log 列出
    `Crashed tests:`；現在讀這段，照樣進修復迴圈。
  - **通過的測試印出 javac 形狀的訊息，被當成範圍外的編譯錯誤中止。** maven 只認編譯外掛自己的
    `[ERROR] X.java:[l,c]` 格式。
  - **紅燈數判斷把「揭露」當成「沒進展」。** 修好編譯錯誤後才看得到流程錯誤、整個模組編得過才看得到測試
    失敗；數量沒降就被算一次沒進展，連兩次就在離綠燈一輪時中止。現在「上一輪有編譯錯誤（只有它藏得住別的
    紅燈）、這輪有東西修好、新冒出的紅燈都在這輪沒改過、也沒引用這輪改過的類別的檔案裡」算進展；修好 A
    卻在同一輪改過的 B、或經由同一輪改過的共用 helper 弄壞 B、或改了測試資源，照樣算沒進展；上一輪只有
    測試失敗時換一個測試失敗也不算（`repair-revealed-errors` / `repair-thrash-still-stops` /
    `repair-thrash-via-helper` / `repair-test-failure-swap`）。
  - **flaky 測試讓預檢紅燈、writer 正確地沒改任何東西，run 以 writer-no-op 中止。** 只有測試失敗、writer
    又沒改檔時，先重跑一次建置確認；重跑變綠就判定為 flaky、點名那些測試後照常開始產生。
  - **`UT_ALLOW_DIRTY_BASELINE` 在修復失敗後，把修復 writer 弄紅的類別也列為「既有、請勿碰」。** gate 只容忍
    writer 介入前就失敗的測試（這點不變，是刻意的 fail-closed），prompt 卻叫 writer 別碰那個類別，兩邊矛盾、
    以 stuck 收場。現在「既有」只列修復前就紅、修復後仍紅的（`loop-dirty-repair-broke-green`）。
  - **`UT_ALLOW_DIRTY_BASELINE` 讓修復輪改過 production code 的 run 照樣跑到 `gates-passed`。** 修復迴圈以
    `scope-violation` 結束時，這個旋鈕原本照樣「帶著紅燈續跑」——之後每個 gate 量的都是被改過的程式碼。
    現在修復以 `scope-violation`、`runner-spawn-error`、`build-aborted` 結束時不論旋鈕一律中止
    （`loop-dirty-repair-scope-violation`）；它只放行「修不好的既有紅燈」。
  - **`UT_TEST_SCOPE=generated` 的 `-Dtest` 只看這一輪改了什麼。** 第 2 輪只修 helper 時，writer 第 1 輪寫
    的測試類別不在 `-Dtest` 裡，跑了 0 個測試，還被叫去「建立 `<Class>Test.java`」；現在用整個 run 寫過的檔。
  - 修復失敗的 FATAL 不再一律猜 Lombok，改依實際的 stopReason 說明；單一模組不再提 `mvn -pl`；範圍外
    清單不再說「全部」落在範圍外；建置逾時時點名當下還在跑的測試類別，逾時訊息也不再只在 verbose 才看得到。
- **reviewer 根本跑不起來時立即中止。** 先前 reviewer 的 spawn-error 被包成 blocker 餵給 writer——
  writer 改測試碼不可能讓 reviewer 起得來，於是多燒一輪 writer 加一次建置，拿到一模一樣的 blocker，
  以 `stuck` 收場。現在與 writer 的 spawn-error 同樣處理（`review-spawn-error-aborts`）。已取得使用者確認。
- **`writer-no-op` 的訊息不再一律猜 permission。** writer session 沒有正常完成（逾時、請求持續失敗、
  context 無法再縮短、回覆一直被截斷）時，訊息改為說明 session 沒完成並指向 runner 的 `[WARN]` 行。
- **逾時設得超大反而立刻逾時。** `UT_AGENT_TIMEOUT_MS` / `UT_BUILD_TIMEOUT_MS` 超過 setTimeout 的上限
  （約 24.8 天）時，Node 會把它改成 1 毫秒——想設成「永不逾時」的人，每個 agent 與每次建置都會一啟動
  就被殺。現在啟動時直接 FATAL 並點名變數。
- **itest 在有 `NO_PROXY` 的機器上會紅。** `BASE_ENV` 釘住了 `UT_NO_PROXY=""`，但空的 UT_ 值會退回讀
  shell 的 `NO_PROXY`——公司電腦幾乎一定有設，且含 `127.0.0.1`——於是 `loop-through-proxy` 的假 proxy
  一次連線都收不到。整合自測現在一併清掉標準 proxy 變數。需要 git 的情境在沒有 git 時標示 `[SKIP]` 而非
  整個 itest 崩潰，fixture 的 commit 也不受開發者全域的簽章設定與 hook 影響；Windows 上的路徑分隔、
  含空白的路徑也不再讓自測誤報。
- **reviewer 解析失敗不再拿 writer 的輪數去換。** 實地回報：reviewer 跑了 193 秒、38 次工具
  呼叫，最後回一個**空訊息**；`parseVerdict` 依 fail-closed 判 REJECT（這部分是對的），但那句
  「Reviewer 輸出無法解析，請重新輸出符合 schema 的單一 JSON 物件」被包成 blocker **餵給
  writer**——而 writer 再怎麼改測試碼，都不可能讓 reviewer 吐出合法 JSON。於是每輪拿到一模
  一樣的意見，第 4 輪判 stuck，**52 分鐘的模型時間沒有一分鐘花在可能有結果的方向上**。
  現在重試落在 reviewer 自己身上（`UT_REVIEW_MAX_RETRIES`，預設 2），用完仍解析不出就以
  `reviewer-unparseable` 中止，訊息明說這是 reviewer 端的故障、不是測試的問題，並列出常見
  原因與可調的旋鈕。這改動了 review gate 的判定語意（AGENTS.md 高風險項），已取得使用者確認。
  重試**刻意只涵蓋真正的解析失敗**（`gates/review.ts` 的 `isUnparseable`）：`parseError` 這個
  欄位其實由三種情況共用，spawn 失敗是環境問題（重試三次不會變），0 tool calls 是 reviewer
  答得出來只是沒讀檔（那道 guard 自有 fail-closed 處置）——把三者混為一談會靜默改掉另外兩道
  guard 的行為，實作時就這樣弄紅了兩個既有情境。
- **api runner 不再把「模型沒說話」當成完成。** `finish("ok", content)` 直接回最後一輪的
  `content`，有兩個洞：(a) 丟掉 `lastText`——模型若在倒數第二輪就給了判決、最後一輪回空訊息
  收尾，那份判決會被扔掉；(b) 空字串照樣報 `[OK] 完成`，一個什麼都沒產出的 run 被當成成功。
  另補上 `reasoning_content` 的讀取：QwQ / DeepSeek-R1 這類推理模型由 vLLM / Ollama 服務時，
  答案放在該欄位而 `content` 是空的，只讀 `content` 會看到一個「什麼都沒說」的模型。三者皆有
  對應 selftest；`content` 與 `reasoning_content` 分開處理，回送給伺服器的 assistant 訊息
  仍是伺服器原本給的內容，不影響下一個請求的合法性。
- **修復迴圈現在拿得到「為什麼失敗」，不只是「哪些類別失敗」。** `collectSurefireFailures`
  （把斷言訊息與專案自己的 stack frame 從 surefire 報告挖出來的那個函式）全專案只有一處呼叫，
  結果放進 `runBuildAndTests` 的 `report`——而 `runBaseline` 只取 `passed` 與 `raw`，把 `report`
  丟掉了。於是修復輪的 prompt 只有類別名加上 maven stdout 的 `[ERROR]` 摘要行，writer 拿不到
  任何一條斷言訊息。實地症狀：三個 service 測試同時紅，writer 在總結裡反覆寫「讓我停止這個
  循環思考」、句子被砍在半途，最後一個檔案都沒改就 `writer-no-op`——沒有失敗原因可依據，它只能
  一直翻檔案找線索，把回合預算燒光。這正是 v1.2.0 那次「surefire 改讀 XML」修好的問題（當時的
  描述是「writer 一直被告知哪些方法失敗、卻從來不知道為什麼，而且花掉一輪」），但那次只修了主
  gate 迴圈，修復迴圈漏掉了。現在 `runBaseline` 自己讀同一份報告存進 `BaselineResult.failureDetail`，
  而且**排在錯誤節錄前面**——`clampText` 保留開頭，測試失敗時斷言訊息才是可據以行動的那一半。
- **環境問題不再被當成測試問題送進修復迴圈。** 實地案例：一個既有測試全是 `@SpringBootTest`
  的模組，紅燈是 Spring context 起不來（HikariDataSource 解密失敗）。那些測試檔**就在 writer
  的可寫範圍內**，所以既有的 `outOfScope` 分類擋不住它，但改測試碼永遠不會讓它變綠——
  結果五次執行沒有一次真的開始產生新測試，全部把 3–5 輪、每輪 8–15 分鐘燒在修不動的東西上，
  最久一次 56 分鐘。`gates/build.ts` 新增 `detectEnvFailures`，認出 context 啟動失敗、bean
  建立失敗、連線池初始化失敗、JDBC 連不上、設定解密失敗，這類紅燈直接中止並指向環境而不是
  測試碼。偵測**刻意寫窄**：誤判會拒絕修一個本來修得動的東西，所以編譯錯誤與一般斷言失敗
  都不算（前者正是 writer 該修也修得動的典型），selftest 有專門的不得誤判斷言。
- **修復迴圈新增紅燈數早停**（`UT_REPAIR_NO_PROGRESS_ROUNDS`，預設 2）。既有的 `stuck` 比對
  feedback fingerprint，要求連續兩輪報告**完全相同**才觸發；「修好 A 又弄壞 B」每輪都產生
  嶄新的報告，fingerprint 永遠不重複，於是一路燒到 `UT_REPAIR_MAX_ITER` 用完，而模組跟第一輪
  一樣紅。現在改成也看紅燈數：連續幾輪沒有下降就以 `repair-no-progress` 停手。在每輪建置要
  8–15 分鐘的模組上，這是省下半小時與省下一小時的差別。
  行為上的連帶影響：兩者都用預設值時，`repair-max-iterations` 會變得很少見——除非紅燈數幾乎
  每輪都在減少，否則早停會先觸發。這是刻意的，`repair-max-iterations` 現在的意思變成
  「一直有進展但預算用完了」。
- **maven 上色時，整條錯誤解析鏈會靜默失效**（實地回報）。jansi 上色的是 level **字**，
  位元組是 `[<ESC>[1;31mERROR<ESC>[m]`——log 裡根本不存在 `[ERROR]` 這個字串，連不錨定的
  `grep -c '\[ERROR\]'` 都是 0。於是 `summarizeBuildErrors` 一行都沒配到、整份退回 `tail()`
  （報告變成 maven 的頁尾加一個被切一半的字），`extractCompileErrorFiles` 回空陣列，
  `runBaseline` 印「無法從輸出定位到具體檔案」，`buildRepairPrompt` 的「需要修復的既有測試」
  下面**一片空白**，writer 沒有目標只能翻別的檔案瞎找，四輪後以 `writer-no-op` 中止——而真正的
  紅燈只是兩個測試檔少了欄位，writer 完全有權限修。現在在擷取邊界剝一次 ANSI（所有解析、
  零測試計數與落地的 `build.log` 都吃乾淨文字，終端機的即時輸出保留顏色），兩個純函式自己
  再剝一次，maven 另外補上 `-B`（對齊 gradle 早就有的 `--console=plain`）。
- **修復迴圈不再空燒在「定位不到檔案」的紅燈上。** 建置紅但分類器指不出任何檔案或測試類別時，
  writer 拿到的是空清單，那跟 `outOfScope` 一樣是「修不動」而非「修得慢」——現在直接以
  `unlocatable-failure` 中止並帶出錯誤節錄，不再耗掉整個輪數預算。
- **中止訊息不再印出一份空清單再猜 Lombok。** `仍然紅燈的：` 在分類器指不出檔案時是空的，
  後面卻接著一句通用的「常見原因：Lombok annotation processor」，跟實際狀況可能毫無關係。
  現在清單為空時改印建置摘要，也就是唯一能據以行動的東西。
- **修復輪的失敗報告不再重複貼同一份錯誤節錄。** 分類器指不出檔案時 `runBaseline` 的 summary
  已經內含節錄，`describe()` 又接了第二份，等於拿一半的 feedback 預算放同樣的文字。
- **undici 的預設逾時坐在 agent 逾時底下，300 秒就砍掉請求**。`headersTimeout` 與
  `bodyTimeout` 預設都是 300 秒，而它們在 api runner 的 AbortController **下面**——模型若超過
  五分鐘才吐第一個 byte，會在約 301 秒以一句 `TypeError: fetch failed` 死掉，而不是等到
  `UT_AGENT_TIMEOUT_MS`（預設 15 分鐘，慢模型常設到 25 分鐘）。現在所有 dispatcher 都把這兩個
  逾時關掉，逾時只由 runner 自己的計時器決定。這條與 proxy 無關，沒有 proxy 的環境一樣中招。
- **多模組時，上游模組的失敗明細讀不到**。build gate 跑的是 `mvn -pl <module> -am test`，
  上游模組也會編譯與執行測試，但失敗報告只從目標模組的 `target/surefire-reports` 撈。`common`
  的測試失敗時，報告在 `common/target/surefire-reports`，永遠不會被讀到——writer 只拿到 maven
  stdout 的方法名，沒有斷言訊息。現在掃描整個 reactor 的 `target/surefire-reports`，mtime 過濾
  保證只會撈到本輪真的寫出來的報告。
- **紅燈在 writer 可寫範圍之外時，修復迴圈會空轉到用完輪數**。writer 的可寫範圍只有
  `<目標模組>/src/test`，但預檢紅燈可能來自上游模組的測試、production code 或 `pom.xml`——
  那不是「難修」，是**沒有權限修**。先前 loop 照樣進修復迴圈，writer 每輪不是什麼都不做就是
  嘗試寫到範圍外，最後以 `repair-failed:writer-no-op` 或 scope-violation 收場，錯誤訊息還去猜
  是 Lombok annotation processor 的問題。現在預檢就把紅燈分類：任何一項落在可寫範圍外就不進
  修復迴圈，直接中止並逐一點名「哪個檔／哪個類別、位於哪個模組」，`stopReason` 為
  `dirty-baseline:out-of-scope`。`UT_ALLOW_DIRTY_BASELINE=1` 行為不變。
- **`@Nested` 測試的失敗明細完全讀不到**。surefire 對「所有測試都在 `@Nested` 內層類別」的
  測試類別——JUnit 5 的常見寫法——`.txt` 摘要寫的是 `Tests run: 0, Failures: 0`，真實結果只在
  `TEST-*.xml`（同一次執行記的是 `tests=14 failures=12`）。build gate 讀 `.txt` 的計數，於是
  `surefireHasFailure` 判定沒失敗，整份斷言訊息被丟掉：writer 只被告知「這 12 個方法失敗了」，
  永遠看不到為什麼。真實執行實測的代價是**燒掉一整輪**——真正的原因是
  `expected: 400 BAD_REQUEST but was: 400`，一行 `isEqualTo(404)` 就能修；拿不到這句話的
  writer 從方法名推理，方向對了卻改過頭，下一輪收到 `int cannot be dereferenced`。
  現在改以 XML 為來源，`.txt` 只在建置關掉 XML 報告時當退路。餵回的區塊也從「貼一段 .txt」
  改成訊息優先：`✗ <容器>.<方法>` 加斷言訊息加**專案自己的** stack frame，junit / assertj /
  mockito / reflection 的框架 frame 一律濾掉。類別識別改用 `testsuite@name`——case 的
  `classname` 在有 `@DisplayName` 時是顯示名而不是型別名，`runBaseline` 的失敗類別清單先前
  也因此定位不到檔案，修復迴圈少了目標。新增 `UT_MAX_FAILURE_CASES`（預設 10）限制每個類別
  引用的失敗案例數：一個 `@Nested` 類別一次失敗數十個時，不該把整份回饋預算花在同一個錯誤的
  數十次重複上。
- **coverage gate 會被上一次的覆蓋率灌水**。JaCoCo agent 預設 `append=true`，exec 資料跨次
  累加進 `target/jacoco.exec`——開發者自己跑過 `mvn test`、或上一次 testgen 跑過，這一輪的
  弱測試就繼承那份覆蓋率。fixture 實測：只蓋 6 行中的 2 行，gate 報 100%。build gate 現在
  固定帶 `-Djacoco.append=false`，每次建置只量自己。
- **coverage gate 會讀到陳舊的 `jacoco.xml`**。report goal 綁在 `verify` 時 `mvn test` 不會重新
  產生報告，gate 讀的是上次留下的檔案（可能是幾天前的）。現在只信 mtime 晚於本輪建置開始的
  報告，陳舊報告視同無報告——訊息會點名 phase 綁定，`UT_STRICT_COV` 的政策不變。
- **stuck 偵測對 build 失敗從未生效**。判定條件是「連續兩輪報告完全相同」，但舊報告用
  `tail` 保留了 `[INFO] Total time: 1.570 s` 與 `Finished at: <timestamp>`，每輪都在變，
  條件永遠不成立——任何 build 失敗都會硬燒滿 `MAX_ITER`。改為抽取錯誤後 INFO 噪音消失，
  編譯錯誤的報告已逐字節穩定；測試失敗還差 surefire 的 `Time elapsed: 0.018 s`，因此
  stuck 改以 `feedbackFingerprint` 正規化後比對（時間與 JVM identity hash），writer 看到的
  報告仍保留真實數值。正規化刻意收窄——誤判成 stuck 會中止一個其實還在進步的 run，
  比多燒幾輪更糟。
- **build 失敗報告改為抽取錯誤，不再 tail 整份 log**。maven 的 `-> [Help 1]`、
  `To see the full stack trace`、`Re-run Maven` 樣板正好落在輸出尾端，`tail` 會完整保留樣板
  卻把編譯錯誤本身推出視窗外。現在只保留 `[ERROR]` 行與 javac 的無前綴接續行
  （`symbol:` / `location:`）。實測一個編譯失敗的模組：4826 → 713 字元，且錯誤在第一行。
- **通過的測試被當成失敗引用**。surefire 報告的彙總行本身就含「Failures」「Errors」字樣，
  舊的 `/FAILURE|ERROR/i` 子字串比對會把每一份通過的報告都當失敗塞進回饋。改為讀計數值。
- **陳舊的 surefire 報告不再進報告**。編譯階段就失敗時本輪根本沒跑測試，先前會引用上一輪
  遺留的報告，等於告訴 writer 一些這輪沒執行過的測試「失敗了」。改以 mtime 過濾。

### Changed
- **`UT_ALLOW_DIRTY_BASELINE=1` 現在真的到得了綠燈。** 先前它只把既有紅燈寫進 prompt
  （`preExisting` 唯一的去處是 `buildFixPrompt`），build gate 仍是整個模組的 pass/fail——
  那些既有失敗每輪照樣讓它紅，所以這個旗標**永遠不可能成功**：測試會產生、會落地，
  run 必定 exit 2。它看起來是逃生口，實際上只是把同一個失敗延後到最後一輪。現在 gate 的
  判準在這個旗標下改為「**本輪失敗識別集合 ⊆ 預檢基準**」：既有失敗可以續紅，writer 新弄壞的
  照樣擋。所有測試仍然全部執行——這是比對結果，不是跳過測試（後者是 DESIGN.md 早已否決的
  `-Dtest` 限縮）。gate 的承諾因此從「模組是綠的」降為「模組沒有比 writer 介入前更糟」；
  模組本來就綠時兩者等價。完整 rationale 與七道護欄見 DESIGN.md。
  - 識別**到方法層級**（FQCN + surefire 的 case name，`@ParameterizedTest` 的案例標識與
    `@Nested` 的內部類別都含在內）。用類別當識別，writer 在一個已失敗類別裡弄壞的新方法會被
    一起放行——mutation 實測：識別退回類別層級，對應情境從 exit 2 變成 exit 0。
  - **編譯錯誤永不扣除**（沒有測試跑過，無從比對），**紅但定位不到任何失敗測試也不扣除**
    （`∅ ⊆ P` 恆真，否則依賴解析失敗會被當成「沒有變糟」放行）。
  - **與 `UT_SKIP_BASELINE=1` 互斥**，並用直接中止——靜默退回全綠要求會讓操作者以為扣除生效了。
  - 失敗時 gate 的報告會**點名哪些是本輪新造成的**，與既有失敗分開陳述；容忍了哪些失敗寫進
    `summary.json` 的 `toleratedFailures`，這個綠燈才可被審計。
  - 預設行為完全不變：沒設這個旗標時，gate 維持原本的 fail-closed 全綠要求。
- **單元測試不連資料庫，嵌入式的也不行**，且既有測試違反時**就地改寫、不得刪除**。
  standards 先前只有一句籠統的「禁止真實網路 / DB / 檔案系統 I/O（一律以 mock 或
  in-memory 取代）」——那句話自己就開了後門：H2 也是 in-memory。現在點名
  `@SpringBootTest` / `@DataJpaTest` / `@JdbcTest` / `@MybatisTest` /
  `@AutoConfigureTestDatabase` / `@Sql` / Testcontainers 與嵌入式資料庫，並說明為什麼
  嵌入式不算緩解：它一樣要載入 driver 與 schema、一樣會因環境而紅，只是紅得比較慢。
  rubric 的 Dimension 5 同步改掉「Real network / DB calls (non-TestContainer)」——
  那行等於在說用 Testcontainers 就沒事——並明確要求列為 **blocker** 而非 advisory；
  advisories 不擋關也不進 feedback，寫成建議級等於沒寫。兩邊都要改，因為 writer 吃
  standards、reviewer 吃 rubric，review prompt 不注入 standards。
  standards 另新增「既有測試違反上述規則時」一節，講清楚 writer 能做什麼：保留測試方法、
  只換掉違規機制，**斷言數不得少於改寫前**（一個連 DB 撈五筆的測試改成 mock 之後只剩三個
  斷言，會被防掏空 guard 判定為刪減而讓該輪失敗，缺的驗證要補回等價斷言）；不得刪除方法、
  刪檔或改掛 `@Disabled`；目標類別本身就是持久層 adapter 時原樣保留並在總結中點名，
  由人決定，rubric 對應地把這種情況列為 advisory 而非 blocker——否則 reviewer 擋、writer
  改不動，會把輪數空燒完。
- standards 新增兩條：測試碼禁止 logging（`@Slf4j` / `log.*` / `System.out`——斷言就是測試的
  輸出，且 Lombok 的 annotation processor 在 test scope 未必生效，`@Slf4j` 產不出 `log`
  欄位會讓整個檔案編譯失敗）；測試類別可見性依 pipeline 掃描結論撰寫，不自行假設。
- `runBuildAndTests` 新增 `allowZeroTests` 選項（預檢專用：模組還沒有測試是本工具的正常
  起點，不該被零測試 guard 判 FAIL）。
- `UT_MODEL` 與 `UT_STANDARDS_PATH` 補進文件。前者是 `UT_WRITER_MODEL` 未設時的後備，
  兩份文件都沒提；後者只在 `.env.example` 有。由新的文件同步 assert 抓出。
- **測試分成兩層，`npm run check` 兩層都跑**（約 13 秒，不需要 Java、Maven 或模型）。
  先前的自測全部停在純函式與注入假 transport 的 runner 兩層：每道 guard 的零件都驗過，
  但沒有一項驗到它接在 loop 上真的會擋——`orchestrator.ts` 的 574 行與 `loop.ts` 的 324 行
  零覆蓋，而那正是上面每一條 Fixed 發生的地方。
  - `scripts/selftest.ts` 擴充至 207 項，新增第 20 組**架構不變式**：AGENTS.md 的硬規則改寫成
    可執行的 assert——`runners/` 以外不得 import agent SDK 或取用 CLI 路徑、內建兩份 agent `.md`
    必須各自守約（writer 無 bash、reviewer 全唯讀且 temperature 0）、每個 `UT_*` 都必須出現在
    `.env.example` 與 README。原本這幾條是文件裡的一行 grep 指令，靠人記得跑。
  - `scripts/itest.ts` 新增**整合自測**，130 項。每個情境建一個假的 Maven repo：`mvnw` 是重播
    腳本的 node 程式，writer 是實作 `AgentRunner` 的物件，其餘全是真的——真的 orchestrator、
    真的 spawn 子行程、真的解析 surefire 與 `jacoco.xml`。25 個情境全是對抗性的，每一個對應
    一道 guard 存在的理由：writer 改 production code、刪掉失敗的測試、加 `@Disabled`、
    什麼都不做、建置綠但 0 測試、覆蓋率報告陳舊、限縮範圍綠但完整模組紅、reviewer 沒讀檔
    就給滿分。其中 5 個跑既有紅燈修復迴圈，3 個跑 `loop.ts` 全流程——經 api runner 打本機
    假端點，驗到 exit code 與 `summary.json` / `params.json` / `repair-summary.md`。
  - itest 另含一個**多模組 reactor** fixture：root pom 加 common/core/web，假 mvnw 模擬 reactor
    輸出與各模組自己的 `target/`。上面兩條多模組的 Fixed 就是先在它身上寫成會失敗的情境、
    確認問題真的存在，才動手修的。
  - 驗收方式是變異測試：把 guard 的判斷條件逐一反轉，對應情境必須紅。18/18 全中。
  - 情境環境是密封的——`BASE_ENV` 釘住每一個 `UT_*`，否則工具自己的 `.env`（例如
    `UT_STRICT_COV=1`）會決定斷言的成敗。新增旋鈕而沒釘住，itest 第一項就紅。

## [1.2.0] - 2026-07-30

依 loop engineering 全面審查（對照 Qodo Cover、Meta TestGen-LLM、SWE-agent、OpenHands 等
業界做法）後的強化與重構。

### Added
- **Writer 變更偵測**：每輪 writer 前後對 `src/test/java` 拍快照，`changed-files.txt`
  進 artifacts。堵住最危險的 fail-open 鏈——writer 靜默 no-op → gate 判的是 repo 既有
  測試 → 什麼都沒產生卻 exit 0。gate 失敗後的 no-op 現在立即中止（stopReason=writer-no-op）。
- **Stuck 偵測**：連續兩輪拿到完全相同的失敗報告即中止（stopReason=stuck），不空燒輪數。
- **基礎設施失敗與模型失敗分流**：`AgentRunner` 回傳 `status`（ok/timeout/spawn-error）。
  opencode 起不來時立即中止並指向環境修法，不再被誤診為「模型行為異常」。
- **迭代漏斗（funnel）**：summary.json 記錄每輪到達的 gate 與結果、變更檔數、
  writer output tokens——一眼看出輪次死在哪個 gate（TestGen-LLM 式 per-stage yield）。
- **Token 記帳**：累計 writer output tokens 進 summary。
- **覆蓋率回饋帶未覆蓋行**：JaCoCo `<line>` 解析成 `12-15, 22` 區間直接給 writer，
  不再只給百分比要模型自己猜哪裡沒蓋到。
- **Fix prompt 帶目標類別**：第 2 輪起 writer 不再只能從截斷的 build log 猜範圍。
- **build/test gate 逾時**（`UT_BUILD_TIMEOUT_MS`，預設 30 分鐘）：卡死的 mvn 會被整樹
  終止，是先前 pipeline 唯一無上限的等待。
- `UT_RUNS_DIR` 覆蓋 artifacts 落點；params.json 補齊全部生效參數 + 目標 repo git SHA，
  成為完整可重現紀錄；crash 也會寫出 summary.json。
- CI 加入 windows-latest（libs/shell.ts 的 Windows 路徑首次進 CI）。
- LICENSE（MIT）。

### Changed
- 數值型環境變數啟動時驗證，拼錯直接 FATAL 並點名變數（先前 `UT_MAX_ITER=five` 會靜默
  變成 0 輪、`UT_AGENT_TIMEOUT_MS` 拼錯會立刻殺掉每個 agent）。
- guard 改解析 frontmatter 的 `tools:` 區塊實值（先前正則掃全文，`description:` 提到
  `bash: false` 就能騙過），契約範圍擴及 `webfetch`。
- 目標路徑包含檢查改用 `path.relative`（先前 `startsWith` 會把 `/work/repo-evil` 當成
  `/work/repo` 內部）。
- `@qwen-code/sdk` 移出 devDependencies（僅 `UT_RUNNER=qwen` 需要，用時再裝）。
- qwen runner 缺 `OPENAI_API_KEY` 時直接報缺鍵，不再塞 `"none"` 假憑證。
- selftest 擴充至 78 項（快照 diff、未覆蓋行、guard 解析、spawn-error 分流等）。

## [1.1.1] - 2026-07-30

### Fixed
- **Windows 逾時會永久卡死。** 逾時只 signal 我們 spawn 的那個程序，但 npm 裝的
  `opencode.cmd` 必須經 cmd.exe，所以被殺的是外殼、opencode 仍在跑，還握著繼承來的
  stdout/stderr 管線——而 Node 的 `'close'` 要等管線關閉才觸發，於是整個 run 永遠不會結束
  （10 秒後的 SIGKILL 是送給一具屍體，什麼也沒做）。現在改殺整棵程序樹：Windows 用
  `taskkill /T /F`，POSIX 用 `detached` + process group signal；並補上 `'exit'` 保險，
  程序結束後最多再等 2 秒讓管線排空就收工。中斷（Ctrl-C）時也會一併帶走整棵樹。
- 逾時訊息不再自稱 `[OK] 完成`，改為 `[WARN] 逾時中止`，並提示調高 `UT_AGENT_TIMEOUT_MS`。
  被砍掉的 run 仍會把已收到的輸出交給 gate 判斷（fail-closed 不變）。

### Added
- README 前置需求與 Troubleshooting 補上 ripgrep：opencode 的 glob 與 grep 都由它實作，
  離線環境不會自動下載，缺了會讓兩個工具一律回 `[error]`。附各平台放置路徑與驗證指令。
- selftest 新增 `planKill` / `killTree` 案例，含「外層死掉但孫程序還在」的實際迴歸驗證。

## [1.1.0] - 2026-07-11

### Added
- Build gate fail-closed 加固：編譯成功但實際執行 0 個測試 → FAIL，失敗報告引導 writer
  建立測試（逃生口 `UT_ALLOW_ZERO_TESTS=1`）。堵住「writer 沒寫檔 → 0 測試 → 兩個 hard gate
  空過」的假通過鏈。
- Review gate fail-closed 加固：reviewer 未呼叫任何工具即輸出判決 → REJECT
  （逃生口 `UT_REVIEWER_MUST_READ=0`）。堵住「schema 合法但內容捏造」的 verdict。
  `AgentRunner.runReview` 介面隨之改為回傳 `{ text, toolCallCount }`。
- README troubleshooting 新增兩個實測根因：global `permission.edit: ask` 擋非互動寫檔
  （project `opencode.json` 解法）、plugin/MCP 開銷吃滿 context（`num_ctx` 調高解法）。

### Changed
- selftest 擴充：新增 `countTestsRun` 與 reviewer must-read guard 案例。

## [1.0.0] - 2026-07-10

### Added
- Central-clone 模式：工具 clone 一份即可對任意 Java repo 執行。
- `npm run setup`：agents + 評分 skill 安裝至 `~/.config/opencode/`（目標 repo 同名定義優先）。
- `npm run doctor`：preflight 自診；`--smoke` 經唯讀 reviewer 實測 provider。
- `bin/testgen` wrapper；工具版本戳記（banner 與 `runs/<repo>/<ts>/params.json`）。
- CI：GitHub Actions 跑 typecheck + selftest。

### Changed
- 目錄整併：`core/`、`review/` 併入根目錄與 `gates/`；三個 prompt 檔合為 `prompts.ts`。
- `runs/` 依目標 repo 名稱分隔命名空間。
- 程式碼註解全面改為極簡英文（文件與 runtime 訊息維持繁中）。
