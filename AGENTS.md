# testgen — Agent 指南（AGENTS.md）

> 本檔是 agent 指令的**單一來源（SSOT）**，同時供 opencode（直接讀 AGENTS.md）與
> Claude Code（讀 CLAUDE.md，其內容為 `@AGENTS.md` import）使用。改指令只改這一份。
> 完整架構 rationale 見 DESIGN.md。

## 互動與語言
- 對話、思考、文檔預設**繁體中文**；技術名詞保留英文。

## 定位（重要）
本 repo 是**中央工具 clone**：clone 一份，對部門任何 Java repo 執行
（在目標 repo 根執行 `npx tsx <clone>/loop.ts <目標>` 或 `bin/testgen`）。
agent 定義與評分 skill 由 `npm run setup` 安裝到 `~/.config/opencode/`；
目標 repo `.opencode/` 內的同名定義優先（專案化覆寫）。
standards 與預設 rubric 隨本 repo 版控；每次執行寫入工具版本戳記。

核心設計是 **maker-checker loop**：控制流 100% 在 TypeScript，LLM 只負責「寫」（ut-writer）
與「審」（ut-reviewer），**驗證權不外包給模型**。編譯、測試、覆蓋率一律由 script 以 child
process 實際執行並解析原始報告——這是 loop 能收斂的前提。

## 架構大圖
控制流只有兩個檔案，兩者並排於根目錄：

- **`loop.ts`** — entry point：參數驗證、模組偵測、rubric 載入、startup guard、版本戳記、
  既有測試偵測、預檢基準（baseline）、建立 `runs/<repo 名>/<ts>/`。
- **`orchestrator.ts`** — 唯一的迭代 loop controller（deterministic，零 SDK import）。
  每輪四步，任一 hard gate FAIL 就把失敗報告餵回下一輪 writer：
  1. Writer agent 產生/修正測試（首輪 generate prompt，之後 fix prompt）
  2. Hard gate：`gates/build.ts` 跑 `mvn -pl <module> -am -DskipITs test`（多模組感知；
     `UT_TEST_SCOPE=generated` 時迭代期間加 `-Dtest=<目標類別的測試>` 只限縮**執行**，
     並在宣告成功前補一次完整模組重跑當驗收）
  3. Hard gate：`gates/coverage.ts` 解析該模組 `target/.../jacoco.xml`
  4. Review gate：唯讀 reviewer 依注入的 rubric 輸出 JSON 判決（`gates/review.ts`）

### 七個必須理解的機制
1. **驗證權在 loop，不在 LLM。** writer 永遠拿不到 bash；所有 hard gate 由 `gates/` 執行並解析
   原始輸出。writer 能自跑測試 = 能自述通過 = gate 被架空。同一個原則的另一面：writer 的
   可寫範圍只有目標模組的 `src/test/`，orchestrator 每輪在 writer 前後對整個 repo（扣除該
   `src/test`、建置輸出與 dot-dirs）拍快照，production code、`pom.xml` 或其他模組有任何變動
   即中止（stopReason=scope-violation），變更留在磁碟交人檢視。prompt 裡的「嚴禁修改
   production code」是勸導，這個快照才是 assert——被改過的 production code 會讓後面每個
   gate 的結果都失去意義。第三面是**防掏空**：build gate 分不出「修好失敗的測試」和「刪掉
   失敗的測試」，兩者都是綠燈，所以 `libs/testmetrics.ts` 在第一輪前量下每個既有測試檔的
   `@Test` 數、斷言數與 `@Disabled` 數，任一檔案數量減少（或 `@Disabled` 增加）該輪即 FAIL
   餵回，不進建置（`UT_ALLOW_TEST_SHRINK=1` 只警告）。刻意用數量不用方法名：standards 要求
   「方法_情境_預期」命名，writer 補強既有檔案時本來就會改名重寫，追方法名會跟 standards 打架。
2. **Runtime adapter 隔離 SDK。** 核心零 SDK import，一切 agent 互動經由
   `AgentRunner` interface（`libs/types.ts`）。換 runtime = 換一個 `runners/*.ts`
   （`opencode` 預設；`api` 直接打 OpenAI-compatible endpoint、tool loop 自己跑，工具在
   `runners/api-tools.ts`；`qwen` 走動態 import 作備援）。`runners/` 外禁止 import agent SDK 或
   spawn agent CLI。api runner 的權限就是工具清單：writer 沒有 bash 可拿、reviewer 的清單裡
   沒有寫入工具、`write_file` 只接受目標模組 `src/test/`——不看 agent `.md` 的 frontmatter，
   只讀它的本文當 system prompt（解析順序同 opencode，最後退回工具內建那份）。
3. **Injection over discovery。** standards（writer 契約，`standards/java-ut-standards.md`）
   與 rubric（reviewer 評分細則）由 loop **讀檔注入 prompt**，不靠 skill discovery 的機率性載入。
   rubric 只注入 `references/rubric.md`，**刻意不注入 SKILL.md 全文**（那是批次稽核 workflow，
   對單輪 gate reviewer 是錯誤指令）。搜尋順序：`UT_SKILL_DIR` → 目標 repo `.opencode` →
   目標 repo `.claude` → 工具內建。
4. **State in artifacts, not context。** 每 phase 開全新 session，跨輪狀態只落在
   `runs/<repo 名>/<ts>/iter-N/`（prompt、writer-summary、build.log、coverage.txt、
   verdict.json、feedback.md；上一層 `params.json` 記錄工具版本戳記、`baseline.md` /
   `baseline.log` 記錄預檢基準）。禁止跨輪複用 session context。
5. **範圍由 loop 界定，不靠 writer 自律。** build gate 跑的是 `mvn -pl <module> -am test`，
   整個模組連同上游模組的測試原始碼都要編得過——一個本工具沒碰過的壞檔就能擋掉每一輪，而
   writer 看到錯誤就會去修別人的檔案。所以 loop 在第一輪之前先做兩件確定性的事：
   **預檢基準**（`gates/build.ts` 的 `runBaseline`，跑與 gate 完全相同的指令；紅燈預設進入
   **修復迴圈** `orchestrator.ts` 的 `repairBaseline`——同一個 writer、同樣的範圍與防掏空
   guard、同一道建置指令，修到綠才開始產生新測試，修不好才中止，artifacts 在 `repair-N/`；
   `UT_REPAIR_BASELINE=0` 回到直接中止，`UT_ALLOW_DIRTY_BASELINE=1` 帶著紅燈續跑並標記為
   pre-existing 要求 writer 別碰。修復輪沒有 coverage / review gate——它們的範圍是目標類別，
   修復要證明的只有「模組綠了、而且沒有東西被拿掉」）與
   **既有測試偵測**（`libs/utils.ts` 的 `findExistingTests`，把既有測試檔名直接寫進 prompt，
   防止 writer 另建 `<Class>UnitTest.java` 造成重複）。這兩件事都禁止改成靠 prompt 措辭勸導。
   同理，專案慣例用量的、不用猜的：`libs/conventions.ts` 掃描既有測試得出可見性慣例與
   class-symbol 測試套件（`@SelectClasses`/`@SuiteClasses`）的存在，再由 prompt 告知結論。
   測試類別可見性**沒有**放諸四海皆準的規則——JUnit 5 不要求 `public`、Sonar S5786 還會標記它，
   但跨 package 的 class-symbol 套件沒有 `public` 就編不過。禁止在 standards 或 prompt 裡
   寫死任一邊。
6. **回饋有預算。** 每輪餵回 writer 的失敗報告受 `MAX_FEEDBACK_CHARS` 上限約束（orchestrator
   統一 clamp，與產生報告的是哪個 gate 無關），且 build 報告是**抽取** `[ERROR]` 行而非
   `tail` 整份 log——maven 的 Help/stack trace 樣板正好落在尾端，tail 會留下樣板、丟掉錯誤。
7. **限縮可以延後完整驗證，不可以取消它。** `UT_TEST_SCOPE=generated` 讓迭代期間只跑目標類別
   的測試（實測 200 隻既有測試下每輪 23.3s → 4.0s），但 build gate 的承諾有兩半——「新測試會過」
   與「沒打壞別人」——後者只有完整模組重跑證明得了。所以成功前一定補跑一次（`final-verify.log`），
   失敗就以 `final-verify-fail` 餵回下一輪。禁止把這次重跑改成可選或省略：那是拿保證換速度，
   而限縮本來就已經拿到速度了。限縮只影響**執行**，不影響編譯——既有編譯錯誤照樣擋，那是修復
   迴圈的事。

### Review gate 判定（fail-closed）
通過 = **blockers 空** 且 **六維（0-10 整數）皆達門檻**。維度：effectiveness / coverage /
independence / readability / fast_reliable / mock_appropriateness。`weightedScore`（權重
25/20/15/15/15/10）與 `grade`（A/B/C/D）由 pipeline **確定性計算**（LLM 不算分），僅供報告。
只有 blockers + 低分維度會餵回下一輪；advisories 不擋關、不進 feedback（防 thrash）。

## SSOT 三分（互不重複）
| 內容 | 位置 | 消費者 |
| --- | --- | --- |
| 測試撰寫標準 | <工具 clone>/standards/java-ut-standards.md | writer prompt（loop 注入） |
| 評分 rubric | skill 的 references/rubric.md（UT_SKILL_DIR → 目標 repo .opencode/.claude → 工具內建） | reviewer prompt（loop 注入；SKILL.md 不注入） |
| 門檻與參數 | config.ts（env 可覆蓋） | gates / verdict |
| 角色契約與權限 | 目標 repo .opencode/agent/ 優先，否則 ~/.config/opencode/agent/（npm run setup 安裝），api runner 再退回工具內建 .opencode/agent/ | opencode runtime + startup guard；api runner 只取本文作 system prompt，權限由 runners/api-tools.ts 的工具清單決定 |

門檻與參數**只能改 `config.ts`**（透過 env 覆蓋），不得寫死在 prompt 或 gate 內。

## 修改前必讀的硬規則（違反 = 架構破壞）
完整 rationale 見 DESIGN.md。
1. 迭代控制流只存在於 orchestrator.ts + loop.ts。禁止讓任何 agent 決定
   重試/停止，禁止引入 Task tool delegation。
2. ut-writer 永遠不得取得 bash/shell；建置與測試只能由 gates/ 執行與解析。
3. ut-reviewer 永遠唯讀（write/edit/bash 全 false）、temperature 0。
4. standards 與 rubric 由 loop 讀檔注入 prompt。禁止改成依賴 skill tool 觸發
   或 agent 自行探索讀檔；rubric 注入 references/rubric.md，禁止注入 SKILL.md 全文。
5. 跨輪狀態只能落在 runs/ artifacts。禁止跨輪複用 session context。
6. 除 runners/ 外禁止 import 任何 agent SDK 或 spawn agent CLI；
   runtime 只能經由 AgentRunner interface（libs/types.ts）介接。
7. 門檻與參數只能改 config.ts（env 覆蓋），不得寫死在 prompt 或 gate 內。
8. libs/guard.ts 的 assert 不得移除或弱化；改 agent 權限先改 DESIGN.md 取得共識。

## 目錄結構
```
loop.ts               entry point（參數驗證/rubric 載入/guard/預檢基準/runs 建立/版本戳記）
orchestrator.ts       迭代迴圈＋既有紅燈修復迴圈（零 SDK import）＋範圍/防掏空 assert＋artifacts
config.ts             所有設定 SSOT（.env 自動載入）
prompts.ts            writer/reviewer 參數化 prompt（standards/rubric 注入）
gates/build.ts        多模組感知 build gate（mvn -pl -am / gradle -p）＋失敗摘要（surefire XML 優先，.txt 退路）＋預檢基準
gates/coverage.ts     JaCoCo 定位＋解析（sourcefile 彙總優先）
gates/review.ts       fail-closed 判決解析＋門檻判定＋review gate 組裝
runners/…             factory＋三個 AgentRunner 實作（opencode / api / qwen；SDK 隔離邊界）
runners/api-tools.ts  api runner 的工具集＝其權限模型（read/list/search；寫入限 src/test）
libs/types.ts         共用型別（GateResult, ReviewVerdict, AgentRunner, ModuleInfo）
libs/log.ts           elapsed/log/banner/die/tail/startHeartbeat
libs/shell.ts         shLive（子行程逐行轉印）
libs/utils.ts         純函式（含 skillDirCandidates / runsDirFor / findExistingTests / clampText）
libs/conventions.ts   專案慣例掃描（測試類別可見性、class-symbol 測試套件）
libs/testmetrics.ts   既有測試檔的 @Test / 斷言 / @Disabled 計數（防掏空 guard 的量尺）
libs/guard.ts         startup guard（agent 解析 repo→global + frontmatter assert）
libs/rubric.ts        rubric loader（只注入 references/rubric.md，禁 SKILL.md 全文）
libs/version.ts       工具版本戳記
scripts/selftest.ts   純邏輯自測＋架構不變式 assert
scripts/itest.ts      整合自測 driver（假 mvnw + 腳本化 writer，跑真的 orchestrator 與 gate）
scripts/itest-lib.ts  整合自測的 fixture 產生器與假 mvnw 原始碼
scripts/itest-scenarios.ts  情境表（每道 guard 配一個作弊劇本）
scripts/itest-case.ts 單一情境的執行體（在 fixture 內以子行程跑）
scripts/setup.ts      安裝 agents+skill 至 ~/.config/opencode/
scripts/doctor.ts     preflight 自診（--smoke 經 AgentRunner 實測 reviewer）
bin/testgen           bash wrapper（doctor/setup/loop）
standards/            writer 契約 SSOT
.opencode/            agents + 評分 skill 的 SSOT（setup 的安裝來源）
runs/<repo>/<ts>/     artifacts（gitignore）
```

## 常用指令
```bash
npm install
npm run check                          # tsc --noEmit + selftest + itest
npm run itest                          # 只跑整合自測；加情境名可單跑一個
npm run setup                          # agents+skill → ~/.config/opencode/
# 在目標 Java repo 根執行：
npx tsx <clone>/scripts/doctor.ts [目標路徑] [--smoke]
npx tsx <clone>/loop.ts <目標路徑>
```
（SDK 隔離、agent 權限契約、UT_* 文件同步都已是 selftest 第 20 組的 assert，不必再手動 grep。）

環境變數見 README.md 與 .env.example。

## 測試分兩層（沒有測試框架，都是手寫斷言）
- **`scripts/selftest.ts`** — 純函式與架構不變式（組數與斷言數以 `npm run selftest` 輸出為準）。
  改 `libs/utils.ts`、`gates/review.ts`、`gates/coverage.ts`、`gates/build.ts` 等純邏輯後先跑它。
- **`scripts/itest.ts`** — 接線。每個情境建一個假的 Maven repo，`mvnw` 是重播腳本的 node 程式、
  writer 是實作 `AgentRunner` 的物件，其餘全是真的：真的 orchestrator、真的 spawn 子行程、真的
  解析 surefire 與 jacoco.xml。改 `orchestrator.ts`、`loop.ts` 或任何 gate 的控制流後必須跑它。
  每個情境都是**對抗性**的——假 writer 嘗試一種作弊（改 production code、刪掉失敗的測試、
  什麼都不做），斷言 loop 擋下來。新增 guard 時一併新增情境，並確認把 guard 的判斷條件
  反轉後該情境會紅；反轉後仍綠的情境沒有在測那道 guard。
- 情境用的環境是密封的：`itest.ts` 的 `BASE_ENV` 釘住每一個 `UT_*`，新增旋鈕而沒釘住會直接紅。

## 高風險操作與授權閘門
以下必須先向人類說明影響並取得明確確認：
1. 刪除、遷移或大規模重構現有代碼
2. 修改 libs/types.ts 共用型別、libs/guard.ts 的 assert、gates/review.ts 判定邏輯
3. 修改 runners/ 的 CLI/SDK 呼叫方式或 agent .md 權限
4. 執行破壞性命令（rm -rf）、重寫 Git 歷史（force push）
