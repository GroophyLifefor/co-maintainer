/** The punctuation check, on small examples, and on the repository itself. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EM_DASH,
  EN_DASH,
  formatViolations,
  scanRepository,
  scanText,
} from "./punctuation.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function kinds(file: string, text: string): string[] {
  return scanText(file, text).map((v) => `${v.line}:${v.kind}`);
}

test("an em dash fails in a comment, a string, a regex, md and css", () => {
  assert.deepEqual(kinds("a.ts", `// wait ${EM_DASH} what\n`), ["1:em dash"]);
  assert.deepEqual(kinds("a.ts", `const s = "a ${EM_DASH} b";\n`), [
    "1:em dash",
  ]);
  assert.deepEqual(kinds("a.ts", `const r = /${EM_DASH}/;\n`), ["1:em dash"]);
  assert.deepEqual(kinds("a.md", `Text ${EM_DASH} more\n`), ["1:em dash"]);
  assert.deepEqual(kinds("a.css", `/* head ${EM_DASH} */\n`), ["1:em dash"]);
});

test("an em dash fails inside inline code too", () => {
  assert.deepEqual(kinds("a.md", `Use \`a ${EM_DASH} b\` here\n`), [
    "1:em dash",
  ]);
});

test("an en dash fails and a hyphen passes", () => {
  assert.deepEqual(kinds("a.ts", `const s = "1${EN_DASH}64";\n`), [
    "1:en dash",
  ]);
  assert.deepEqual(kinds("a.ts", `const s = "1-64";\n`), []);
  assert.deepEqual(kinds("a.md", "Use 1-64 characters\n"), []);
});

test("a semicolon fails in a comment but not in inline code of a comment", () => {
  assert.deepEqual(kinds("a.ts", "// first; second\n"), [
    "1:semicolon in a comment",
  ]);
  assert.deepEqual(kinds("a.ts", "/** one; two */\nconst a = 1;\n"), [
    "1:semicolon in a comment",
  ]);
  assert.deepEqual(kinds("a.ts", "// use `a; b` here\n"), []);
});

test("TypeScript statement semicolons are fine", () => {
  assert.deepEqual(
    kinds("a.ts", "const a = 1;\nfor (let i = 0; i < 3; i++) {}\n"),
    [],
  );
});

test("a regex literal that holds two slashes is not a comment", () => {
  assert.deepEqual(kinds("a.ts", 'const r = /\\/\\//g;\nconst s = "x; y";\n'), [
    "2:semicolon in a string",
  ]);
});

test("a semicolon in a sentence string fails, in a code string it passes", () => {
  assert.deepEqual(kinds("a.ts", 'const s = "wait; then retry";\n'), [
    "1:semicolon in a string",
  ]);
  assert.deepEqual(
    kinds("a.ts", 'const css = "a { color: red; background: blue }";\n'),
    [],
  );
  assert.deepEqual(
    kinds("a.ts", 'const h = "text/plain; charset=utf-8";\n'),
    [],
  );
});

test("Markdown prose fails on a semicolon, code does not", () => {
  assert.deepEqual(kinds("a.md", "One; two\n"), ["1:semicolon in prose"]);
  assert.deepEqual(kinds("a.md", "Run `a; b` now\n"), []);
  assert.deepEqual(kinds("a.md", "```\na; b\n```\n"), []);
});

test("a note with a reason lets the code below it keep a semicolon", () => {
  const text = [
    "// punctuation: code, the Cookie header joins attributes with a semicolon",
    'const header = flags.join("; ");',
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.ts", text), []);
});

test("a note covers the whole statement, not only its first line", () => {
  const text = [
    "const files = {",
    "  // punctuation: code, a fixture file written to disk as source code",
    '  "a.ts": lines(',
    '    "  name: string;",',
    '    "  port: number;",',
    "  ),",
    "};",
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.ts", text), []);
});

test("a note without a reason fails", () => {
  const text = ["// punctuation: code", 'const h = flags.join("; ");', ""].join(
    "\n",
  );
  assert.deepEqual(kinds("a.ts", text), ["1:note without a reason"]);
});

test("a note that covers no semicolon fails", () => {
  const text = [
    "// punctuation: code, the Cookie header joins attributes with a semicolon",
    'const h = flags.join(", ");',
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.ts", text), ["1:note covers no semicolon"]);
});

test("a note never excuses a dash", () => {
  const text = [
    "// punctuation: code, the Cookie header joins attributes with a semicolon",
    `const h = "a ${EM_DASH} b; c";`,
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.ts", text), ["2:em dash"]);
});

test("skipped files are not scanned", () => {
  assert.deepEqual(kinds("docs/assets/mermaid.min.js", `${EM_DASH}`), []);
  assert.deepEqual(kinds("LICENSE", `${EM_DASH}`), []);
  assert.deepEqual(kinds("package-lock.json", `${EM_DASH}`), []);
});

test("the repository has no punctuation violations", () => {
  const found = scanRepository(root);
  if (found.length > 0) {
    throw new Error(`punctuation:\n${formatViolations(found)}`);
  }
});
