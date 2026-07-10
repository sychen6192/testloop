/**
 * Rubric loader（injection over discovery）。
 * 只注入「評分細則」：references/rubric.md → rubric.md → rubric/*.md。
 * 刻意不注入 SKILL.md 全文——那是批次稽核的 workflow 文件（六輸入確認、
 * concurrency、environment probe），對單輪 review gate 的 reviewer 是錯誤指令。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function loadRubric(candidates: string[]): { rubric: string; source: string } {
  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    const files: string[] = [];

    const refRubric = path.join(dir, "references", "rubric.md");
    if (fs.existsSync(refRubric)) files.push(refRubric);

    if (files.length === 0) {
      const flat = path.join(dir, "rubric.md");
      if (fs.existsSync(flat)) files.push(flat);
    }
    if (files.length === 0) {
      const rubricDir = path.join(dir, "rubric");
      if (fs.existsSync(rubricDir)) {
        for (const f of fs.readdirSync(rubricDir).sort()) {
          if (f.endsWith(".md")) files.push(path.join(rubricDir, f));
        }
      }
    }
    if (files.length > 0) {
      const rubric = files.map((f) => fs.readFileSync(f, "utf8")).join("\n\n---\n\n");
      return { rubric, source: files.join(", ") };
    }
  }
  return { rubric: "", source: "" };
}
