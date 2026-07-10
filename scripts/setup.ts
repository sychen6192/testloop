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
