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
import * as fs from "node:fs";
import * as path from "node:path";
import { pomFactsFromChain, readPomChain } from "./teststack";
import { ModuleInfo } from "./types";

export interface SourceEncoding {
  name: string;
  /** "pom": configured; "platform": Maven fell back to the platform encoding (the build log says so). */
  source: "pom" | "platform";
}

export function isUtf8Name(name: string): boolean {
  return /^utf-?8$/i.test(name.trim());
}

/**
 * Pure: the effective source encoding. The compiler plugin's own <encoding> wins over
 * project.build.sourceEncoding, which wins over what Maven reported falling back to: the
 * resources plugin prints the platform encoding on every build when none is configured
 * ("Using platform encoding (MS950 actually) to copy filtered resources" in 2.x, "File encoding
 * has not been set, using platform encoding MS950" in 3.x and in the compiler plugin).
 */
export function sourceEncodingFrom(
  pom: { compilerEncoding?: string; sourceEncoding?: string },
  buildLog: string,
): SourceEncoding | undefined {
  const configured = pom.compilerEncoding ?? pom.sourceEncoding;
  if (configured && !/\$\{/.test(configured)) return { name: configured, source: "pom" };
  const m =
    /File encoding has not been set, using platform encoding ([^\s,]+)/.exec(buildLog) ??
    /Using platform encoding \(([^\s)]+) actually\)/.exec(buildLog);
  return m ? { name: m[1], source: "platform" } : undefined;
}

/** The module's source encoding, from its poms and the latest build's output. */
export function measureSourceEncoding(mod: ModuleInfo, repoRoot: string, buildLog = ""): SourceEncoding | undefined {
  let pom: { compilerEncoding?: string; sourceEncoding?: string } = {};
  try {
    const facts = pomFactsFromChain(readPomChain(mod.moduleRoot, repoRoot));
    pom = { compilerEncoding: facts.compiler.encoding, sourceEncoding: facts.properties["project.build.sourceEncoding"] };
  } catch {
    /* no readable pom: the log may still say */
  }
  return sourceEncodingFrom(pom, buildLog);
}

// ─── Bytes ───────────────────────────────────────────────────────────────────

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
 * Pure: Java source with every non-ASCII character written as a \uXXXX escape — the same program
 * in bytes every ASCII-compatible encoding reads identically. javac translates Unicode escapes
 * before anything else, so string literals keep their exact value. A leading byte-order mark is
 * dropped rather than escaped: it is not a character javac accepts anywhere.
 */
export function escapeNonAscii(text: string): string {
  let out = "";
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    out += c < 0x80 ? src[i] : `\\u${c.toString(16).padStart(4, "0")}`;
  }
  return out;
}

// ─── Around a writer session ─────────────────────────────────────────────────

/**
 * The .java files under `tree` that are not valid UTF-8 — in a non-UTF-8 module, the ones with
 * characters outside ASCII, which a UTF-8 edit tool would destroy. Keyed by absolute path; the
 * bytes are what gets put back.
 */
export function captureNonUtf8Sources(tree: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
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
      else if (e.isFile() && e.name.endsWith(".java")) {
        try {
          const buf = fs.readFileSync(p);
          if (!isValidUtf8(buf)) out.set(p, buf);
        } catch {
          /* unreadable: nothing to protect */
        }
      }
    }
  };
  walk(tree);
  return out;
}

export interface EncodingRepair {
  /** Files whose non-ASCII characters were rewritten as \uXXXX. */
  escaped: string[];
  /** Non-UTF-8 files the session changed or deleted: put back byte for byte. */
  restored: string[];
}

/**
 * After a writer session in a non-UTF-8 module. A file that was not valid UTF-8 before the session
 * is read-only in effect: no agent tool writes MS950, so any change to it went through a UTF-8
 * decode that mangled its characters — into U+FFFD, or, where a byte pair happens to be valid
 * UTF-8, into different characters without any trace — and it is put back as it was. Every other
 * changed .java file that now holds characters outside ASCII is the writer's own text, and gets
 * them as \uXXXX so it compiles.
 */
export function repairWriterEncoding(changed: string[], originals: Map<string, Buffer>): EncodingRepair {
  const result: EncodingRepair = { escaped: [], restored: [] };
  for (const file of changed) {
    if (!file.endsWith(".java")) continue;
    let buf: Buffer | undefined;
    try {
      buf = fs.readFileSync(file);
    } catch {
      buf = undefined;
    }
    const original = originals.get(file);
    if (original) {
      if (!buf || !buf.equals(original)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, original);
        result.restored.push(file);
      }
      continue;
    }
    if (!buf || !hasNonAscii(buf) || !isValidUtf8(buf)) continue;
    fs.writeFileSync(file, escapeNonAscii(buf.toString("utf8")));
    result.escaped.push(file);
  }
  return result;
}
