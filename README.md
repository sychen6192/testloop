# testgen — Java UT Loop Engineering Pipeline（OpenCode 版）

對指定資料夾的 Java 類別執行「產生 → 編譯/測試 gate → 覆蓋率 gate → 品質審查 gate → 修正」
的迭代迴圈，直到單元測試符合團隊品質標準。控制流 100% 在 TypeScript loop，
LLM 只負責「寫」（ut-writer）與「審」（ut-reviewer），驗證權不外包。

## 放置（zip 解到 Java repo 根目錄）

```
<你的 Java repo>/
├-- .opencode/agent/ut-writer.md      ← agent 定義（權限契約）
├-- .opencode/agent/ut-reviewer.md
├-- .opencode/skills/test-quality-evaluator/   ← 你的 skill（rubric 來源，已存在就不用動）
└-- tools/testgen/                    ← 本 pipeline
```

## 安裝

```bash
cd tools/testgen
npm install                 # typescript / tsx / @types/node
cp .env.example .env        # 視需要調整（全部可留空）
```

前置：`opencode` CLI 已安裝且在 PATH；provider（本地 vLLM、Anthropic 等）已在
opencode.json / auth 設定好；建議在兩個 agent .md 取消 `model:` 註解填入 provider/model。

## 煙霧測試（由內而外，一次驗一層）

```bash
# Layer 0：純邏輯自測（不需 opencode / mvn / LLM）
npx tsx tools/testgen/scripts/selftest.ts

# Layer 1：writer 能不能真的寫檔（不經過 loop）
opencode run --agent ut-writer --format json \
  "在 minio-sync-core/src/test/java 對應 package 建一個最小的 SmokeTest.java，只要一個空的 @Test 方法"
# 看兩件事：(a) 有跳 tool 事件 (b) 檔案真的落地

# Layer 2：端到端（挑一個最簡單、依賴最少的 class）
npx tsx tools/testgen/loop.ts minio-sync-core/src/main/java/<某個簡單的package>
```

一定要在 **Java repo 根目錄**執行 loop（多模組的 reactor root）。

## 多模組 Maven（已內建處理）

- 由目標路徑自動向上找最近的 `pom.xml` 判定模組，`mvn -pl <module> -am -DskipITs test`
  在 reactor root 執行。
- Surefire 與 JaCoCo 報告都到「該模組」的 `target/` 底下找
  （`<module>/target/site/jacoco/jacoco.xml`）。
- JaCoCo 的 report 若未綁 `test` phase，設 `UT_MAVEN_ARGS="jacoco:report"`。
- 完全沒有 JaCoCo 時預設「略過並提示」；設 `UT_STRICT_COV=1` 改為直接 FAIL。

## 環境變數（全部選填，詳見 .env.example）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `UT_RUNNER` | opencode | opencode｜qwen（qwen 需另裝 @qwen-code/sdk） |
| `UT_WRITER_MODEL` / `UT_REVIEWER_MODEL` | （agent .md 的 model） | provider/model 覆蓋 |
| `UT_MAX_ITER` | 5 | 最大迭代輪數 |
| `UT_MIN_LINE_COV` / `UT_MIN_BRANCH_COV` | 80 / 70 | 覆蓋率門檻（%） |
| `UT_STRICT_COV` | - | 1 = 無 JaCoCo 報告直接 FAIL |
| `UT_SCORE_THRESHOLDS` | 7/7/7/6/7/6 | 六維門檻局部覆蓋（JSON，0-10 制） |
| `UT_SKIP_REVIEW` | - | 1 = 跳過 review gate |
| `UT_AGENT_TIMEOUT_MS` | 900000 | 單輪 agent 逾時 |
| `UT_SKILL_DIR` | 自動搜尋 | rubric 來源覆蓋 |
| `UT_JACOCO_XML` | 自動搜尋 | 報告路徑覆蓋 |

Rubric 搜尋順序：`UT_SKILL_DIR` → `.opencode/skills/test-quality-evaluator` →
`.claude/skills/test-quality-evaluator`；注入 `references/rubric.md`
（fallback：`rubric.md` → `rubric/*.md`），由 loop 讀檔注入 reviewer prompt。
**刻意不注入 SKILL.md 全文**——那是批次稽核的 workflow 文件（六輸入確認、
concurrency、environment probe），對單輪 gate reviewer 是錯誤指令。
找不到 rubric 時退回 standards 全文並警告。

評分量表對齊 skill rubric：六維 **0-10 整數**（分數帶 9-10/7-8/5-6/3-4/0-2），
門檻預設 7/7/7/6/7/6；`weighted_score`（權重 25/20/15/15/15/10）與
`grade`（A≥85/B≥70/C≥55/D）由 pipeline 確定性計算（skill 原則 P1/P3：LLM 不算分），
僅供報告——gate 條件是「blockers 空 且 六維達門檻」。
blockers ≈ skill 的 severity=high，advisories ≈ medium/low（不擋關、不進 feedback）。

## Artifacts

每次執行寫入 `tools/testgen/runs/<timestamp>/`：`params.json`、每輪
`iter-N/{prompt.md, writer-summary.md, build.log, coverage.txt, verdict.json,
review-raw.txt, feedback.md}`、最終 `summary.json`。已在 .gitignore。

## Troubleshooting

- **writer 有跑但沒寫檔**：非互動模式 permission 被擋。先確認 ut-writer.md 的
  `permission: edit: allow` 存在；最後手段 `UT_OC_SKIP_PERMS=1`
  （附加 --dangerously-skip-permissions，writer 的 bash/web 已在 tools 層關閉）。
- **看不到即時進度**：需要 opencode 支援 `--format json`（JSONL 事件）。
  版本太舊可先 `UT_OPENCODE_JSON=0` 退回整段輸出（會失去即時 tracing）。
- **啟動就 FATAL agent 權限**：startup guard 攔到 agent .md 權限被改壞——
  這是刻意設計，照訊息修回 frontmatter。
- **覆蓋率永遠略過**：模組沒綁 JaCoCo。加 jacoco-maven-plugin
  （prepare-agent + report 綁 test phase），或 `UT_MAVEN_ARGS="jacoco:report"`。
