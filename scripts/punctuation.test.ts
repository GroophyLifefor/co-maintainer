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
  // punctuation: code, a fixture of TypeScript source that the check scans
  const text = [
    "// punctuation: code, the Cookie header joins attributes with a semicolon",
    'const header = flags.join("; ");',
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.ts", text), []);
});

test("a note covers the whole statement, not only its first line", () => {
  // punctuation: code, a fixture of TypeScript source that the check scans
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
  // punctuation: code, a fixture of TypeScript source that the check scans
  const text = ["// punctuation: code", 'const h = flags.join("; ");', ""].join(
    "\n",
  );
  assert.deepEqual(kinds("a.ts", text), ["1:note without a reason"]);
});

test("a note that covers no semicolon fails", () => {
  // punctuation: code, a fixture of TypeScript source that the check scans
  const text = [
    "// punctuation: code, the Cookie header joins attributes with a semicolon",
    'const h = flags.join(", ");',
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.ts", text), ["1:note covers no semicolon"]);
});

test("a note never excuses a dash", () => {
  // punctuation: code, a fixture line of source code that the test writes or reads
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

test("a word such as function does not make a sentence code", () => {
  assert.deepEqual(
    kinds("a.ts", 'const s = "call the function; then retry";\n'),
    ["1:semicolon in a string"],
  );
  assert.deepEqual(kinds("a.ts", 'const s = "if (a) { return 1; }\\n";\n'), []);
});

test("JSON string values are checked, fenced code inside them is not", () => {
  assert.deepEqual(kinds("a.json", '{"a": "first; second"}\n'), [
    "1:semicolon in a string",
  ]);
  assert.deepEqual(kinds("a.json", '{"a": "```ts\\nlet x = 1;\\n```"}\n'), []);
  assert.deepEqual(
    kinds("a.json", '{"patch": "@@ -1,3 +1,4 @@\\n+let x = 1;\\n"}\n'),
    [],
  );
  assert.deepEqual(kinds("a.json", `{"a": "x ${EM_DASH} y"}\n`), ["1:em dash"]);
});

test("HTML text is checked, code elements and entities are not", () => {
  assert.deepEqual(kinds("a.html", "<p>first; second</p>\n"), [
    "1:semicolon in prose",
  ]);
  assert.deepEqual(kinds("a.html", "<p>a &amp; b <code>x; y</code></p>\n"), []);
  assert.deepEqual(kinds("a.html", "<script>let a = 1;</script>\n"), []);
});

test("an HTML note covers the element below it, and needs a reason", () => {
  // punctuation: code, a fixture of HTML source that the check scans
  const ok = [
    "<!-- punctuation: code, the page shows a TypeScript diff as sample code -->",
    "<div><div>let a = 1;</div></div>",
    "<p>after</p>",
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.html", ok), []);
  // punctuation: code, a fixture of HTML source that the check scans
  const bare = ["<!-- punctuation: code -->", "<div>let a = 1;</div>", ""].join(
    "\n",
  );
  assert.deepEqual(kinds("a.html", bare), ["1:note without a reason"]);
  const empty = [
    "<!-- punctuation: code, the page shows a TypeScript diff as sample code -->",
    "<div>nothing here</div>",
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.html", empty), ["1:note covers no semicolon"]);
});

test("YAML values and comments are checked, run blocks are not", () => {
  assert.deepEqual(kinds("a.yml", "name: first; second\n"), [
    "1:semicolon in a string",
  ]);
  assert.deepEqual(kinds("a.yml", "# first; second\n"), [
    "1:semicolon in a comment",
  ]);
  assert.deepEqual(kinds("a.yml", "run: echo a; echo b\n"), []);
  assert.deepEqual(
    kinds("a.yml", "steps:\n  - run: |\n      echo a; echo b\n"),
    [],
  );
  assert.deepEqual(
    kinds("a.yml", "description: >\n  first; second\nname: ok\n"),
    ["2:semicolon in a string"],
  );
});

test("a fence closes only with its own marker", () => {
  assert.deepEqual(
    kinds("a.md", "~~~\n```\ncode; one\n```\ncode; two\n~~~\nprose; here\n"),
    ["7:semicolon in prose"],
  );
  assert.deepEqual(kinds("a.md", "````\n```\ncode; one\n````\nprose; here\n"), [
    "5:semicolon in prose",
  ]);
});

test("inline code may use a longer run of backticks", () => {
  assert.deepEqual(kinds("a.md", "Use ``a; b ` c`` here\n"), []);
  assert.deepEqual(kinds("a.md", "Use ``a ` b; c`` here\n"), []);
  assert.deepEqual(kinds("a.md", "Use `a; b` and `` c; d `` here\n"), []);
  assert.deepEqual(kinds("a.md", "Use `a` then b; c\n"), [
    "1:semicolon in prose",
  ]);
});

test("a note covers its statement by position, not the whole line", () => {
  // punctuation: code, a fixture of TypeScript source that the check scans
  const text = [
    "// punctuation: code, a cookie header needs its semicolon",
    'flags.join("; "); const s = "wait, then retry; now";',
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.ts", text), ["2:semicolon in a string"]);
});

test("an HTML note on a void or unclosed element stops at its opening tag", () => {
  // punctuation: code, a fixture of HTML source that the check scans
  const meta = [
    "<!-- punctuation: code, a meta tag holds a code value here -->",
    '<meta content="a; b">',
    "<p>wait; then retry</p>",
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.html", meta), [
    "1:note covers no semicolon",
    "3:semicolon in prose",
  ]);
  // punctuation: code, a fixture of HTML source that the check scans
  const unclosed = [
    "<!-- punctuation: code, a paragraph that holds code here -->",
    "<p>let a = 1;",
    "<p>wait; then retry</p>",
    "",
  ].join("\n");
  assert.deepEqual(kinds("a.html", unclosed), [
    "1:note covers no semicolon",
    "2:semicolon in prose",
    "3:semicolon in prose",
  ]);
});

test("a placeholder in braces does not make a sentence code", () => {
  assert.deepEqual(
    kinds("a.ts", 'const s = "Use {account} and retry; then wait";\n'),
    ["1:semicolon in a string"],
  );
  assert.deepEqual(kinds("a.ts", 'const s = "a { b = 1; }";\n'), []);
});

test("a template literal with a placeholder is still checked", () => {
  assert.deepEqual(
    kinds("a.ts", "const s = `wait; then retry ${x} and more`;\n"),
    ["1:semicolon in a string"],
  );
  assert.deepEqual(kinds("a.ts", "const s = `${x}; then retry`;\n"), [
    "1:semicolon in a string",
  ]);
  assert.deepEqual(kinds("a.ts", "const s = `a { b = 1; } ${x}`;\n"), []);
});

test("a media type header is code, a sentence that names a charset is not", () => {
  assert.deepEqual(
    kinds("a.ts", 'const h = "text/html; charset=utf-8";\n'),
    [],
  );
  assert.deepEqual(
    kinds("a.ts", 'const s = "Send charset=utf-8 first; then retry";\n'),
    ["1:semicolon in a string"],
  );
});

test("a CSS content string is text, a declaration list is not", () => {
  assert.deepEqual(kinds("a.css", '.a::after { content: "wait; then"; }\n'), [
    "1:semicolon in a string",
  ]);
  assert.deepEqual(kinds("a.css", ".a { color: red; margin: 0; }\n"), []);
});

test("a YAML inline comment is checked", () => {
  assert.deepEqual(kinds("a.yml", "name: ok # first; second\n"), [
    "1:semicolon in a comment",
  ]);
  assert.deepEqual(kinds("a.yml", "name: ok # fine\n"), []);
});

test("shell strings are checked, statement separators are not", () => {
  assert.deepEqual(kinds("a.sh", 'echo "wait; then retry"\n'), [
    "1:semicolon in a string",
  ]);
  assert.deepEqual(kinds("a.sh", "cd /tmp; ls\n"), []);
  // punctuation: code, a fixture of shell source that the check scans
  const noted = [
    "# punctuation: code, the sed script ends its substitution with a semicolon",
    "RUN v=\"$(sed -n 's/a/b/;p' f)\" \\",
    ' && echo "x; y"',
    "",
  ].join("\n");
  assert.deepEqual(kinds("Dockerfile", noted), []);
  assert.deepEqual(
    kinds("a.sh", "# punctuation: code, a note with a reason\necho ok\n"),
    ["1:note covers no semicolon"],
  );
});

test("every other text file is read as prose", () => {
  assert.deepEqual(kinds("a.txt", "wait; then retry\n"), [
    "1:semicolon in prose",
  ]);
  assert.deepEqual(kinds("a.xml", "<a>wait; then retry</a>\n"), [
    "1:semicolon in prose",
  ]);
  assert.deepEqual(kinds("a.svg", '<path d="M0 0;"/>\n'), []);
  assert.deepEqual(kinds("notes", "first; second\n"), ["1:semicolon in prose"]);
});

test("HTML attributes that a person reads are checked", () => {
  assert.deepEqual(
    kinds("a.html", '<button aria-label="wait; then retry">x</button>\n'),
    ["1:semicolon in prose"],
  );
  assert.deepEqual(kinds("a.html", '<a title="plain" href="/a;b">x</a>\n'), []);
});

test("a repeated JSON value is reported at its own line", () => {
  const json = '{"a": "wait; then retry",\n "b": "wait; then retry"}\n';
  assert.deepEqual(kinds("a.json", json), [
    "1:semicolon in a string",
    "2:semicolon in a string",
  ]);
});

test("an HTML comment is prose, an entity in it is not a semicolon", () => {
  assert.deepEqual(kinds("a.html", "<!-- first; second -->\n<p>ok</p>\n"), [
    "1:semicolon in a comment",
  ]);
  assert.deepEqual(kinds("a.html", "<!-- a &#10; b -->\n<p>ok</p>\n"), []);
});

test("markup in a string does not exempt the words around it", () => {
  assert.deepEqual(
    kinds("a.ts", 'const s = "Tom &amp; Jerry; then retry";\n'),
    ["1:semicolon in a string"],
  );
  assert.deepEqual(
    kinds("a.ts", 'const s = "Click <b>here</b>; then retry";\n'),
    ["1:semicolon in a string"],
  );
  assert.deepEqual(
    kinds("a.ts", 'const s = "<a style=\\"a:b;c:d\\">x</a>";\n'),
    [],
  );
  assert.deepEqual(kinds("a.ts", 'const s = "<script>run();</script>";\n'), []);
  assert.deepEqual(
    kinds("a.ts", 'const s = `<a style="a:b;c:d" href=${x}`;\n'),
    [],
  );
});

test("JSDoc text is checked for dashes and semicolons", () => {
  assert.deepEqual(
    kinds(
      "a.ts",
      "/**\n * one; two\n * @param a x\n */\nexport function f(a: number) {}\n",
    ),
    ["2:semicolon in a comment"],
  );
  assert.deepEqual(
    kinds("a.ts", `/** one ${EM_DASH} two */\nexport const a = 1;\n`),
    ["1:em dash"],
  );
});

test("JSX text is checked", () => {
  assert.deepEqual(kinds("a.tsx", "const a = <b>first; second</b>;\n"), [
    "1:semicolon in a string",
  ]);
  assert.deepEqual(
    kinds("a.tsx", `const a = <b>first ${EM_DASH} second</b>;\n`),
    ["1:em dash"],
  );
});

test("the repository has no punctuation violations", () => {
  const found = scanRepository(root);
  if (found.length > 0) {
    throw new Error(`punctuation:\n${formatViolations(found)}`);
  }
});
