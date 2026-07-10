# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 語言慣例

對話、思考、文檔預設**繁體中文**，技術名詞保留英文（沿用 AGENTS.md）。

## 這是什麼

`testgen` 是一個**中央工具 clone**：clone 一份，對部門任何 Java repo 執行
（在目標 repo 根執行 `npx tsx <clone>/loop.ts <目標>` 或 `bin/testgen`），不需要把工具放進
目標 repo。它對指定的 Java 類別執行「產生 → 編譯/測試 gate → 覆蓋率 gate →
品質審查 gate → 修正」的迭代迴圈，直到單元測試符合團隊標準。

agent 定義與評分 skill 由 `npm run setup` 安裝到 `~/.config/opencode/`；目標 repo
`.opencode/` 內的同名定義優先（可專案化覆寫）。standards 與預設 rubric 隨本 repo 版控；
每次執行寫入工具版本戳記（banner + `params.json`）。

核心設計是 **maker-checker loop**：控制流 100% 在 TypeScript，LLM 只負責「寫」（ut-writer）
與「審」（ut-reviewer），**驗證權不外包給模型**。編譯、測試、覆蓋率一律由 script 以 child
process 實際執行並解析原始報告——這是 loop 能收斂的前提。

完整 rationale 在 `DESIGN.md`；agent 操作規範在 `AGENTS.md`；使用/環境變數在 `README.md`。

## 常用指令

```bash
npm install
npm run check                          # tsc --noEmit + selftest
npm run setup                          # agents+skill → ~/.config/opencode/
# 在目標 Java repo 根執行：
npx tsx <clone>/scripts/doctor.ts [目標路徑] [--smoke]
npx tsx <clone>/loop.ts <目標路徑>
# 驗證 SDK 隔離（runners/ 以外不得 import SDK / spawn agent CLI）：
grep -rn "@qwen-code/sdk\|@opencode-ai" --include="*.ts" --exclude-dir=node_modules --exclude-dir=runners . && echo LEAK || echo CLEAN
```

沒有測試框架；`scripts/selftest.ts` 是手寫斷言的純函式自測（6 組 42 項檢查，`npm run check`
已包含在內）。改動 `libs/utils.ts`、`gates/review.ts`、`gates/coverage.ts` 等純邏輯後先跑它。
退出碼：pipeline 成功 0、失敗 2、致命錯誤 1（`die`）。

## 架構（大圖）

控制流只有兩個檔案，兩者並排於根目錄：

- **`loop.ts`** — entry point：參數驗證、模組偵測、rubric 載入、startup guard、版本戳記、
  建立 `runs/<repo 名>/<ts>/`。
- **`orchestrator.ts`** — 唯一的迭代 loop controller（deterministic，零 SDK import）。
  每輪四步，任一 hard gate FAIL 就把失敗報告餵回下一輪 writer：
  1. Writer agent 產生/修正測試（首輪 generate prompt，之後 fix prompt）
  2. Hard gate：`gates/build.ts` 跑 `mvn -pl <module> -am -DskipITs test`（多模組感知）
  3. Hard gate：`gates/coverage.ts` 解析該模組 `target/.../jacoco.xml`
  4. Review gate：唯讀 reviewer 依注入的 rubric 輸出 JSON 判決（`gates/review.ts`）

其餘目錄都是被這個 loop 呼叫的無狀態零件：`gates/`（build/coverage 實際執行並解析、
review 的 fail-closed 判決解析與門檻判定）、`prompts.ts`（單檔，writer/reviewer 參數化
prompt，注入 standards/rubric）、`runners/`（AgentRunner 實作）、`libs/`（型別、log、shell、
純函式 utils、guard、rubric loader、版本戳記）。

### 四個必須理解的機制

1. **驗證權在 loop，不在 LLM。** writer 永遠拿不到 bash；所有 hard gate 由 `gates/` 執行並解析
   原始輸出。writer 能自跑測試 = 能自述通過 = gate 被架空。

2. **Runtime adapter 隔離 SDK。** 核心零 SDK import，一切 agent 互動經由
   `AgentRunner` interface（`libs/types.ts`）。換 runtime = 換一個 `runners/*.ts`
   （`opencode` 預設，`qwen` 走動態 import 作備援）。`runners/` 外禁止 import agent SDK 或 spawn agent CLI。

3. **Injection over discovery。** standards（writer 契約，`standards/java-ut-standards.md`）
   與 rubric（reviewer 評分細則）由 loop **讀檔注入 prompt**，不靠 skill discovery 的機率性載入。
   rubric 只注入 `references/rubric.md`，**刻意不注入 SKILL.md 全文**（那是批次稽核 workflow，
   對單輪 gate reviewer 是錯誤指令）。搜尋順序：`UT_SKILL_DIR` → 目標 repo `.opencode` →
   目標 repo `.claude` → 工具內建。

4. **State in artifacts, not context。** 每 phase 開全新 session，跨輪狀態只落在
   `runs/<repo 名>/<ts>/iter-N/`（prompt、writer-summary、build.log、coverage.txt、
   verdict.json、feedback.md；上一層 `params.json` 記錄工具版本戳記）。禁止跨輪複用 session context。

### Review gate 判定（fail-closed）

通過 = **blockers 空** 且 **六維（0-10 整數）皆達門檻**。維度：effectiveness / coverage /
independence / readability / fast_reliable / mock_appropriateness。`weightedScore`（權重
25/20/15/15/15/10）與 `grade`（A/B/C/D）由 pipeline **確定性計算**（LLM 不算分），僅供報告。
只有 blockers + 低分維度會餵回下一輪；advisories 不擋關、不進 feedback（防 thrash）。

## SSOT 三分（互不重複）

| 內容 | 位置 | 消費者 |
| --- | --- | --- |
| 測試撰寫標準 | <工具 clone>/standards/java-ut-standards.md | writer prompt（loop 注入） |
| 評分 rubric | skill 的 references/rubric.md（目標 repo .opencode/.claude → 工具內建） | reviewer prompt（loop 注入；SKILL.md 不注入） |
| 門檻與參數 | config.ts（env 可覆蓋） | gates / verdict |
| 角色契約與權限 | 目標 repo .opencode/agent/ 優先，否則 ~/.config/opencode/agent/（npm run setup 安裝） | opencode runtime + startup guard |

門檻與參數**只能改 `config.ts`**（透過 env 覆蓋），不得寫死在 prompt 或 gate 內。

## 修改前必讀的硬規則（違反 = 架構破壞，完整清單見 AGENTS.md §硬規則 / DESIGN.md）

- 迭代控制流只存在於 `orchestrator.ts` + `loop.ts`。**禁止**讓 agent 決定重試/停止，
  **禁止** Task tool delegation（雙重 orchestration 已被否決）。
- ut-writer 永不得 bash/shell；ut-reviewer 永遠唯讀（write/edit/bash 全 false）+ temperature 0。
  checker 能改 code 就會「順手修好再打高分」污染 signal。
- `libs/guard.ts` 的 startup assert（把權限契約變成機器檢查）**不得移除或弱化**。
  要改 agent 權限先改 `DESIGN.md` 取得共識。
- 修改 `libs/types.ts` 共用型別、`gates/review.ts` 判定邏輯、`runners/` 的 CLI/SDK 呼叫方式、
  或執行破壞性/大規模重構前，必須先向人類說明影響並取得明確確認。
- 架構刻意扁平（~1000 行、單用途內部工具）；full-SOLID 拆分（v5）已回退為 overdesign。
  重新 SOLID 化的門檻：出現第三個 build tool、或 gate 數量 ≥ 5。
