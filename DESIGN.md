# testgen pipeline — Design

## 目標與範圍
為 Java repo（含多模組 Maven）的指定類別自動產生符合團隊品質標準的 JUnit 5
單元測試。maker-checker loop：LLM 寫與審，確定性程式碼掌握全部驗證與迭代決策。

## 架構總覽（控制流）

```
npx tsx tools/testgen/loop.ts <目標>        （或由 opencode 自訂指令包一層 UX）
        │
        ▼
loop.ts -- 參數驗證 / 模組偵測 / rubric 載入 / startup guard / runs/ 建立
        │
core/orchestrator.ts  ←-- 唯一 loop controller（確定性）
        │  每輪迭代：
        │  1) Writer agent（ut-writer：可寫檔、禁 bash/web）產生/修正測試
        │  2) Hard gate：script 跑 mvn -pl <module> -am test → 全綠才過
        │  3) Hard gate：解析 <module>/target JaCoCo XML → line/branch 達門檻
        │  4) Review gate：唯讀 ut-reviewer 依注入的 rubric 輸出 JSON 判決
        │     通過 = blockers 空 且 六維（0-10）達門檻（advisories 不擋關）；
        │     weighted_score/grade 由 pipeline 依 skill 權重確定性計算（P1/P3）
        │  5) 未過 → 失敗報告（blockers + 低分維度）餵回步驟 1；全過 → 結束
        ▼
   通過 or 達到 UT_MAX_ITER；每輪 artifacts 落盤 runs/<ts>/iter-N/
```

關鍵：**驗證不交給 LLM 自述**。建置、測試、覆蓋率由腳本以 child process 實際
執行並解析原始報告；這是 loop engineering 能收斂的前提。

## 設計原則（7 條）

1. **單一 orchestrator**：迭代控制流 100% 在 TS loop，LLM 永不掌握重試/停止決策。
   （否則 loop 收斂性交給模型心情。）
2. **驗證權不外包**：writer 無 bash；所有 hard gate 由 script 執行並解析原始輸出。
   （writer 能自跑測試 = 能自述通過 = gate 被架空。）
3. **Injection over discovery**：standards / rubric 由 loop 讀檔注入 prompt；
   agent .md body 只放不變的角色契約。（skill 機制是 description-triggered
   的機率性載入，自動 loop 不能靠機率。）
4. **State in artifacts, not context**：每 phase 開全新 session，跨輪狀態只存在
   runs/ 檔案。（可重現、可審計、防 context drift。）
5. **SSOT 三分**：standards（writer 契約）、skill rubric（reviewer 評分細則）、
   config.ts（門檻參數），互不重複。writer 只拿到六維「名稱＋一句話」，
   不拿評分細則（防 teaching-to-the-test）。
6. **Runtime adapter**：核心零 SDK import；AgentRunner interface 隔離，
   換 runtime = 換一個 runner 檔（runners/opencode.ts ↔ runners/qwen.ts）。
7. **可觀測性**：每輪 artifacts 落盤；startup guard 把「文件契約」變成
   「機器 assert」——writer 拿到 bash 或 reviewer 可寫檔時第一秒炸。

## SSOT 對照表

| 內容 | 位置 | 消費者 |
| --- | --- | --- |
| 測試撰寫標準 | tools/testgen/standards/java-ut-standards.md | writer prompt（loop 注入） |
| 評分 rubric | skill 的 references/rubric.md（.opencode/skills → .claude/skills） | reviewer prompt（loop 注入；SKILL.md 不注入） |
| 門檻與參數 | tools/testgen/config.ts（env 可覆蓋） | gates / verdict |
| 角色契約與權限 | .opencode/agent/ut-{writer,reviewer}.md | opencode runtime + startup guard |

## Agent 權限矩陣

| tool | ut-writer | ut-reviewer | 理由 |
| --- | --- | --- | --- |
| read/glob/grep | [OK] | [OK] | 兩者都要讀原始碼/測試 |
| write/edit | [OK] | [FAIL] | checker 能改 code 就會「順手修好再打高分」，污染 signal |
| bash | [FAIL] | [FAIL] | 驗證權在 loop（原則 2） |
| webfetch | [FAIL] | [FAIL] | 無需求、縮小面 |
| skill | [FAIL] | 互動模式限 test-quality-evaluator | pipeline 走注入；skill 只供人工 debug |

模型建議：writer 走本地 Qwen3-coder（便宜狂迭代）、reviewer 走 Claude——
cross-model 降低 self-agreement bias，且弱模型 follow 長 rubric 穩定度差。

## Phase 計畫

- [OK] Phase 0：monolith 拆檔、AgentRunner interface、artifacts、guard
- [OK] Phase 1：review gate 換血（六維 + blockers/advisories + fail-closed + rubric 注入）
- [OK] Phase 2：OpencodeRunner（spawn + JSONL）、cross-model、qwen 降為備援
- ⬜ Phase 3：mutation gate（pitest 限縮 targetClasses，門檻 60–70 起，
  掛在 coverage 之後、review 之前）——tautological test 的真 oracle

## 已否決方案（防止重新提案）

- **LLM orchestrator / Task tool delegation**：雙重 orchestration 增加不確定性；
  且 custom agent 的 task tool 權限有已知問題。控制流留在 TS。
- **靠 skill discovery 觸發 rubric**：機率性載入，某輪沒觸發 = rubric 靜默消失。
- **把 SKILL.md 全文注入 reviewer**：那是批次稽核 workflow（六輸入、concurrency、
  environment probe），對單輪 gate 是錯誤指令；只注入評分細則。
- **checker 可寫檔**：見權限矩陣。
- **binary 零缺陷 review**：LLM judge 幾乎不回空 issues，會震盪到 MAX_ITER 燒完。
- **full-SOLID 拆分（v5，已回退）**：Gate 介面 + BuildToolStrategy + 全面 DI
  對這個規模（~1000 行、單用途內部工具）是 overdesign——20+ 檔案的間接層
  換不到等值的可維護性。Phase 3 加 pitest 在扁平架構下也只是
  gates/mutation.ts 一個函式 + orchestrator 一個呼叫點，成本可接受。
  重新提案 SOLID 化的門檻：出現第三個 build tool、或 gate 數量 >= 5。
- **global 安裝 pipeline/skill 供 loop 消費**：機器級隱性依賴，破壞可重現性。
  loop 依賴的一切跟 repo 綁死、commit、版本鎖定。
