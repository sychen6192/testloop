// Tools for the api runner: the writer's and reviewer's whole world, implemented in-process.
//
// This is where the runner's permissions live. The opencode runner asks an agent file for
// `bash: false` and has libs/guard.ts assert it; here there is simply no bash tool to grant.
// The reviewer is read-only because its tool list has no write in it, and the writer cannot
// leave the module's test tree because write_file refuses the path. The snapshot guards in
// orchestrator.ts still run afterwards — this layer is what makes them rarely fire, and what
// gives the model an error it can act on instead of a run that aborts later.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ToolContext {
  repoRoot: string;
  // Writes are refused outside this directory; undefined = this session cannot write at all.
  writableRoot?: string;
  // Tool results are clipped to this many characters — a 2000-line class must not eat the
  // model's whole context in one read.
  maxResultChars: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
}

const IGNORED_DIRS = new Set(["target", "build", "node_modules"]);
const MAX_LIST_ENTRIES = 300;
const MAX_SEARCH_MATCHES = 60;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const str = (v: unknown, def = ""): string => (typeof v === "string" ? v : def);

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "read_file",
    readOnly: true,
    description: "讀取 repo 內一個檔案的完整內容。path 相對於 repo 根目錄。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相對於 repo 根目錄的檔案路徑" } },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    readOnly: true,
    description:
      "遞迴列出目錄下的檔案（略過 target / build / node_modules）。可用 pattern 以 glob 過濾檔名，例如 *Test.java。",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "相對於 repo 根目錄的目錄；預設為根目錄" },
        pattern: { type: "string", description: "檔名 glob，例如 *ServiceImpl.java" },
      },
      required: [],
    },
  },
  {
    name: "search",
    readOnly: true,
    description: "以正規表示式在檔案內容中搜尋，回傳「路徑:行號: 內容」。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正規表示式（JavaScript 語法）" },
        dir: { type: "string", description: "限定目錄；預設整個 repo" },
        glob: { type: "string", description: "檔名 glob 過濾，例如 *.java" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    readOnly: false,
    description:
      "建立或整個覆寫一個測試檔。只允許目標模組的 src/test/ 底下；production code、pom.xml 與其他路徑一律拒絕。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相對於 repo 根目錄的檔案路徑" },
        content: { type: "string", description: "完整檔案內容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "replace_in_file",
    readOnly: false,
    description:
      "在既有測試檔中把 old_string 精確替換為 new_string。old_string 必須在檔案中恰好出現一次；先用 read_file 確認精確內容。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
];

// The reviewer's tool list is the read-only subset; nothing else makes it read-only.
export function toolsFor(readOnly: boolean): ToolSpec[] {
  return TOOL_SPECS.filter((t) => !readOnly || t.readOnly);
}

// OpenAI chat-completions `tools` shape.
export function toOpenAiTools(specs: readonly ToolSpec[]): unknown[] {
  return specs.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Pure: the absolute path for `target` if it stays inside `root`, else null. path.relative-
// based, because a plain startsWith would accept /work/repo-evil as being inside /work/repo.
export function resolveInside(root: string, target: string): string | null {
  const abs = path.resolve(root, target);
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) ? abs : null;
}

function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

// Depth-first, sorted, skipping build output and dot-dirs. `visit` returns false to stop.
function walkFiles(dir: string, visit: (abs: string) => boolean | void): void {
  let stopped = false;
  const walk = (d: string) => {
    if (stopped) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (stopped) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !IGNORED_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && visit(p) === false) {
        stopped = true;
      }
    }
  };
  walk(dir);
}

function clip(s: string, max: number): string {
  return s.length <= max
    ? s
    : `${s.slice(0, max)}\n…（已截斷，原長 ${s.length} 字元；請用 search 定位後分段讀取）`;
}

/**
 * Execute one tool call. Never throws: every failure is returned as a string starting with
 * "錯誤：" so the model sees it and can try again — a thrown error would end the session.
 */
export function execTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  allowed: readonly ToolSpec[],
): string {
  const spec = allowed.find((t) => t.name === name);
  if (!spec) {
    return `錯誤：未知或不允許的工具 ${name}。可用工具：${allowed.map((t) => t.name).join(", ")}`;
  }
  const relOf = (abs: string) => path.relative(ctx.repoRoot, abs).replace(/\\/g, "/");
  try {
    switch (name) {
      case "read_file": {
        const rel = str(args.path);
        const abs = resolveInside(ctx.repoRoot, rel);
        if (!abs) return `錯誤：路徑不在 repo 內：${rel}`;
        if (!fs.existsSync(abs)) return `錯誤：檔案不存在：${rel}`;
        if (fs.statSync(abs).isDirectory()) return `錯誤：${rel} 是目錄，請用 list_files`;
        return clip(fs.readFileSync(abs, "utf8"), ctx.maxResultChars);
      }
      case "list_files": {
        const rel = str(args.dir, ".");
        const abs = resolveInside(ctx.repoRoot, rel);
        if (!abs) return `錯誤：路徑不在 repo 內：${rel}`;
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `錯誤：目錄不存在：${rel}`;
        const re = str(args.pattern) ? globToRegExp(str(args.pattern)) : null;
        const out: string[] = [];
        let truncated = false;
        walkFiles(abs, (f) => {
          if (re && !re.test(path.basename(f))) return;
          if (out.length >= MAX_LIST_ENTRIES) {
            truncated = true;
            return false;
          }
          out.push(relOf(f));
        });
        if (!out.length) return "（沒有符合的檔案）";
        return (
          out.join("\n") +
          (truncated ? `\n…（超過 ${MAX_LIST_ENTRIES} 個，已截斷；請縮小 dir 或 pattern）` : "")
        );
      }
      case "search": {
        let re: RegExp;
        try {
          re = new RegExp(str(args.pattern));
        } catch (e) {
          return `錯誤：正規表示式無效：${e instanceof Error ? e.message : String(e)}`;
        }
        const rel = str(args.dir, ".");
        const abs = resolveInside(ctx.repoRoot, rel);
        if (!abs) return `錯誤：路徑不在 repo 內：${rel}`;
        if (!fs.existsSync(abs)) return `錯誤：目錄不存在：${rel}`;
        const globRe = str(args.glob) ? globToRegExp(str(args.glob)) : null;
        const matches: string[] = [];
        let truncated = false;
        walkFiles(abs, (f) => {
          if (globRe && !globRe.test(path.basename(f))) return;
          let st: fs.Stats;
          try {
            st = fs.statSync(f);
          } catch {
            return;
          }
          if (st.size > MAX_SCAN_BYTES) return;
          const lines = fs.readFileSync(f, "utf8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            if (matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true;
              return false;
            }
            matches.push(`${relOf(f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        });
        if (!matches.length) return "（沒有符合的內容）";
        return (
          matches.join("\n") +
          (truncated ? `\n…（超過 ${MAX_SEARCH_MATCHES} 筆，已截斷；請縮小 pattern、dir 或 glob）` : "")
        );
      }
      case "write_file":
      case "replace_in_file": {
        const rel = str(args.path);
        if (!ctx.writableRoot) return `錯誤：此 session 沒有寫入權限，無法寫 ${rel}`;
        const abs = resolveInside(ctx.repoRoot, rel);
        if (!abs) return `錯誤：路徑不在 repo 內：${rel}`;
        if (!resolveInside(ctx.writableRoot, abs)) {
          return (
            `錯誤：拒絕寫入 ${rel}——只允許 ${relOf(ctx.writableRoot)}/ 底下的測試檔。` +
            `production code、pom.xml 與其他模組一律唯讀；若測試需要 production 端改動，請在總結中說明，交由人類處理。`
          );
        }
        if (name === "write_file") {
          if (typeof args.content !== "string") return "錯誤：content 必須是字串";
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, args.content);
          return `已寫入 ${rel}（${args.content.length} 字元）`;
        }
        if (!fs.existsSync(abs)) return `錯誤：檔案不存在：${rel}（要建立新檔請用 write_file）`;
        const oldS = str(args.old_string);
        const newS = str(args.new_string);
        if (!oldS) return "錯誤：old_string 不得為空";
        const src = fs.readFileSync(abs, "utf8");
        let count = 0;
        for (let i = src.indexOf(oldS); i !== -1; i = src.indexOf(oldS, i + oldS.length)) count++;
        if (count === 0) return `錯誤：在 ${rel} 找不到 old_string，請先 read_file 確認精確內容（含空白與縮排）`;
        if (count > 1) return `錯誤：old_string 在 ${rel} 出現 ${count} 次，請提供更長的唯一片段`;
        fs.writeFileSync(abs, src.replace(oldS, () => newS));
        return `已替換 ${rel} 中的一處`;
      }
      default:
        return `錯誤：工具 ${name} 尚未實作`;
    }
  } catch (e) {
    return `錯誤：${e instanceof Error ? e.message : String(e)}`;
  }
}
