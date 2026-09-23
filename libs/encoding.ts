// The encoding the module's Java sources are compiled with, and what the loop does when it is
// not UTF-8.
//
// A UTF-8 test file compiled as MS950 is not the test the writer wrote. Depending on the
// toolchain, javac either rejects the bytes it cannot map (standalone javac, a forked compiler)
// or reports them and compiles on: maven-compiler-plugin 3.13 on JDK 21 prints "[ERROR]
// unmappable character", then BUILD SUCCESS, with "含稅金額" compiled to eight characters of
// mojibake. So the module fails to compile, or every Chinese expectation in the test silently
// differs from the production string it is compared with — and the writer, copying the right
// text from the failure report back into a UTF-8 file, can never make it match. MS950 is common
// in older department repos: set explicitly, or, with no project.build.sourceEncoding, as the
// platform encoding of a zh-TW Windows machine on a JDK before 18; and the writer's prompts are
// Chinese, so Chinese comments and literals are the likely output. Worse, an agent's edit tool
// reads and writes UTF-8: editing an existing MS950 test file changed every Chinese character in
// it — string literals included — and the file went on compiling.
//
// So around every agent session the test sources are shown in a form every tool reads and writes
// faithfully: ASCII, with each non-ASCII character as the \uXXXX escape javac translates before
// anything else. After the session, a file the agent left alone gets its original bytes back; one
// it edited keeps the original bytes of every line it did not change, and its own lines are
// written in the module's encoding, by the JDK — the same charset javac reads them with.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TESTGEN_ROOT } from "../config";
import { onShutdown } from "./shell";
import { pomFactsFromChain, readPomChain, resolvePomValue } from "./teststack";
import { ModuleInfo } from "./types";

export interface SourceEncoding {
  name: string;
  /**
   * "pom": configured (the pom, or build.gradle's options.encoding); "platform": Maven fell back
   * to the platform encoding, as its build log says; "jdk": the JDK's default charset — what the
   * platform encoding will be — before any build has said.
   */
  source: "pom" | "platform" | "jdk";
}

export function isUtf8Name(name: string): boolean {
  return /^utf-?8$/i.test(name.trim());
}

// ─── Measurement ─────────────────────────────────────────────────────────────

// What Maven prints when no encoding is configured: the resources plugin's 2.x wording, 3.x's (and
// the compiler plugin's) — which ends the name with a period: "…platform encoding UTF-8. Build is
// platform dependent!", read as an encoding named "UTF-8." that was not UTF-8.
const PLATFORM_ENCODING = [
  /Using platform encoding \(([^\s)]+) actually\)/,
  /File encoding has not been set, using platform encoding ([^\s,]+?)\.?(?=[\s,]|$)/,
];

/**
 * Pure: the platform encoding a build log names, preferring what was printed for `artifactId`'s
 * own module (a reactor build prints one per module, "--- … @ <artifactId> ---" before each).
 */
export function platformEncodingFromLog(buildLog: string, artifactId?: string): string | undefined {
  let current: string | undefined;
  let first: string | undefined;
  for (const line of buildLog.split(/\r?\n/)) {
    const header = /--- \S.*? @ (\S+) ---/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    for (const re of PLATFORM_ENCODING) {
      const m = re.exec(line);
      if (!m) continue;
      if (artifactId && current === artifactId) return m[1];
      first ??= m[1];
    }
  }
  return first;
}

/**
 * Pure: the effective source encoding. The compiler plugin's own <encoding> wins over
 * project.build.sourceEncoding, which wins over what Maven reported falling back to.
 */
export function sourceEncodingFrom(
  pom: { compilerEncoding?: string; sourceEncoding?: string },
  buildLog: string,
  artifactId?: string,
): SourceEncoding | undefined {
  const configured = pom.compilerEncoding ?? pom.sourceEncoding;
  if (configured && !/\$\{/.test(configured)) return { name: configured, source: "pom" };
  const platform = platformEncodingFromLog(buildLog, artifactId);
  return platform ? { name: platform, source: "platform" } : undefined;
}

/** Pure: options.encoding from a Gradle build script. */
export function gradleEncoding(script: string): string | undefined {
  return /options\.encoding\s*=\s*["']([\w.:-]+)["']/.exec(script.replace(/\/\/.*$/gm, ""))?.[1];
}

/**
 * The module's source encoding: the pom (or build.gradle), else the platform encoding the latest
 * build's log names, else — before any build has said — the JDK's default charset.
 */
export function measureSourceEncoding(mod: ModuleInfo, repoRoot: string, buildLog = ""): SourceEncoding | undefined {
  let pom: { compilerEncoding?: string; sourceEncoding?: string } = {};
  let artifactId: string | undefined;
  try {
    const facts = pomFactsFromChain(readPomChain(mod.moduleRoot, repoRoot).map((c) => c.xml));
    artifactId = facts.artifactId;
    pom = {
      compilerEncoding: facts.compiler.encoding,
      // ${…} resolved against the chain's properties: <encoding>${project.build.sourceEncoding}</encoding>.
      sourceEncoding: resolvePomValue(facts, facts.properties["project.build.sourceEncoding"]),
    };
  } catch {
    /* no readable pom: the log may still say */
  }
  for (const dir of [mod.moduleRoot, repoRoot]) {
    for (const f of ["build.gradle", "build.gradle.kts"]) {
      try {
        const enc = gradleEncoding(fs.readFileSync(path.join(dir, f), "utf8"));
        if (enc) pom.compilerEncoding ??= enc;
      } catch {
        /* no such script */
      }
    }
  }
  const measured = sourceEncodingFrom(pom, buildLog, artifactId);
  if (measured) return measured;
  const jdk = findJdk();
  const def = jdk ? jdkDefaultCharset(jdk) : undefined;
  return def ? { name: def, source: "jdk" } : undefined;
}

/**
 * Pure: a new measurement where it is better. A build that said what encoding Maven fell back to
 * outranks the JDK default read before it; the JDK default never replaces what a build said.
 */
export function refineSourceEncoding(prev: SourceEncoding | undefined, next: SourceEncoding | undefined): SourceEncoding | undefined {
  if (!next || (next.source === "jdk" && prev && prev.source !== "jdk")) return prev;
  return next;
}

export function describeSourceEncoding(enc: SourceEncoding): string {
  return `${enc.name}（${enc.source === "pom" ? "專案設定" : enc.source === "platform" ? "pom 沒設定，Maven 用平台編碼" : "沒有設定，JDK 預設編碼"}）`;
}

// ─── Java source text ────────────────────────────────────────────────────────

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function isValidUtf8(buf: Buffer): boolean {
  try {
    utf8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

export function hasNonAscii(buf: Buffer): boolean {
  for (const b of buf) if (b > 0x7f) return true;
  return false;
}

/**
 * Pure: `text` with each character `escape` selects (default: every non-ASCII one) written as a
 * \uXXXX escape — the same program in bytes an ASCII-compatible encoding reads identically, since
 * javac translates Unicode escapes before anything else. A \ is only the start of an escape when
 * an even number of backslashes precede it, so one right after an odd run (a Windows path in a
 * comment: C:\資料) would not be read as one; that backslash becomes \u005c. A leading byte-order
 * mark is dropped rather than escaped: it is not a character javac accepts anywhere.
 */
export function escapeNonAscii(text: string, escape: (codeUnit: number) => boolean = (c) => c >= 0x80): string {
  let out = "";
  let run = 0; // raw backslashes at the end of `out`
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (!escape(c)) {
      out += src[i];
      run = src[i] === "\\" ? run + 1 : 0;
      continue;
    }
    if (run % 2 === 1) out = `${out.slice(0, -1)}\\u005c`;
    out += `\\u${c.toString(16).padStart(4, "0")}`;
    run = 0;
  }
  return out;
}

const UNICODE_ESCAPE = /\\u+([0-9a-fA-F]{4})/y;

/**
 * Pure: the \uXXXX escapes of non-ASCII characters written back as the characters — for text an
 * agent edited in its escaped form. Only escapes javac would read as escapes (an even number of
 * backslashes before them), and only non-ASCII ones: \u0022 or \u005c can mean something to the
 * lexer that the character itself would not. A surrogate pair becomes its one character.
 */
export function unescapeNonAscii(text: string): string {
  let out = "";
  let run = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\" && run % 2 === 0) {
      UNICODE_ESCAPE.lastIndex = i;
      const m = UNICODE_ESCAPE.exec(text);
      if (m) {
        const code = parseInt(m[1], 16);
        if (code >= 0xd800 && code <= 0xdbff) {
          UNICODE_ESCAPE.lastIndex = i + m[0].length;
          const low = UNICODE_ESCAPE.exec(text);
          const lowCode = low ? parseInt(low[1], 16) : -1;
          if (low && lowCode >= 0xdc00 && lowCode <= 0xdfff) {
            out += String.fromCharCode(code, lowCode);
            i += m[0].length + low[0].length;
            run = 0;
            continue;
          }
        } else if (code >= 0x80 && !(code >= 0xdc00 && code <= 0xdfff)) {
          out += String.fromCharCode(code);
          i += m[0].length;
          run = 0;
          continue;
        }
      }
    }
    run = text[i] === "\\" ? run + 1 : 0;
    out += text[i];
    i++;
  }
  return out;
}

/** U+FFFD: what a character becomes when a tool decoded bytes in the wrong encoding. It stays lost. */
export const REPLACEMENT = "\uFFFD";

/**
 * Pure: an edited version of a file the agent saw as an ASCII view, as lines to write — the
 * original's own bytes for every line the agent left as it was, and its own text (escapes of
 * non-ASCII characters written back as the characters) for the rest. In every ASCII-compatible
 * encoding javac reads, 0x0A is a line feed and never part of a multibyte character, so the
 * original's lines are its bytes split at 0x0A. Lines are matched by content, ignoring a trailing
 * CR; the agent's own lines get the original's line ending when that is CRLF.
 */
export function mergeEdited(original: Buffer, view: string, edited: string): Array<Buffer | string> {
  const origLines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < original.length; i++) {
    if (original[i] === 0x0a) {
      origLines.push(original.subarray(start, i));
      start = i + 1;
    }
  }
  origLines.push(original.subarray(start));
  const viewLines = view.split("\n");
  const byView = new Map<string, Buffer>();
  if (viewLines.length === origLines.length) {
    viewLines.forEach((l, i) => {
      const key = l.replace(/\r$/, "");
      if (!byView.has(key)) byView.set(key, origLines[i]);
    });
  }
  const terminated = origLines.slice(0, -1);
  const crlf = terminated.length > 0 && terminated.filter((l) => l[l.length - 1] === 0x0d).length * 2 >= terminated.length;
  const lines = edited.split("\n");
  return lines.map((line, i) => {
    const last = i === lines.length - 1;
    if (last && line === "") return "";
    const known = byView.get(line.replace(/\r$/, ""));
    if (known) return known;
    const text = unescapeNonAscii(line);
    return crlf && !last && !text.endsWith("\r") ? `${text}\r` : text;
  });
}

// ─── The JDK ─────────────────────────────────────────────────────────────────

export interface Jdk {
  java: string;
  classDir: string;
}

function jdkTool(name: string): string | undefined {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const home = process.env.JAVA_HOME;
  if (home) {
    const p = path.join(home, "bin", exe);
    if (fs.existsSync(p)) return p;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

let jdk: Jdk | null | undefined;

/**
 * The transcoder, compiled once per JDK and source into the system temp directory: JAVA_HOME's
 * JDK, else the one on PATH — where Maven finds it. undefined when there is no JDK to compile it
 * with; the loop then falls back to protecting what it cannot convert.
 */
export function findJdk(): Jdk | undefined {
  if (jdk !== undefined) return jdk ?? undefined;
  jdk = null;
  const java = jdkTool("java");
  const javac = jdkTool("javac");
  if (!java || !javac) return undefined;
  const source = path.join(TESTGEN_ROOT, "libs", "java", "Transcode.java");
  let src: string;
  try {
    src = fs.readFileSync(source, "utf8");
  } catch {
    return undefined;
  }
  const key = createHash("sha1").update(src).update(javac).digest("hex").slice(0, 12);
  const classDir = path.join(os.tmpdir(), `testgen-transcode-${key}`);
  if (!fs.existsSync(path.join(classDir, "Transcode.class"))) {
    // Compiled into a fresh directory and moved into place, so a run racing this one never loads
    // a half-written class.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-transcode-"));
    const compile = (args: string[]) =>
      spawnSync(javac, [...args, "-nowarn", "-d", tmp, source], { stdio: "ignore", timeout: 120_000 }).status === 0;
    if (!compile(["--release", "8"]) && !compile([])) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return undefined;
    }
    try {
      fs.renameSync(tmp, classDir);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another run got there first
    }
  }
  jdk = { java, classDir };
  return jdk;
}

/** Test support: forget the JDK found, so the next call looks again (JAVA_HOME / PATH changed). */
export function resetJdkForTests(): void {
  jdk = undefined;
}

function transcode(j: Jdk, args: string[], request: string): string[] | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-tc-"));
  try {
    const req = path.join(dir, "request.txt");
    fs.writeFileSync(req, request);
    const r = spawnSync(j.java, ["-cp", j.classDir, "Transcode", ...args.map((a) => (a === "{req}" ? req : a))], {
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
    return r.stdout.replace(/\r/g, "").split("\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const defaultCharsets = new Map<string, string | undefined>();

/** The JDK's default charset — the platform encoding Maven falls back to without a configured one. */
export function jdkDefaultCharset(j: Jdk): string | undefined {
  if (!defaultCharsets.has(j.java)) defaultCharsets.set(j.java, transcode(j, ["info"], "")?.[0]?.trim() || undefined);
  return defaultCharsets.get(j.java);
}

/** Each file decoded strictly in `charset`: its text, or why it is not valid in that charset. */
export function jdkDecode(j: Jdk, charset: string, files: string[]): Map<string, string | Error> {
  const out = new Map<string, string | Error>();
  if (!files.length) return out;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-tc-"));
  try {
    const outs = files.map((_, i) => path.join(dir, `${i}.txt`));
    const status = transcode(j, ["decode", charset, "{req}"], files.map((f, i) => `${f}\t${outs[i]}`).join("\n"));
    files.forEach((f, i) => {
      const s = status?.[i] ?? "ERR transcoder did not answer";
      if (s === "OK") {
        try {
          out.set(f, fs.readFileSync(outs[i], "utf8"));
          return;
        } catch (e) {
          out.set(f, e as Error);
          return;
        }
      }
      out.set(f, new Error(s.replace(/^ERR /, "")));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

/** Each text encoded in `charset`, escaping first what the charset cannot hold. undefined per text that failed. */
export function jdkEncode(j: Jdk, charset: string, texts: string[]): Array<Buffer | undefined> {
  if (!texts.length) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-tc-"));
  try {
    // One probe for every character the texts hold outside ASCII.
    const chars = [...new Set(texts.join("").replace(/[\x00-\x7f]/g, ""))].join("");
    const probeFile = path.join(dir, "probe.txt");
    fs.writeFileSync(probeFile, chars);
    const probe = chars ? transcode(j, ["probe", charset, "{req}"], probeFile) : [""];
    if (!probe) return texts.map(() => undefined);
    const missing = new Set<number>();
    for (const hex of (probe[0] ?? "").split(" ").filter(Boolean)) {
      const cp = parseInt(hex, 16);
      if (cp > 0xffff) {
        missing.add(0xd800 + ((cp - 0x10000) >> 10));
        missing.add(0xdc00 + ((cp - 0x10000) & 0x3ff));
      } else missing.add(cp);
    }
    const ins = texts.map((t, i) => {
      const f = path.join(dir, `in-${i}.txt`);
      fs.writeFileSync(f, escapeNonAscii(t, (c) => missing.has(c)));
      return f;
    });
    const outs = texts.map((_, i) => path.join(dir, `out-${i}.bin`));
    const status = transcode(j, ["encode", charset, "{req}"], ins.map((f, i) => `${f}\t${outs[i]}`).join("\n"));
    return texts.map((_, i) => {
      if (status?.[i] !== "OK") return undefined;
      try {
        return fs.readFileSync(outs[i]);
      } catch {
        return undefined;
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Around an agent session ─────────────────────────────────────────────────

interface Viewed {
  original: Buffer;
  view: Buffer;
  atime: Date;
  mtime: Date;
}

export interface EncodingView {
  encoding: SourceEncoding;
  /** "transcode": the JDK converts. "protect": no JDK — what cannot be written safely is put back. */
  mode: "transcode" | "protect";
  root: string;
  jdk?: Jdk;
  /** Files shown as their ASCII view, by absolute path. */
  viewed: Map<string, Viewed>;
  /**
   * Files that cannot be shown or written safely — not valid in the module's encoding (or, with no
   * JDK, anything outside ASCII): put back byte for byte if the session touched them.
   */
  protectedFiles: Map<string, Buffer>;
  /** The files that were all ASCII: an agent that writes characters into one keeps its other lines' bytes. */
  plain: Map<string, Buffer>;
}

export interface ViewResult {
  /** Files whose characters outside ASCII were written in the module's encoding (or, without a JDK, escaped). */
  converted: string[];
  /** Protected files the session changed or deleted: put back. */
  restored: string[];
  /** Files the agent wrote U+FFFD into: characters already lost when a tool read something in the wrong encoding. */
  replacement: string[];
  /** Files that could not be converted: put back when they existed before, left as written otherwise. */
  failed: string[];
}

const openViews = new Set<EncodingView>();

// Ctrl-C in the middle of a session must not leave the tree in its escaped form.
onShutdown(() => restoreOpenViews());

/** Puts every view still open back to its original bytes — the interrupt and crash paths. */
export function restoreOpenViews(): void {
  for (const v of openViews) {
    for (const [file, f] of v.viewed) {
      try {
        fs.writeFileSync(file, f.original);
        fs.utimesSync(file, f.atime, f.mtime);
      } catch {
        /* best effort on the way out */
      }
    }
  }
  openViews.clear();
}

function javaFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".java")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Before an agent session in a module whose sources are not UTF-8: every test source under `root`
 * (src/test/java — test resources are data, not sources, and are left alone) that holds characters
 * outside ASCII is replaced by its ASCII view. undefined when the module is UTF-8 or unmeasured.
 */
export function openEncodingView(enc: SourceEncoding | undefined, root: string): EncodingView | undefined {
  if (!enc || isUtf8Name(enc.name)) return undefined;
  const j = findJdk();
  const view: EncodingView = {
    encoding: enc,
    mode: j ? "transcode" : "protect",
    root,
    jdk: j,
    viewed: new Map(),
    protectedFiles: new Map(),
    plain: new Map(),
  };
  const candidates = new Map<string, { buf: Buffer; st: fs.Stats }>();
  for (const file of javaFiles(root)) {
    try {
      const buf = fs.readFileSync(file);
      if (hasNonAscii(buf)) candidates.set(file, { buf, st: fs.statSync(file) });
      else view.plain.set(file, buf);
    } catch {
      /* unreadable: nothing to show or protect */
    }
  }
  if (!j) {
    // Without the JDK nothing outside ASCII can be shown or written back faithfully — not even a
    // file that happens to be valid UTF-8, which in an MS950 module is either mojibake already or
    // MS950 bytes that decode as UTF-8 by accident.
    for (const [file, c] of candidates) view.protectedFiles.set(file, c.buf);
    openViews.add(view);
    return view;
  }
  const decoded = jdkDecode(j, enc.name, [...candidates.keys()]);
  for (const [file, c] of candidates) {
    const text = decoded.get(file);
    if (typeof text !== "string") {
      view.protectedFiles.set(file, c.buf);
      continue;
    }
    const ascii = Buffer.from(escapeNonAscii(text), "latin1");
    try {
      fs.writeFileSync(file, ascii);
      view.viewed.set(file, { original: c.buf, view: ascii, atime: c.st.atime, mtime: c.st.mtime });
    } catch {
      view.protectedFiles.set(file, c.buf);
    }
  }
  openViews.add(view);
  return view;
}

/**
 * After the session: files the agent left alone get their original bytes and times back (the
 * build sees nothing changed), files it edited are written in the module's encoding, and what
 * cannot be written safely is put back or reported.
 */
export function closeEncodingView(view: EncodingView): ViewResult {
  const result: ViewResult = { converted: [], restored: [], replacement: [], failed: [] };
  openViews.delete(view);
  const now = new Set(javaFiles(view.root));
  // Texts to encode, and how to put each file together from them.
  const jobs: Array<{ file: string; parts: Array<Buffer | string>; restore?: Buffer }> = [];

  for (const [file, v] of view.viewed) {
    if (!now.has(file)) continue; // deleted: whether that was allowed is the shrink guard's call
    let cur: Buffer;
    try {
      cur = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (cur.equals(v.view)) {
      fs.writeFileSync(file, v.original);
      fs.utimesSync(file, v.atime, v.mtime);
      continue;
    }
    if (!isValidUtf8(cur)) {
      // Not written by an agent tool: nothing to merge. The original goes back.
      fs.writeFileSync(file, v.original);
      result.failed.push(file);
      continue;
    }
    const text = cur.toString("utf8");
    if (text.includes(REPLACEMENT)) result.replacement.push(file);
    jobs.push({ file, parts: mergeEdited(v.original, v.view.toString("latin1"), text), restore: v.original });
  }

  for (const [file, original] of view.protectedFiles) {
    let cur: Buffer | undefined;
    try {
      cur = fs.readFileSync(file);
    } catch {
      cur = undefined;
    }
    if (cur && cur.equals(original)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);
    result.restored.push(file);
  }

  // The rest the agent wrote is its own text — files it created, ASCII files it edited: characters
  // outside ASCII, typed or copied from the view as escapes, are written in the module's encoding.
  // The lines it did not change keep their bytes, escapes their author wrote on purpose included.
  for (const file of now) {
    if (view.viewed.has(file) || view.protectedFiles.has(file)) continue;
    let cur: Buffer;
    try {
      cur = fs.readFileSync(file);
    } catch {
      continue;
    }
    const before = view.plain.get(file);
    if ((before && cur.equals(before)) || !isValidUtf8(cur)) continue;
    const text = cur.toString("utf8");
    if (!hasNonAscii(cur) && unescapeNonAscii(text) === text) continue;
    if (text.includes(REPLACEMENT)) result.replacement.push(file);
    jobs.push({ file, parts: before ? mergeEdited(before, before.toString("latin1"), text) : text.split("\n").map(unescapeNonAscii) });
  }

  if (view.mode === "protect" || !view.jdk) {
    for (const job of jobs) {
      const text = job.parts.map((p) => (typeof p === "string" ? p : p.toString("latin1"))).join("\n");
      fs.writeFileSync(job.file, escapeNonAscii(text), "latin1");
      result.converted.push(job.file);
    }
  } else {
    // One encode per file: its own lines joined, split again at the line feeds. A file whose every
    // line is the original's (line endings changed, lines moved) has nothing to encode.
    const own = jobs.map((job) => job.parts.filter((p) => typeof p === "string").length);
    const toEncode = jobs.filter((_, i) => own[i] > 0);
    const encodedSome = jdkEncode(
      view.jdk,
      view.encoding.name,
      toEncode.map((job) => job.parts.filter((p): p is string => typeof p === "string").join("\n")),
    );
    const encoded = jobs.map((job) => (own[jobs.indexOf(job)] > 0 ? encodedSome[toEncode.indexOf(job)] : Buffer.alloc(0)));
    jobs.forEach((job, i) => {
      const bytes = encoded[i];
      const pieces: Buffer[] = [];
      if (bytes && own[i] > 0) {
        let start = 0;
        for (let k = 0; k < bytes.length; k++) {
          if (bytes[k] === 0x0a) {
            pieces.push(bytes.subarray(start, k));
            start = k + 1;
          }
        }
        pieces.push(bytes.subarray(start));
      }
      if (!bytes || pieces.length !== own[i]) {
        if (job.restore) fs.writeFileSync(job.file, job.restore);
        result.failed.push(job.file);
        return;
      }
      let next = 0;
      const out = job.parts.map((p) => (typeof p === "string" ? pieces[next++] : p));
      fs.writeFileSync(job.file, Buffer.concat(out.flatMap((b, k) => (k === 0 ? [b] : [Buffer.from([0x0a]), b]))));
      result.converted.push(job.file);
    });
  }
  for (const list of Object.values(result)) list.sort();
  return result;
}
