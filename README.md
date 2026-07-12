# testgen — Java 單元測試自動產生 pipeline

對指定的 Java 類別執行「產生 → 編譯/測試 gate → 覆蓋率 gate → 品質審查 gate → 修正」
迭代迴圈，直到單元測試符合團隊品質標準。控制流 100% 在 TypeScript，
LLM 只負責寫（ut-writer）與審（ut-reviewer），驗證權不外包。

**使用模式：中央 clone。** 你 clone 一份本工具，對部門任何 Java repo 執行；
不需要把工具放進你的 Java repo。

```
你的 Java repo（在此執行指令）◄── 實際跑 mvn test / 解析 JaCoCo / 寫測試檔
        ▲
        │ 每輪：writer 寫 → build gate → coverage gate → review gate
本工具 clone ──────────── artifacts 寫入 <clone>/runs/<repo 名>/<時間戳>/
        │
~/.config/opencode/ ◄──── npm run setup 安裝 ut-writer / ut-reviewer / 評分 skill
```

## 前置需求

- Node.js >= 20
- [opencode](https://opencode.ai) CLI 已安裝且在 PATH（版本需支援 `--format json`）
- LLM provider 存取權（見下方「Provider / 模型設定」）
- 目標 Java repo：Maven（主力支援；Gradle best-effort）、JUnit 5；
  覆蓋率 gate 需要模組綁 JaCoCo（沒有也能跑，該 gate 會略過並提示）

## 安裝（每人一次）

```bash
git clone git@github.com:sychen6192/testloop.git
cd testloop
npm install
npm run setup      # 安裝 agents + 評分 skill 到 ~/.config/opencode/
npm run doctor     # 環境自診（此時「Java repo」項顯示 WARN 屬正常）
```

選用：把 wrapper 加入 PATH，之後在任何地方都能用 `testgen`：

```bash
echo 'export PATH="$PATH:'$(pwd)'/bin"' >> ~/.zshrc && source ~/.zshrc
```

## Provider / 模型設定

> **部門設定**
> - writer 模型：`ollama/qwen3.6:27b`（dense；endpoint：`http://llm:11434/v1`，Ollama OpenAI 相容）
> - reviewer 模型：`ollama/qwen3.6:27b`（單卡 32GB 共用同一顆，避免 writer/reviewer 換模 reload thrash）
>
> 實測要點（qwen3.6:27b dense on RTX 5090 32GB）：
> - 一次只鎖**單一 class** 當目標——讓 writer 每輪只產一個測試檔；同時重寫多個大檔會慢到撞逾時。
> - `UT_AGENT_TIMEOUT_MS=1500000`（~25 分）——dense 約 15-25 tok/s，給完整生成餘裕免被 SIGTERM 截斷。
> - opencode 該模型 `num_ctx` 設 65536——扣掉 plugin/MCP 的 session 固定開銷才有足夠工作空間。
> - `qwen3.6:35b-a3b`（MoE，僅 3B active）服從性不足、寫不出較大的新測試檔，**不建議**當 writer。

1. 設定 provider 憑證：`opencode auth login`（或部門 vLLM 的 OpenAI 相容 endpoint）。
2. 指定模型（二選一）：
   - 編輯 `~/.config/opencode/agent/ut-writer.md` / `ut-reviewer.md` 的 `model:` 欄位；或
   - 用環境變數覆蓋：`UT_WRITER_MODEL` / `UT_REVIEWER_MODEL`（格式 `provider/model`）。

建議：理想上 writer 用便宜模型狂迭代、reviewer 用較強模型——cross-model 可降低
self-agreement bias。但若只有單張 GPU（放不下兩顆模型並存），writer/reviewer 用同一顆
可免每輪換模的 reload 成本；此時靠 review gate 的 must-read 防護擋掉 reviewer 不讀檔的假判決。

## 第一次執行

```bash
cd <你的 Java repo 根目錄>          # 多模組 Maven = reactor root
testgen doctor <某個 package 路徑> --smoke   # preflight + 實測 provider 一發
testgen core-module/src/main/java/com/acme/service   # 端對端
```

挑一個依賴最少的簡單 class 起手。退出碼：`0` 全數通過、`2` 迭代用盡未通過、`1` 致命錯誤。
每輪產物在 `<clone>/runs/<repo 名>/<時間戳>/`（prompt、writer 總結、build log、
覆蓋率、審查判決、失敗報告，以及 `params.json` 內的工具版本戳記）。

## 參數（環境變數，全部選填，詳見 .env.example）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `UT_RUNNER` | opencode | opencode｜qwen（qwen 需另裝 @qwen-code/sdk） |
| `UT_WRITER_MODEL` / `UT_REVIEWER_MODEL` | （agent .md 的 model） | provider/model 覆蓋 |
| `UT_MAX_ITER` | 5 | 最大迭代輪數 |
| `UT_MIN_LINE_COV` / `UT_MIN_BRANCH_COV` | 80 / 70 | 覆蓋率門檻（%） |
| `UT_STRICT_COV` | - | 1 = 無 JaCoCo 報告直接 FAIL |
| `UT_ALLOW_ZERO_TESTS` | - | 1 = 允許「編譯成功但 0 個測試執行」通過 build gate（預設 fail-closed 擋下） |
| `UT_REVIEWER_MUST_READ` | 1 | 0 = 允許 reviewer 未呼叫任何工具就輸出判決（預設 fail-closed 擋下） |
| `UT_SCORE_THRESHOLDS` | 7/7/7/6/7/6 | 六維門檻局部覆蓋（JSON，0-10 制） |
| `UT_SKIP_REVIEW` | - | 1 = 跳過 review gate |
| `UT_AGENT_TIMEOUT_MS` | 900000 | 單輪 agent 逾時 |
| `UT_SKILL_DIR` | 自動搜尋 | rubric 來源覆蓋（未設：目標 repo → 工具內建） |
| `UT_JACOCO_XML` | 自動搜尋 | 報告路徑覆蓋 |
| `UT_MAVEN_ARGS` | - | 額外 maven 參數，例如 `jacoco:report` |

評分規則：六維 0-10 整數、門檻預設 7/7/7/6/7/6；`weighted_score`（權重
25/20/15/15/15/10）與 `grade`（A≥85/B≥70/C≥55/D）由 pipeline 確定性計算，僅供報告——
gate 條件是「blockers 空 且 六維達門檻」。advisories 不擋關、不進下一輪 feedback。

## Troubleshooting

先跑 `testgen doctor <目標> --smoke`——多數問題會直接指出修法。常見情形：

- **doctor 說 agent 找不到**：回工具 clone 跑 `npm run setup`。
- **smoke FAIL / writer 沒動靜**：provider 未設定或 model 欄位空——見「Provider / 模型設定」。
- **writer 有跑但沒寫檔**：非互動模式 permission 被擋。常見根因是 global
  `~/.config/opencode/opencode.json` 設了 `"permission": {"edit": "ask"}`，會蓋過 agent 的
  `edit: allow`。首選解法：在**目標 repo 根**放 project 級 `opencode.json`：
  `{"permission": {"edit": "allow"}}`（只影響該 repo）。最後手段 `UT_OC_SKIP_PERMS=1`
  （writer 的 bash/web 本來就關閉）。
- **writer 探索完就結束、寫不出大檔／寫到一半中斷**：session 固定開銷太大（plugin 與 MCP
  工具 schema 可吃掉 20k+ tokens），模型 context 不夠用。在目標 repo 的 project
  `opencode.json` 調高該模型 context，例如 Ollama：
  `{"provider":{"ollama":{"models":{"<model>":{"options":{"num_ctx":65536}}}}}}`。
- **覆蓋率永遠略過**：模組沒綁 JaCoCo。加 jacoco-maven-plugin（prepare-agent + report 綁
  test phase），或 `UT_MAVEN_ARGS="jacoco:report"`；要強制擋關設 `UT_STRICT_COV=1`。
- **review gate 一直 REJECT 且訊息含「tool calls = 0」**：reviewer 模型沒讀任何檔案就直接
  輸出判決（fail-closed 防捏造假 verdict）。換更強的 `UT_REVIEWER_MODEL`；確定要放行設
  `UT_REVIEWER_MUST_READ=0`，或暫時 `UT_SKIP_REVIEW=1` 只跑 hard gates。
- **啟動就 FATAL agent 權限**：startup guard 攔到 agent 權限被改壞——刻意設計，照訊息修回
  frontmatter（writer 禁 bash、reviewer 全唯讀）。
- **看不到即時進度**：opencode 版本太舊不支援 `--format json`——`UT_OPENCODE_JSON=0` 退回
  整段輸出（失去即時 tracing）。
- **我的 repo 想客製 reviewer**：把 agent .md 放進該 repo 的 `.opencode/agent/`——repo 內
  定義優先於 global。

## 更新工具

```bash
cd <clone> && git pull && npm install && npm run setup
```

變更內容見 `CHANGELOG.md`。每次執行的 banner 與 `params.json` 都有工具版本戳記，
回報問題時請附上。

## 維運者

作者・維運：**Jack SY Chen**（[@sychen6192](https://github.com/sychen6192)）。歡迎同事提 PR。

- 品質防線：`npm run check`（typecheck + selftest）；GitHub Actions 於 push/PR 自動執行。
- 修改測試標準：`standards/java-ut-standards.md`（writer 契約）；
  修改評分細則：`.opencode/skills/test-quality-evaluator/references/rubric.md`
  ——改完通知同事 `git pull && npm run setup`。
- 設計文件：`DESIGN.md`（架構決策與否決紀錄）、`AGENTS.md`（agent 操作規範）；
  歷次改動的完整 rationale 見 `git log`。
