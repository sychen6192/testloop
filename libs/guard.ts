// Startup guard: assert the agent permission contract at launch.
// Docs drift, this doesn't — it fails instantly if writer gets bash or reviewer can write.
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT, SKIP_GUARD } from "../config";
import { die, log } from "./log";

function frontmatterOf(p: string): string {
  if (!fs.existsSync(p)) die(`缺少 agent 定義：${p}`);
  const t = fs.readFileSync(p, "utf8");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) die(`${p} 缺少 frontmatter（--- ... ---）`);
  return m[1];
}

function mustContain(fm: string, file: string, key: string, value: "true" | "false") {
  if (!new RegExp(`${key}:\\s*${value}\\b`).test(fm)) {
    die(`${file} 必須明確設定 tools.${key}: ${value}（架構契約，見 DESIGN.md）`);
  }
}

export function assertAgents() {
  if (SKIP_GUARD) {
    log("[WARN] 已跳過 agent 權限 guard（UT_SKIP_GUARD=1）");
    return;
  }
  const writerPath = path.join(REPO_ROOT, ".opencode", "agent", "ut-writer.md");
  const w = frontmatterOf(writerPath);
  mustContain(w, "ut-writer.md", "write", "true");
  mustContain(w, "ut-writer.md", "edit", "true");
  mustContain(w, "ut-writer.md", "bash", "false"); // verification stays in the loop

  const reviewerPath = path.join(REPO_ROOT, ".opencode", "agent", "ut-reviewer.md");
  const r = frontmatterOf(reviewerPath);
  mustContain(r, "ut-reviewer.md", "write", "false");
  mustContain(r, "ut-reviewer.md", "edit", "false");
  mustContain(r, "ut-reviewer.md", "bash", "false"); // reviewer is fully read-only

  log("[OK] agent 權限 guard 通過（writer 無 bash / reviewer 唯讀）");
}
