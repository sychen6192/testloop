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
      const j = end < 0 ? n : end + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      // A text block runs to the next unescaped """.
      let j = i + 3;
      while (j < n && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) j += src[j] === "\\" ? 2 : 1;
      j = Math.min(j, n);
      out.push('"', '"', '"');
      blank(i + 3, j);
      if (j < n) out.push('"', '"', '"');
      i = Math.min(j + 3, n);
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
