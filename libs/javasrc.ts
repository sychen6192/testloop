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
 */
export function codeOnly(src: string): string {
  const out: string[] = [];
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(src[k] === "\n" || src[k] === "\r" ? src[k] : " ");
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
      blank(i + 3, j);
      out.push('"', '"', '"');
      i = j + 3;
    } else if (c === '"' || c === "'") {
      // A string or char literal ends at its quote — or, unterminated, at the end of the line.
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n" && src[j] !== "\r") j += src[j] === "\\" ? 2 : 1;
      j = Math.min(j, n);
      out.push(c);
      blank(i + 1, j);
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
