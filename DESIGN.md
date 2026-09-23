# testgen pipeline — Design

## 目標與範圍
為 Java repo（含多模組 Maven）的指定類別自動產生符合團隊品質標準的 JUnit 5
單元測試。maker-checker loop：LLM 寫與審，確定性程式碼掌握全部驗證與迭代決策。
部署型態為中央 clone：工具 clone 一份，對任意 Java repo 執行。

## 架構總覽（控制流）

```
npx tsx <工具 clone>/loop.ts <目標>        （於目標 Java repo 根執行；或 bin/testgen wrapper）
        │
        ▼
loop.ts -- 參數驗證 / 模組偵測 / rubric 載入 / startup guard / runs/ 建立
        │  既有測試偵測（findExistingTests）→ 寫進 generate prompt
        │  專案慣例掃描（scanTestConventions）→ 可見性結論寫進 prompt
        │  預檢基準（runBaseline，與 build gate 同一道指令）
        │    └ 紅燈 → repairBaseline：同一 writer + 同樣 guard + 同一指令，修到綠才往下；修不好才停
        │  測試相依量測（measureTestStack：surefire classpath，退回 pom）與原始碼編碼量測
        │    （measureSourceEncoding：pom，退回 build log 的平台編碼）→ 寫進 prompt
        │  資料夾目標 → 依 UT_BATCH_SIZE 分批，每批一個完整的 orchestrate；
        │    沒通過的批次撤回它對 src/test 的變更（保留在 batch-NN/rejected/）
        │
orchestrator.ts  ←-- 唯一 loop controller（確定性）
        │  每輪迭代：
        │  1) Writer agent（ut-writer：可寫檔、禁 bash/web）產生/修正測試
        │  2) Hard gate：script 跑 mvn -pl <module> -am test → 全綠才過
        │  3) Hard gate：解析 <module>/target JaCoCo XML → line/branch 達門檻
        │  4) Review gate：唯讀 ut-reviewer 依注入的 rubric 輸出 JSON 判決
        │     通過 = blockers 空 且 六維（0-10）達門檻（advisories 不擋關）；
        │     weighted_score/grade 由 pipeline 依 skill 權重確定性計算（P1/P3）
        │  5) 未過 → 失敗報告（blockers + 低分維度）餵回步驟 1；全過 → 結束
        ▼
   通過 or 達到 UT_MAX_ITER；每輪 artifacts 落盤 runs/<repo 名>/<ts>/iter-N/
```

關鍵：**驗證不交給 LLM 自述**。建置、測試、覆蓋率由腳本以 child process 實際
執行並解析原始報告；這是 loop engineering 能收斂的前提。

## 設計原則（8 條）

1. **單一 orchestrator**：迭代控制流 100% 在 TS loop，LLM 永不掌握重試/停止決策。
   （否則 loop 收斂性交給模型心情。）
2. **驗證權不外包**：writer 無 bash；所有 hard gate 由 script 執行並解析原始輸出。
   （writer 能自跑測試 = 能自述通過 = gate 被架空。）同理 writer 的寫入範圍也由 script
   assert：每輪前後對 repo 拍快照，`src/test` 以外有變動即中止——例外只有 loop 自己的 runs
   目錄，與別的程序寫的輸出（被 git ignore、不在 `src/` 底下、不是建置檔、且形狀是輸出：
   `logs/`、`out/`、`bin/`、`*.log`、本機 DB 檔等；只印 WARN）。後者是 allowlist 而不是「被 ignore
   就豁免」：Spring Boot 從模組根載入 `./config/application.yml`，被 ignore 的設定檔一樣是測試會讀的
   東西。（執行中的應用程式寫 `logs/app.log`、IDE 自己建置到 `out/`，先前都會在隨機的輪次以
   scope-violation 中止。）（writer 能改 production
   code = 能把測試「改到會過」= build gate 被架空。這條先前只靠 prompt 勸導，實測 writer
   加一個 method 進 production 後 loop 照樣 gates-passed。）同樣由 script 守的還有既有測試
   的數量：`@Test` 數、斷言數不得減少、略過標記（`@Disabled`、`@Ignore`、TestNG `enabled = false`、
   assumption——`assumeTrue(false)` 讓失敗的測試以「略過」結束，數量卻一個不少）不得增加，否則該輪 FAIL 餵回。（writer 能
   刪測試 = 能把失敗「刪到會過」= 同一個洞的另一面。有了這兩道 assert，「修復既有紅燈」才敢
   交給 writer 做——先前否決的理由是修好與掏空在 build gate 眼裡一模一樣，現在分得出來。）
3. **Injection over discovery**：standards / rubric 由 loop 讀檔注入 prompt；
   agent .md body 只放不變的角色契約。（skill 機制是 description-triggered
   的機率性載入，自動 loop 不能靠機率。）
4. **State in artifacts, not context**：每 phase 開全新 session，跨輪狀態只存在
   runs/ 檔案。（可重現、可審計、防 context drift。）
5. **SSOT 三分**：standards（writer 契約）、skill rubric（reviewer 評分細則）、
   config.ts（門檻參數），互不重複。writer 只拿到六維「名稱＋一句話」，
   不拿評分細則（防 teaching-to-the-test）。
6. **Runtime adapter**：核心零 SDK import；AgentRunner interface 隔離，
   換 runtime = 換一個 runner 檔（runners/opencode.ts ↔ runners/api.ts ↔ runners/qwen.ts）。
   api runner 是這條原則的直接受益者：整個 tool loop（工具定義、tool_call 解析、結果回送、
   回合與逾時預算、重試）約三百行，全部在 runners/ 內，核心一行未動。它同時把原則 2 從
   「設定檔＋guard assert」變成結構：沒定義 bash 工具就沒有 bash 可拿。
7. **可觀測性**：每輪 artifacts 落盤；startup guard 把「文件契約」變成
   「機器 assert」——writer 拿到 bash 或 reviewer 可寫檔時第一秒炸。
8. **範圍與慣例用量的，不用猜的**：build gate 的解析度是整個模組（`-am` 之下還含上游模組），
   writer 的職責卻只有目標類別。這個落差必須由確定性步驟填平，不能靠 prompt 措辭：
   預檢基準先量出「介入前就存在的紅燈」，既有測試偵測先量出「已經有哪些測試檔」，
   慣例掃描先量出「既有測試怎麼寫的」，三者都在第一輪之前完成並寫進 prompt。
   （否則 writer 會拿迭代次數去修別人的編譯錯誤、在既有測試旁邊再開一個
   `<Class>UnitTest.java`、或用錯可見性讓整個模組編不過。）
   測試相依與原始碼編碼同理：standards 描述的是一套 stack（JUnit 5、MockitoExtension、AssertJ），
   部門的 repo 跑的是好幾套。只有 JUnit 4 的模組拒絕每一個 JUnit 5 import，沒有 inline mock maker
   的 mockStatic 編得過卻在執行時失敗，MS950 模組裡的 UTF-8 中文不是讓模組編不過、就是讓字串常值編成
   亂碼（maven-compiler-plugin 3.13 + JDK 21 印出 unmappable character 後照樣 BUILD SUCCESS）——每一種
   都是 writer 一輪一輪才撞到的失敗，而它照著改的 prompt 寫的正是失敗的寫法。模組其實早就知道答案：
   surefire 在每次執行的報告裡記錄了測試 classpath，Maven 在每次建置的 log 裡寫了它用的平台編碼。
   所以量它、寫進 prompt；量不到的（模組還沒跑過測試時的 pom 推斷）明說是推斷。編碼另有一道
   確定性的護欄，因為 prompt 攔不住工具：agent 的編輯工具以 UTF-8 讀寫，改一個 MS950 既有測試檔會把
   裡面的中文（包括字串常值）默默變成別的字——所以非 UTF-8 的檔案在 writer 前後比對、有變動一律照原
   bytes 還原並判該輪失敗；writer 自己留下的非 ASCII 字元則轉成 `\uXXXX`（javac 先處理 Unicode 跳脫，
   字串值不變）。
   回饋同理有預算：報告是抽取錯誤而非 tail 整份 log，並由 orchestrator 統一 clamp。

## SSOT 對照表

| 內容 | 位置 | 消費者 |
| --- | --- | --- |
| 測試撰寫標準 | <工具 clone>/standards/java-ut-standards.md | writer prompt（loop 注入） |
| 評分 rubric | skill 的 references/rubric.md（UT_SKILL_DIR → 目標 repo .opencode/.claude → 工具內建） | reviewer prompt（loop 注入；SKILL.md 不注入） |
| 門檻與參數 | config.ts（env 可覆蓋） | gates / verdict |
| 角色契約與權限 | 目標 repo .opencode/agent/ 優先，否則 ~/.config/opencode/agent/（npm run setup 安裝） | opencode runtime + startup guard |

## Agent 權限矩陣

| tool | ut-writer | ut-reviewer | 理由 |
| --- | --- | --- | --- |
| read/glob/grep | [OK] | [OK] | 兩者都要讀原始碼/測試 |
| write/edit | [OK] | [FAIL] | checker 能改 code 就會「順手修好再打高分」，污染 signal |
| bash | [FAIL] | [FAIL] | 驗證權在 loop（原則 2） |
| webfetch | [FAIL] | [FAIL] | 無需求、縮小面 |
| skill | [FAIL] | 互動模式限 test-quality-evaluator | pipeline 走注入；skill 只供人工 debug |
| task | [FAIL] | [FAIL] | subagent 拿到的是 opencode 預設工具組（含 bash），等於繞過上面每一列；runner 只看得到 `[tool] task [completed]`。guard 強制 `tools.task: false` |

opencode 的 `permission` 另外收斂兩件事（guard 不檢查這一段，只影響 opencode runtime）：

- **writer 的 `edit` 只允許 `src/test/**`**。其餘路徑 `deny`：模型想改 `pom.xml` 加依賴、或替目標類別
  加 constructor 時拿到的是工具錯誤，session 繼續；先前是 `edit: allow`，改下去之後 snapshot guard
  判 scope-violation 中止整個 run。snapshot guard 仍是 assert，這一層只是讓它很少需要開火——與
  api runner 的 `write_file` 拒寫範圍外路徑同一個道理。
- **`external_directory: deny`（兩個 agent）**。opencode 預設是 `ask`，而 `opencode run` 非互動時會
  自動拒絕 ask，且**拒絕會結束整個 session**：模型只要讀一次 `~/.m2` 裡的依賴原始碼或 stack trace
  上的絕對路徑，writer 就空手結束、下一輪 writer-no-op。`deny` 讓模型拿到工具錯誤後繼續。

模型建議：writer 走本地 Qwen3-coder（便宜狂迭代）、reviewer 走 Claude——
cross-model 降低 self-agreement bias，且弱模型 follow 長 rubric 穩定度差。

## Phase 計畫

- [OK] Phase 0：monolith 拆檔、AgentRunner interface、artifacts、guard
- [OK] Phase 1：review gate 換血（六維 + blockers/advisories + fail-closed + rubric 注入）
- [OK] Phase 2：OpencodeRunner（spawn + JSONL）、cross-model、qwen 降為備援
- ⬜ Phase 3：mutation gate（pitest 限縮 targetClasses，門檻 60–70 起，
  掛在 coverage 之後、review 之前）——tautological test 的真 oracle

## 已採納：dirty baseline 下，gate 扣除既有失敗（2026-09-16，使用者決策）

**現狀是一個到不了的逃生口。** `UT_ALLOW_DIRTY_BASELINE=1` 文件上寫「帶著紅燈續跑」，
但它實際上只把既有紅燈寫進 prompt——`preExisting` 唯一的去處是 `buildFixPrompt`，
build gate 本身仍是整個模組的 pass/fail。那些既有失敗每輪照樣讓 gate 紅，所以這個旗標
**永遠到不了綠燈**：測試會產生、會落地，run 必定以 exit 2 結束。它看起來是逃生口，
實際上只是把同一個失敗延後到最後一輪。實地案例：一個模組有三個既有 service 測試紅著，
writer 無論產得多好都不可能讓 gate 轉綠。

**提案。** 預檢基準記下「writer 介入前就在失敗的測試識別」集合 P。設了
`UT_ALLOW_DIRTY_BASELINE=1` 時，build gate 的通過條件改為：

> 編譯成功 **且** 本輪的失敗識別集合 ⊆ P

**為什麼這不是已否決的 `-Dtest` 限縮換皮。** 那條否決的理由是「gate 對『新測試破壞既有
測試』完全失明」——因為 `-Dtest` 讓那些測試**根本不執行**，沒有結果可言。扣除不同：
所有測試照跑，只是把結果跟基準比對。writer 打壞任何一個既有測試，都會產生一個不在 P 裡的
識別，gate 照樣紅。差別是「不看」與「看了再比」，而 gate 的承諾靠的是後者。

**必要的護欄**（少任何一條，這個提案就該被否決）：
- **編譯錯誤永不扣除。** 編不過就沒有測試跑過，任何比對都失去意義。
- **識別到方法層級，不到類別層級。** 一個類別裡 `a` 本來就紅、`b` 是這輪被打壞的——
  用類別當識別會把 `b` 一起放行，等於用 P 當免死金牌。
- **`@ParameterizedTest` 的識別要含案例標識。** 否則同方法的既有失敗會遮住一個新失敗的案例。
- **預設不變。** 沒設旗標時維持現在的 fail-closed 全綠要求，這個機制完全不生效。
- **與 `UT_SKIP_BASELINE=1` 互斥。** 沒有基準就沒有 P，此時應直接報錯，不得靜默退回全綠要求
  ——靜默退回會讓操作者以為扣除生效了。
- **扣除了什麼必須寫進 `summary.json`**（原則 7）。一個人要看得出這次 run 容忍了哪些失敗，
  否則這個綠燈無法被審計，也就不值得信任。

**放棄了什麼，講清楚。** gate 的承諾從「模組是綠的」降為「模組沒有比 writer 介入前更糟」。
這是真的降級。值不值得取決於一件事：對一個既有測試就已經紅的模組，前者根本達不到——
所以實際的選擇不是「強保證 vs 弱保證」，而是「一個達不到的保證 vs 一個達得到且可驗證的保證」。
模組本來就是綠的時候，兩者完全等價（P 是空集合）。

**狀態：已實作。** 六道護欄逐條落地，另補上一條實作時才看清楚的第七道：
- 扣除判定是純函式 `subtractTolerated`（`gates/build.ts`），識別由 `failingTestIds` 從
  surefire XML 的 `name` 屬性取得——`@ParameterizedTest` 的案例標識與 `@Nested` 的內部類別
  本來就在那個屬性裡，不必另外拼。
- **第七道護欄（實作時補的）**：紅燈但**定位不到任何失敗測試**時不得扣除。空集合是任何集合的
  子集，`∅ ⊆ P` 恆真——少了這條，依賴解析失敗、plugin 掛掉、或關閉了 XML 報告的建置都會被
  當成「沒有變糟」直接放行。這是提案時沒想到的洞。
- gate 的失敗報告會**點名哪些是本輪新造成的**，與既有失敗分開陳述；沒有這個，writer 面對的
  是一堆被要求忽略的失敗混著一個必須修的。

itest 三個情境如承諾：`loop-dirty-tolerated`（既有失敗原樣通過，exit 0）、
`loop-dirty-new-failure-blocked`（新失敗被擋）、
`loop-dirty-same-class-new-method-blocked`（同類別另一個方法失敗被擋），
外加 `loop-skip-baseline-conflicts-dirty`（互斥）。

mutation 實測：把識別退回類別層級，第三個情境**從 exit 2 變成 exit 0**——writer 弄壞的測試
直接放行，正是這道護欄存在的理由。拿掉編譯錯誤護欄與第七道護欄，各自對應的 selftest 轉紅。

## 已採納：資料夾目標分批（2026-09-23）

**問題。** 目標是資料夾時，所有類別交給同一個 `orchestrate()`：一個 writer session 寫全部的測試、
一個 reviewer session 讀全部的測試、共用一份 `UT_MAX_ITER`。類別一多，session 就超出模型的 context
與 `UT_AGENT_TIMEOUT_MS`——README 因此建議「一次只鎖定單一 class」，等於把這個工具最自然的用法
（對整個 package 執行）列為已知會失敗；而且只要有一個類別修不綠，整個 run 就以 stuck / max-iterations
結束，其他類別的進度一起停在半路。

**作法。** `loop.ts` 依路徑排序後每 `UT_BATCH_SIZE`（預設 1）個類別一批，每批跑一次完整的
`orchestrate()`：新的 session、自己的輪數、自己的 artifacts 目錄（`batch-NN-<類別>/`）。預檢與修復
在所有批次之前只做一次。控制流仍只在 `loop.ts` + `orchestrator.ts`（硬規則 1）。

**隔離。** 沒通過的批次會撤回它對 `src/test` 的**所有**變更——新增的檔移走、改過的檔照批次開始時的
內容還原、刪掉的放回——嘗試的版本依 repo 相對路徑保留在該批的 `rejected/`。比對用內容不用 mtime。
不撤回的話，一個留下編譯錯誤的批次會讓後面每一批的 build gate 都紅，而那不是後面那些 writer 的錯。
結果是 `src/test` 最後只留下通過所有 gate 的測試。

**提前停止。** 三種情況不跑後面的批次，因為它們不屬於某一批：agent 無法執行（spawn-error）、writer 改了
測試範圍外的檔案（scope-violation——那批**不撤回**，變更原樣交給人檢視，否則後面每一批都建置在被改過的
production code 上）、連續兩批以同一個 `writer-no-op` 或 `reviewer-unparseable` 結束（模型端或權限的問題，
每批重新發現一次只是空轉）。

**不變的部分。** 只有一批時（單一類別，或 `UT_BATCH_SIZE` 不小於類別數）走原本的路徑，artifacts
版面、summary 形狀、失敗時測試檔留在原處，都與以前相同。分批不改 build gate 的承諾：每批仍是完整
模組建置（或 `UT_TEST_SCOPE=generated` 時每批通過前的完整驗收）。代價是建置次數隨批數增加，README 說明。

## 已否決方案（防止重新提案）

- **LLM orchestrator / Task tool delegation**：雙重 orchestration 增加不確定性；
  且 custom agent 的 task tool 權限有已知問題。控制流留在 TS。
- **靠 skill discovery 觸發 rubric**：機率性載入，某輪沒觸發 = rubric 靜默消失。
- **把 SKILL.md 全文注入 reviewer**：那是批次稽核 workflow（六輸入、concurrency、
  environment probe），對單輪 gate 是錯誤指令；只注入評分細則。
- **checker 可寫檔**：見權限矩陣。
- **以 `-Dtest` 限縮換掉完整模組驗證**（不是延後，是取消）：build gate 的承諾有兩半，
  「新測試會過」與「沒打壞別人」，後者只有完整重跑證明得了。實測過一個新測試污染共享靜態狀態：
  限縮期間三個 gate 全過，完整重跑才抓到。`UT_TEST_SCOPE=generated` 因此是**延後**到成功前補跑
  一次，不是省略。
- **standards 一律規定測試類別為 `public`**：JUnit 5 不要求，Sonar S5786 反而會標記
  「JUnit5 test classes should not be public」——寫死任一邊都會在某類專案上出錯。
  改由 `libs/conventions.ts` 掃描該 repo 後給結論。
- **`@Slf4j` 失效時退回明確的 `Logger` 宣告**：那是把噪音搬進測試碼。單元測試不需要
  logging，斷言就是輸出；standards 直接禁止測試碼 logging，問題根除而非繞道。
- **用 `-Dtest=<GeneratedTest>` 把 build gate 限縮到本次產生的測試**：`-Dtest` 只限制
  surefire「執行」哪些測試，不限制 `test-compile` 編哪些檔——既有壞檔照樣擋死整輪，
  解不了它想解的問題；而且會讓 gate 對「新測試破壞既有測試」完全失明。改採預檢基準：
  gate 維持全模組解析度，落差由「介入前的紅燈快照」在 prompt 層標記。
  （最後這句正由上面「dirty baseline 下，gate 扣除既有失敗」提案修訂——把快照從 prompt 層
  延伸到 gate 層。本條的核心「不得用不執行測試的方式限縮 gate」不受影響。）
- **binary 零缺陷 review**：LLM judge 幾乎不回空 issues，會震盪到 MAX_ITER 燒完。
- **full-SOLID 拆分（v5，已回退）**：Gate 介面 + BuildToolStrategy + 全面 DI
  對這個規模（~1000 行、單用途內部工具）是 overdesign——20+ 檔案的間接層
  換不到等值的可維護性。Phase 3 加 pitest 在扁平架構下也只是
  gates/mutation.ts 一個函式 + orchestrator 一個呼叫點，成本可接受。
  重新提案 SOLID 化的門檻：出現第三個 build tool、或 gate 數量 >= 5。
- ~~**global 安裝 pipeline/skill 供 loop 消費**~~：**superseded（2026-07-10，使用者決策）**——
  改採中央 clone + global agents（部門多 repo 下，per-repo vendoring 的維護成本高於
  per-repo 可重現性收益）。原否決理由以三項緩解：每次執行寫入工具版本戳記
  （banner + params.json）、doctor preflight、目標 repo `.opencode/` 同名定義仍優先
  （可專案化覆寫）。
