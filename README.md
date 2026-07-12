# testgen — Java 單元測試自動產生 pipeline

testgen 為指定的 Java 類別自動產生 JUnit 5 單元測試。它跑一個迭代迴圈：產生 →
編譯/測試 gate → 覆蓋率 gate → 品質審查 gate → 依失敗報告修正，直到測試符合團隊品質標準。

控制流完全在 TypeScript。LLM 只做兩件事：ut-writer 寫測試、ut-reviewer 審查。驗證權不
外包給模型；編譯、測試、覆蓋率一律由 script 實際執行並解析原始報告。

**本工具走中央 clone 模式。** clone 一份即可對部門任何 Java repo 執行，不需把工具放進
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
- LLM provider 存取權。設定方式見「Provider 與模型設定」。
- 目標 Java repo 使用 JUnit 5。建置工具以 Maven 為主力，Gradle 為 best-effort 支援。
- 覆蓋率 gate 需要模組綁定 JaCoCo。未綁定時該 gate 會自動略過並提示。

## 安裝

每人一次：

```bash
git clone git@github.com:sychen6192/testloop.git
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

> **部門設定**
>
> | 角色 | 模型 | 說明 |
> | --- | --- | --- |
> | writer | `ollama/qwen3.6:27b` | dense 模型，endpoint 為 `http://llm:11434/v1` |
> | reviewer | `ollama/qwen3.6:27b` | 單卡 32GB 共用同一顆，免去換模的 reload thrash |
>
> 在 RTX 5090 32GB 上以 qwen3.6:27b dense 實測，建議依下列設定執行。
>
> - 一次只鎖定單一 class 當目標，讓 writer 每輪只產一個測試檔。同時重寫多個大檔會慢到撞逾時。
> - 設 `UT_AGENT_TIMEOUT_MS=1500000`，約 25 分鐘。dense 模型約 15–25 tok/s，這給完整生成
>   留餘裕，避免被 SIGTERM 截斷。
> - 將 opencode 中該模型的 `num_ctx` 設為 65536。扣掉 plugin 與 MCP 的 session 固定開銷後，
>   才有足夠工作空間。
> - 不要用 `qwen3.6:35b-a3b` 當 writer。它是 MoE、僅 3B active，服從性不足，寫不出較大的
>   新測試檔。

設定步驟：

1. 設定 provider 憑證，執行 `opencode auth login`。部門若使用 vLLM，改指向其 OpenAI 相容
   endpoint。
2. 指定模型，以下二擇一：
   - 編輯 `~/.config/opencode/agent/ut-writer.md` 與 `ut-reviewer.md` 的 `model:` 欄位；或
   - 用環境變數 `UT_WRITER_MODEL`、`UT_REVIEWER_MODEL` 覆蓋，格式為 `provider/model`。

模型搭配建議：理想上 writer 用便宜模型快速迭代、reviewer 用較強模型，cross-model 可降低
self-agreement bias。但單張 GPU 通常放不下兩顆模型並存，此時 writer 與 reviewer 共用同一顆
即可，省去每輪換模的 reload 成本。共用同一顆時，review gate 的 must-read 防護會擋掉 reviewer
不讀檔就給出的假判決。

## 第一次執行

```bash
cd <目標 Java repo 根目錄>              # 多模組 Maven 請用 reactor root
testgen doctor <package 路徑> --smoke   # preflight，並實測 provider 一次
testgen <package 路徑>                  # 端對端執行
```

起手挑一個依賴最少的簡單 class。退出碼定義：`0` 全數通過、`2` 迭代用盡仍未通過、`1` 致命錯誤。

每輪產物寫入 `<clone>/runs/<repo 名>/<時間戳>/`，包含 prompt、writer 總結、build log、
覆蓋率、審查判決與失敗報告。同層的 `params.json` 記錄工具版本戳記。

## 參數

全部為環境變數、全部選填，詳見 `.env.example`。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `UT_RUNNER` | opencode | opencode 或 qwen。qwen 需另裝 @qwen-code/sdk |
| `UT_WRITER_MODEL` / `UT_REVIEWER_MODEL` | agent .md 的 model | 以 provider/model 覆蓋 |
| `UT_MAX_ITER` | 5 | 最大迭代輪數 |
| `UT_MIN_LINE_COV` / `UT_MIN_BRANCH_COV` | 80 / 70 | 覆蓋率門檻，單位 % |
| `UT_STRICT_COV` | - | 1 = 無 JaCoCo 報告直接 FAIL |
| `UT_ALLOW_ZERO_TESTS` | - | 1 = 允許「編譯成功但 0 測試」通過 build gate。預設 fail-closed 擋下 |
| `UT_REVIEWER_MUST_READ` | 1 | 0 = 允許 reviewer 未讀檔就輸出判決。預設 fail-closed 擋下 |
| `UT_SCORE_THRESHOLDS` | 7/7/7/6/7/6 | 六維門檻局部覆蓋，JSON 格式，0-10 制 |
| `UT_SKIP_REVIEW` | - | 1 = 跳過 review gate |
| `UT_AGENT_TIMEOUT_MS` | 900000 | 單輪 agent 逾時，單位毫秒 |
| `UT_SKILL_DIR` | 自動搜尋 | rubric 來源覆蓋。未設時依序找目標 repo、工具內建 |
| `UT_JACOCO_XML` | 自動搜尋 | 報告路徑覆蓋 |
| `UT_MAVEN_ARGS` | - | 額外 maven 參數，例如 `jacoco:report` |

評分規則：六維各給 0-10 整數，門檻預設 7/7/7/6/7/6。`weighted_score` 依權重
25/20/15/15/15/10 計算，`grade` 依 85/70/55 分界為 A/B/C/D。兩者都由 pipeline 確定性計算、
僅供報告。gate 的通過條件是 blockers 為空且六維皆達門檻。advisories 屬建議級，不擋關、也
不進下一輪 feedback。

## Troubleshooting

先跑 `testgen doctor <目標> --smoke`，多數問題會直接指出修法。常見情形如下。

- **doctor 說 agent 找不到。** 回工具 clone 目錄執行 `npm run setup`。
- **smoke FAIL，或 writer 沒動靜。** provider 未設定，或 model 欄位為空。見「Provider 與
  模型設定」。
- **writer 有跑但沒寫檔。** 非互動模式下 permission 被擋。常見根因是 global
  `~/.config/opencode/opencode.json` 設了 `"permission": {"edit": "ask"}`，蓋過 agent 的
  `edit: allow`。首選解法是在目標 repo 根放一份 project 級 `opencode.json`，內容
  `{"permission": {"edit": "allow"}}`，只影響該 repo。最後手段是 `UT_OC_SKIP_PERMS=1`；
  writer 的 bash 與 web 本來就關閉，風險有限。
- **writer 探索完就結束，或寫大檔寫到一半中斷。** session 固定開銷太大：plugin 與 MCP 工具
  schema 可吃掉 20k 以上 tokens，模型 context 不夠用。在目標 repo 的 project `opencode.json`
  調高該模型 context。Ollama 範例：
  `{"provider":{"ollama":{"models":{"<model>":{"options":{"num_ctx":65536}}}}}}`。
- **覆蓋率永遠略過。** 模組沒綁 JaCoCo。加上 jacoco-maven-plugin，將 prepare-agent 與 report
  綁到 test phase；或設 `UT_MAVEN_ARGS="jacoco:report"`。要強制擋關則設 `UT_STRICT_COV=1`。
- **review gate 一直 REJECT，訊息含「tool calls = 0」。** reviewer 沒讀任何檔案就輸出判決，
  fail-closed 防的是捏造的假 verdict。改用更強的 `UT_REVIEWER_MODEL`。確定要放行設
  `UT_REVIEWER_MUST_READ=0`，或暫時 `UT_SKIP_REVIEW=1` 只跑 hard gate。
- **啟動就 FATAL agent 權限。** startup guard 攔到 agent 權限被改壞。這是刻意設計，照訊息把
  frontmatter 修回：writer 禁 bash、reviewer 全唯讀。
- **看不到即時進度。** opencode 版本太舊，不支援 `--format json`。設 `UT_OPENCODE_JSON=0`
  退回整段輸出，但會失去即時 tracing。
- **想為某個 repo 客製 reviewer。** 把 agent .md 放進該 repo 的 `.opencode/agent/`。repo 內
  定義優先於 global。

## 更新工具

```bash
cd <clone> && git pull && npm install && npm run setup
```

變更內容見 `CHANGELOG.md`。每次執行的 banner 與 `params.json` 都帶工具版本戳記，回報問題時
請一併附上。

## 維運者

作者與維運：**Jack SY Chen**，GitHub [@sychen6192](https://github.com/sychen6192)。歡迎
同事提 PR。

- 品質防線為 `npm run check`，內容是 typecheck 加 selftest。GitHub Actions 於 push 與 PR
  自動執行。
- 修改測試標準改 `standards/java-ut-standards.md`，這是 writer 契約。修改評分細則改
  `.opencode/skills/test-quality-evaluator/references/rubric.md`。改完通知同事
  `git pull && npm run setup`。
- 設計文件見 `DESIGN.md` 與 `AGENTS.md`：前者記架構決策與否決紀錄，後者是 agent 操作規範。
  歷次改動的完整 rationale 見 `git log`。
