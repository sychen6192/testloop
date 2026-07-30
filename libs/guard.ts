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
  ["webfetch", "false"],
];

export const REVIEWER_RULES: readonly ContractRule[] = [
  ["write", "false"],
  ["edit", "false"],
  ["bash", "false"], // reviewer is fully read-only
  ["webfetch", "false"],
];

// Both guard sites (startup assert + doctor) check the same two agents.
export const AGENT_SPECS = [
  { name: "ut-writer", rules: WRITER_RULES },
  { name: "ut-reviewer", rules: REVIEWER_RULES },
] as const;

// The `tools:` map from an agent file's frontmatter. A targeted parser, not YAML:
// opencode agent files use exactly `tools:\n  <key>: <true|false>` two-space nesting.
// Parsing the real block (instead of regex-matching anywhere in the frontmatter) stops a
// `description:` that merely mentions "bash: false" from satisfying the guard.
export function parseToolsBlock(frontmatter: string): Record<string, string> {
  const tools: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  let inTools = false;
  for (const line of lines) {
    if (/^tools:\s*$/.test(line)) {
      inTools = true;
      continue;
    }
    if (inTools) {
      const m = line.match(/^\s{2}([A-Za-z_-]+):\s*(\S+)/);
      if (m) tools[m[1]] = m[2];
      else if (!/^\s/.test(line)) inTools = false; // left the tools block
    }
  }
  return tools;
}

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
  const tools = parseToolsBlock(m[1]);
  const errs: string[] = [];
  for (const [key, value] of rules) {
    if (tools[key] !== value) {
      errs.push(
        `${path.basename(filePath)} 必須明確設定 tools.${key}: ${value}` +
          `（實際為 ${tools[key] ?? "未設定"}；架構契約，見 DESIGN.md）`,
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
  for (const { name, rules } of AGENT_SPECS) {
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
