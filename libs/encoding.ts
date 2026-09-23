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
// written in the module's encoding, by the JDK — the same charset javac reads them with. The
// escaped form is the same program to javac, so whatever goes wrong, a file left in it still
// compiles to the same thing; only its bytes differ.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TESTGEN_ROOT } from "../config";
import { log } from "./log";
import { onShutdown } from "./shell";
import { pomFactsFromChain, readPomChain, resolvePomValue } from "./teststack";
import { ModuleInfo } from "./types";

export interface SourceEncoding {
  name: string;
  /**
   * "pom": configured — the pom chain, a Spring Boot parent (UTF-8), build.gradle.
   * "platform": the platform encoding the build falls back to, as the build says (Maven's log line,
   * Gradle's -Dfile.encoding).
   * "sniffed": configured somewhere the loop cannot read (a parent outside the repo, a profile,
   * settings.xml) and not UTF-8 — the module's own sources are not; which encoding they are is not
   * known, so nothing is converted, only protected.
   */
  source: "pom" | "platform" | "sniffed";
}

export function isUtf8Name(name: string): boolean {
  return /^utf-?8$/i.test(name.trim());
}

/** A non-UTF-8 encoding of unknown name: sniffed from the sources. */
export const UNKNOWN_ENCODING = "非 UTF-8（名稱不明）";

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

/**
 * Pure: the compile encoding a Gradle build script sets — on compileJava / compileTestJava or a
 * JavaCompile task, not a javadoc block's options.encoding, which says nothing about javac.
 */
export function gradleEncoding(script: string): string | undefined {
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return /(?:compileTestJava|compileJava|JavaCompile)[\s\S]{0,200}?options\.encoding\s*=\s*["']([\w.:-]+)["']/.exec(code)?.[1];
}

/** Pure: the Gradle daemon's -Dfile.encoding, from gradle.properties' org.gradle.jvmargs. */
export function gradleDaemonEncoding(properties: string): string | undefined {
  const jvmargs = /^\s*org\.gradle\.jvmargs\s*[=:](.*)$/m.exec(properties)?.[1] ?? "";
  return /-Dfile\.encoding=([\w.:-]+)/.exec(jvmargs)?.[1];
}

const sniffed = new Map<string, boolean>();

/**
 * Whether the module's own Java sources hold characters outside ASCII that are not UTF-8 — then
 * javac cannot be reading them as UTF-8 in a module that builds. Cached per module for the run.
 */
function sourcesAreNonUtf8(moduleRoot: string): boolean {
  const cached = sniffed.get(moduleRoot);
  if (cached !== undefined) return cached;
  let found = false;
  for (const tree of [path.join(moduleRoot, "src", "main", "java"), path.join(moduleRoot, "src", "test", "java")]) {
    for (const file of javaFiles(tree)) {
      try {
        const buf = fs.readFileSync(file);
        if (hasNonAscii(buf) && !isValidUtf8(buf)) {
          found = true;
          break;
        }
      } catch {
        /* unreadable */
      }
    }
    if (found) break;
  }
  sniffed.set(moduleRoot, found);
  return found;
}

/**
 * The module's source encoding: the pom chain (a Spring Boot parent sets UTF-8), build.gradle, else
 * the platform encoding the latest build names, else — configured somewhere out of sight — what
 * the sources themselves say: not UTF-8 when they are not. undefined: UTF-8 as far as anything shows.
 *
 * Never the JDK's default charset. Maven prints the platform encoding whenever it uses it; a build
 * that does not print it has one configured, by a parent outside the repo more often than not, and
 * guessing the JDK default there turned a UTF-8 Spring Boot module on a zh-TW Windows JDK 17 into
 * "MS950" — every character the writer wrote saved in bytes javac then read as UTF-8.
 */
export function measureSourceEncoding(mod: ModuleInfo, repoRoot: string, buildLog = ""): SourceEncoding | undefined {
  let pom: { compilerEncoding?: string; sourceEncoding?: string } = {};
  let artifactId: string | undefined;
  let bootParent = false;
  try {
    const facts = pomFactsFromChain(readPomChain(mod.moduleRoot, repoRoot).map((c) => c.xml));
    artifactId = facts.artifactId;
    bootParent = facts.externalParent === "spring-boot-starter-parent";
    pom = {
      compilerEncoding: facts.compiler.encoding,
      // ${…} resolved against the chain's properties: <encoding>${project.build.sourceEncoding}</encoding>.
      sourceEncoding: resolvePomValue(facts, facts.properties["project.build.sourceEncoding"]),
    };
  } catch {
    /* no readable pom: the log may still say */
  }
  let daemon: string | undefined;
  for (const dir of [mod.moduleRoot, repoRoot]) {
    for (const f of ["build.gradle", "build.gradle.kts"]) {
      try {
        const enc = gradleEncoding(fs.readFileSync(path.join(dir, f), "utf8"));
        if (enc) pom.compilerEncoding ??= enc;
      } catch {
        /* no such script */
      }
    }
    try {
      daemon ??= gradleDaemonEncoding(fs.readFileSync(path.join(dir, "gradle.properties"), "utf8"));
    } catch {
      /* none */
    }
  }
  const measured = sourceEncodingFrom(pom, buildLog, artifactId);
  if (measured) return measured;
  // spring-boot-starter-parent has set project.build.sourceEncoding=UTF-8 since 1.x.
  if (bootParent) return { name: "UTF-8", source: "pom" };
  if (daemon) return { name: daemon, source: "platform" };
  return sourcesAreNonUtf8(mod.moduleRoot) ? { name: UNKNOWN_ENCODING, source: "sniffed" } : undefined;
}

/**
 * Pure: a new measurement where it is better. What is configured or said by a build outranks what
 * the sources suggest; a build that says nothing leaves what an earlier one said.
 */
export function refineSourceEncoding(prev: SourceEncoding | undefined, next: SourceEncoding | undefined): SourceEncoding | undefined {
  if (!next || (next.source === "sniffed" && prev && prev.source !== "sniffed")) return prev;
  return next;
}

export function describeSourceEncoding(enc: SourceEncoding): string {
  const why =
    enc.source === "pom"
      ? "專案設定"
      : enc.source === "platform"
        ? "沒有設定，建置用平台編碼"
        : "設定不在 repo 裡（多半是 repo 外的 parent），但原始碼不是 UTF-8";
  return `${enc.name}（${why}）`;
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
 * Pure: `text` with each character `escape` selects (default: every one outside ASCII) written as
 * \uXXXX — the same program in bytes an ASCII-compatible encoding reads identically, since javac
 * translates Unicode escapes before anything else. Decided per code point: a character outside the
 * BMP is escaped as its two surrogates or not at all. A \ is only the start of an escape when an
 * even number of backslashes precede it, so one right after an odd run (a Windows path in a
 * comment: C:\資料) would not be read as one; that backslash becomes \u005c. `dropBom`: a byte-order
 * mark at the start of a file is dropped — javac accepts it nowhere — and only there.
 */
export function escapeNonAscii(
  text: string,
  escape: (codePoint: number) => boolean = (c) => c >= 0x80,
  opts: { dropBom?: boolean } = {},
): string {
  let out = "";
  let run = 0; // raw backslashes at the end of `out`
  const src = opts.dropBom && text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i)!;
    const units = cp > 0xffff ? 2 : 1;
    if (!escape(cp)) {
      out += src.slice(i, i + units);
      run = src[i] === "\\" ? run + 1 : 0;
      i += units;
      continue;
    }
    if (run % 2 === 1) out = `${out.slice(0, -1)}\\u005c`;
    for (let k = 0; k < units; k++) out += `\\u${src.charCodeAt(i + k).toString(16).padStart(4, "0")}`;
    run = 0;
    i += units;
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
const REPLACEMENT_ESCAPE = /\\u+fffd/i;

/**
 * Pure: an edited version of a file the agent saw as an ASCII view, as lines to write — the
 * original's own bytes for every line the agent left as it was, and its own text (escapes of
 * non-ASCII characters written back as the characters) for the rest. In every ASCII-compatible
 * encoding javac reads, 0x0A is a line feed and never part of a multibyte character, so the
 * original's lines are its bytes split at 0x0A. Lines are matched by content, ignoring a trailing
 * CR, occurrence by occurrence (two lines that read alike can differ in bytes: MS950 has
 * characters with two encodings); the agent's own lines get the original's line ending when that
 * is CRLF.
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
  // Lines, not the empty remainder after a final line feed: an inserted blank line is the agent's.
  const byView = new Map<string, Buffer[]>();
  if (viewLines.length === origLines.length) {
    const last = viewLines.length - 1;
    viewLines.forEach((l, i) => {
      if (i === last && l === "") return;
      const key = l.replace(/\r$/, "");
      const list = byView.get(key) ?? [];
      list.push(origLines[i]);
      byView.set(key, list);
    });
  }
  const used = new Map<string, number>();
  const terminated = origLines.slice(0, -1);
  const crlf = terminated.length > 0 && terminated.filter((l) => l[l.length - 1] === 0x0d).length * 2 >= terminated.length;
  const lines = edited.split("\n");
  return lines.map((line, i) => {
    const last = i === lines.length - 1;
    if (last && line === "") return "";
    const key = line.replace(/\r$/, "");
    const known = byView.get(key);
    if (known) {
      const n = used.get(key) ?? 0;
      used.set(key, n + 1);
      return known[Math.min(n, known.length - 1)];
    }
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

// Only this user can have written it: a directory, or a class in it, that another user could
// write — a shared /tmp — would be code this run executes.
function ownedPrivately(p: string): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  try {
    const st = fs.lstatSync(p);
    return !st.isSymbolicLink() && st.uid === process.getuid() && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

// Where what the loop keeps between runs lives, this user's alone: the compiled transcoder, the
// journal of views in progress.
function cacheTop(): string {
  const base =
    process.env.LOCALAPPDATA ||
    (process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : "") ||
    path.join(os.homedir(), ".cache");
  return path.join(base, "testgen");
}

/** A directory under the cache, created if asked and there is none; undefined when it is not ours alone. */
function cacheDir(sub: string[], create = true): string | undefined {
  const top = cacheTop();
  const dir = path.join(top, ...sub);
  if (create) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return undefined;
    }
  } else if (!fs.existsSync(dir)) {
    return undefined;
  }
  for (let d = dir; ; d = path.dirname(d)) {
    if (!ownedPrivately(d)) return undefined;
    if (d === top) break;
  }
  return dir;
}

let jdk: Jdk | null | undefined;
let transcoderWarned = false;

function warnTranscoder(why: string): void {
  if (transcoderWarned) return;
  transcoderWarned = true;
  log(`[WARN] JDK 轉碼器無法使用，非 UTF-8 的測試檔改用保守做法（含非 ASCII 的既有檔不讓改）：${why}`);
}

/**
 * The transcoder: JAVA_HOME's JDK, else the one on PATH — where Maven finds it — with the class
 * compiled once per JDK and source into this user's cache, and checked to answer before it is
 * trusted. undefined when there is none that works; the loop then protects what it cannot convert.
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
  const cache = cacheDir([]);
  const cached = cache ? path.join(cache, `transcode-${key}`) : undefined;
  let classDir: string | undefined;
  if (cached && fs.existsSync(path.join(cached, "Transcode.class")) && ownedPrivately(cached) && ownedPrivately(path.join(cached, "Transcode.class"))) {
    classDir = cached;
  } else {
    // Compiled into a fresh private directory and moved into place, so a run racing this one never
    // loads a half-written class; when the move is refused, the fresh directory is used as it is.
    let tmp: string;
    try {
      tmp = fs.mkdtempSync(path.join(cache ?? os.tmpdir(), "transcode-"));
    } catch {
      return undefined;
    }
    const compile = (args: string[]) =>
      spawnSync(javac, [...args, "-nowarn", "-d", tmp, source], { stdio: "ignore", timeout: 120_000 }).status === 0;
    if (!compile(["--release", "8"]) && !compile([])) {
      fs.rmSync(tmp, { recursive: true, force: true });
      warnTranscoder(`${javac} 編譯 Transcode.java 失敗`);
      return undefined;
    }
    classDir = tmp;
    if (cached) {
      try {
        fs.renameSync(tmp, cached);
        classDir = cached;
      } catch {
        if (fs.existsSync(path.join(cached, "Transcode.class")) && ownedPrivately(cached)) {
          fs.rmSync(tmp, { recursive: true, force: true }); // another run got there first
          classDir = cached;
        }
      }
    }
  }
  const candidate = { java, classDir };
  const info = transcode(candidate, ["info"], "", 60_000);
  if (!info?.[0]) return undefined;
  defaultCharsets.set(java, info[0]);
  jdk = candidate;
  return jdk;
}

/** Test support: forget the JDK found, so the next call looks again (JAVA_HOME / PATH changed). */
export function resetJdkForTests(): void {
  jdk = undefined;
  transcoderWarned = false;
  checkedCharsets.clear();
}

const PROTOCOL = "@@tc ";

function transcode(j: Jdk, args: string[], request: string, timeoutMs = 300_000): string[] | undefined {
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-tc-"));
  } catch (e) {
    warnTranscoder(`無法建立暫存目錄：${(e as Error).message}`);
    return undefined;
  }
  try {
    const req = path.join(dir, "request.txt");
    fs.writeFileSync(req, request);
    const r = spawnSync(j.java, ["-cp", j.classDir, "Transcode", ...args.map((a) => (a === "{req}" ? req : a))], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    const answers =
      typeof r.stdout === "string"
        ? r.stdout
            .replace(/\r/g, "")
            .split("\n")
            .filter((l) => l.startsWith(PROTOCOL))
            .map((l) => l.slice(PROTOCOL.length))
        : [];
    if (r.status !== 0 || !answers.length) {
      const err = (typeof r.stderr === "string" ? r.stderr : "")
        .split("\n")
        .filter((l) => l && !l.startsWith("Picked up "))
        .slice(-3)
        .join(" / ");
      warnTranscoder(`${args[0]} 失敗（${r.error ? r.error.message : `exit ${r.status}`}）${err ? `：${err}` : ""}`);
      return undefined;
    }
    return answers;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const defaultCharsets = new Map<string, string | undefined>();

/** The JDK's default charset. Not used to guess a module's encoding — see measureSourceEncoding. */
export function jdkDefaultCharset(j: Jdk): string | undefined {
  if (!defaultCharsets.has(j.java)) defaultCharsets.set(j.java, transcode(j, ["info"], "")?.[0]?.trim() || undefined);
  return defaultCharsets.get(j.java);
}

const checkedCharsets = new Map<string, string>();

/** "ok", "unknown" (no such charset in this JDK) or "notascii" (0x0A is not a line feed, and so on). */
export function jdkCheckCharset(j: Jdk, charset: string): string {
  if (!checkedCharsets.has(charset)) checkedCharsets.set(charset, transcode(j, ["check", charset], "")?.[0] ?? "failed");
  return checkedCharsets.get(charset)!;
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

/**
 * Each text encoded in `charset`, escaping first what the charset cannot hold as itself — and
 * U+FFFD always, so a lost character is never saved as if it were one. undefined per text that failed.
 */
export function jdkEncode(j: Jdk, charset: string, texts: string[], timeoutMs?: number): Array<Buffer | undefined> {
  if (!texts.length) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testgen-tc-"));
  try {
    // One probe for every character the texts hold outside ASCII.
    const chars = [...new Set(texts.join("").replace(/[\x00-\x7f]/g, ""))].join("");
    const probeFile = path.join(dir, "probe.txt");
    fs.writeFileSync(probeFile, chars);
    const probe = chars ? transcode(j, ["probe", charset, "{req}"], probeFile, timeoutMs) : [""];
    if (!probe) return texts.map(() => undefined);
    const missing = new Set<number>((probe[0] ?? "").split(" ").filter(Boolean).map((hex) => parseInt(hex, 16)));
    missing.add(0xfffd);
    const ins = texts.map((t, i) => {
      const f = path.join(dir, `in-${i}.txt`);
      fs.writeFileSync(f, escapeNonAscii(t, (cp) => missing.has(cp) || (cp >= 0xd800 && cp <= 0xdfff)));
      return f;
    });
    const outs = texts.map((_, i) => path.join(dir, `out-${i}.bin`));
    const status = transcode(j, ["encode", charset, "{req}"], ins.map((f, i) => `${f}\t${outs[i]}`).join("\n"), timeoutMs);
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

/**
 * The given sources, decoded in the module's encoding and shown as their ASCII view — for files an
 * agent reads but the loop does not put in a view on disk (production code: never touched). Only
 * files that hold characters outside ASCII; none without a working JDK.
 */
export function sourceViews(enc: SourceEncoding | undefined, files: string[]): Array<{ file: string; view: string }> {
  if (!enc || isUtf8Name(enc.name) || enc.source === "sniffed") return [];
  const j = findJdk();
  if (!j || jdkCheckCharset(j, enc.name) !== "ok") return [];
  const nonAscii = files.filter((f) => {
    try {
      return hasNonAscii(fs.readFileSync(f));
    } catch {
      return false;
    }
  });
  const decoded = jdkDecode(j, enc.name, nonAscii);
  return nonAscii.flatMap((file) => {
    const text = decoded.get(file);
    return typeof text === "string" ? [{ file, view: escapeNonAscii(text, undefined, { dropBom: true }) }] : [];
  });
}

// ─── Around an agent session ─────────────────────────────────────────────────

interface Viewed {
  original: Buffer;
  view: Buffer;
  atime: Date;
  mtime: Date;
  /**
   * The agent's own UTF-8 text from earlier in the run, before the encoding was known or while it
   * could not be converted: written in the module's encoding at close even if left alone.
   */
  agentText?: string;
}

export interface EncodingView {
  encoding: SourceEncoding;
  /**
   * "transcode": the JDK converts. "protect": no conversion is possible — no working JDK, or an
   * encoding whose name is not known — and what cannot be written safely is put back.
   */
  mode: "transcode" | "protect";
  root: string;
  jdk?: Jdk;
  /** Files shown as their ASCII view, by absolute path. */
  viewed: Map<string, Viewed>;
  /**
   * Files that existed before the run and cannot be shown or written safely — not valid in the
   * module's encoding, or, when nothing converts, anything outside ASCII: put back byte for byte
   * if the session touched them.
   */
  protectedFiles: Map<string, Buffer>;
  /** The files that were all ASCII: an agent that writes characters into one keeps its other lines' bytes. */
  plain: Map<string, Buffer>;
  /** Files the agent wrote earlier in the run: never protected from it, checked for lost characters. */
  agentFiles: Set<string>;
  journal?: string;
}

export interface ViewResult {
  /** Files whose characters outside ASCII were written in the module's encoding (or, when nothing converts, escaped). */
  converted: string[];
  /** Protected files the session changed or deleted: put back. */
  restored: string[];
  /** Files the agent wrote U+FFFD into: characters already lost when a tool read something in the wrong encoding. */
  replacement: string[];
  /** Files that could not be written back or converted, with why. */
  failed: string[];
}

const openViews = new Set<EncodingView>();

// Ctrl-C in the middle of a session must not leave the tree in its escaped form.
onShutdown(() => finishOpenViews(20_000));

/**
 * Closes every view still open — the interrupt and crash paths — so the agent's work is written in
 * the module's encoding like at any session's end; a view that cannot be closed has its originals
 * put back instead.
 */
export function finishOpenViews(timeoutMs = 20_000): void {
  for (const v of [...openViews]) {
    try {
      closeEncodingView(v, { timeoutMs });
    } catch {
      restoreView(v);
    }
  }
  openViews.clear();
}

/** Puts every view still open back to its original bytes, discarding what was written into it. */
export function restoreOpenViews(): void {
  for (const v of [...openViews]) restoreView(v);
  openViews.clear();
}

function restoreView(v: EncodingView): void {
  for (const [file, f] of v.viewed) {
    try {
      fs.writeFileSync(file, f.original);
      fs.utimesSync(file, f.atime, f.mtime);
    } catch {
      /* best effort on the way out */
    }
  }
  if (v.journal) fs.rmSync(v.journal, { recursive: true, force: true });
  openViews.delete(v);
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

const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");

// The journal: what a view replaced, kept on disk while it is open, so a run killed without a chance
// to put anything back (the OOM killer, a cancelled CI job) is undone by the next run on the repo.
function journalDir(root: string, create: boolean): string | undefined {
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    /* as given */
  }
  return cacheDir(["views", createHash("sha1").update(real).digest("hex").slice(0, 16)], create);
}

function writeJournal(root: string, entries: Array<{ file: string; original: Buffer; view: Buffer }>): string | undefined {
  const dir = journalDir(root, true);
  if (!dir) return undefined;
  try {
    const manifest = entries.map((e, i) => {
      fs.writeFileSync(path.join(dir, `${i}.bin`), e.original);
      return { file: e.file, view: sha1(e.view), original: `${i}.bin` };
    });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    return dir;
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

/**
 * At the start of a run: puts back the files a killed run left in their view, from its journal —
 * each one only while it still is exactly that view. Returns the files put back.
 */
export function recoverEncodingViews(root: string): string[] {
  const dir = journalDir(root, false);
  if (!dir) return [];
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    fs.rmSync(dir, { recursive: true, force: true }); // a journal cut short before its manifest
    return [];
  }
  const restored: string[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Array<{ file: string; view: string; original: string }>;
    for (const e of manifest) {
      try {
        if (sha1(fs.readFileSync(e.file)) !== e.view) continue;
        fs.writeFileSync(e.file, fs.readFileSync(path.join(dir, e.original)));
        restored.push(e.file);
      } catch {
        /* gone or changed since: leave it */
      }
    }
  } catch {
    /* unreadable journal: nothing to do */
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return restored.sort();
}

/**
 * Before an agent session in a module whose sources are not UTF-8: every test source under `root`
 * (src/test/java — test resources are data, not sources, and are left alone) that holds characters
 * outside ASCII is replaced by its ASCII view. undefined when the module is UTF-8 or unmeasured.
 * `agentFiles`: the files the agent has written this run (absolute) — its own text, never protected
 * from it: one it wrote in UTF-8 before the encoding was known is converted now.
 */
export function openEncodingView(
  enc: SourceEncoding | undefined,
  root: string,
  opts: { agentFiles?: Iterable<string> } = {},
): EncodingView | undefined {
  if (!enc || isUtf8Name(enc.name)) return undefined;
  let j = enc.source === "sniffed" ? undefined : findJdk();
  if (j) {
    const check = jdkCheckCharset(j, enc.name);
    if (check === "unknown" || check === "notascii") {
      warnTranscoder(check === "unknown" ? `這個 JDK 不認得編碼 ${enc.name}` : `${enc.name} 不是與 ASCII 相容的編碼`);
      if (check === "notascii") return undefined; // nothing written in ASCII would be right either
      j = undefined;
    } else if (check !== "ok") j = undefined;
  }
  const view: EncodingView = {
    encoding: enc,
    mode: j ? "transcode" : "protect",
    root,
    jdk: j,
    viewed: new Map(),
    protectedFiles: new Map(),
    plain: new Map(),
    agentFiles: new Set(opts.agentFiles ?? []),
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
  const agentUtf8 = (file: string, buf: Buffer) => view.agentFiles.has(file) && isValidUtf8(buf);
  if (!j) {
    // Nothing outside ASCII can be shown or written back faithfully — not even a file that happens
    // to be valid UTF-8, which in an MS950 module is mojibake already or MS950 by accident. The
    // agent's own UTF-8 from earlier in the run is escaped now, as it would have been then.
    for (const [file, c] of candidates) {
      if (agentUtf8(file, c.buf)) {
        const ascii = Buffer.from(escapeNonAscii(c.buf.toString("utf8"), undefined, { dropBom: true }), "latin1");
        try {
          fs.writeFileSync(file, ascii);
          view.plain.set(file, ascii);
          continue;
        } catch {
          /* protected below */
        }
      }
      view.protectedFiles.set(file, c.buf);
    }
    openViews.add(view);
    return view;
  }
  const decoded = jdkDecode(j, enc.name, [...candidates.keys()]);
  const shown: Array<{ file: string; original: Buffer; view: Buffer; st: fs.Stats; agentText?: string }> = [];
  for (const [file, c] of candidates) {
    const text = decoded.get(file);
    if (typeof text === "string") {
      shown.push({ file, original: c.buf, view: Buffer.from(escapeNonAscii(text, undefined, { dropBom: true }), "latin1"), st: c.st });
    } else if (agentUtf8(file, c.buf)) {
      const own = c.buf.toString("utf8");
      shown.push({ file, original: c.buf, view: Buffer.from(escapeNonAscii(own, undefined, { dropBom: true }), "latin1"), st: c.st, agentText: own });
    } else {
      view.protectedFiles.set(file, c.buf);
    }
  }
  // The originals go to the journal before any file is replaced; no journal, no view.
  if (shown.length) {
    view.journal = writeJournal(root, shown);
    if (!view.journal) {
      log("[WARN] 無法寫入編碼轉換的復原日誌，這一輪不轉換：含非 ASCII 的既有測試檔不讓改");
      for (const s of shown) if (!s.agentText) view.protectedFiles.set(s.file, s.original);
      view.mode = "protect";
      view.jdk = undefined;
      openViews.add(view);
      return view;
    }
  }
  openViews.add(view);
  for (const s of shown) {
    try {
      fs.writeFileSync(s.file, s.view);
      view.viewed.set(s.file, { original: s.original, view: s.view, atime: s.st.atime, mtime: s.st.mtime, agentText: s.agentText });
    } catch {
      view.protectedFiles.set(s.file, s.original);
    }
  }
  return view;
}

/**
 * After the session: files the agent left alone get their original bytes and times back (the
 * build sees nothing changed), files it edited are written in the module's encoding, and what
 * cannot be written safely is put back or reported. A file that fails is reported and the others
 * still go through; the view stays open, for the crash path, until every file has.
 */
export function closeEncodingView(view: EncodingView, opts: { timeoutMs?: number } = {}): ViewResult {
  const result: ViewResult = { converted: [], restored: [], replacement: [], failed: [] };
  const fail = (file: string, e: unknown) =>
    result.failed.push(`${file}（${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e)}）`);
  const now = new Set(javaFiles(view.root));
  // Texts to encode, and how to put each file together from them.
  const jobs: Array<{ file: string; parts: Array<Buffer | string>; restore?: Buffer }> = [];
  const put = (file: string, bytes: Buffer, times?: { atime: Date; mtime: Date }) => {
    fs.writeFileSync(file, bytes);
    if (times) {
      try {
        fs.utimesSync(file, times.atime, times.mtime);
      } catch {
        /* another user's file: its content is back, only its time is not */
      }
    }
  };

  for (const [file, v] of view.viewed) {
    if (!now.has(file)) continue; // deleted: whether that was allowed is the shrink guard's call
    try {
      const cur = fs.readFileSync(file);
      if (cur.equals(v.view)) {
        if (v.agentText !== undefined) jobs.push({ file, parts: v.agentText.split("\n"), restore: v.original });
        else put(file, v.original, v);
        continue;
      }
      if (!isValidUtf8(cur)) {
        // Not written by an agent tool: nothing to merge. The original goes back.
        put(file, v.original);
        fail(file, new Error("不是 UTF-8"));
        continue;
      }
      const text = cur.toString("utf8");
      const parts =
        v.agentText !== undefined ? text.split("\n").map(unescapeNonAscii) : mergeEdited(v.original, v.view.toString("latin1"), text);
      jobs.push({ file, parts, restore: v.original });
    } catch (e) {
      fail(file, e);
    }
  }

  for (const [file, original] of view.protectedFiles) {
    try {
      let cur: Buffer | undefined;
      try {
        cur = fs.readFileSync(file);
      } catch {
        cur = undefined;
      }
      if (cur && cur.equals(original)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      put(file, original);
      result.restored.push(file);
    } catch (e) {
      fail(file, e);
    }
  }

  // The rest the agent wrote is its own text — files it created, ASCII files it edited: characters
  // outside ASCII, typed or copied from the view as escapes, are written in the module's encoding.
  // The lines it did not change keep their bytes, escapes their author wrote on purpose included.
  for (const file of now) {
    if (view.viewed.has(file) || view.protectedFiles.has(file)) continue;
    try {
      const cur = fs.readFileSync(file);
      const before = view.plain.get(file);
      if ((before && cur.equals(before)) || !isValidUtf8(cur)) continue;
      const text = cur.toString("utf8");
      if (!hasNonAscii(cur) && unescapeNonAscii(text) === text) continue;
      jobs.push({ file, parts: before ? mergeEdited(before, before.toString("latin1"), text) : text.split("\n").map(unescapeNonAscii) });
    } catch (e) {
      fail(file, e);
    }
  }

  // A lost character, in what the agent wrote this session or in a file it wrote earlier in the run.
  const lost = new Set<string>();
  for (const job of jobs) if (job.parts.some((p) => typeof p === "string" && p.includes(REPLACEMENT))) lost.add(job.file);
  for (const file of view.agentFiles) {
    if (lost.has(file) || jobs.some((j) => j.file === file) || !now.has(file)) continue;
    try {
      const bytes = fs.readFileSync(file);
      if (REPLACEMENT_ESCAPE.test(bytes.toString("latin1")) || (isValidUtf8(bytes) && bytes.toString("utf8").includes(REPLACEMENT))) lost.add(file);
    } catch {
      /* gone */
    }
  }
  result.replacement.push(...lost);

  const write = (job: (typeof jobs)[number], bytes: Buffer) => {
    try {
      put(job.file, bytes);
      result.converted.push(job.file);
    } catch (e) {
      fail(job.file, e);
    }
  };
  if (view.mode === "protect" || !view.jdk) {
    for (const job of jobs) {
      const text = job.parts.map((p) => (typeof p === "string" ? p : p.toString("latin1"))).join("\n");
      write(job, Buffer.from(escapeNonAscii(text, (cp) => cp >= 0x80, { dropBom: true }), "latin1"));
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
      opts.timeoutMs,
    );
    jobs.forEach((job, i) => {
      const bytes = own[i] > 0 ? encodedSome[toEncode.indexOf(job)] : Buffer.alloc(0);
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
        try {
          if (job.restore) put(job.file, job.restore);
        } catch {
          /* reported below either way */
        }
        fail(job.file, new Error("無法以模組編碼寫出"));
        return;
      }
      let next = 0;
      const out = job.parts.map((p) => (typeof p === "string" ? pieces[next++] : p));
      write(job, Buffer.concat(out.flatMap((b, k) => (k === 0 ? [b] : [Buffer.from([0x0a]), b]))));
    });
  }
  if (view.journal) fs.rmSync(view.journal, { recursive: true, force: true });
  openViews.delete(view);
  for (const list of Object.values(result)) list.sort();
  return result;
}
