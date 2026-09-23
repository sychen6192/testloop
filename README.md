# testgen — Java 單元測試自動產生 pipeline

testgen 為指定的 Java 類別自動產生 JUnit 5 單元測試。它跑一個迭代迴圈：產生 →
編譯/測試 gate → 覆蓋率 gate → 品質審查 gate → 依失敗報告修正，直到測試符合團隊品質標準。

控制流完全在 TypeScript。LLM 只做兩件事：ut-writer 寫測試、ut-reviewer 審查。驗證權不
外包給模型；編譯、測試、覆蓋率一律由 script 實際執行並解析原始報告。

**本工具走中央 clone 模式。** clone 一份即可對任何 Java repo 執行，不需把工具放進
目標 repo。

```
目標 Java repo ────── 在此執行指令；實際跑 mvn test、解析 JaCoCo、寫測試檔
      ▲
      │ 每輪：writer 寫 → build gate → coverage gate → review gate
工具 clone ────────── artifacts 寫入 <clone>/runs/<repo 名>/<時間戳>/
      │
~/.config/opencode/ ─ npm run setup 安裝 ut-writer、ut-reviewer、評分 skill
```

## 前置需求

- Node.js 20 以上。
- opencode CLI 已安裝並在 PATH 中，版本需支援 `--format json`。
- ripgrep（`rg`）已安裝。opencode 的 glob 與 grep 工具都靠它，writer 與 reviewer 都要用；
  缺了會讓兩個工具一起回 `[error]`。見「離線環境需先備妥 ripgrep」。
- LLM provider 存取權。設定方式見「Provider 與模型設定」。
- 目標 Java repo 使用 JUnit 5。建置工具以 Maven 為主力，Gradle 為 best-effort 支援。
- 覆蓋率 gate 需要模組綁定 JaCoCo。未綁定時該 gate 會自動略過並提示。

## 安裝


```bash
git clone https://github.com/sychen6192/testloop.git
cd testloop
npm install
npm run setup      # 安裝 agents 與評分 skill 到 ~/.config/opencode/
npm run doctor     # 環境自診。此時「Java repo」項顯示 WARN 屬正常
```

選用：把 wrapper 加入 PATH，之後在任何目錄都能用 `testgen`。

```bash
echo 'export PATH="$PATH:'$(pwd)'/bin"' >> ~/.zshrc && source ~/.zshrc
```

## Provider 與模型設定

自架單卡（約 32GB VRAM）跑 27B 級 dense 模型的實測建議：

- writer 與 reviewer 共用同一顆模型即可，省去每輪換模的 reload 成本。
- 目標是資料夾時 loop 會一次處理一個類別（`UT_BATCH_SIZE=1`），writer 每輪只產一個測試檔；
  不建議調大——同時重寫多個大檔會慢到撞逾時。
- 設 `UT_AGENT_TIMEOUT_MS=1500000`，約 25 分鐘。dense 模型約 15–25 tok/s，這給完整生成
  留餘裕，避免被 SIGTERM 截斷。
- 將 opencode 中該模型的 context（如 Ollama 的 `num_ctx`）設為 65536。扣掉 plugin 與 MCP
  的 session 固定開銷後，才有足夠工作空間。
- 避免用 activation 很小的 MoE 模型當 writer——服從性不足，寫不出較大的新測試檔。

設定步驟：

1. 設定 provider 憑證，執行 `opencode auth login`。若使用 vLLM，改指向其 OpenAI 相容
   endpoint。
2. 指定模型，以下二擇一：
   - 編輯 `~/.config/opencode/agent/ut-writer.md` 與 `ut-reviewer.md` 的 `model:` 欄位；或
   - 用環境變數 `UT_WRITER_MODEL`、`UT_REVIEWER_MODEL` 覆蓋，格式為 `provider/model`。

模型搭配建議：理想上 writer 用便宜模型快速迭代、reviewer 用較強模型，cross-model 可降低
self-agreement bias。但單張 GPU 通常放不下兩顆模型並存，此時 writer 與 reviewer 共用同一顆
即可，省去每輪換模的 reload 成本。共用同一顆時，review gate 的 must-read 防護會擋掉 reviewer
不讀檔就給出的假判決。

## 直接打 API（`UT_RUNNER=api`，不需要 opencode）

第三種 runner：不經任何 agent CLI，直接對 OpenAI-compatible 的 `POST /v1/chat/completions` 做
tool calling，tool loop 由本工具自己跑。Ollama、vLLM、LM Studio、OpenAI，以及 Anthropic 的
OpenAI 相容端點都可以。

```bash
UT_RUNNER=api \
UT_API_BASE_URL=http://localhost:11434/v1 \
UT_WRITER_MODEL=qwen3.6:27b UT_REVIEWER_MODEL=qwen3.6:27b \
testgen <package 路徑>
```

跟 opencode runner 的差別：

- **權限是工具清單，不是設定檔。** writer 拿到 `read_file / list_files / search / write_file /
  replace_in_file`，沒有 bash 可給；reviewer 只有前三個。`write_file` 只接受目標模組 `src/test/`
  底下的路徑，其他路徑直接回錯誤給模型自己修正，不用等到 orchestrator 的快照 guard 才中止。
- **沒有 session 固定開銷。** 不載 plugin / MCP schema，context 全部留給程式碼。
- **不需要 ripgrep、不需要 `npm run setup`。** 角色契約（system prompt）仍讀 agent `.md` 的本文，
  解析順序同 opencode runner（目標 repo → global → 工具內建），所以 repo 級的 reviewer 覆寫兩種
  runner 都吃得到。
- **Windows 沒有 spawn 問題。** 唯一的子行程是 mvn。

前提：模型端要支援 tool calling。vLLM 需 `--enable-auto-tool-choice --tool-call-parser <parser>`
（qwen 系列通常用 `hermes` 或 `qwen3_coder`）；Ollama 對支援 tools 的模型（qwen3 系列在內）直接
可用。`testgen doctor` 在 `UT_RUNNER=api` 下改檢查端點連得上、兩個模型有設、角色契約找得到。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `UT_API_BASE_URL` | - | OpenAI-compatible base URL（含 `/v1`）。也接受 `OPENAI_BASE_URL` |
| `UT_API_KEY` | - | Bearer token；本地 Ollama / vLLM 通常不用。也接受 `OPENAI_API_KEY` |
| `UT_API_MAX_TURNS` | 60 | 單次 session 最多幾個 assistant 回合 |
| `UT_API_MAX_TOKENS` | 8192 | 傳給 `max_tokens`；0 = 用伺服器預設 |
| `UT_API_MAX_TOOL_RESULT_CHARS` | 24000 | 單次工具結果上限，超過截斷 |
| `UT_AGENT_RETRY_WINDOW_MS` | 180000 | 模型端暫時故障時持續重試多久。api runner：端點回應過之後，連線錯誤、429、5xx 以指數退避重試（尊重 `Retry-After`）；opencode runner：同一個 agent 完成過 session 之後，opencode 異常結束（多半是 provider 故障）就重新執行。都受 `UT_AGENT_TIMEOUT_MS` 限制。`0` = 不重試；大於 0 時至少重試一次。這個 run 裡端點從未回應過（api：只快速試 3 次）或 agent 從未做過事（opencode：不重新執行）時不適用，直接判定設定錯誤 |
| `UT_WRITER_TEMPERATURE` | 0.2 | writer 溫度；reviewer 固定 0，不可設定 |

## 第一次執行

```bash
cd <目標 Java repo 根目錄>              # 多模組 Maven 請用 reactor root
testgen doctor <package 路徑> --smoke   # preflight，並實測 provider 一次
testgen <package 路徑>                  # 端對端執行
```

起手挑一個依賴最少的簡單 class。退出碼定義：`0` 全數通過、`2` 有目標沒通過（單一類別是迭代用盡；
分批時是任何一批沒過）、`1` 致命錯誤。

每輪產物寫入 `<clone>/runs/<repo 名>/<時間戳>/`，包含 prompt、writer 總結、build log、
覆蓋率、審查判決與失敗報告。同層的 `params.json` 記錄工具版本戳記，`project-facts.json` 記錄
量到的測試相依與原始碼編碼（見下方 Troubleshooting）。資料夾目標分批時，每批在自己的
`batch-NN-<類別>/` 底下。

## 參數

全部為環境變數、全部選填，詳見 `.env.example`。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `UT_RUNNER` | opencode | opencode、api 或 qwen。api 見上一節；qwen 需另裝：`npm i -D @qwen-code/sdk` |
| `UT_WRITER_MODEL` / `UT_REVIEWER_MODEL` | agent .md 的 model | 以 provider/model 覆蓋 |
| `UT_MODEL` | - | writer 的後備模型，僅在 `UT_WRITER_MODEL` 未設時生效 |
| `UT_MAX_ITER` | 5 | 最大迭代輪數（分批時為每批） |
| `UT_BATCH_SIZE` | 1 | 目標是資料夾時，每批幾個類別。每批是一個完整的 writer → gate 迴圈：新的 session、自己的迭代輪數；沒通過的批次撤回它對 `src/test` 的變更（保留在該批的 `rejected/`），不影響其他批次。見「一次處理整個資料夾」 |
| `UT_MIN_LINE_COV` / `UT_MIN_BRANCH_COV` | 80 / 70 | 覆蓋率門檻，單位 % |
| `UT_STRICT_COV` | - | 1 = 無 JaCoCo 報告直接 FAIL |
| `UT_ALLOW_ZERO_TESTS` | - | 1 = 允許「編譯成功但 0 測試」通過 build gate。預設 fail-closed 擋下 |
| `UT_SKIP_BASELINE` | - | 1 = 跳過預檢基準建置（省一次 build，但既有紅燈將無法與 writer 造成的失敗區分） |
| `UT_REPAIR_BASELINE` | 1 | 0 = 預檢發現既有紅燈時直接中止，不進修復迴圈 |
| `UT_REPAIR_MAX_ITER` | 5 | 修復迴圈最大輪數 |
| `UT_REPAIR_NO_PROGRESS_ROUNDS` | 2 | 連續幾輪紅燈數沒下降就停。stuck 需要兩輪報告完全相同，「修好 A 又弄壞 B」的報告每輪都不一樣卻毫無進展，只有數量抓得到。例外是**揭露**：上一輪有編譯錯誤、這輪修好了一些，而新紅燈都在沒改過、也沒引用這輪改過的類別的檔案裡（改了測試資源則不算），算進展 |
| `UT_ALLOW_DIRTY_BASELINE` | - | 1 = 修復失敗（或關閉修復）時照樣執行。既有紅燈會標記為 pre-existing 寫進 prompt，**且 build gate 改為「失敗集合不得超出預檢基準」**——既有失敗可以續紅，writer 新弄壞的照樣擋。與 `UT_SKIP_BASELINE` 互斥（沒有基準就沒有可扣除的集合，會直接中止）。預設中止 |
| `UT_ALLOW_TEST_SHRINK` | - | 1 = 既有測試檔被刪減（@Test / 斷言變少、新增 @Disabled / @Ignore / `enabled = false` / assumeTrue 之類的略過標記）時只警告。預設該輪 FAIL 餵回 |
| `UT_TEST_SCOPE` | module | `generated` = 迭代期間只跑目標類別的測試，通過前完整重跑一次驗收。見下節 |
| `UT_MAX_FEEDBACK_CHARS` | 12000 | 每輪餵回 writer 的失敗報告上限。超過則保留開頭並標明截斷量 |
| `UT_MAX_FAILURE_BLOCKS` | 5 | 失敗報告中最多引用幾個失敗測試類別的 surefire 明細 |
| `UT_MAX_FAILURE_CASES` | 10 | 每個失敗類別最多引用幾個失敗案例。`@Nested` 測試一次可能失敗數十個 |
| `UT_REVIEWER_MUST_READ` | 1 | 0 = 允許 reviewer 未讀檔就輸出判決。預設 fail-closed 擋下 |
| `UT_SCORE_THRESHOLDS` | 7/7/7/6/7/6 | 六維門檻局部覆蓋，JSON 格式，0-10 制 |
| `UT_REVIEW_MAX_RETRIES` | 2 | reviewer 輸出解析不出判決時額外重試幾次。用完仍失敗即以 `reviewer-unparseable` 中止——那是 reviewer 端的故障，餵回 writer 只會白燒輪數 |
| `UT_SKIP_REVIEW` | - | 1 = 跳過 review gate |
| `UT_AGENT_TIMEOUT_MS` | 900000 | 單輪 agent 逾時，單位毫秒 |
| `UT_BUILD_TIMEOUT_MS` | 1800000 | build/test gate 逾時；逾時會終止整棵程序樹 |
| `UT_MAX_BUILD_OUTPUT_CHARS` | 67108864 | 建置輸出在記憶體中保留的字元上限；超過時丟棄前段、只留尾端與 `[ERROR]` / `Tests run:` 行（避免測試大量輸出 log 時撐爆字串上限而中斷） |
| `UT_STANDARDS_PATH` | 工具內建 | writer 契約（standards）路徑覆蓋 |
| `UT_SKILL_DIR` | 自動搜尋 | rubric 來源覆蓋。未設時依序找目標 repo、工具內建 |
| `UT_JACOCO_XML` | 自動搜尋 | 報告路徑覆蓋 |
| `UT_MAVEN_ARGS` | - | 額外 maven 參數，例如 `jacoco:report` |
| `UT_RUNS_DIR` | 工具 clone 內 | artifacts 落點覆蓋（共用或唯讀安裝時使用） |
| `UT_OPENCODE_BIN` | opencode | opencode 執行檔路徑覆蓋 |
| `UT_HTTPS_PROXY` / `UT_HTTP_PROXY` | 讀 `HTTPS_PROXY` / `HTTP_PROXY` | 公司 proxy。Node 的 fetch 不吃標準變數，本工具自己讀 |
| `UT_NO_PROXY` | 讀 `NO_PROXY` | 繞過 proxy 的主機，支援 `host:port`。內網模型端點要列進來 |
| `UT_CA_CERTS` | - | TLS 被攔截時額外信任的 CA（PEM，逗號分隔）。比 `NODE_EXTRA_CA_CERTS` 可靠 |
| `UT_USER_AGENT` | `testgen/<版本>` | 送出的 User-Agent，供依此過濾 CONNECT 的 proxy 使用 |
| `UT_OPENCODE_JSON` | 1 | 0 = 不用 `--format json`（失去即時 tracing 與 must-read 觀測） |
| `UT_OC_SKIP_PERMS` | - | 1 = writer 附加 `--dangerously-skip-permissions`（最後手段） |
| `UT_SKIP_GUARD` | - | 1 = 跳過 agent 權限 guard（不建議） |
| `UT_QUIET` | - | 1 = 關閉 verbose 行 |

數值型變數在啟動時驗證：`UT_MAX_ITER=five` 這類拼錯會直接 FATAL，不會靜默用 NaN
把整個迴圈變成 0 輪。

提前中止：writer 程序起不來（環境問題）、gate 失敗後 writer 未改任何測試檔（no-op）、
連續兩輪拿到完全相同的失敗報告（stuck）——三者都立即結束並在 summary 標明 `stopReason`，
不會空燒剩餘輪數。

評分規則：六維各給 0-10 整數，門檻預設 7/7/7/6/7/6。`weighted_score` 依權重
25/20/15/15/15/10 計算，`grade` 依 85/70/55 分界為 A/B/C/D。兩者都由 pipeline 確定性計算、
僅供報告。gate 的通過條件是 blockers 為空且六維皆達門檻。advisories 屬建議級，不擋關、也
不進下一輪 feedback。

## 加速：`UT_TEST_SCOPE=generated`

預設每輪 build gate 都跑完整模組（含上游）的測試。既有測試越多、越慢——尤其 Spring Boot 測試，
每輪都重新載入一次 context。

```bash
UT_TEST_SCOPE=generated testgen <package 路徑>
```

開啟後：**迭代期間** surefire 只跑目標類別的測試（`-Dtest=<那幾個>`），**所有 gate 通過之後、
宣告成功之前**，再以完整模組範圍重跑一次驗收。「新測試有沒有打壞既有測試」這個保證沒有被拿掉，
只是從每輪一次改成整個 run 一次。

200 隻既有測試（模擬 Spring context 載入）的實測：

| | 每輪 build | 2 輪總時間 |
| --- | --- | --- |
| `module`（預設） | 23.3 s | 70.5 s |
| `generated` | **4.0 s** | 56.0 s（含最後 21.8 s 的完整驗收） |

省下的量隨輪數放大：2 輪省 21%，5 輪約省一半。輪數少時固定成本（預檢 + 最終驗收）佔比高，
效益就沒那麼明顯。

注意事項：

- **只限縮執行，不限縮編譯。** 整個模組的測試原始碼還是要編得過，所以既有的編譯錯誤照樣擋你——
  那是修復迴圈的工作。
- **最終驗收失敗會餵回 writer**，報告明說「目標類別的測試本身通過，但打壞了既有測試」，附上失敗的
  類別與斷言，然後進下一輪。
- **覆蓋率反而更準**：限縮後 JaCoCo 只記錄目標測試造成的覆蓋，不會被別的測試順帶碰到而灌水。
- Maven only。Gradle 會顯示警告並退回 `module`。

## 一次處理整個資料夾

目標是資料夾時，loop 把裡面的類別依路徑排序、每 `UT_BATCH_SIZE` 個（預設 1）一批，**每批各自跑完整的
writer → 編譯測試 → 覆蓋率 → review 迴圈**：新的 writer / reviewer session、自己的 `UT_MAX_ITER` 輪數。
預檢與修復在所有批次之前只做一次。

- **一批沒過不會拖垮其他批。** 沒通過的批次會撤回它對 `src/test` 的所有變更——新增的檔移走、改過的檔
  還原成原本的內容——嘗試的版本依 repo 相對路徑保留在 `runs/<repo>/<ts>/batch-NN-<類別>/rejected/`，
  清單在同目錄的 `rollback.md`。它留在建置輸出（`target/test-classes`）的東西也一併清掉：編譯與資源複製
  只會新增、不會刪除，撤回的測試編出來的 `.class` 還在的話，surefire 在下一批照樣會跑它，複製過去的
  `mockito-extensions` 開關也照樣生效。下一批因此從一個還編得過的模組開始，`src/test` 最後只留下通過所有
  gate 的測試。
- **中途按 Ctrl-C（或 crash）**：正在跑的那一批比照失敗批次撤回——它的測試還沒通過任何 gate。
  `summary.json` 的 `inProgress` 是被中斷的那一批，`notRun` 是還沒輪到的類別。
- **環境問題會提前停止。** agent 無法執行（spawn-error）、writer 改了測試範圍外的檔案（scope-violation，
  變更原樣保留給你檢視）、連續兩批以同一個 `writer-no-op` / `reviewer-unparseable` 結束、連續兩批的
  建置以同樣的原因失敗（去掉各批的類別名稱與數字後一字不差，例如 surefire 的 JVM 當掉——問題在模組、
  相依或環境，不在這兩個類別；覆蓋率與 review 的失敗是各類別自己的事，不算），或撤回時有檔案放不回去
  （多半是防毒軟體或 IDE 鎖住了檔案）——後面的批次也會遇到同樣的事，summary 會列出沒執行的類別。
- **結果**：`summary.json` 的 `batches` 逐批列出結果、每輪卡在哪個 gate（`funnel`）與 artifacts 目錄，
  `notRun` 是沒執行的類別，`attention` 是 run 留在原地、要你先處理的東西（沒還原的範圍外變更、放不回去的
  檔案）。`stopReason`：`gates-passed`、`some-batches-failed`、`stopped:<原因>`（提前停止且還有類別沒跑；
  原因是 `runner-spawn-error`、`scope-violation`、`writer-no-op`、`reviewer-unparseable`、
  `repeated-build-failure`、`rollback-failed`）、`interrupted:<signal>`、`crash`。
  全部通過才 exit 0，否則 exit 2。每一批跑完就更新一次 `batches.json`。
- **建置次數隨批數增加。** 每批至少一次建置；`UT_TEST_SCOPE=generated` 時每批通過前還會做一次完整模組
  驗收。建置很慢的模組建議搭配 `UT_TEST_SCOPE=generated`，或把 `UT_BATCH_SIZE` 調大一些來分攤。
- 只有一個類別（或 `UT_BATCH_SIZE` 不小於類別數）時就是單一一批，行為與 artifacts 版面都和以前一樣：
  沒通過時測試檔留在原處，由你決定怎麼處理。

## Troubleshooting

先跑 `testgen doctor <目標> --smoke`，多數問題會直接指出修法。常見情形如下。

- **writer 一直寫專案沒有的東西（JUnit 5、`MockitoExtension`、`mockStatic`、`var`），每輪編不過。**
  loop 會量目標模組的測試相依並寫進 prompt：優先讀預檢留下的 surefire 報告裡的測試 classpath
  （實際跑過的，最準），模組還沒有任何測試跑過時退回讀 pom（連同 Spring Boot 版本推斷，prompt 會
  標明是推斷）；writer 的測試第一次跑過之後，後面的 prompt 就改用實際 classpath。量到什麼在 log 的
  「測試相依：」那一行與 `project-facts.json`。只有 JUnit 4 的模組會被告知用 JUnit 4 的寫法，
  沒有 inline mock maker 時會被告知不能 mock static / final。surefire 2.21 以前的報告不記錄測試
  classpath，這時一律讀 pom；pom 繼承 repo 外的公司 parent 時，parent 帶了什麼量不到，loop 不斷定框架，
  改看既有測試用哪一個。量到的不對時，看 log 那一行寫的來源——`pom 宣告（未經建置確認）` 表示還沒有
  可採用的 surefire 報告。
- **`unmappable character (0x..) for encoding MS950`，或 log 出現「原始碼編碼：MS950」。** javac 以
  MS950 讀原始碼：pom 這樣設定，或 pom 沒設 `project.build.sourceEncoding`、在繁中 Windows 上用 JDK 17
  以前的版本建置（平台編碼就是 MS950）。在這種模組裡，writer 以 UTF-8 寫的中文依工具鏈不是讓模組編不過，
  就是編得過但字串常值成了亂碼（maven-compiler-plugin 3.13 + JDK 21 印出 unmappable character 後照樣
  BUILD SUCCESS），斷言中文訊息的測試因此永遠對不上；而 agent 的編輯工具以 UTF-8 讀寫，改一個 MS950 的
  既有測試檔會把裡面的中文默默換成別的字。loop 會處理兩件事：
  writer 留下的非 ASCII 字元轉成 `\uXXXX`（字串值不變、編得過），以 MS950 存且含中文的既有測試檔不讓
  writer 改——被改到就照原 bytes 還原並判該輪失敗，writer 改在新的測試類別（`<類別>AdditionalTest.java`）
  補測試。如果專案的原始碼其實是 UTF-8、只是 pom 沒設，在 pom 加上
  `<project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>` 才是根本解法。

- **doctor 說 agent 找不到。** 回工具 clone 目錄執行 `npm run setup`。
- **中途中止，說「writer 修改了測試範圍以外的檔案」。** writer 動了 production code、
  `pom.xml` 或其他模組（常見於它想幫目標類別「順手」加 constructor 好注入 mock）。loop 不會
  替你還原——沒有內容快照，而 `git checkout` 會連你自己未提交的改動一起清掉——所以停下來
  交給你：`git diff` 看一眼，還原後重跑。檔案清單在 `runs/<repo>/<ts>/iter-N/scope-violations.txt`。
  如果 production code 真的需要那個改動才可測（抽 constructor、注入 `Clock`），那是人的工作，
  先改完再跑。
- **啟動先跑了一段「修復既有紅燈」。** 預檢基準抓到模組本來就編不過或測不過。build gate
  跑的是 `mvn -pl <module> -am test`，整個模組**連同上游模組**的測試原始碼都要編得過，所以一個
  本工具沒碰過的壞檔就能擋掉每一輪。預設會先用同一個 writer 修這些檔（範圍 guard 與防掏空
  guard 全程有效），修到綠才開始產生新測試；修好的檔案會列在 log 與 `repair-summary.md`，
  **那是 writer 對別人測試的改動，commit 前一定要看 diff**。
- **中止，說「紅燈全部落在 writer 的可寫範圍之外」。** 預檢抓到的紅燈不在
  `<目標模組>/src/test` 裡——多模組時最常見的是上游模組（`common`、`core`）的測試壞掉，也可能是
  production code 或 `pom.xml`。writer 對這些檔案沒有寫入權，進修復迴圈只會用光輪數才發現寫不了，
  所以預檢就直接中止並逐一點名是哪個模組的哪個類別。人工修好再跑；`UT_ALLOW_DIRTY_BASELINE=1`
  可硬跑，但那些紅燈每一輪都還在。
- **中止，說「修復 N 輪後模組仍無法通過建置」。** 修復迴圈放棄了。最常見的根因不在測試檔而在
  建置設定——例如 `pom.xml` 沒讓 Lombok 的 annotation processor 在 test scope 生效，`@Slf4j`
  產不出 `log` 欄位——writer 無權改 pom，只能繞。人工修好再跑最省事；`UT_ALLOW_DIRTY_BASELINE=1`
  可硬跑（紅燈標記為 pre-existing，但 build gate 每輪仍紅）；`UT_REPAIR_BASELINE=0` 關掉修復
  直接中止。每一輪修復的 prompt / build log 在 `runs/<repo>/<ts>/repair-N/`。
- **某一輪說「既有測試被刪減」並直接進下一輪。** writer 在既有測試檔裡拿掉了 `@Test` 方法或
  斷言，或加了讓測試略過的標記（`@Disabled`、JUnit 4 的 `@Ignore`、TestNG 的 `enabled = false`、
  `assumeTrue(false)` 之類的 assumption）。對 build gate 來說「修好」和「刪掉」都是綠燈，所以 loop 量數量：
  少了就判該輪 FAIL、把前後數字餵回去要它補回來。改寫、改名都可以，數量不能少。確定是合理
  整併就設 `UT_ALLOW_TEST_SHRINK=1`。
- **smoke FAIL，或 writer 沒動靜。** provider 未設定，或 model 欄位為空。見「Provider 與
  模型設定」。
- **writer 有跑但沒寫檔。** 非互動模式下 permission 被擋。常見根因是 global
  `~/.config/opencode/opencode.json` 設了 `"permission": {"edit": "ask"}`，蓋過 agent 只對
  `src/test/**` 放行的 edit 權限。首選解法是在目標 repo 根放一份 project 級 `opencode.json`，內容
  `{"permission": {"edit": {"*": "deny", "src/test/**": "allow", "**/src/test/**": "allow"}}}`，
  只影響該 repo，範圍與 agent 定義相同。**不要**設成 `"edit": "allow"`——那會把 pom.xml 與
  production code 也開放給 writer，改下去就是 scope-violation 中止。最後手段是
  `UT_OC_SKIP_PERMS=1`；writer 的 bash 與 web 本來就關閉，越界的寫入仍會被範圍快照擋下並中止。
- **writer 探索完就結束，或寫大檔寫到一半中斷。** session 固定開銷太大：plugin 與 MCP 工具
  schema 可吃掉 20k 以上 tokens，模型 context 不夠用。在目標 repo 的 project `opencode.json`
  調高該模型 context。Ollama 範例：
  `{"provider":{"ollama":{"models":{"<model>":{"options":{"num_ctx":65536}}}}}}`。
  另一半在失敗報告：每輪餵回的報告有 `UT_MAX_FEEDBACK_CHARS` 上限（預設 12000 字元），
  且只保留 `[ERROR]` 行與 javac 的接續行，maven 的 Help/stack trace 樣板不會進 prompt。
  context 仍然吃緊時可再調小。注意跨輪 context 本來就不累積——每輪都是全新 session，
  只帶上一輪的報告，所以 summary 的「writer output tokens 合計」是各輪輸出的加總，
  不是單輪 context 佔用。
- **覆蓋率永遠略過，或說「報告比本輪建置還舊」。** 模組沒綁 JaCoCo，或 report goal 綁在
  `verify` 而非 `test`——`mvn test` 不會重新產生 `jacoco.xml`，gate 讀到的是上次留下的檔案，
  所以 loop 只信本輪建置之後才寫出的報告。加上 jacoco-maven-plugin，將 prepare-agent 與 report
  綁到 test phase；或設 `UT_MAVEN_ARGS="jacoco:report"`。要強制擋關則設 `UT_STRICT_COV=1`。
  另外 build gate 固定帶 `-Djacoco.append=false`：JaCoCo agent 預設會把 exec 資料**累加**進
  `target/jacoco.exec`，你自己跑過的 `mvn test` 或上一次 testgen 的覆蓋率會被算進這一輪，
  空測試也能「過」coverage gate。
- **review gate 一直 REJECT，訊息含「tool calls = 0」。** reviewer 沒讀任何檔案就輸出判決，
  fail-closed 防的是捏造的假 verdict。改用更強的 `UT_REVIEWER_MODEL`。確定要放行設
  `UT_REVIEWER_MUST_READ=0`，或暫時 `UT_SKIP_REVIEW=1` 只跑 hard gate。
- **trace 裡 glob 與 grep 一律 `[error]`。** 缺 ripgrep。見下一節。
- **（api runner）log 出現「N 秒後重試」。** 端點回了 429 / 5xx 或連線中斷，runner 正在等它恢復，
  最多 `UT_AGENT_RETRY_WINDOW_MS`（預設 3 分鐘）。端點**從未回應過**時只快速試 3 次就以 spawn-error
  中止——那幾乎都是 `UT_API_BASE_URL`、proxy 或金鑰設錯，實際的 HTTP 錯誤在 `[FAIL]` 那一行。
- **（api runner）log 出現「context 已滿」。** 對話超過模型的 context（vLLM 的 `--max-model-len`）。
  runner 會先省略較早的工具結果、再降低 `max_tokens` 後重送；頻繁出現代表 context 太小，調大伺服器
  context，或調小 `UT_API_MAX_TOKENS`、`UT_API_MAX_TOOL_RESULT_CHARS`。
- **（api runner）log 出現「回覆超過輸出上限被截斷」。** 模型一次輸出超過 `max_tokens`（通常是一口氣
  write_file 整個測試類別）；runner 會要它拆成小步驟重送。頻繁出現就調大 `UT_API_MAX_TOKENS`。
- **要跑很久、想丟到背景再登出。** `nohup bin/testgen <目標> > testgen.log 2>&1 &` 可以安全登出——stdin
  不是終端機時，斷線的 SIGHUP 只會記一行 `[WARN]`，run 照常進行。互動式終端直接關掉則會像 Ctrl-C 一樣
  收掉整棵程序樹並寫出 `summary.json`（`interrupted:SIGHUP`）。也可以用 tmux。
- **writer 逾時被中止。** 預設 15 分鐘對 dense 模型太短，見「Provider 與模型設定」的
  `UT_AGENT_TIMEOUT_MS=1500000` 建議。逾時會終止整棵 opencode 程序樹（Windows 走
  `taskkill /T /F`），已產出的部分仍會交給 gate 判斷，不會靜默當成通過。
- **啟動就 FATAL agent 權限。** startup guard 攔到 agent 權限被改壞。這是刻意設計，照訊息把
  frontmatter 修回：writer 禁 bash、reviewer 全唯讀。
- **看不到即時進度。** opencode 版本太舊，不支援 `--format json`。設 `UT_OPENCODE_JSON=0`
  退回整段輸出，但會失去即時 tracing。
- **想為某個 repo 客製 reviewer。** 把 agent .md 放進該 repo 的 `.opencode/agent/`。repo 內
  定義優先於 global。

## 離線環境需先備妥 ripgrep

opencode 的 glob 與 grep 兩個內建工具都由 ripgrep 實作。writer 靠它找目標類別與既有測試，
reviewer 靠它蒐證，缺了會讓兩個工具在 trace 裡一律回 `[error]`，本工具無從代勞。

opencode 找 ripgrep 的順序是：PATH 上的 `rg`（Windows 為 `rg.exe`）→ 自己的 cache bin →
都沒有就從 GitHub Releases 下載。第三步在封閉網路必然失敗，所以要在跑 `testgen` 前先讓
前兩步之一命中。cache bin 位置在各平台都是家目錄下的 `.cache`（opencode 用 XDG 慣例，
Windows 也不例外）：

| 平台 | 放置路徑 |
| --- | --- |
| Windows | `%USERPROFILE%\.cache\opencode\bin\rg.exe` |
| macOS / Linux | `~/.cache/opencode/bin/rg`（需 `chmod +x`） |

取得 `rg` 的方式，擇一即可：

- 裝過 VS Code 的話它自帶一份，直接複製即可，免下載。Windows 路徑為
  `<VS Code>\resources\app\node_modules\@vscode\ripgrep\bin\rg.exe`。
- 用套件管理器安裝並確認在 PATH 上：`winget install BurntSushi.ripgrep.MSVC`、
  `brew install ripgrep`、`apt install ripgrep`。
- 從別台有網路的機器抓 [ripgrep releases](https://github.com/BurntSushi/ripgrep/releases)
  的對應壓縮檔，把裡面的 `rg` 執行檔拷進上表路徑。

驗證：`opencode debug rg files --glob "**/*.java" --limit 5`。列得出檔案就代表 ripgrep
已就緒。

## 更新工具

```bash
cd <clone> && git pull && npm install && npm run setup
```

變更內容見 `CHANGELOG.md`。每次執行的 banner 與 `params.json` 都帶工具版本戳記，回報問題時
請一併附上。
