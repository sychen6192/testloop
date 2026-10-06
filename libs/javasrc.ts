// Java source, read the way the compiler reads it — as much of it as pattern matching needs.
//
// Regexes over raw source are fooled by what is not code: a "@Test" in a comment, a "//" inside a
// URL string that a line-comment pattern cuts the line at, a "/*" inside a string that swallows
// the code up to the next "*/". The lexer's order settles all of it: whatever starts first — a
// comment, a string, a character, a text block — runs to its own end, and nothing inside it
// starts anything.

/**
 * Pure: `src` with comments, and the contents of string, character and text-block literals,
 * replaced by spaces. Same length with the line breaks kept, so an index or a line number in the
 * result is the same one in the source. The quotes stay: `"…"` still reads as an argument.
 *
 * A comment or text block left open does not compile. Blanking everything after it made the rest
 * of the file vanish — every test in it "removed" — so its opener is blanked alone and the rest is
 * read as code, which is what the source was before the stray opener went in. The build reports
 * the error itself.
 *
 * `keepLiterals`: the literals' contents stay and only the comments go — a Gradle script's plugin id
 * is a string, and one commented out applies nothing.
 */
export function codeOnly(src: string, keepLiterals = false): string {
  const out: string[] = [];
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(src[k] === "\n" || src[k] === "\r" ? src[k] : " ");
  };
  const literal = (from: number, to: number) => {
    if (!keepLiterals) return blank(from, to);
    for (let k = from; k < to; k++) out.push(src[k]);
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n" && src[j] !== "\r") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      blank(i, end + 2);
      i = end + 2;
    } else if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      // A text block runs to the next unescaped """.
      let j = i + 3;
      while (j < n && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) j += src[j] === "\\" ? 2 : 1;
      out.push('"', '"', '"');
      if (j >= n) {
        i += 3;
        continue;
      }
      literal(i + 3, j);
      out.push('"', '"', '"');
      i = j + 3;
    } else if (c === '"' || c === "'") {
      // A string or char literal ends at its quote — or, unterminated, at the end of the line.
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n" && src[j] !== "\r") j += src[j] === "\\" ? 2 : 1;
      j = Math.min(j, n);
      out.push(c);
      literal(i + 1, j);
      if (j < n && src[j] === c) {
        out.push(c);
        i = j + 1;
      } else {
        i = j;
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

/**
 * Pure: code-only text (see codeOnly) with every annotation — `@Name` and its argument list, across
 * lines when it spans them — replaced by spaces, line breaks kept. `@interface`, a declaration
 * keyword, stays. An argument list that never closes is left as it is: in code that compiles it
 * always does, and blanking to the end of the file would take the code after it with it.
 */
export function stripAnnotations(code: string): string {
  const out = code.split("");
  const n = code.length;
  const name = /@\s*[\w$]+(?:\s*\.\s*[\w$]+)*/y;
  for (let i = 0; i < n; i++) {
    if (code[i] !== "@") continue;
    name.lastIndex = i;
    const m = name.exec(code);
    if (!m || /^@\s*interface$/.test(m[0])) continue;
    let end = i + m[0].length;
    let k = end;
    while (k < n && /\s/.test(code[k])) k++;
    if (code[k] === "(") {
      let depth = 0;
      for (; k < n; k++) {
        if (code[k] === "(") depth++;
        else if (code[k] === ")" && --depth === 0) break;
      }
      if (k >= n) continue; // never closes
      end = k + 1;
    }
    for (let x = i; x < end; x++) if (out[x] !== "\n" && out[x] !== "\r") out[x] = " ";
    i = end - 1;
  }
  return out.join("");
}

const DECLARATION_MODIFIERS = "(?:(?:public|protected|private|static|final|transient|volatile|abstract|strictfp|sealed|non-sealed)\\s+)*";
const TYPE_REF =
  "[\\w$]+(?:\\s*\\.\\s*[\\w$]+)*(?:\\s*<(?:[^<>;=(){}]|<(?:[^<>;=(){}]|<[^<>;=(){}]*>)*>)*>)?(?:\\s*\\[\\s*\\])*";
const DECLARED_NAME = "[\\w$]+(?:\\s*\\[\\s*\\])*";
// A variable declared without an initializer. Two words and a semicolon is otherwise only a statement
// that starts with one of these keywords — `return x;` is code.
const DECLARED_ONLY = new RegExp(
  `^${DECLARATION_MODIFIERS}(?!(?:return|throw|yield|assert|break|continue|case|default|goto|else|do|new|package|import)\\b)` +
    `${TYPE_REF}\\s+${DECLARED_NAME}(?:\\s*,\\s*${DECLARED_NAME})*\\s*;$`,
);
// A type's declaration, its body opening on the line at most: `public class Foo extends Bar {`.
const TYPE_DECLARATION = new RegExp(`^${DECLARATION_MODIFIERS}(?:class|interface|enum|record|@\\s*interface)\\s+[\\w$]+[^{}=;]*\\{?$`);

/**
 * Pure: `src` with its Unicode escapes translated, which javac does before anything else: `\u0041`
 * is an `A`, while `\\u0041` — an even run of backslashes — is no escape. An escaped line break in
 * a comment ends that comment for javac; read without this, the code after it looks commented out.
 */
export function decodeUnicodeEscapes(src: string): string {
  return src.replace(/(\\+)u+([0-9a-fA-F]{4})/g, (m, bs: string, hex: string) =>
    bs.length % 2 ? bs.slice(0, -1) + String.fromCharCode(parseInt(hex, 16)) : m,
  );
}

/**
 * Pure: the value of a string literal as written between its quotes: its Unicode escapes, then its
 * escape sequences (\n, \", \\, octal), translated as javac translates them.
 */
export function javaStringValue(body: string): string {
  const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", s: " ", '"': '"', "'": "'", "\\": "\\" };
  return decodeUnicodeEscapes(body).replace(/\\(?:([btnfrs"'\\])|([0-3][0-7]{0,2}|[4-7][0-7]?))/g, (_m, c: string, oct: string) =>
    c ? simple[c] : String.fromCharCode(parseInt(oct, 8)),
  );
}

// Java's names for the double-byte charsets of older repos, as the WHATWG labels Node's TextDecoder
// knows them by. Other names it takes as they are: GBK, GB18030, Shift_JIS, EUC-KR, windows-1252.
// Measured on every two-byte sequence against JDK 21: each decoder splits the bytes javac accepts
// exactly as javac does — a lead byte and the one after it, "\" (0x5C) or not — which is what the
// lexer needs; the characters are javac's for MS950 and EUC-KR, while a few rare ones come out as
// others elsewhere (IBM's cp950 364, GBK 101, MS932 63, MS949's Hangul beyond KS X 1001 as two
// characters): a string's value there — a @DisplayName — can differ from what javac compiles.
const DECODER_LABELS: Record<string, string> = {
  ms950: "big5",
  cp950: "big5",
  "windows-950": "big5",
  "x-windows-950": "big5",
  "ms950-hkscs": "big5",
  "x-ms950-hkscs": "big5",
  "big5-hkscs": "big5",
  ms936: "gbk",
  cp936: "gbk",
  "windows-936": "gbk",
  "x-mswin-936": "gbk",
  "euc-cn": "gbk",
  ms932: "shift_jis",
  cp932: "shift_jis",
  "windows-932": "shift_jis",
  ms949: "euc-kr",
  cp949: "euc-kr",
  "windows-949": "euc-kr",
  "x-windows-949": "euc-kr",
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
// When the name is not known (set in a parent pom outside the repo): the double-byte encodings of
// older repos, each tried whole, the first that decodes every byte taken. One that is not the file's
// mostly splits its bytes as the file's does wherever it decodes them all — lead byte, then the next —
// and lexing is what the text is for: read byte for byte, MS950's 功 ends in a "\" that escapes the
// quote after it. Not so Shift_JIS's half-width katakana, one byte each that Big5 and GBK take as a
// lead byte, the byte after it — a "\" among them — as its second: a Shift_JIS text is taken as one when
// it decodes and says something in kana, which Big5's and GBK's bytes never do (its hiragana and
// katakana lead with 0x82 and 0x83, below every Big5 lead byte, and GBK text read so is noise).
const SNIFFED = ["big5", "gbk", "shift_jis", "euc-kr"].map((label) => new TextDecoder(label, { fatal: true }));
const SHIFT_JIS = SNIFFED[2];
const KANA = /[\u3041-\u3096\u30a1-\u30fa]{2}/;

/**
 * Pure: a Java source's text, decoded as javac decodes it — in `charset` (Java's name for the module's
 * source encoding) when that is known and Node has a decoder for it; else as UTF-8, when the bytes are
 * that; else in the first of the double-byte encodings (SNIFFED) that decodes them all. Otherwise byte
 * for byte (latin1): every ASCII character where it is. That is not enough for the lexer: MS950 has
 * "\" (0x5C) as the second byte of 功, 許 and 蓋, so the quote after "處理成功" reads as escaped and the
 * string runs to the end of the line, the code after it with it; and a string literal or a
 * @DisplayName read so is not the one javac compiles.
 */
export function decodeJavaSource(buf: Buffer, charset?: string): string {
  const name = charset?.trim().toLowerCase().replace(/_/g, "-");
  let decoder: TextDecoder | undefined;
  if (name && !/^utf-?8$/.test(name)) {
    for (const label of [DECODER_LABELS[name], name, charset!.trim()]) {
      if (!label) continue;
      try {
        decoder = new TextDecoder(label);
        break;
      } catch {
        /* not a label Node knows */
      }
    }
  }
  if (decoder) return decoder.decode(buf);
  try {
    return strictUtf8.decode(buf);
  } catch {
    /* not UTF-8 */
  }
  try {
    const text = SHIFT_JIS.decode(buf);
    if (KANA.test(text)) return text;
  } catch {
    /* not Shift_JIS */
  }
  for (const d of SNIFFED) {
    try {
      return d.decode(buf);
    } catch {
      /* not this one */
    }
  }
  return buf.toString("latin1");
}

// javac's line terminators: CR LF, a lone LF, and a lone CR.
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Pure: the 1-based numbers of the lines that hold no code anyone wrote — a field declared without an
 * initializer, a type's declaration, and the annotations on either. The compiler attributes code to
 * them all the same: Lombok's generated methods to the annotation (@Data's equals and hashCode, a
 * whole @Builder) or to the field (@Getter, @Setter), the implicit default constructor to the type's
 * declaration. Measured on JaCoCo 0.8.8 with Spring Boot 2.7's Lombok: a @Data DTO whose getters,
 * setters, equals, hashCode and toString were all tested showed 40% branch coverage, every missed
 * branch on the @Data line. Coverage that counts those lines asks for tests of code nobody wrote.
 *
 * An annotation's line goes only with what it annotates: javac puts a field's initializer on the
 * line its declaration starts, which is its first annotation's — `@Deprecated` over
 * `boolean on = level > 0 && level < 5;` carries both of that expression's branches (measured, javac
 * 21 and JaCoCo 0.8.12). Only a line matched outright counts: one this cannot read (an identifier
 * outside ASCII, a declaration continued from the line before) stays in the figure, and a source
 * whose escapes hide a line break has none excluded — which line javac numbers is not worth a guess.
 */
export function declarationOnlyLines(src: string): number[] {
  const decoded = decodeUnicodeEscapes(src);
  if (decoded.split(LINE_BREAK).length !== src.split(LINE_BREAK).length) return [];
  const code = codeOnly(decoded);
  const lines = code.split(LINE_BREAK);
  const bare = stripAnnotations(code).split(LINE_BREAK).map((l) => l.trim());
  const kind: Array<"blank" | "annotation" | "declaration" | "code"> = [];
  lines.forEach((raw, i) => {
    if (!raw.trim()) kind.push("blank");
    else if (!bare[i]) kind.push("annotation");
    else if (TYPE_DECLARATION.test(bare[i])) kind.push("declaration");
    else if (DECLARED_ONLY.test(bare[i])) {
      // `Type name;` continuing the line before is not a declaration: `o instanceof` / `String s;`.
      let j = i - 1;
      while (j >= 0 && kind[j] === "blank") j--;
      const starts = j < 0 || kind[j] === "annotation" || /[;{}]$/.test(bare[j]);
      kind.push(starts ? "declaration" : "code");
    } else kind.push("code");
  });
  const out: number[] = [];
  kind.forEach((k, i) => {
    if (k === "declaration") out.push(i + 1);
    else if (k === "annotation") {
      let j = i + 1;
      while (j < kind.length && (kind[j] === "blank" || kind[j] === "annotation")) j++;
      if (kind[j] === "declaration") out.push(i + 1);
    }
  });
  return out;
}
