import { redact, safeCopy } from "./redact.ts";

Deno.test("redact replaces known secret shapes", () => {
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
  ];
  for (const [input, expected] of cases) {
    if (redact(input) !== expected) {
      throw new Error(`redact(${JSON.stringify(input)}) = ${redact(input)}`);
    }
  }
});

Deno.test("redact strips a PEM private key block", () => {
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

Deno.test("safeCopy strips a dash and a semicolon", () => {
  const cleaned = safeCopy("Broken — really; stop");
  if (cleaned.includes("\u2014") || cleaned.includes(";")) {
    throw new Error(cleaned);
  }
});

Deno.test("redact leaves ordinary text and commit shas alone", () => {
  const line = "merged commit a1b2c3d into main, 12 files changed";
  if (redact(line) !== line) {
    throw new Error("an ordinary log line was altered");
  }
});
