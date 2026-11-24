import {
  hasSecretMask,
  maskSecrets,
  outsideCode,
  redact,
  safeCopy,
} from "./redact.ts";
import { test } from "node:test";

test("redact replaces known secret shapes", () => {
  const cases: [string, string][] = [
    [
      "token ghp_1234567890abcdEFGH1234567890 was used",
      "token [redacted] was used",
    ],
    [
      "pat github_pat_11AAAA0000_abcdefghijklmnopqrstuvwxyz1234",
      "pat [redacted]",
    ],
    ["key sk-or-v1-abcdef0123456789 here", "key [redacted] here"],
    [
      "openai sk-proj-AbCdEf0123456789_ghIJkl-mnop here",
      "openai [redacted] here",
    ],
    [
      "legacy sk-abcdefghijklmnopqrstuvwxyz123456 here",
      "legacy [redacted] here",
    ],
  ];
  for (const [input, expected] of cases) {
    if (redact(input) !== expected) {
      throw new Error(`redact(${JSON.stringify(input)}) = ${redact(input)}`);
    }
  }
});

test("redact strips a PEM private key block", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAK...
-----END RSA PRIVATE KEY-----`;
  const result = redact(`before\n${pem}\nafter`);
  if (result.includes("MIIBOgIBAAJBAK")) {
    throw new Error("PEM body leaked through");
  }
  if (!result.includes("[redacted]")) {
    throw new Error("PEM block was not redacted");
  }
});

test("safeCopy strips a dash and a semicolon", () => {
  // punctuation: code, the test feeds a prose semicolon to the cleaner
  const cleaned = safeCopy("Broken \u2014 really; stop");
  // punctuation: code, the guard looks for the semicolon character in the output
  if (cleaned.includes("\u2014") || cleaned.includes(";")) {
    throw new Error(cleaned);
  }
});

test("safeCopy leaves code blocks alone so suggestions still compile", () => {
  // punctuation: code, the test feeds a prose semicolon to the cleaner
  const source = `Prose with a semicolon; and more.

\`\`\`ts
let known = true;
\`\`\`

Inline \`a; b\` stays too.`;
  const cleaned = safeCopy(source);
  // punctuation: code, the test checks that a prose semicolon is gone
  if (cleaned.includes("semicolon;")) throw new Error(cleaned);
  // punctuation: code, the test needs a semicolon character as input or to assert on
  if (!cleaned.includes("let known = true;")) throw new Error(cleaned);
  // punctuation: code, the test checks that a semicolon inside inline code stays
  if (!cleaned.includes("`a; b`")) throw new Error(cleaned);
});

test("safeCopy leaves a four backtick fence with a nested fence alone", () => {
  const source =
    "Fix it; like this.\n\n````suggestion\n```js\nlet a = 1;\n```\n````";
  const cleaned = safeCopy(source);
  if (!cleaned.includes("```js\nlet a = 1;\n```\n````"))
    throw new Error(cleaned);
  // punctuation: code, the test checks that a prose semicolon is gone
  if (cleaned.includes("it;")) throw new Error(cleaned);
});

test("outsideCode reports untouched text when prose is already clean", () => {
  // punctuation: code, the test checks that a semicolon inside a code block stays
  const source = "clean prose \`\`\`code; here\`\`\`";
  // punctuation: code, the check names the semicolon it removes from text
  if (outsideCode(source, (prose) => prose.replaceAll(";", "")) !== source) {
    throw new Error("a semicolon inside code was treated as forbidden copy");
  }
});

test("redact leaves ordinary text and commit shas alone", () => {
  const line = "merged commit a1b2c3d into main, 12 files changed";
  if (redact(line) !== line) {
    throw new Error("an ordinary log line was altered");
  }
});

test("safeCopy keeps the line breaks around a dash", () => {
  const dash = String.fromCharCode(0x2014);
  const cleaned = safeCopy(
    `First paragraph.\n\n${dash} a list item\nnext ${dash} line`,
  );
  if (cleaned !== "First paragraph.\n\n, a list item\nnext, line") {
    throw new Error(JSON.stringify(cleaned));
  }
});

// Fake values are built at runtime, so no secret shape sits in the source.
const fake = (...parts: string[]) => parts.join("");

test("maskSecrets names the kind of each secret it hides", () => {
  const cases: [string, string][] = [
    [fake("ghp", "_", "A".repeat(36)), "github-token"],
    [fake("sk-or-", "v1-", "a".repeat(20)), "openrouter-key"],
    [fake("sk-ant-", "api03-", "b".repeat(20)), "anthropic-key"],
    [fake("sk-", "proj-", "c".repeat(24)), "openai-key"],
    [fake("sk", "_live_", "d".repeat(24)), "stripe-key"],
    [fake("AKIA", "ABCDEFGHIJKLMNOP"), "aws-access-key"],
    [fake("xox", "b-", "1234567890-abcdef"), "slack-token"],
    [fake("AIza", "e".repeat(35)), "google-key"],
    [fake("glpat", "-", "f".repeat(20)), "gitlab-token"],
    [fake("npm", "_", "g".repeat(36)), "npm-token"],
    [fake("cmr", "_", "h".repeat(24)), "co-maintainer-token"],
  ];
  for (const [value, kind] of cases) {
    const { text, count } = maskSecrets(`const key = "${value}"\n`);
    if (text !== `const key = "[redacted:${kind}]"\n` || count !== 1) {
      throw new Error(`${kind}: got ${text} (${count})`);
    }
  }
});

test("maskSecrets keeps the text around a value secret", () => {
  const cases: [string, string][] = [
    [
      fake("aws_secret_access_key = ", "A1b2".repeat(10)),
      "aws_secret_access_key = [redacted:aws-secret-key]",
    ],
    [
      fake("postgres://app:", "s3cret-pass", "@db:5432/app"),
      "postgres://app:[redacted:url-password]@db:5432/app",
    ],
    [
      fake(
        "eyJhbGciOiJIUzI1NiJ9",
        ".",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".",
        "x".repeat(43),
      ),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.[redacted:jwt-signature]",
    ],
  ];
  for (const [input, want] of cases) {
    const { text } = maskSecrets(input);
    if (text !== want) throw new Error(`got ${text}, want ${want}`);
  }
});

test("maskSecrets keeps a private key's lines, also with its END cut off", () => {
  const body = ["M".repeat(64), "N".repeat(64), "O".repeat(20)].join("\n");
  const begin = fake("-----BEGIN ", "RSA PRIVATE KEY-----");
  const end = fake("-----END ", "RSA PRIVATE KEY-----");
  const whole = `+${begin}\n+${body.replaceAll("\n", "\n+")}\n+${end}\n+next line`;
  const masked = maskSecrets(whole);
  if (masked.text.split("\n").length !== whole.split("\n").length) {
    throw new Error("the line count changed");
  }
  if (masked.text.includes("MMMM") || !masked.text.includes(end)) {
    throw new Error(`body kept or END lost: ${masked.text}`);
  }
  if (masked.count !== 1) throw new Error(`one key counted ${masked.count}`);
  const cut = maskSecrets(`${begin}\n${body}`);
  if (cut.text.includes("NNNN")) throw new Error("a cut key kept its body");
});

test("maskSecrets leaves ordinary code alone and runs twice to the same text", () => {
  const ordinary = [
    'class="mask-radial-farthest-side task-runner-config-value"',
    "commit 3f786850e387550fdab836ed7e6dc881de23001b",
    "id 123e4567-e89b-12d3-a456-426614174000",
    "const desk_live_wire = 1",
    "https://example.com/path",
  ].join("\n");
  const { text, count } = maskSecrets(ordinary);
  if (text !== ordinary || count !== 0) throw new Error(`changed: ${text}`);
  const once = maskSecrets(fake("ghp", "_", "Z".repeat(36))).text;
  if (maskSecrets(once).text !== once || !hasSecretMask(once)) {
    throw new Error("not idempotent");
  }
});

test("redact no longer cuts an identifier that only contains sk-", () => {
  const text = "mask-radial-farthest-side-with-a-long-tail";
  if (redact(text) !== text) throw new Error(redact(text));
});
