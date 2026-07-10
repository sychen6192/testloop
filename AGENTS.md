# testgen — Agent 指南（AGENTS.md）

## 互動與語言
- 對話、思考、文檔預設**繁體中文**；技術名詞保留英文。

## 定位（重要）
本 repo 是**中央工具 clone**：clone 一份，對部門任何 Java repo 執行
（在目標 repo 根執行 `npx tsx <clone>/loop.ts <目標>` 或 `bin/testgen`）。
agent 定義與評分 skill 由 `npm run setup` 安裝到 `~/.config/opencode/`；
目標 repo `.opencode/` 內的同名定義優先（專案化覆寫）。
standards 與預設 rubric 隨本 repo 版控；每次執行寫入工具版本戳記。

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
loop.ts               entry point（參數驗證/rubric 載入/guard/runs 建立/版本戳記）
orchestrator.ts       迭代迴圈（零 SDK import）＋ artifacts 落盤
config.ts             所有設定 SSOT（.env 自動載入）
prompts.ts            writer/reviewer 參數化 prompt（standards/rubric 注入）
gates/build.ts        多模組感知 build gate（mvn -pl -am / gradle -p）＋失敗摘要
gates/coverage.ts     JaCoCo 定位＋解析（sourcefile 彙總優先）
gates/review.ts       fail-closed 判決解析＋門檻判定＋review gate 組裝
runners/…             factory＋兩個 AgentRunner 實作（SDK 隔離邊界）
libs/types.ts         共用型別（GateResult, ReviewVerdict, AgentRunner, ModuleInfo）
libs/log.ts           elapsed/log/banner/die/tail/startHeartbeat
libs/shell.ts         shLive（子行程逐行轉印）
libs/utils.ts         純函式（含 skillDirCandidates / runsDirFor）
libs/guard.ts         startup guard（agent 解析 repo→global + frontmatter assert）
libs/rubric.ts        rubric loader（只注入 references/rubric.md，禁 SKILL.md 全文）
libs/version.ts       工具版本戳記
scripts/selftest.ts   純邏輯自測
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
npm run check                          # tsc --noEmit + selftest
npm run setup                          # agents+skill → ~/.config/opencode/
# 在目標 Java repo 根執行：
npx tsx <clone>/scripts/doctor.ts [目標路徑] [--smoke]
npx tsx <clone>/loop.ts <目標路徑>
# 驗證 SDK 隔離（runners/ 以外不得 import SDK / spawn agent CLI）：
grep -rn "@qwen-code/sdk\|@opencode-ai" --include="*.ts" --exclude-dir=node_modules --exclude-dir=runners . && echo LEAK || echo CLEAN
```

環境變數見 README.md 與 .env.example。

## 高風險操作與授權閘門
以下必須先向人類說明影響並取得明確確認：
1. 刪除、遷移或大規模重構現有代碼
2. 修改 libs/types.ts 共用型別、libs/guard.ts 的 assert、gates/review.ts 判定邏輯
3. 修改 runners/ 的 CLI/SDK 呼叫方式或 agent .md 權限
4. 執行破壞性命令（rm -rf）、重寫 Git 歷史（force push）
