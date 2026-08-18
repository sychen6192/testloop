# Changelog

使用者可見的變更記錄。更新方式：`git pull && npm install && npm run setup`。

## [Unreleased]

依實地使用回報修正兩個範圍問題：build gate 涵蓋整個模組，但 writer 的職責只有目標類別，
兩者之間的落差先前完全由 prompt 措辭承擔。

### Added
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
- **回饋預算**：每輪餵回 writer 的失敗報告受 `UT_MAX_FEEDBACK_CHARS`（預設 12000）約束，
  由 orchestrator 統一 clamp，與產生報告的是哪個 gate 無關；surefire 明細另受
  `UT_MAX_FAILURE_BLOCKS`（預設 5）限制，超出的類別數會據實標明而非靜默丟棄。

### Fixed
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
- standards 新增兩條：測試碼禁止 logging（`@Slf4j` / `log.*` / `System.out`——斷言就是測試的
  輸出，且 Lombok 的 annotation processor 在 test scope 未必生效，`@Slf4j` 產不出 `log`
  欄位會讓整個檔案編譯失敗）；測試類別可見性依 pipeline 掃描結論撰寫，不自行假設。
- `runBuildAndTests` 新增 `allowZeroTests` 選項（預檢專用：模組還沒有測試是本工具的正常
  起點，不該被零測試 guard 判 FAIL）。
- selftest 擴充至 133 項（編譯錯誤檔名解析的 maven/javac 兩種格式、測試檔命名比對的誤判
  防護、錯誤抽取與樣板剔除、surefire 計數判定、可見性與套件偵測、各 prompt 區塊的實際
  注入與留空行為）。

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
