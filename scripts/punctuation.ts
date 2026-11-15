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

const SCRIPT_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const SCRIPT_COMMENT_ONLY = /\.(?:css)$/;
const HASH_COMMENT_FILE = /(?:\.ya?ml|\.sh|Dockerfile)$/;

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

/** The lines of a comment or a Markdown body that are prose: fenced blocks and
 * inline code keep their characters, because a code sample is not a sentence. */
function proseLines(text: string): Array<[number, string]> {
  const kept: Array<[number, string]> = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, index) => {
    const bare = line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/)\s?/, "");
    if (/^\s*(?:```|~~~)/.test(bare)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    kept.push([index + 1, line.replace(/`[^`]*`/g, "")]);
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

/** Text that is plainly a CSS, JS or HTML snippet: braces, an arrow, a tag, an
 * entity, a header, a keyword. A semicolon in it is syntax. Any other string
 * that must keep a semicolon carries a note, see `NOTE`. */
const CODE_SHAPE =
  /[{}]|=>|<\/?[A-Za-z]|&[A-Za-z#0-9]+;|charset=|\bfunction\b|\b(?:const|let|var|return|import|export|await|async)\b|\$\(|\\n/;

export function isCodeShaped(chunk: string): boolean {
  return CODE_SHAPE.test(chunk);
}

function stringSemicolons(
  file: string,
  chunk: string,
  firstLine: number,
): Violation[] {
  // punctuation: code, the check looks for the semicolon character in text
  if (!chunk.includes(";") || isCodeShaped(chunk)) return [];
  const found: Violation[] = [];
  chunk.split(/\r?\n/).forEach((line, index) => {
    // punctuation: code, the check looks for the semicolon character in text
    if (line.includes(";")) {
      found.push({
        file,
        line: firstLine + index,
        kind: "semicolon in a string",
        text: line.trim(),
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
      found.push(...stringSemicolons(file, chunk, first));
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
    const from = next
      ? source.getLineAndCharacterOfPosition(next.getStart(source)).line + 1
      : 0;
    const to = next
      ? source.getLineAndCharacterOfPosition(next.end).line + 1
      : -1;
    const covered = result.filter(
      (v) =>
        v.kind === "semicolon in a string" && v.line >= from && v.line <= to,
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

function hashCommentViolations(file: string, text: string): Violation[] {
  const found = dashViolations(file, text);
  text.split(/\r?\n/).forEach((line, index) => {
    // punctuation: code, the check looks for the semicolon character in text
    if (/^\s*#/.test(line) && line.replace(/`[^`]*`/g, "").includes(";")) {
      found.push({
        file,
        line: index + 1,
        kind: "semicolon in a comment",
        text: line.trim(),
      });
    }
  });
  return found;
}

/** Every violation in one file's text. A file type this does not know is still
 * checked for the two dashes. */
export function scanText(file: string, text: string): Violation[] {
  if (isSkipped(file)) return [];
  if (SCRIPT_FILE.test(file)) return scriptViolations(file, text);
  if (SCRIPT_COMMENT_ONLY.test(file)) return cssViolations(file, text);
  if (file.endsWith(".md")) return markdownViolations(file, text);
  if (HASH_COMMENT_FILE.test(file)) return hashCommentViolations(file, text);
  return dashViolations(file, text);
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
