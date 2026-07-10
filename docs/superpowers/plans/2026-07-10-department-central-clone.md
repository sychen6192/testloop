# testgen 部門化（central-clone mode）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓部門同事 clone 一份本工具、`npm run setup && npm run doctor` 後即可對任意 Java repo 執行 UT 產生 pipeline。

**Architecture:** 中央 clone 為 SSOT；agents/skill 由 setup 安裝到 `~/.config/opencode/`（目標 repo `.opencode/` 同名定義優先）；doctor 提供 preflight；目錄整併 7→4；pipeline 邏輯零更動。規格：`docs/superpowers/specs/2026-07-10-department-central-clone-design.md`。

**Tech Stack:** TypeScript（strict, ESM, tsx 執行）、Node >= 20、opencode CLI、GitHub Actions。

## Global Constraints

- 文件/runtime 訊息/LLM prompts 一律繁體中文；code comments 一律極簡英文。
- `runners/` 以外禁止 import agent SDK 或 spawn agent CLI（doctor 的 smoke 必須走 `AgentRunner`）。
- orchestrator / gates / prompts / runners **邏輯零更動**；Task 2 只搬移與合檔，exports 名稱一字不改。
- guard 的 assert 嚴格度不得弱化（同樣的 frontmatter 規則、同樣 die）。
- 門檻與參數只能進 `config.ts`（env 覆蓋）。
- 每個 task 結尾驗證：`npx tsc --noEmit && npx tsx scripts/selftest.ts`（Task 7 之後可用 `npm run check`）。
- Commit message 用 conventional commits，結尾加：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 工作目錄即本 repo 根（`loop.ts` 所在）。

---

### Task 1: Spike — opencode global agent 探索實測

**Files:** 無程式碼變更（實驗性驗證，決定 Task 3/5 走主線或備援）。

**Interfaces:**
- Produces: 一個明確結論——「opencode 1.17.x 能否從 `~/.config/opencode/agent/` 解析 `--agent ut-reviewer`」。

- [ ] **Step 1: 把 reviewer agent 放進 global 目錄（不覆蓋既有檔案）**

```bash
mkdir -p ~/.config/opencode/agent
[ -f ~/.config/opencode/agent/ut-reviewer.md ] \
  && echo "already exists, keeping" \
  || cp .opencode/agent/ut-reviewer.md ~/.config/opencode/agent/
```

- [ ] **Step 2: 在一個沒有 `.opencode/` 的目錄執行 agent**

```bash
cd "$(mktemp -d)"
opencode run --agent ut-reviewer "這是連線測試，請只回覆：OK"
```

- [ ] **Step 3: 判讀結果（三種情形）**

| 觀察 | 結論 | 動作 |
| --- | --- | --- |
| 有回覆（任何文字） | global 探索 OK、provider OK | 續行 Task 2 |
| 錯誤訊息指 agent 不存在 / unknown agent | **global 探索失敗** | **停止**，回報使用者；後續 Task 3 的 guard 移除 global 分支、Task 5 的 setup 改為 `--into <目標repo>` 拷貝模式（spec §6 備援） |
| 錯誤訊息指 model / provider / auth | global 探索 OK（agent 有被解析），只是 provider 未設 | 續行 Task 2，並記錄「doctor --smoke 需 provider 設定後才會綠」 |

回到本 repo 根目錄再繼續。

---

### Task 2: 目錄整併（7 個程式碼資料夾 → 4）

**Files:**
- Move: `core/orchestrator.ts` → `orchestrator.ts`
- Create: `gates/review.ts`（合併 `review/verdict.ts` + `review/gate.ts`）
- Create: `prompts.ts`（合併 `prompts/{generate,fix,review}.ts`）
- Delete: `review/gate.ts`, `review/verdict.ts`, `prompts/generate.ts`, `prompts/fix.ts`, `prompts/review.ts`
- Modify: `loop.ts`（1 行 import）、`scripts/selftest.ts`（1 行 import）

**Interfaces:**
- Produces（後續 task 依賴的匯出，名稱不變）：
  - `gates/review.ts`: `computeWeighted(scores: ReviewScores)`, `parseVerdict(raw: string, thresholds?: ScoreThresholds): ReviewVerdict`, `runReviewGate(runner: AgentRunner, prompt: string): Promise<ReviewVerdict>`
  - `prompts.ts`: `DIMENSION_ONELINERS`, `testRootRel(mod)`, `buildGeneratePrompt(input)`, `buildFixPrompt(input)`, `buildReviewPrompt(input)` 與三個 input interface

- [ ] **Step 1: 搬移 orchestrator**

```bash
git mv core/orchestrator.ts orchestrator.ts
```

- [ ] **Step 2: 修 orchestrator.ts 的 import（檔案其餘內容一字不動）**

把檔頭 import 區塊改為：

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_ITER } from "./config";
import { log, banner, tail } from "./libs/log";
import {
  AgentRunner,
  BuildTool,
  ModuleInfo,
  ReviewVerdict,
} from "./libs/types";
import { buildGeneratePrompt, buildFixPrompt, buildReviewPrompt } from "./prompts";
import { runBuildAndTests } from "./gates/build";
import { checkCoverage } from "./gates/coverage";
import { runReviewGate } from "./gates/review";
```

（原本分別從 `../prompts/generate`、`../prompts/fix`、`../prompts/review`、`../review/gate` 匯入的四行合併如上；其他 `../` 前綴全部改 `./`。）

- [ ] **Step 3: 建立 gates/review.ts（verdict + gate 合檔，邏輯 verbatim）**

````ts
// Review gate: run the read-only reviewer, then fail-closed parsing + deterministic scoring.
// Six 0-10 integer dims (per the skill rubric bands).
// weighted_score and grade are computed here from skill weights (25/20/15/15/15/10)
// and bands (A>=85 / B>=70 / C>=55 / D) — the LLM never scores.
// Pass = blockers empty AND all six dims meet threshold; advisories/grade don't affect it.
// Any parse failure, missing field, or out-of-range score -> passed=false with a reason, never throws.
import {
  AgentRunner,
  REVIEW_DIMENSIONS,
  ReviewScores,
  ReviewVerdict,
} from "../libs/types";
import { SCORE_THRESHOLDS, ScoreThresholds, RUBRIC_WEIGHTS, GRADE_BANDS } from "../config";
import { tail } from "../libs/log";

export function computeWeighted(scores: ReviewScores): { weighted: number; grade: string } {
  let sum = 0;
  for (const d of REVIEW_DIMENSIONS) sum += scores[d] * RUBRIC_WEIGHTS[d];
  const weighted = Math.round(sum * 10 * 10) / 10; // Σ(score×weight)×10, one decimal
  const grade = GRADE_BANDS.find((b) => weighted >= b.min)?.grade ?? "D";
  return { weighted, grade };
}

export function parseVerdict(
  raw: string,
  thresholds: ScoreThresholds = SCORE_THRESHOLDS,
): ReviewVerdict {
  const failed = (why: string): ReviewVerdict => ({
    passed: false,
    scores: {},
    blockers: [
      `Reviewer 輸出無法解析（${why}），依 fail-closed 原則判 REJECT。` +
        `請重新輸出符合 schema 的單一 JSON 物件。原文節錄：${tail(raw, 800)}`,
    ],
    advisories: [],
    belowThreshold: [],
    parseError: why,
    raw,
  });

  const cleaned = raw.replace(/```json|```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return failed("找不到 JSON 物件");

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return failed(`JSON.parse 失敗：${e instanceof Error ? e.message : String(e)}`);
  }
  const o = obj as Record<string, unknown>;
  const rawScores = (o.scores ?? {}) as Record<string, unknown>;

  const scores = {} as ReviewScores;
  const belowThreshold: string[] = [];
  for (const d of REVIEW_DIMENSIONS) {
    const v = Number(rawScores[d]);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > 10) {
      return failed(`維度 ${d} 分數缺漏或超出 0-10 整數`);
    }
    scores[d] = v;
    const th = thresholds[d];
    if (v < th) belowThreshold.push(`${d}（${v} < 門檻 ${th}）`);
  }

  if (!Array.isArray(o.blockers)) return failed("缺 blockers 陣列");
  const blockers = (o.blockers as unknown[]).map(String);
  const advisories = Array.isArray(o.advisories)
    ? (o.advisories as unknown[]).map(String)
    : [];

  const { weighted, grade } = computeWeighted(scores);
  const passed = blockers.length === 0 && belowThreshold.length === 0;
  return { passed, scores, blockers, advisories, belowThreshold, weightedScore: weighted, grade, raw };
}

export async function runReviewGate(
  runner: AgentRunner,
  prompt: string,
): Promise<ReviewVerdict> {
  const raw = await runner.runReview(prompt);
  return parseVerdict(raw);
}
````

- [ ] **Step 4: 建立根目錄 prompts.ts（三檔合一，prompt 字串 verbatim）**

```ts
// Writer + reviewer prompts. Standards and rubric are injected by the loop
// (injection over discovery). Score scale matches the skill rubric (0-10 integers);
// weighted_score/grade are computed by the pipeline — the reviewer must not output them.
import * as path from "node:path";
import { ModuleInfo, REVIEW_DIMENSIONS } from "./libs/types";
import { SCORE_THRESHOLDS } from "./config";
import { expectedTestPath } from "./libs/utils";

// Six dimensions as name + one-liner for the writer — direction only, no rubric detail (avoid teaching-to-the-test).
export const DIMENSION_ONELINERS = `你產出的測試之後會依以下六個維度被審查（評分細則由審查方持有）：
- Effectiveness：斷言驗證具體行為與值，能抓出真實錯誤
- Coverage：涵蓋正常路徑、邊界（null/空/0/負數/極值）與例外路徑
- Independence：測試彼此獨立、無順序相依、無共享可變狀態
- Readability：AAA 結構、命名「方法_情境_預期結果」、意圖清晰
- Fast & Reliable：無 sleep、無真實 I/O、結果具決定性
- Mock Appropriateness：只 mock 外部相依，不過度驗證內部實作`;

export interface GeneratePromptInput {
  targetClasses: string[];
  standards: string;
  mod: ModuleInfo;
}

export function testRootRel(mod: ModuleInfo): string {
  return path.join(mod.moduleRel, "src", "test", "java").replace(/\\/g, "/");
}

export function buildGeneratePrompt(input: GeneratePromptInput): string {
  const root = testRootRel(input.mod);
  const buildFile = input.mod.moduleRel
    ? `${input.mod.moduleRel}/pom.xml（或 build.gradle）`
    : "pom.xml（或 build.gradle）";
  return `你的任務：為以下 Java 類別撰寫單元測試（JUnit 5）。

目標模組：${input.mod.multiModule ? input.mod.moduleRel : "（單一模組專案）"}
測試檔一律放在：${root}/<對應 package>/<ClassName>Test.java
若已存在測試檔，請補強而非覆蓋掉仍有效的測試。

目標類別：
${input.targetClasses.map((c) => `- ${c}`).join("\n")}

必須嚴格遵守以下品質標準：
<standards>
${input.standards}
</standards>

${DIMENSION_ONELINERS}

流程要求：
1. 先讀取每個目標類別的原始碼與其相依介面，理解行為與邊界。
2. 參考 ${buildFile} 已宣告的測試相依，以及專案既有測試的風格。
3. 只建立/修改 ${root} 下的測試檔案。不要執行任何建置或測試指令（由外部 pipeline 負責驗證）。
4. 不得修改 production code、不得刪除仍有效的測試、不得使用 @Disabled。

完成後以清單列出你建立/修改的檔案。`;
}

export interface FixPromptInput {
  gateReport: string;
  standards: string;
  mod: ModuleInfo;
}

export function buildFixPrompt(input: FixPromptInput): string {
  const root = testRootRel(input.mod);
  return `上一輪產生的單元測試未通過驗證 pipeline，以下是失敗報告：

<gate_report>
${input.gateReport}
</gate_report>

請修正 ${root} 中相關的測試檔案，讓上述所有問題被解決。仍然嚴格遵守：
<standards>
${input.standards}
</standards>

${DIMENSION_ONELINERS}

規則：
- 只修改測試碼，不得修改 production code
- 不得刪除有效測試來規避失敗、不得使用 @Disabled
- 不要執行任何建置或測試指令（由外部 pipeline 負責驗證）

完成後以清單列出你修改的檔案。`;
}

export interface ReviewPromptInput {
  targetClasses: string[];
  rubric: string;
  mod: ModuleInfo;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const pairs = input.targetClasses
    .map((c) => `- 來源：${c}\n  預期測試：${expectedTestPath(c)}`)
    .join("\n");
  const dims = REVIEW_DIMENSIONS.map((d) => `"${d}"（門檻 ${SCORE_THRESHOLDS[d]}）`).join("、");

  return `請審查以下 Java 類別對應的單元測試品質。

目標模組：${input.mod.multiModule ? input.mod.moduleRel : "（單一模組專案）"}
目標類別與預期測試檔位置：
${pairs}
（若實際測試檔名不同，請自行以 glob/grep 在該模組 src/test/java 下找到對應檔案。）

審查依據為以下評分 rubric（分數帶與 Java 範例皆以此為準）：
<rubric>
${input.rubric}
</rubric>

要求：
- 必須實際讀取每個測試檔案內容逐條檢查，不得僅憑檔名或摘要推斷。
- 不得臆測你沒有實際讀到的內容；quantitative signals（mutation score、
  branch coverage 等）不在你的職責內，由 pipeline 的 hard gate 負責，勿推估。
- 特別注意：無意義斷言（assertNotNull / assertTrue(true) / 只驗 mock 回傳值）、
  缺漏的邊界與例外情境、AAA 結構、命名規範、Thread.sleep、真實 I/O、
  測試間相依、@Disabled、以及任何對 production code 的修改跡象。

評分與判決定義：
- 六個維度各給 0-10「整數」，依 rubric 分數帶（9-10 / 7-8 / 5-6 / 3-4 / 0-2）：${dims}
- 不要計算或輸出 weighted_score、grade——由 pipeline 依權重確定性計算。
- blockers：相當於 rubric 的 severity=high——違反標準「禁止事項」、false-negative
  或會誤導的測試（例如無意義斷言、規避失敗的手段）。每條必須具體，
  包含檔名與方法名。blockers 非空即不通過。
- advisories：相當於 severity=medium/low 的建議級改善，不擋關。

最終回覆必須是「單一 JSON 物件」，不得包含 markdown 圍欄、前言或任何其他文字。schema：
{"scores":{"effectiveness":N,"coverage":N,"independence":N,"readability":N,"fast_reliable":N,"mock_appropriateness":N},"blockers":["..."],"advisories":["..."]}`;
}
```

- [ ] **Step 5: 刪除舊檔**

```bash
git rm review/gate.ts review/verdict.ts prompts/generate.ts prompts/fix.ts prompts/review.ts
```

- [ ] **Step 6: 修 loop.ts 與 selftest.ts 的 import**

`loop.ts`：`import { orchestrate } from "./core/orchestrator";` → `import { orchestrate } from "./orchestrator";`

`scripts/selftest.ts`：`import { parseVerdict } from "../review/verdict";` → `import { parseVerdict } from "../gates/review";`

- [ ] **Step 7: 驗證（搬移無行為變更的證明）**

```bash
npx tsc --noEmit && npx tsx scripts/selftest.ts
```
Expected: tsc 無輸出；selftest `結果：34 passed / 0 failed`。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: consolidate directories (7 code dirs -> 4)

core/ -> root, review/ merged into gates/review.ts, prompts merged
into prompts.ts. Logic and exports unchanged; verified by tsc + selftest.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: central-clone 解析純函式 + config/guard 接線（TDD）

**Files:**
- Modify: `libs/utils.ts`（新增兩個純函式）
- Modify: `libs/guard.ts`（agent 解析 repo→global；assert 嚴格度不變）
- Modify: `config.ts`（GLOBAL_OPENCODE_DIR、SKILL_DIR_CANDIDATES、RUNS_DIR）
- Test: `scripts/selftest.ts`（新增第 6 節，8 條）

**Interfaces:**
- Produces:
  - `libs/utils.ts`: `skillDirCandidates(repoRoot: string, testgenRoot: string, envDir?: string): string[]`、`runsDirFor(testgenRoot: string, repoRoot: string): string`
  - `libs/guard.ts`: `resolveAgentPath(name: string, repoRoot: string, globalDir: string): { path: string; source: "repo" | "global" } | null`、`contractViolations(filePath: string, rules: readonly ContractRule[]): string[]`、`WRITER_RULES` / `REVIEWER_RULES`（`ContractRule = readonly [string, "true" | "false"]`）、`assertAgents()`（簽名不變）
  - `config.ts`: `GLOBAL_OPENCODE_DIR: string`（其餘匯出名稱不變）

- [ ] **Step 1: 先寫 failing test——selftest 加第 6 節**

在 `scripts/selftest.ts` 的 import 區新增：

```ts
import { resolveAgentPath, contractViolations, WRITER_RULES } from "../libs/guard";
import { skillDirCandidates, runsDirFor } from "../libs/utils";
```

在第 5 節區塊之後、結尾 `console.log(\`\n結果：...\`)` 之前插入：

```ts
// ---------------------------------------------------------------------------
// 6. central-clone resolution (agent repo->global, skill candidates, runs namespace)
// ---------------------------------------------------------------------------
console.log("\n[6] resolveAgentPath / contractViolations / skillDirCandidates / runsDirFor");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-central-"));
  const repo = path.join(tmp, "repo");
  const globalDir = path.join(tmp, "global-opencode");
  fs.mkdirSync(path.join(repo, ".opencode", "agent"), { recursive: true });
  fs.mkdirSync(path.join(globalDir, "agent"), { recursive: true });
  const writerFm = "---\ntools:\n  write: true\n  edit: true\n  bash: false\n---\nbody";
  fs.writeFileSync(path.join(repo, ".opencode", "agent", "ut-writer.md"), writerFm);
  fs.writeFileSync(path.join(globalDir, "agent", "ut-writer.md"), writerFm);
  fs.writeFileSync(
    path.join(globalDir, "agent", "ut-reviewer.md"),
    "---\ntools:\n  write: false\n  edit: false\n  bash: false\n---\nbody",
  );

  const both = resolveAgentPath("ut-writer", repo, globalDir);
  check("repo-local agent 優先於 global", both?.source === "repo" && !!both?.path.startsWith(repo));
  const globalOnly = resolveAgentPath("ut-reviewer", repo, globalDir);
  check("repo 無此 agent → global fallback", globalOnly?.source === "global");
  check("兩處皆無 → null", resolveAgentPath("nope", repo, globalDir) === null);

  check(
    "writer 契約合規 → 無違規",
    contractViolations(path.join(globalDir, "agent", "ut-writer.md"), WRITER_RULES).length === 0,
  );
  const badWriter = path.join(tmp, "bad-writer.md");
  fs.writeFileSync(badWriter, "---\ntools:\n  write: true\n  edit: true\n  bash: true\n---\n");
  const errs = contractViolations(badWriter, WRITER_RULES);
  check("writer 拿到 bash → 違規", errs.length === 1 && errs[0].includes("bash"));

  const cands = skillDirCandidates("/repo", "/tool", undefined);
  check(
    "skill 候選順序：repo .opencode → repo .claude → 工具內建",
    cands.length === 3 &&
      cands[0] === path.join("/repo", ".opencode", "skills", "test-quality-evaluator") &&
      cands[1] === path.join("/repo", ".claude", "skills", "test-quality-evaluator") &&
      cands[2] === path.join("/tool", ".opencode", "skills", "test-quality-evaluator"),
    JSON.stringify(cands),
  );
  const withEnv = skillDirCandidates("/repo", "/tool", "/env/dir");
  check("UT_SKILL_DIR 排最前", withEnv.length === 4 && withEnv[0] === "/env/dir");

  check(
    "runsDirFor：runs/<repo basename>",
    runsDirFor("/tool", "/w/myrepo") === path.join("/tool", "runs", "myrepo"),
  );
}
```

- [ ] **Step 2: 跑 selftest 確認 FAIL**

```bash
npx tsx scripts/selftest.ts
```
Expected: 啟動即錯（`resolveAgentPath` / `skillDirCandidates` 尚未匯出）。

- [ ] **Step 3: 實作 libs/utils.ts 新函式（附加到檔尾）**

```ts
// Skill-dir search order: env override -> target repo (.opencode, .claude) -> the tool's own copy.
export function skillDirCandidates(
  repoRoot: string,
  testgenRoot: string,
  envDir?: string,
): string[] {
  return [
    envDir,
    path.join(repoRoot, ".opencode", "skills", "test-quality-evaluator"),
    path.join(repoRoot, ".claude", "skills", "test-quality-evaluator"),
    path.join(testgenRoot, ".opencode", "skills", "test-quality-evaluator"),
  ].filter(Boolean) as string[];
}

// Per-target-repo artifacts namespace: runs/<repo basename>.
export function runsDirFor(testgenRoot: string, repoRoot: string): string {
  return path.join(testgenRoot, "runs", path.basename(repoRoot));
}
```

- [ ] **Step 4: 改寫 libs/guard.ts（全檔取代為下列內容）**

```ts
// Startup guard: assert the agent permission contract at launch.
// Docs drift, this doesn't — it fails instantly if writer gets bash or reviewer can write.
// Resolution order: target repo .opencode/agent/ first, then the global opencode dir.
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, GLOBAL_OPENCODE_DIR, SKIP_GUARD } from "../config";
import { die, log } from "./log";

export type ContractRule = readonly [string, "true" | "false"];

export const WRITER_RULES: readonly ContractRule[] = [
  ["write", "true"],
  ["edit", "true"],
  ["bash", "false"], // verification stays in the loop
];

export const REVIEWER_RULES: readonly ContractRule[] = [
  ["write", "false"],
  ["edit", "false"],
  ["bash", "false"], // reviewer is fully read-only
];

export function resolveAgentPath(
  name: string,
  repoRoot: string,
  globalDir: string,
): { path: string; source: "repo" | "global" } | null {
  const repoPath = path.join(repoRoot, ".opencode", "agent", `${name}.md`);
  if (fs.existsSync(repoPath)) return { path: repoPath, source: "repo" };
  const globalPath = path.join(globalDir, "agent", `${name}.md`);
  if (fs.existsSync(globalPath)) return { path: globalPath, source: "global" };
  return null;
}

// Contract violations for one agent file; empty array = compliant.
export function contractViolations(filePath: string, rules: readonly ContractRule[]): string[] {
  if (!fs.existsSync(filePath)) return [`缺少 agent 定義：${filePath}`];
  const t = fs.readFileSync(filePath, "utf8");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [`${filePath} 缺少 frontmatter（--- ... ---）`];
  const fm = m[1];
  const errs: string[] = [];
  for (const [key, value] of rules) {
    if (!new RegExp(`${key}:\\s*${value}\\b`).test(fm)) {
      errs.push(
        `${path.basename(filePath)} 必須明確設定 tools.${key}: ${value}（架構契約，見 DESIGN.md）`,
      );
    }
  }
  return errs;
}

export function assertAgents() {
  if (SKIP_GUARD) {
    log("[WARN] 已跳過 agent 權限 guard（UT_SKIP_GUARD=1）");
    return;
  }
  const specs = [
    { name: "ut-writer", rules: WRITER_RULES },
    { name: "ut-reviewer", rules: REVIEWER_RULES },
  ];
  for (const { name, rules } of specs) {
    const res = resolveAgentPath(name, REPO_ROOT, GLOBAL_OPENCODE_DIR);
    if (!res) {
      die(
        `找不到 agent 定義 ${name}.md（目標 repo .opencode/agent/ 與 global 皆無）。` +
          `請先在工具 clone 目錄執行 npm run setup`,
      );
    }
    const errs = contractViolations(res.path, rules);
    if (errs.length) die(errs.join("\n"));
    log(`[OK] agent ${name}：${res.source}（${res.path}）`);
  }
  log("[OK] agent 權限 guard 通過（writer 無 bash / reviewer 唯讀）");
}
```

- [ ] **Step 5: 接線 config.ts**

import 區新增：

```ts
import * as os from "node:os";
import { skillDirCandidates, runsDirFor } from "./libs/utils";
```

三處替換：

```ts
// 舊：
export const SKILL_DIR_CANDIDATES = [
  process.env.UT_SKILL_DIR,
  path.join(REPO_ROOT, ".opencode", "skills", "test-quality-evaluator"),
  path.join(REPO_ROOT, ".claude", "skills", "test-quality-evaluator"),
].filter(Boolean) as string[];
// 新：
// Rubric search order: env override -> target repo -> the tool's own copy.
export const SKILL_DIR_CANDIDATES = skillDirCandidates(
  REPO_ROOT,
  TESTGEN_ROOT,
  process.env.UT_SKILL_DIR,
);
```

```ts
// 舊：
export const RUNS_DIR = path.join(TESTGEN_ROOT, "runs");
// 新：
// Artifacts, namespaced per target repo.
export const RUNS_DIR = runsDirFor(TESTGEN_ROOT, REPO_ROOT);
```

檔尾新增：

```ts
// Global opencode config dir (agents/skill installed here by scripts/setup.ts).
export const GLOBAL_OPENCODE_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "opencode",
);
```

（config → libs/utils → libs/types，無循環依賴。）

- [ ] **Step 6: 驗證**

```bash
npx tsc --noEmit && npx tsx scripts/selftest.ts
```
Expected: `結果：42 passed / 0 failed`（34 + 8）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: central-clone resolution (agents repo->global, skill fallback, runs namespace)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 工具版本戳記

**Files:**
- Create: `libs/version.ts`
- Modify: `loop.ts`（banner 印版本 + params.json 加欄位）

**Interfaces:**
- Consumes: `TESTGEN_ROOT`（config）
- Produces: `getToolVersion(): string`，格式 `"<pkg version> (<git short SHA | no-git>)"`

- [ ] **Step 1: 建立 libs/version.ts**

```ts
// Tool version stamp: "<package version> (<git short SHA | no-git>)".
// Mitigates central-clone reproducibility loss — every run records which tool built it.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TESTGEN_ROOT } from "../config";

export function getToolVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(TESTGEN_ROOT, "package.json"), "utf8"));
  const pkgVersion = pkg.version ?? "0.0.0";
  let sha = "no-git";
  try {
    sha = execSync("git rev-parse --short HEAD", {
      cwd: TESTGEN_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // not a git clone — keep "no-git"
  }
  return `${pkgVersion} (${sha})`;
}
```

- [ ] **Step 2: loop.ts 接線**

import 區新增：`import { getToolVersion } from "./libs/version";`

`banner("write-java-ut pipeline 啟動");` 之後新增兩行：

```ts
  const toolVersion = getToolVersion();
  log(`工具版本：${toolVersion}`);
```

params.json 物件的 `runner: RUNNER_KIND,` 之後加一行：

```ts
        toolVersion,
```

- [ ] **Step 3: 驗證**

```bash
npx tsc --noEmit && npx tsx scripts/selftest.ts && npx tsx loop.ts
```
Expected: selftest 42 綠；`loop.ts`（無參數）先印 `工具版本：0.0.0 (…)` 之類再 `FATAL: 請提供要寫 UT 的類別資料夾…` 結束（package.json 尚無 version 欄位 → fallback 0.0.0；Task 7 升為 1.0.0）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: stamp tool version in banner and run artifacts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: scripts/setup.ts（global 安裝器）

**Files:**
- Create: `scripts/setup.ts`

**Interfaces:**
- Consumes: `TESTGEN_ROOT`、`GLOBAL_OPENCODE_DIR`（config）
- Produces: CLI 行為——冪等安裝 agents + skill 到 global dir，失敗非零退出。

- [ ] **Step 1: 建立 scripts/setup.ts**

```ts
// Install agents + the quality-evaluator skill into the global opencode dir. Idempotent.
// Run after every tool update: git pull && npm install && npm run setup
import * as fs from "node:fs";
import * as path from "node:path";
import { TESTGEN_ROOT, GLOBAL_OPENCODE_DIR } from "../config";

const ITEMS: Array<{ src: string; dst: string; dir?: boolean }> = [
  { src: ".opencode/agent/ut-writer.md", dst: "agent/ut-writer.md" },
  { src: ".opencode/agent/ut-reviewer.md", dst: "agent/ut-reviewer.md" },
  { src: ".opencode/skills/test-quality-evaluator", dst: "skills/test-quality-evaluator", dir: true },
];

console.log(`安裝目的地：${GLOBAL_OPENCODE_DIR}`);
let failed = false;
for (const item of ITEMS) {
  const src = path.join(TESTGEN_ROOT, item.src);
  const dst = path.join(GLOBAL_OPENCODE_DIR, item.dst);
  try {
    if (!fs.existsSync(src)) throw new Error(`來源不存在：${src}`);
    const existed = fs.existsSync(dst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (item.dir) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
    console.log(`  [${existed ? "updated" : "installed"}] ${item.dst}`);
  } catch (e) {
    failed = true;
    console.error(`  [FAIL] ${item.dst}：${e instanceof Error ? e.message : String(e)}`);
  }
}
if (failed) process.exit(1);
console.log("完成。目標 repo 的 .opencode/agent/ 內同名定義仍會優先於 global。");
```

- [ ] **Step 2: 實測（本機）**

```bash
npx tsc --noEmit && npx tsx scripts/setup.ts && ls ~/.config/opencode/agent/ ~/.config/opencode/skills/test-quality-evaluator/
```
Expected: 每項 `[installed]` 或 `[updated]`；ls 看到兩個 agent .md 與 skill 目錄（含 references/）。再跑一次全部變 `[updated]`（冪等）。

- [ ] **Step 3: Commit**

```bash
git add scripts/setup.ts && git commit -m "feat: add setup installer for global agents and skill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: scripts/doctor.ts（preflight 自診）

**Files:**
- Create: `scripts/doctor.ts`

**Interfaces:**
- Consumes: `resolveAgentPath` / `contractViolations` / `WRITER_RULES` / `REVIEWER_RULES`（guard）、`loadRubric`、`findModuleInfo`、config 各常數、`createRunner`（runners/runner——smoke 走 AgentRunner，遵守硬規則 #6）
- Produces: CLI 行為——`doctor [targetPath] [--smoke]`，FAIL 存在 → exit 1。

- [ ] **Step 1: 建立 scripts/doctor.ts**

注意：**env 預設必須寫在任何會載入 config 的 import 之前**——node 內建模組用靜態 import（不觸發 config），專案模組一律 `await import`（top-level await，tsconfig 為 ESNext 可用）。

```ts
// Preflight for the central-clone pipeline. Run from the target Java repo root.
// Usage: npx tsx <tool>/scripts/doctor.ts [targetPath] [--smoke]
// The env default below MUST run before importing ../config (dynamic imports only).
if (!process.env.UT_AGENT_TIMEOUT_MS) process.env.UT_AGENT_TIMEOUT_MS = "60000"; // short --smoke

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const config = await import("../config");
const { resolveAgentPath, contractViolations, WRITER_RULES, REVIEWER_RULES } = await import(
  "../libs/guard"
);
const { loadRubric } = await import("../libs/rubric");
const { findModuleInfo } = await import("../libs/utils");

type Status = "OK" | "WARN" | "FAIL";
const rows: Array<{ status: Status; name: string; note: string }> = [];
const add = (status: Status, name: string, note = "") => rows.push({ status, name, note });

const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const target = args.find((a) => !a.startsWith("--"));

// 1. node
const major = Number(process.versions.node.split(".")[0]);
add(major >= 20 ? "OK" : "FAIL", "node >= 20", `目前 ${process.versions.node}`);

// 2. opencode CLI
const ver = spawnSync(config.OPENCODE_BIN, ["--version"], { encoding: "utf8" });
if (ver.status === 0) add("OK", "opencode CLI", ver.stdout.trim());
else add("FAIL", "opencode CLI", `找不到 ${config.OPENCODE_BIN}——安裝 opencode 或設 UT_OPENCODE_BIN`);

// 3. agents (repo-local wins, global fallback)
for (const { name, rules } of [
  { name: "ut-writer", rules: WRITER_RULES },
  { name: "ut-reviewer", rules: REVIEWER_RULES },
]) {
  const res = resolveAgentPath(name, config.REPO_ROOT, config.GLOBAL_OPENCODE_DIR);
  if (!res) add("FAIL", `agent ${name}`, "repo 與 global 皆無——在工具 clone 執行 npm run setup");
  else {
    const errs = contractViolations(res.path, rules);
    if (errs.length) add("FAIL", `agent ${name}`, errs.join("；"));
    else add("OK", `agent ${name}`, `${res.source}：${res.path}`);
  }
}

// 4. rubric
const { rubric, source } = loadRubric(config.SKILL_DIR_CANDIDATES);
if (rubric) add("OK", "評分 rubric", source);
else add("WARN", "評分 rubric", "找不到 references/rubric.md——review gate 將退回 standards 全文");

// 5. standards
add(fs.existsSync(config.STANDARDS_PATH) ? "OK" : "FAIL", "品質標準檔", config.STANDARDS_PATH);

// 6-8. target-repo context
const hasPom = fs.existsSync(path.join(config.REPO_ROOT, "pom.xml"));
const hasGradle =
  fs.existsSync(path.join(config.REPO_ROOT, "build.gradle")) ||
  fs.existsSync(path.join(config.REPO_ROOT, "build.gradle.kts"));
const isToolItself =
  fs.existsSync(path.join(config.REPO_ROOT, "loop.ts")) &&
  fs.existsSync(path.join(config.REPO_ROOT, "scripts", "doctor.ts"));

if (hasPom || hasGradle) {
  add("OK", "Java repo（cwd）", config.REPO_ROOT);
  if (hasPom) {
    const wrapper = path.join(config.REPO_ROOT, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
    if (fs.existsSync(wrapper)) add("OK", "Maven", "使用 repo 內 mvnw");
    else if (spawnSync("mvn", ["-v"], { encoding: "utf8" }).status === 0)
      add("OK", "Maven", "使用 PATH 中的 mvn");
    else add("FAIL", "Maven", "無 mvnw 也無 mvn——安裝 Maven 或補 wrapper");
  } else {
    const wrapper = path.join(
      config.REPO_ROOT,
      process.platform === "win32" ? "gradlew.bat" : "gradlew",
    );
    if (fs.existsSync(wrapper)) add("OK", "Gradle", "使用 repo 內 gradlew");
    else if (spawnSync("gradle", ["-v"], { encoding: "utf8" }).status === 0)
      add("OK", "Gradle", "使用 PATH 中的 gradle");
    else add("FAIL", "Gradle", "無 gradlew 也無 gradle");
  }
  if (target) {
    const absTarget = path.resolve(config.REPO_ROOT, target);
    if (!fs.existsSync(absTarget)) add("FAIL", "目標路徑", `不存在：${absTarget}`);
    else {
      const mod = findModuleInfo(absTarget, config.REPO_ROOT);
      add("OK", "目標模組", mod.multiModule ? mod.moduleRel : "（單一模組）");
      const modPom = path.join(mod.moduleRoot, "pom.xml");
      if (fs.existsSync(modPom)) {
        if (fs.readFileSync(modPom, "utf8").includes("jacoco-maven-plugin"))
          add("OK", "JaCoCo", "模組 pom 含 jacoco-maven-plugin");
        else
          add(
            "WARN",
            "JaCoCo",
            '模組 pom 未見 jacoco——coverage gate 將略過；可加 plugin、設 UT_MAVEN_ARGS="jacoco:report" 或 UT_STRICT_COV=1',
          );
      } else add("WARN", "JaCoCo", "Gradle 模組：請自行確認 jacocoTestReport 設定");
    }
  } else add("WARN", "目標模組", "未提供目標路徑——帶上 <targetPath> 可加檢 JaCoCo");
} else if (isToolItself) {
  add("WARN", "Java repo（cwd）", "目前在工具 clone 內——環境項已檢查；到目標 Java repo 根再跑一次以檢查 repo 項目");
} else {
  add("FAIL", "Java repo（cwd）", "此目錄無 pom.xml / build.gradle——請在目標 Java repo 根執行");
}

// 9. --smoke: one read-only reviewer ping via AgentRunner (never spawn the agent CLI here)
if (smoke) {
  const { createRunner } = await import("../runners/runner");
  try {
    const runner = await createRunner();
    const out = await runner.runReview("這是連線測試，請只回覆：OK");
    if (out.trim()) add("OK", "smoke（reviewer）", out.trim().slice(0, 60));
    else add("FAIL", "smoke（reviewer）", "無回應——檢查 provider 設定（opencode auth）與 agent 的 model 欄位");
  } catch (e) {
    add("FAIL", "smoke（reviewer）", e instanceof Error ? e.message : String(e));
  }
}

console.log("\ntestgen doctor\n");
for (const r of rows) console.log(`  [${r.status}] ${r.name}${r.note ? ` — ${r.note}` : ""}`);
const fails = rows.filter((r) => r.status === "FAIL").length;
console.log(fails ? `\n${fails} 項 FAIL——依提示修復後重跑` : "\n全部通過（WARN 為提示性）");
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: 實測——工具 clone 內（repo 項應 WARN 不 FAIL）**

```bash
npx tsc --noEmit && npx tsx scripts/doctor.ts; echo "exit=$?"
```
Expected: node/opencode/agents/rubric/standards 為 OK（agents 來源 `global`，因 Task 5 已 setup；工具 repo 自帶 `.opencode` 則顯示 `repo`——皆可）；`Java repo（cwd）` 為 WARN；`exit=0`。

- [ ] **Step 3: 實測——假 Java repo（repo 項應 OK/WARN）**

```bash
FIX=$(mktemp -d)/javarepo && mkdir -p "$FIX/src/main/java/com/x"
printf '<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>fix</artifactId><version>1</version></project>' > "$FIX/pom.xml"
printf 'class Foo {}' > "$FIX/src/main/java/com/x/Foo.java"
cd "$FIX" && npx tsx <本工具絕對路徑>/scripts/doctor.ts src/main/java/com/x; echo "exit=$?"; cd -
```
Expected: `Java repo（cwd）` OK、`目標模組`（單一模組）OK、`JaCoCo` WARN；Maven 行依本機環境 OK 或 FAIL（如 FAIL 屬環境事實，不是 doctor 缺陷）；無 crash。

- [ ] **Step 4: Commit**

```bash
git add scripts/doctor.ts && git commit -m "feat: add doctor preflight (env + repo checks, --smoke via AgentRunner)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: bin wrapper + package.json scripts

**Files:**
- Create: `bin/testgen`（chmod +x）
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run check|setup|doctor`；`testgen [doctor|setup] [...]` wrapper；`version: 1.0.0`、`engines.node >= 20`。

- [ ] **Step 1: 建立 bin/testgen**

```bash
#!/usr/bin/env bash
# Thin wrapper: `testgen <target>` runs the loop; `testgen doctor|setup [...]` runs the scripts.
set -euo pipefail
TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX="$TOOL_DIR/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "先在 $TOOL_DIR 執行 npm install"; exit 1; }
case "${1:-}" in
  doctor) shift; exec "$TSX" "$TOOL_DIR/scripts/doctor.ts" "$@" ;;
  setup)  shift; exec "$TSX" "$TOOL_DIR/scripts/setup.ts" "$@" ;;
  *)      exec "$TSX" "$TOOL_DIR/loop.ts" "$@" ;;
esac
```

```bash
chmod +x bin/testgen
```

- [ ] **Step 2: 改 package.json（全檔取代）**

```json
{
  "name": "testgen",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "selftest": "tsx scripts/selftest.ts",
    "check": "tsc --noEmit && tsx scripts/selftest.ts",
    "setup": "tsx scripts/setup.ts",
    "doctor": "tsx scripts/doctor.ts"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

（注意：`npm run doctor` 的 cwd 是工具目錄——給安裝後環境自檢用；在目標 Java repo 要用 `bin/testgen doctor` 或 `npx tsx <clone>/scripts/doctor.ts`，README 會寫清楚。）

- [ ] **Step 3: 驗證**

```bash
npm run check && ./bin/testgen doctor >/dev/null; echo "doctor-exit=$?" && cd "$(mktemp -d)" && <本工具絕對路徑>/bin/testgen 2>&1 | head -5; cd -
```
Expected: check 綠（42 passed）；`doctor-exit=0`；最後一段印 banner + `工具版本：1.0.0 (…)` + `FATAL: 請提供要寫 UT 的類別資料夾…`。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add bin wrapper and npm scripts (check/setup/doctor), v1.0.0

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: README 重寫（使用者視角）

**Files:**
- Modify: `README.md`（全檔取代）
- Modify: `.env.example`（一行註解）

- [ ] **Step 1: README.md 全檔取代為：**

````markdown
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

> **部門設定（維運者填寫後 commit 本 README）**
> - writer 模型：`＿＿＿＿＿＿＿＿`（例：`vllm/qwen3-coder`，endpoint：＿＿＿＿）
> - reviewer 模型：`＿＿＿＿＿＿＿＿`（例：`anthropic/claude-sonnet-4-6`）

1. 設定 provider 憑證：`opencode auth login`（或部門 vLLM 的 OpenAI 相容 endpoint）。
2. 指定模型（二選一）：
   - 編輯 `~/.config/opencode/agent/ut-writer.md` / `ut-reviewer.md` 的 `model:` 欄位；或
   - 用環境變數覆蓋：`UT_WRITER_MODEL` / `UT_REVIEWER_MODEL`（格式 `provider/model`）。

建議：writer 用本地/便宜模型狂迭代、reviewer 用較強模型——cross-model 可降低
self-agreement bias。

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
- **writer 有跑但沒寫檔**：非互動模式 permission 被擋。確認 global 的 ut-writer.md 含
  `permission: edit: allow`；最後手段 `UT_OC_SKIP_PERMS=1`（writer 的 bash/web 本來就關閉）。
- **覆蓋率永遠略過**：模組沒綁 JaCoCo。加 jacoco-maven-plugin（prepare-agent + report 綁
  test phase），或 `UT_MAVEN_ARGS="jacoco:report"`；要強制擋關設 `UT_STRICT_COV=1`。
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

- 品質防線：`npm run check`（typecheck + selftest）；GitHub Actions 於 push/PR 自動執行。
- 修改測試標準：`standards/java-ut-standards.md`（writer 契約）；
  修改評分細則：`.opencode/skills/test-quality-evaluator/references/rubric.md`
  ——改完通知同事 `git pull && npm run setup`。
- 設計文件：`DESIGN.md`（架構決策與否決紀錄）、`AGENTS.md`（agent 操作規範）；
  規格與計畫：`docs/superpowers/`。
````

- [ ] **Step 2: .env.example 的 `#UT_SKILL_DIR=` 上一行註解改為：**

```
# 路徑覆蓋（UT_SKILL_DIR 未設時：目標 repo .opencode/.claude → 工具內建）
```

（原行為 `# 路徑覆蓋`。）

- [ ] **Step 3: 驗證與 Commit**

```bash
npm run check
git add README.md .env.example && git commit -m "docs: rewrite README for department consumers (central-clone)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: DESIGN.md / AGENTS.md / CLAUDE.md 更新

**Files:**
- Modify: `DESIGN.md`（4 處）
- Modify: `AGENTS.md`（5 處）
- Modify: `CLAUDE.md`（全檔取代）

先 `Read` 各檔現況再下 Edit（以下 old 錨點若因先前編輯略有出入，以「段落語義」對位）。

- [ ] **Step 1: DESIGN.md——架構圖第一行**

old：`npx tsx tools/testgen/loop.ts <目標>        （或由 opencode 自訂指令包一層 UX）`
new：`npx tsx <工具 clone>/loop.ts <目標>        （於目標 Java repo 根執行；或 bin/testgen wrapper）`

- [ ] **Step 2: DESIGN.md——SSOT 對照表（整表取代）**

```markdown
| 內容 | 位置 | 消費者 |
| --- | --- | --- |
| 測試撰寫標準 | <工具 clone>/standards/java-ut-standards.md | writer prompt（loop 注入） |
| 評分 rubric | skill 的 references/rubric.md（目標 repo .opencode/.claude → 工具內建） | reviewer prompt（loop 注入；SKILL.md 不注入） |
| 門檻與參數 | config.ts（env 可覆蓋） | gates / verdict |
| 角色契約與權限 | 目標 repo .opencode/agent/ 優先，否則 ~/.config/opencode/agent/（npm run setup 安裝） | opencode runtime + startup guard |
```

- [ ] **Step 3: DESIGN.md——已否決清單的 global 安裝條目取代為：**

```markdown
- ~~**global 安裝 pipeline/skill 供 loop 消費**~~：**superseded（2026-07-10，使用者決策）**——
  改採中央 clone + global agents（部門多 repo 下，per-repo vendoring 的維護成本高於
  per-repo 可重現性收益）。原否決理由以三項緩解：每次執行寫入工具版本戳記
  （banner + params.json）、doctor preflight、目標 repo `.opencode/` 同名定義仍優先
  （可專案化覆寫）。
```

- [ ] **Step 4: DESIGN.md——「目標與範圍」段尾補一句**

在該段落末尾加：`部署型態為中央 clone：工具 clone 一份，對任意 Java repo 執行。`

- [ ] **Step 5: AGENTS.md——「定位」整節取代**

```markdown
## 定位（重要）
本 repo 是**中央工具 clone**：clone 一份，對部門任何 Java repo 執行
（在目標 repo 根執行 `npx tsx <clone>/loop.ts <目標>` 或 `bin/testgen`）。
agent 定義與評分 skill 由 `npm run setup` 安裝到 `~/.config/opencode/`；
目標 repo `.opencode/` 內的同名定義優先（專案化覆寫）。
standards 與預設 rubric 隨本 repo 版控；每次執行寫入工具版本戳記。
```

- [ ] **Step 6: AGENTS.md——硬規則 #1 與高風險 #2 的路徑字面**

- 硬規則 #1：`core/orchestrator.ts + loop.ts` → `orchestrator.ts + loop.ts`（其餘文字不動）
- 高風險 #2：`review/verdict.ts 判定邏輯` → `gates/review.ts 判定邏輯`（其餘文字不動）

- [ ] **Step 7: AGENTS.md——「目錄結構」code block 整塊取代**

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

- [ ] **Step 8: AGENTS.md——「常用指令」code block 整塊取代**

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

- [ ] **Step 9: CLAUDE.md 全檔取代**（保持既有前言兩行 + 更新後內容；沿用原結構，路徑與指令改為整併後/中央模式；「四個必須理解的機制」第 3 點的 rubric 搜尋順序改為「`UT_SKILL_DIR` → 目標 repo `.opencode`/`.claude` → 工具內建」；SSOT 表同 DESIGN 新表；硬規則引用路徑改 `orchestrator.ts`、`gates/review.ts`；常用指令區塊同 AGENTS 新版並加 `npm run setup` / `doctor`；架構節的兩個控制流檔案改為「`loop.ts` + `orchestrator.ts`（根目錄並排）」，`review/` 相關描述改 `gates/review.ts`，prompts 描述改單檔 `prompts.ts`；其餘原則性內容不變。）

- [ ] **Step 10: 驗證與 Commit**

```bash
npm run check
grep -rn "core/orchestrator\|review/verdict\|review/gate\|prompts/generate\|tools/testgen" --include="*.md" README.md AGENTS.md DESIGN.md CLAUDE.md || echo "docs clean"
git add -A && git commit -m "docs: update DESIGN/AGENTS/CLAUDE for central-clone mode and new layout

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Expected: grep 印 `docs clean`（docs/superpowers/ 下的歷史 spec/plan 不在掃描範圍，保留原文）。

---

### Task 10: CHANGELOG + 清理

**Files:**
- Create: `CHANGELOG.md`
- Delete（staged）: `CHANGES.md`（working tree 已刪）
- Modify: `.gitignore`（補回結尾換行）

- [ ] **Step 1: 建立 CHANGELOG.md**

```markdown
# Changelog

使用者可見的變更記錄。更新方式：`git pull && npm install && npm run setup`。

## [1.0.0] - 2026-07-10

### Added
- Central-clone 模式：工具 clone 一份即可對任意 Java repo 執行。
- `npm run setup`：agents + 評分 skill 安裝至 `~/.config/opencode/`（目標 repo 同名定義優先）。
- `npm run doctor`：preflight 自診；`--smoke` 經唯讀 reviewer 實測 provider。
- `bin/testgen` wrapper；工具版本戳記（banner 與 `runs/<repo>/<ts>/params.json`）。
- CI：GitHub Actions 跑 typecheck + selftest。

### Changed
- 目錄整併：`core/`、`review/` 併入根目錄與 `gates/`；三個 prompt 檔合為 `prompts.ts`。
- `runs/` 依目標 repo 名稱分隔命名空間。
- 程式碼註解全面改為極簡英文（文件與 runtime 訊息維持繁中）。
```

- [ ] **Step 2: .gitignore 全檔取代（內容同現況、補回結尾換行）**

```
node_modules/
runs/
.env
```

- [ ] **Step 3: Stage 刪除與 Commit**

```bash
git rm --cached CHANGES.md 2>/dev/null || true
git add -A
git status --porcelain   # 應包含 D CHANGES.md、A CHANGELOG.md、M .gitignore
git commit -m "chore: replace CHANGES.md with CHANGELOG.md, fix .gitignore trailing newline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: CI workflow

**Files:**
- Create: `.github/workflows/check.yml`

- [ ] **Step 1: 建立 .github/workflows/check.yml**

```yaml
name: check
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run check
```

- [ ] **Step 2: Commit**

```bash
git add .github && git commit -m "ci: run typecheck + selftest on push and PR

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

（workflow 實跑要等 push；本 task 驗證僅 yaml 落地。）

---

### Task 12: 最終驗證清單（不產生 commit，除非發現需修）

- [ ] `npm run check` → 42 passed / 0 failed、tsc 無輸出。
- [ ] `npm run setup` → 全部 `[updated]`（冪等重跑）。
- [ ] `npm run doctor` 於工具目錄 → exit 0，repo 項 WARN。
- [ ] Task 6 Step 3 的假 Java repo doctor → 各 row 符合預期。
- [ ] `./bin/testgen`（無參數、於暫存目錄執行）→ 印版本 `1.0.0 (<sha>)` 後 FATAL 提示用法。
- [ ] SDK 隔離：`grep -rn "@qwen-code/sdk\|@opencode-ai" --include="*.ts" --exclude-dir=node_modules --exclude-dir=runners .` → 無輸出。
- [ ] `git status` clean；`git log --oneline` 每 task 一 commit。
- [ ] 向使用者回報兩個「環境相依待驗證項」：(a) `doctor --smoke` 需 provider 憑證；(b) 真 Java repo 端對端一輪。
