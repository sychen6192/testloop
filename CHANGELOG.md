# Changelog

使用者可見的變更記錄。更新方式：`git pull && npm install && npm run setup`。

## [Unreleased]

依實地使用回報修正兩個範圍問題：build gate 涵蓋整個模組，但 writer 的職責只有目標類別，
兩者之間的落差先前完全由 prompt 措辭承擔。

### Added
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
  loop 現在在第一輪前量下每個既有測試檔的 `@Test` 數、斷言數與 `@Disabled` 數，任一檔案
  數量減少或 `@Disabled` 增加，該輪即 FAIL 並把前後數字餵回，不進建置；主迴圈與修復迴圈
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
