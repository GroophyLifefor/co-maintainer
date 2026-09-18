import { cloneDirFor, parseOcrFindings, parseOcrUsage } from "./runners.ts";
import { test } from "node:test";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

test("cloneDirFor does not collide across a moved slash", () => {
  const a = cloneDirFor("clones", "a/b-c");
  const b = cloneDirFor("clones", "a-b/c");
  if (a === b) throw new Error(`both mapped to ${a}`);
});

test("parseOcrFindings reads a top-level array", () => {
  const findings = parseOcrFindings(
    JSON.stringify([
      { file: "src/a.ts", line: 12, title: "NPE", message: "may be null" },
    ]),
  );
  same(
    findings,
    [
      {
        path: "src/a.ts",
        from: 12,
        to: 12,
        heading: "NPE",
        excerpt: "may be null",
      },
    ],
    "top-level array",
  );
});

test("parseOcrFindings reads a nested list and a line range", () => {
  const findings = parseOcrFindings(
    JSON.stringify({
      data: {
        findings: [
          {
            path: "src/b.ts",
            start_line: 4,
            end_line: 9,
            rule: "xss",
            body: "unescaped",
            severity: "P1",
          },
        ],
      },
    }),
  );
  same(findings.length, 1, "nested count");
  same([findings[0].from, findings[0].to], [4, 9], "line range");
  same(findings[0].severity, "P1", "severity");
});

test("parseOcrFindings drops rows with no line anchor", () => {
  same(
    parseOcrFindings(
      JSON.stringify({
        findings: [{ file: "src/c.ts", message: "file-level note" }],
      }),
    ),
    [],
    "unanchored row",
  );
});

test("parseOcrFindings survives non-JSON output", () => {
  same(parseOcrFindings("review failed"), [], "non-JSON");
});

test("parseOcrUsage marks cost unknown when absent", () => {
  const usage = parseOcrUsage(
    JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  );
  same(
    [usage.tokensIn, usage.tokensOut, usage.costKnown],
    [100, 20, false],
    "usage",
  );
});

test("parseOcrUsage reads the real OCR summary shape", () => {
  const usage = parseOcrUsage(
    JSON.stringify({
      status: "complete",
      summary: {
        files_reviewed: 29,
        comments: 4,
        total_tokens: 1461748,
        input_tokens: 1419689,
        output_tokens: 42059,
      },
    }),
  );
  same(
    [usage.tokensIn, usage.tokensOut, usage.costKnown],
    [1419689, 42059, false],
    "summary usage",
  );
});

test("parseOcrFindings reads the real OCR comment shape", () => {
  const findings = parseOcrFindings(
    JSON.stringify({
      comments: [
        {
          path: "packages/a/index.ts",
          content: "These properties are not declared.",
          start_line: 41,
          end_line: 45,
          category: "maintainability",
          severity: "low",
        },
      ],
    }),
  );
  same(findings.length, 1, "count");
  same(
    [findings[0].path, findings[0].from, findings[0].to, findings[0].severity],
    ["packages/a/index.ts", 41, 45, "low"],
    "anchor",
  );
});
