/** Punctuation guard for everything the repository ships or a person reads.
 *
 * The product rule: no em dash, no en dash, and a semicolon only where code
 * needs one. A comment is prose, so it carries no semicolon. Inline code and
 * fenced code blocks keep theirs. A hyphen is fine.
 *
 * The check reads git-tracked files only. TypeScript and JavaScript go
 * through the TypeScript parser, so a regular expression is never mistaken
 * for a comment. This file names the two dashes by code point, so it passes
 * its own check without an exception. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const EM_DASH = String.fromCharCode(0x2014);
export const EN_DASH = String.fromCharCode(0x2013);

export type Kind =
  | "em dash"
  | "en dash"
  | "semicolon in a comment"
  | "semicolon in a string"
  | "semicolon in prose"
  | "note without a reason"
  | "note covers no semicolon";

export type Violation = {
  file: string;
  line: number;
  kind: Kind;
  text: string;
  /** Source offsets of the string literal a string violation came from, so a
   * note can be matched by position and not by line. */
  range?: [number, number];
};

/** Not ours to rewrite: vendored, legal, generated, or not in the repository. */
const SKIPPED: RegExp[] = [
  /^docs\/assets\/mermaid\.min\.js$/,
  /^docs\/assets\/svg-pan-zoom\.min\.js$/,
  /^THIRD_PARTY_NOTICES$/,
  /^LICENSE$/,
  /^package-lock\.json$/,
  /^dist\//,
  /^node_modules\//,
  /^dev-work\//,
];

const SCRIPT_FILE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;
const SCRIPT_COMMENT_ONLY = /\.(?:css)$/;
/** HTML elements that have no closing tag. */
const HTML_VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HASH_COMMENT_FILE =
  /(?:\.ya?ml|\.sh|\.cmd|Dockerfile|\.gitignore|\.gitattributes|\.dockerignore)$/;

export function isSkipped(file: string): boolean {
  return SKIPPED.some((pattern) => pattern.test(file));
}

function dashViolations(file: string, text: string): Violation[] {
  const found: Violation[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(EM_DASH)) {
      found.push({ file, line: index + 1, kind: "em dash", text: line.trim() });
    }
    if (line.includes(EN_DASH)) {
      found.push({ file, line: index + 1, kind: "en dash", text: line.trim() });
    }
  });
  return found;
}

/** A line without its inline code. A span opens with a run of backticks and
 * closes at the next run of exactly the same length, as Markdown reads it, so
 * a double-backtick span may hold a single backtick. */
export function withoutInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++];
      continue;
    }
    let run = 0;
    while (line[i + run] === "`") run++;
    let j = i + run;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== "`") {
        j++;
        continue;
      }
      let n = 0;
      while (line[j + n] === "`") n++;
      if (n === run) {
        close = j;
        break;
      }
      j += n;
    }
    if (close === -1) {
      out += line.slice(i, i + run);
      i += run;
    } else {
      i = close + run;
    }
  }
  return out;
}

/** The lines of a comment or a Markdown body that are prose: fenced blocks and
 * inline code keep their characters, because a code sample is not a sentence.
 * A fence closes only with the same marker, at least as long as the opener. */
function proseLines(text: string): Array<[number, string]> {
  const kept: Array<[number, string]> = [];
  let fence: { marker: string; length: number } | undefined;
  text.split(/\r?\n/).forEach((line, index) => {
    const bare = line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/)\s?/, "");
    const mark = /^\s*(`{3,}|~{3,})(.*)$/.exec(bare);
    if (fence) {
      if (
        mark &&
        mark[1]![0] === fence.marker &&
        mark[1]!.length >= fence.length &&
        mark[2]!.trim() === ""
      ) {
        fence = undefined;
      }
      return;
    }
    if (mark) {
      fence = { marker: mark[1]![0]!, length: mark[1]!.length };
      return;
    }
    kept.push([index + 1, withoutInlineCode(line)]);
  });
  return kept;
}

function commentSemicolons(
  file: string,
  text: string,
  firstLine: number,
): Violation[] {
  const found: Violation[] = [];
  for (const [offset, line] of proseLines(text)) {
    // punctuation: code, the check looks for the semicolon character in text
    if (line.includes(";")) {
      found.push({
        file,
        line: firstLine + offset - 1,
        kind: "semicolon in a comment",
        text: line.trim(),
      });
    }
  }
  return found;
}

/** What is left of a string once its HTML tags and entities are taken out. A
 * tag, a script or style block, or an entity is markup, and its own semicolon
 * is syntax, but it proves nothing about the words around it. A tag cut off by
 * the end of a template part is markup too. */
/** The HTML attributes that hold text a person reads. The quote may carry a
 * backslash, because the tag can sit inside a string literal. */
const TEXT_ATTRIBUTE =
  /\b(aria-label|aria-description|aria-placeholder|title|alt|placeholder|label|summary|value)\s*=\s*\\?["']([^"'\\]*)\\?["']/gi;

function withoutMarkup(chunk: string): string {
  return chunk
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?[A-Za-z][^>]*(?:>|$)/g, (tag) =>
      // The attributes a person reads, such as a title or a value, stay.
      [...tag.matchAll(TEXT_ATTRIBUTE)].map((m) => ` ${m[2] ?? ""} `).join(""),
    )
    .replace(/&[A-Za-z#0-9]+;/g, "");
}

/** Text that is plainly a CSS or JS snippet: an arrow, a media type header such
 * as `text/html; charset=utf-8`, an escaped newline, a diff hunk header, a
 * brace followed by a semicolon before it closes. A semicolon in it is syntax.
 * A lone `{name}` is a placeholder in a sentence, not code. A word such as
 * `function` proves nothing, because a sentence can hold it. Any other string
 * that must keep a semicolon carries a note, see `NOTE`. */
const CODE_SHAPE =
  /\{[^}]*;|;\s*\}|=>|^\s*[\w.+*-]+\/[\w.+*-]+(?:;\s*[\w-]+=[^;\s]+)+\s*$|\$\(|\\n|^@@ -\d/m;

/** Three plain words in a row. Code holds identifiers, operators and brackets
 * between its words, and its keywords do not count, so a run like this is a
 * sentence. A sentence that also holds an arrow or a brace is mixed text. */
const KEYWORD =
  "(?:const|let|var|function|return|import|export|from|await|async|class|new|throw|type|interface|try|catch|break|continue|default|case|else|for|while|if|of|in|as|typeof|void|extends|implements|static|public|private)";
const WORD = `(?!${KEYWORD}\\b)[a-z]{2,}`;
const SENTENCE = new RegExp(
  `(?:^|[^\\w$./-])(?!${KEYWORD}\\b)[A-Za-z]{2,}(?: ${WORD}){2,}(?![\\w$.(/-])`,
);

/** True when every semicolon in the text is syntax: markup is set aside first,
 * and what remains either holds no semicolon or looks like code and does not
 * read as a sentence. */
export function isCodeShaped(chunk: string): boolean {
  const view = withoutMarkup(chunk);
  // punctuation: code, the check looks for the semicolon character in text
  if (!view.includes(";")) return true;
  // Comments and quoted strings inside a code snippet are text of their own,
  // so they do not make the snippet a sentence.
  const skeleton = view
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`/g, '""');
  return CODE_SHAPE.test(view) && !SENTENCE.test(skeleton);
}

/** The text of a template part without the marks that join it to the next
 * part: the backticks, the opening `${` and the closing `}`. They are template
 * syntax, not code in the text. */
function templateText(kind: ts.SyntaxKind, chunk: string): string {
  const K = ts.SyntaxKind;
  if (kind === K.StringLiteral) return chunk.slice(1, -1);
  if (kind === K.NoSubstitutionTemplateLiteral) return chunk.slice(1, -1);
  if (kind === K.TemplateHead) return chunk.slice(1, -2);
  if (kind === K.TemplateMiddle) return chunk.slice(1, -2);
  if (kind === K.TemplateTail) return chunk.slice(1, -1);
  return chunk;
}

function stringSemicolons(
  file: string,
  chunk: string,
  firstLine: number,
  range: [number, number],
  kind: ts.SyntaxKind,
): Violation[] {
  const body = templateText(kind, chunk);
  // punctuation: code, the check looks for the semicolon character in text
  if (!body.includes(";") || isCodeShaped(body)) return [];
  const found: Violation[] = [];
  chunk.split(/\r?\n/).forEach((line, index) => {
    // punctuation: code, the check looks for the semicolon character in text
    if (withoutMarkup(line).includes(";")) {
      found.push({
        file,
        line: firstLine + index,
        kind: "semicolon in a string",
        text: line.trim(),
        range,
      });
    }
  });
  return found;
}

function lineAt(text: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** `// punctuation: code, <why the semicolon is required>` above a statement,
 * a property or an array element lets the strings inside it keep a semicolon.
 * The reason is part of the note, and a note that covers nothing fails. */
const NOTE = /^(?:\/\/|\/\*+)\s*punctuation: code(?:, ([^\n]*?))?\s*(?:\*\/)?$/;

type Note = { start: number; end: number; line: number };

function coversNode(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (
    ts.isBlock(parent) ||
    ts.isSourceFile(parent) ||
    ts.isModuleBlock(parent) ||
    ts.isCaseClause(parent) ||
    ts.isDefaultClause(parent) ||
    ts.isPropertyAssignment(node) ||
    ts.isClassElement(node) ||
    ts.isArrayLiteralExpression(parent) ||
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      (parent.arguments?.includes(node as ts.Expression) ?? false))
  );
}

const STRING_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

function scriptViolations(file: string, text: string): Violation[] {
  const found: Violation[] = [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const seen = new Set<number>();
  const notes: Note[] = [];
  const coverable: ts.Node[] = [];
  const comments = (position: number): void => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, position) ?? []),
      ...(ts.getTrailingCommentRanges(text, position) ?? []),
    ];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const body = text.slice(range.pos, range.end);
      const first = lineAt(text, range.pos);
      const note = NOTE.exec(body.trim());
      if (note) {
        if ((note[1] ?? "").trim().split(/\s+/).filter(Boolean).length < 3) {
          found.push({
            file,
            line: first,
            kind: "note without a reason",
            text: body.trim(),
          });
        }
        notes.push({ start: range.end, end: range.end, line: first });
      }
      found.push(
        ...dashViolations(file, body).map((v) => ({
          ...v,
          line: first + v.line - 1,
        })),
      );
      found.push(...commentSemicolons(file, body, first));
    }
  };
  const walk = (node: ts.Node): void => {
    // A JSDoc block is read as a comment by `comments()` below, from the raw
    // text. Its own subtree only holds tokens inside that comment, so it is
    // skipped, and its dashes and semicolons are still checked.
    if (ts.isJSDoc(node)) return;
    if (coversNode(node)) coverable.push(node);
    const children = node.getChildren(source);
    if (children.length === 0) comments(node.getFullStart());
    if (STRING_KINDS.has(node.kind)) {
      const start = node.getStart(source);
      const chunk = text.slice(start, node.end);
      const first = lineAt(text, start);
      found.push(
        ...dashViolations(file, chunk).map((v) => ({
          ...v,
          line: first + v.line - 1,
        })),
      );
      found.push(
        ...stringSemicolons(file, chunk, first, [start, node.end], node.kind),
      );
    } else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const start = node.getStart(source);
      const first = lineAt(text, start);
      found.push(
        ...dashViolations(file, text.slice(start, node.end)).map((v) => ({
          ...v,
          line: first + v.line - 1,
        })),
      );
    }
    for (const child of children) walk(child);
  };
  walk(source);
  return applyNotes(source, found, notes, coverable);
}

/** Drops the string-semicolon hits that sit inside the node right below a
 * note. The node is the smallest coverable one that starts after the note. */
function applyNotes(
  source: ts.SourceFile,
  found: Violation[],
  notes: Note[],
  coverable: ts.Node[],
): Violation[] {
  let result = found;
  for (const note of notes) {
    const next = coverable
      .filter((node) => node.getStart(source) >= note.end)
      .sort(
        (a, b) => a.getStart(source) - b.getStart(source) || a.end - b.end,
      )[0];
    const covered = result.filter(
      (v) =>
        v.kind === "semicolon in a string" &&
        v.range !== undefined &&
        next !== undefined &&
        v.range[0] >= next.getStart(source) &&
        v.range[1] <= next.end,
    );
    if (covered.length === 0) {
      result = [
        ...result,
        {
          file: source.fileName,
          line: note.line,
          kind: "note covers no semicolon",
          text: "punctuation: code",
        },
      ];
    } else {
      result = result.filter((v) => !covered.includes(v));
    }
  }
  return result;
}

function cssViolations(file: string, text: string): Violation[] {
  const found = dashViolations(file, text);
  // A `content` string is text a person reads, so it is prose.
  for (const match of text.matchAll(
    /\bcontent\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
  )) {
    // punctuation: code, the check looks for the semicolon character in text
    if (match[1]!.includes(";")) {
      found.push({
        file,
        line: lineAt(text, match.index ?? 0),
        kind: "semicolon in a string",
        text: match[1]!.slice(0, 120),
      });
    }
  }
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
    found.push(
      ...commentSemicolons(file, match[0], lineAt(text, match.index ?? 0)),
    );
  }
  return found;
}

function markdownViolations(file: string, text: string): Violation[] {
  const found = dashViolations(file, text);
  for (const [line, body] of proseLines(text)) {
    // punctuation: code, the check looks for the semicolon character in text
    if (body.includes(";")) {
      found.push({
        file,
        line,
        kind: "semicolon in prose",
        text: body.trim(),
      });
    }
  }
  return found;
}

/** YAML and shell. A whole-line comment is prose. In YAML a value is prose too,
 * except under `run` and `script`, which hold shell. */
function hashCommentViolations(file: string, text: string): Violation[] {
  const found = dashViolations(file, text);
  const yaml = /\.ya?ml$/.test(file);
  let block: { indent: number; code: boolean } | undefined;
  // `# punctuation: code, <why>` above a shell command lets its quoted strings
  // keep a semicolon, through the lines the command continues onto.
  let pending: { line: number; used: boolean } | undefined;
  let covering: { line: number; used: boolean } | undefined;
  text.split(/\r?\n/).forEach((line, index) => {
    const note = /^\s*(?:#|REM\b|::)\s*punctuation: code(?:, (.*))?$/i.exec(
      line,
    );
    if (note && !yaml) {
      // punctuation: code, the check looks for the semicolon character in text
      if ((note[1] ?? "").includes(";")) {
        found.push({
          file,
          line: index + 1,
          kind: "semicolon in a comment",
          text: line.trim(),
        });
      }
      if ((note[1] ?? "").trim().split(/\s+/).filter(Boolean).length < 3) {
        found.push({
          file,
          line: index + 1,
          kind: "note without a reason",
          text: line.trim(),
        });
      }
      pending = { line: index + 1, used: false };
      return;
    }
    const indent = line.length - line.trimStart().length;
    if (block && (line.trim() === "" || indent > block.indent)) {
      if (yaml && !block.code) {
        found.push(...yamlValue(file, index + 1, line));
      }
      if (yaml && block.code)
        found.push(...shellStrings(file, index + 1, line));
      if (!/^\s*#/.test(line)) return;
    } else {
      block = undefined;
    }
    // punctuation: code, the check looks for the semicolon character in text
    if (
      /^\s*(?:#|REM\b|::)/i.test(line) &&
      withoutInlineCode(line).includes(";")
    ) {
      found.push({
        file,
        line: index + 1,
        kind: "semicolon in a comment",
        text: line.trim(),
      });
      return;
    }
    if (!yaml) {
      if (pending) {
        covering = pending;
        pending = undefined;
      }
      const hits = shellStrings(file, index + 1, line);
      // A shell line may end in a comment, after a `#` that is not in quotes.
      if (/\.sh$/.test(file)) {
        const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (m) =>
          " ".repeat(m.length),
        );
        const tail = /(?:^|\s)#(.*)$/.exec(bare);
        // punctuation: code, the check looks for the semicolon character in text
        if (tail && withoutInlineCode(tail[1]!).includes(";")) {
          found.push({
            file,
            line: index + 1,
            kind: "semicolon in a comment",
            text: tail[1]!.trim(),
          });
        }
      }
      if (!covering) {
        found.push(...hits);
        return;
      }
      if (hits.length > 0) covering.used = true;
      if (!line.trimEnd().endsWith("\\")) {
        if (!covering.used) {
          found.push({
            file,
            line: covering.line,
            kind: "note covers no semicolon",
            text: "punctuation: code",
          });
        }
        covering = undefined;
      }
      return;
    }
    if (/^\s*#/.test(line)) return;
    const key = /^\s*(?:-\s+)?([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    const code = key !== null && /^(?:run|script)$/.test(key[1]!);
    if (key && /^[|>][+-]?\d*\s*(?:#.*)?$/.test(key[2] ?? "")) {
      block = { indent, code };
      return;
    }
    if (key && !code) found.push(...yamlValue(file, index + 1, key[2] ?? ""));
    // A `run` or `script` value is shell. Its quoted text is checked, and the
    // semicolons that separate its statements are not.
    if (key && code) found.push(...shellStrings(file, index + 1, key[2] ?? ""));
    // A sequence item that is a plain scalar, not a mapping: `- "text"`.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!key && item && !/^[A-Za-z0-9_-]+:(?:\s|$)/.test(item[1]!)) {
      found.push(...yamlValue(file, index + 1, item[1]!));
    }
  });
  if (pending) {
    found.push({
      file,
      line: pending.line,
      kind: "note covers no semicolon",
      text: "punctuation: code",
    });
  }
  return found;
}

/** The quoted strings of a shell line. A semicolon that separates statements
 * sits outside quotes and is left alone. Inside quotes it is text. */
function shellStrings(file: string, line: number, text: string): Violation[] {
  const found: Violation[] = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)) {
    const inner = match[0].slice(1, -1);
    // punctuation: code, the check looks for the semicolon character in text
    if (inner.includes(";") && !isCodeShaped(inner)) {
      found.push({
        file,
        line,
        kind: "semicolon in a string",
        text: inner.slice(0, 120),
      });
    }
  }
  return found;
}

function yamlValue(file: string, line: number, value: string): Violation[] {
  const suffix = /\s+#(.*)$/.exec(value);
  const bare = value.replace(/\s+#.*$/, "");
  const found: Violation[] = [];
  // punctuation: code, the check looks for the semicolon character in text
  if (suffix && withoutInlineCode(suffix[1]!).includes(";")) {
    found.push({
      file,
      line,
      kind: "semicolon in a comment",
      text: suffix[1]!.trim(),
    });
  }
  // punctuation: code, the check looks for the semicolon character in text
  if (bare.includes(";") && !isCodeShaped(bare)) {
    found.push({
      file,
      line,
      kind: "semicolon in a string",
      text: bare.trim(),
    });
  }
  return found;
}

/** JSON string values are text a person may read, and may hold Markdown with
 * fenced code. JSON has no comments, so a value that needs a semicolon as
 * prose cannot carry a note: reword it. */
function jsonViolations(file: string, text: string): Violation[] {
  const found = dashViolations(file, text);
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const after = text.slice((match.index ?? 0) + match[0].length);
    // A key is followed by a colon, a value is not.
    if (/^\s*:/.test(after)) continue;
    let value: string;
    try {
      value = JSON.parse(match[0]) as string;
    } catch {
      continue;
    }
    // punctuation: code, the check looks for the semicolon character in text
    if (!value.includes(";") || isCodeShaped(value)) continue;
    // punctuation: code, the check looks for the semicolon character in text
    const prose = proseLines(value).find(([, line]) => line.includes(";"));
    if (!prose) continue;
    found.push({
      file,
      line: lineAt(text, match.index ?? 0),
      kind: "semicolon in a string",
      text: prose[1].trim().slice(0, 120),
    });
  }
  return found;
}

/** HTML text outside script, style, pre and code. Tags and entities are not
 * text, and a newline is kept so a line number still points at the file. */
function htmlViolations(file: string, text: string): Violation[] {
  const found = dashViolations(file, text);
  const blank = (match: string): string => match.replace(/[^\n]/g, " ");
  const visibleText = (html: string): string =>
    html
      .replace(/<(script|style|pre|code)\b[\s\S]*?<\/\1>/gi, blank)
      .replace(/<!--[\s\S]*?-->/g, blank)
      .replace(/<[^>]*>/g, blank)
      .replace(/&[A-Za-z#0-9]+;/g, blank);
  // `<!-- punctuation: code, <why> -->` right above an element lets the text
  // inside that element, up to its closing tag, keep its semicolons.
  let body = text;
  for (const note of text.matchAll(
    /<!--\s*punctuation: code(?:, ([^]*?))?\s*-->\s*<([A-Za-z0-9]+)\b/g,
  )) {
    const line = lineAt(text, note.index ?? 0);
    // punctuation: code, the check looks for the semicolon character in text
    if ((note[1] ?? "").includes(";")) {
      found.push({
        file,
        line,
        kind: "semicolon in a comment",
        text: note[0].slice(0, 120),
      });
    }
    if ((note[1] ?? "").trim().split(/\s+/).filter(Boolean).length < 3) {
      found.push({
        file,
        line,
        kind: "note without a reason",
        text: note[0].slice(0, 120),
      });
    }
    const start = (note.index ?? 0) + note[0].length - note[2]!.length - 1;
    const opening = text.indexOf(">", start) + 1;
    // A void or self-closing element ends at its opening tag, and so does an
    // element that never closes, so a note cannot reach to the end of the file.
    let end = opening;
    if (
      !HTML_VOID.has(note[2]!.toLowerCase()) &&
      !text.slice(start, opening).endsWith("/>")
    ) {
      const tag = new RegExp(`<(/?)${note[2]!}\\b`, "gi");
      tag.lastIndex = start;
      let depth = 0;
      for (let m = tag.exec(text); m; m = tag.exec(text)) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) {
          end = text.indexOf(">", m.index) + 1;
          break;
        }
      }
    }
    // punctuation: code, the check looks for the semicolon character in text
    if (!visibleText(text.slice(start, end)).includes(";")) {
      found.push({
        file,
        line,
        kind: "note covers no semicolon",
        text: "punctuation: code",
      });
    }
    body =
      body.slice(0, start) + blank(body.slice(start, end)) + body.slice(end);
  }
  // Text a person reads from an attribute: its accessible name, title, alt.
  for (const match of body.matchAll(
    /\b(?:aria-label|aria-description|aria-placeholder|title|alt|placeholder|label|summary|value)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
  )) {
    const value = (match[1] ?? match[2] ?? "").replace(/&[A-Za-z#0-9]+;/g, "");
    // punctuation: code, the check looks for the semicolon character in text
    if (value.includes(";") && !isCodeShaped(value)) {
      found.push({
        file,
        line: lineAt(body, match.index ?? 0),
        kind: "semicolon in prose",
        text: value.slice(0, 120),
      });
    }
  }
  // A comment is prose. The notes of this check are comments too, and are not.
  for (const comment of body.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (/^\s*punctuation: code/.test(comment[1]!)) continue;
    const first = lineAt(body, comment.index ?? 0);
    for (const [offset, line] of proseLines(comment[1]!)) {
      // punctuation: code, the check looks for the semicolon character in text
      if (line.replace(/&[A-Za-z#0-9]+;/g, "").includes(";")) {
        found.push({
          file,
          line: first + offset - 1,
          kind: "semicolon in a comment",
          text: line.trim(),
        });
      }
    }
  }
  const visible = visibleText(body);
  visible.split(/\r?\n/).forEach((line, index) => {
    // punctuation: code, the check looks for the semicolon character in text
    if (line.includes(";")) {
      found.push({
        file,
        line: index + 1,
        kind: "semicolon in prose",
        text: line.trim(),
      });
    }
  });
  return found;
}

/** Every violation in one file's text. A file type this does not know is read
 * as prose, so no text file escapes the rule. */
export function scanText(file: string, text: string): Violation[] {
  if (isSkipped(file)) return [];
  if (SCRIPT_FILE.test(file)) return scriptViolations(file, text);
  if (SCRIPT_COMMENT_ONLY.test(file)) return cssViolations(file, text);
  if (file.endsWith(".md")) return markdownViolations(file, text);
  if (HASH_COMMENT_FILE.test(file)) return hashCommentViolations(file, text);
  if (file.endsWith(".json")) return jsonViolations(file, text);
  if (/\.(?:html?|svg|xml)$/.test(file)) return htmlViolations(file, text);
  // Any other text file is read as prose: plain text, notes, unknown formats.
  return markdownViolations(file, text);
}

export function trackedFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter((file) => file !== "");
}

export function scanRepository(root: string): Violation[] {
  const found: Violation[] = [];
  for (const file of trackedFiles(root)) {
    if (isSkipped(file)) continue;
    let text: string;
    try {
      text = readFileSync(`${root}/${file}`, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    found.push(...scanText(file, text));
  }
  return found;
}

export function formatViolations(found: Violation[]): string {
  const lines = found.map(
    (v) => `${v.file}:${v.line}: ${v.kind}: ${v.text.slice(0, 120)}`,
  );
  const counts = new Map<Kind, number>();
  for (const v of found) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
  const summary = [...counts].map(([kind, n]) => `${n} ${kind}`).join(", ");
  return `${lines.join("\n")}\n\n${found.length} violations (${summary})`;
}

if (import.meta.main) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const found = scanRepository(root);
  if (found.length > 0) {
    console.error(formatViolations(found));
    process.exit(1);
  }
  console.log("punctuation: no violations");
}
