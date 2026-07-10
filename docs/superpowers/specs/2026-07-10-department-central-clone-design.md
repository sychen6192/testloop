# testgen 部門化：central-clone mode — Design Spec

日期：2026-07-10
狀態：已核准（使用者於 brainstorming 流程逐項確認）

## 0. 決策紀錄（本 spec 的前提）

| 決策 | 選擇 | 影響 |
| --- | --- | --- |
| 使用型態 | **中央 clone，對各 Java repo 執行**（非 per-repo vendoring） | 覆寫 DESIGN.md「已否決：global 安裝」——該節須標記 superseded 並記錄理由與緩解 |
| agent 安裝機制 | **Global 安裝**到 `~/.config/opencode/`（每人一次），目標 repo 的 `.opencode/agent/` 優先（專案化覆寫） | guard 的 agent 解析邏輯需擴充；此為 AGENTS.md 高風險項，授權即本 spec |
| 語言 | 文件維持繁體中文；code comments 維持極簡英文 | 沿用既有慣例 |

## 1. 目標與成功標準

一位部門同事在 **15 分鐘內**、不需口頭教學，完成：

```bash
git clone git@github.com:sychen6192/testloop.git && cd testloop
npm install
npm run setup      # agents + skill 裝到 ~/.config/opencode/
npm run doctor     # preflight 全綠（或依提示修復）
cd ~/work/<自己的 Java repo>
npx tsx <clone 路徑>/loop.ts <target>   # 或 bin/testgen wrapper
```

支援成本由 `doctor` 自診與 README FAQ 吸收。更新流程 = `git pull && npm install && npm run setup`。

## 2. 程式碼調整

原則：orchestrator / gates / review / prompts / runners 的**邏輯零更動**；權限矩陣不變；新增邏輯以純函式為主，讓 selftest 覆蓋。

### 2.1 `config.ts`
- `SKILL_DIR_CANDIDATES` 尾端追加 `TESTGEN_ROOT/.opencode/skills/test-quality-evaluator`（目標 repo 的候選仍在前，保留專案化覆寫）。
- `RUNS_DIR` 由 `TESTGEN_ROOT/runs` 改為 `TESTGEN_ROOT/runs/<basename(REPO_ROOT)>`（loop.ts 內的 `<timestamp>` 子目錄不變）。同名 repo 共用 namespace 可接受——timestamp 已能區分。
- 新增 `GLOBAL_OPENCODE_DIR`：`$XDG_CONFIG_HOME`（未設則 `~/.config`）+ `/opencode`。

### 2.2 `libs/guard.ts`
- 新增純函式 `resolveAgentPath(name, repoRoot, globalDir): { path, source: "repo" | "global" } | null`——repo `.opencode/agent/<name>.md` 存在則用之，否則 global，都沒有回 null。
- `assertAgents()` 改用上述解析，對**生效檔案**做原有 frontmatter assert（`mustContain` 規則一字不改），log 生效來源；兩處皆無 → `die`，訊息指向 `npm run setup`。
- `UT_SKIP_GUARD` 行為不變。

### 2.3 新 `scripts/setup.ts`
- 將 repo 內 `.opencode/agent/ut-writer.md`、`.opencode/agent/ut-reviewer.md`、`.opencode/skills/test-quality-evaluator/**` 拷貝到 `GLOBAL_OPENCODE_DIR` 對應路徑。
- 冪等：目的檔已存在則覆寫並標示 `updated`，否則 `installed`；絕不刪除目的地的其他檔案。
- 任一拷貝失敗 → 非零退出。結尾列出安裝清單與目的路徑。

### 2.4 新 `scripts/doctor.ts`
- Preflight 檢查，每項輸出 `[OK]/[WARN]/[FAIL]` 與修復提示；有 FAIL → exit 1，僅 WARN/OK → exit 0：
  1. node >= 20
  2. opencode 在 PATH（或 `UT_OPENCODE_BIN`）且可取版本
  3. agent 解析（repo/global 哪份生效）+ frontmatter guard 通過
  4. skill rubric 可解析（列出來源）
  5. standards 檔存在
  6. cwd 是 Java repo（pom.xml / build.gradle）；非 → FAIL 並說明須在 Java repo 根執行
  7. mvn/gradle（wrapper 或 binary）可用
  8. （選帶目標路徑時）模組偵測 + 模組 pom 是否含 jacoco（無 → WARN，附 UT_MAVEN_ARGS/STRICT_COV 說明）
- `--smoke`：以唯讀 reviewer 跑一發最小 prompt（如「回覆 OK」），逾時 60s，驗證 provider/model 真的通——這同時是「global agent 探索」的實測。
- 用法：`npm run doctor [-- <targetPath>] [--smoke]`（在目標 Java repo 內執行）。

### 2.5 版本戳記：新 `libs/version.ts`
- `getToolVersion(): string`，格式 `"<pkg version> (<git short SHA | no-git>)"`；以 `execSync("git -C <TESTGEN_ROOT> rev-parse --short HEAD")` 取得，失敗 fallback `no-git`。
- `loop.ts` 啟動 banner 列印，並寫入 `runs/<...>/params.json`（緩解中央工具「版本不與 repo 綁定」的可重現性損失）。

### 2.6 `package.json` / wrapper
- scripts：`setup`、`doctor`、`check`（= `tsc --noEmit && tsx scripts/selftest.ts`，typecheck/selftest 保留）。
- `engines: { node: ">=20" }`；`version: "1.0.0"`。
- 新 `bin/testgen`（bash，chmod +x）：`exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/loop.ts" "$@"`——同事可把 clone 的 `bin/` 加入 PATH。Windows 不提供 wrapper（README 註明直接用 npx tsx）。

### 2.7 selftest 擴充
- `resolveAgentPath` 解析順序（repo 優先 / global fallback / 皆無）。
- runs 目錄 namespace 推導。
- skill 候選順序（repo 候選在前、TESTGEN_ROOT fallback 在後）。
- 既有 34 條全數保留。

## 3. 文件

### 3.1 `README.md`（全面改寫為使用者視角，繁中）
章節：這是什麼（3 行 + 流程圖）→ 前置需求（node>=20、opencode CLI、provider 存取權；目標 repo 需 Maven/Gradle + JUnit5 + JaCoCo）→ 安裝（§1 的五行）→ Provider/模型設定（opencode auth 步驟；agent .md 的 model 欄位與 `UT_*_MODEL` 覆蓋；**部門實際 endpoint/model 留一個明確標示的填空區塊**）→ 第一次執行（doctor → smoke → 端對端）→ 日常用法與參數表（沿用現有 env 表）→ Troubleshooting/FAQ（現有四條 + doctor 對應）→ 更新方式（git pull + npm install + npm run setup；看 CHANGELOG）。

### 3.2 `DESIGN.md`
- 「目標與範圍」「架構總覽」定位段落改為中央 clone 模式（工具 clone 是 SSOT，對任意 Java repo 執行）。
- 「已否決方案」中「global 安裝 pipeline/skill 供 loop 消費」→ 標記 **superseded（2026-07-10，使用者決策）**：部門多 repo 的 vendoring 維護成本高於 per-repo 可重現性收益；緩解 = params.json 版本戳記、doctor preflight、repo-local `.opencode` 覆寫仍優先。
- 權限矩陣、七條設計原則不變（原則 6 runtime adapter、原則 2 驗證權不外包等全數維持）。

### 3.3 `AGENTS.md` / `CLAUDE.md`
- 「定位」段落改寫（不再是 `tools/testgen/` 內嵌；改述中央 clone + global agents + repo 覆寫）。
- 硬規則八條不變；高風險清單不變。
- CLAUDE.md 的指令區與架構描述同步（含 setup/doctor/check）。

### 3.4 其他
- `.env.example`：無新增 env（版本戳記不走 env），僅校對描述。
- 新 `CHANGELOG.md`：keep-a-changelog 簡化版，自 v1.0.0 起記。

## 4. CI

`.github/workflows/check.yml`：push + PR 觸發，node 22，`npm ci && npm run check`。

## 5. 清理

- `git rm CHANGES.md`（使用者已於 working tree 刪除，spec 假設為刻意；由新 CHANGELOG.md 承接「何時該更新」的需求）。
- `.gitignore` 補回結尾換行。
- `package-lock.json` 已入版控——不需處理。

## 6. 實作順序與驗收

### 順序（風險前置）
1. **Spike：global agent 探索實測**——把 agents 拷到 `~/.config/opencode/`，在一個**無 `.opencode` 的暫存目錄**跑 `opencode run --agent ut-reviewer "回覆 OK"`。成功 → 續行；失敗 → 停下回報，setup 降級為「拷進目標 repo」機制（本 spec 其餘部分不受影響，僅 §2.2/§2.3 的 global 分支改為 repo 分支）。
2. 純函式（resolveAgentPath、candidates、runs namespace）+ selftest → guard/config 接線。
3. setup.ts、doctor.ts、version.ts、bin/testgen、package.json。
4. 文件（README/DESIGN/AGENTS/CLAUDE/CHANGELOG）。
5. CI workflow。
6. 清理項。

### 驗收（evidence, not assertion）
- `npm run check` 綠（tsc + selftest 含新 cases）。
- 本機實走：`npm run setup` → 於暫存 fixture Java repo（selftest 式假 repo）跑 `npm run doctor`，agent 來源顯示 `global`、各項 OK/WARN 合理。
- `doctor --smoke` 於真實環境通過（需本機 provider 已設定；不通則列為已知待使用者環境驗證項）。
- README 依步驟從頭走一遍無斷點。
- 端對端（真 Java repo 跑滿一輪迭代）：需使用者環境配合，列為交付後驗證項。

## 7. 風險

| 風險 | 緩解 |
| --- | --- |
| opencode 1.17.18 不支援 global agent 探索 | 實作第 1 步 spike 實測；備援機制已定義（§6.1） |
| guard 屬高風險清單 | 本 spec 即共識紀錄；assert 嚴格度不變，只擴充搜尋位置 |
| 中央工具版本與 repo 脫鉤 | params.json 版本戳記 + CHANGELOG + doctor |
| 各人 provider 設定差異 | doctor --smoke 實測 + README provider 段落含部門值 |

## 8. 明確不做（YAGNI）

- Windows global-path 支援（README 註記限制即可）。
- mutation gate（Phase 3，另案）。
- 英文版文件、npm registry 發佈、多 build tool 擴充。
- 任何 orchestrator/gates/review/prompts/runners 的邏輯重構。
