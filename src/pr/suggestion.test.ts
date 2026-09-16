import {
  plainSuggestionFences,
  readSuggestion,
  stripSuggestion,
  suggestionAnchor,
} from "./suggestion.ts";
import type { ParsedFinding } from "./findings.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

const PATCH = [
  "@@ -16,3 +16,3 @@",
  " function gate() {",
  "-  const failing = old;",
  "+  const failing = list.filter((v) => v > threshold);",
  "   return failing;",
].join("\n");

const CLOSING = "If you'd like me to explain it in more detail, please ask.";

function finding(
  suggestion: string,
  from = 16,
  to = 18,
  path = "src/gate.js",
): ParsedFinding {
  return {
    path: "src/gate.js",
    from,
    to,
    heading: "gate",
    excerpt:
      `The comparison is strict.\n\nSuggestion: \`${path}:${suggestion}\`\n` +
      "```suggestion\n  const failing = list.filter((v) => v >= threshold);\n```" +
      `\n\n${CLOSING}`,
  };
}

Deno.test("suggestionAnchor accepts a real change inside the span and one hunk", () => {
  same(suggestionAnchor(finding("17"), PATCH), { line: 17 }, "single line");
});

Deno.test("suggestionAnchor rejects what GitHub could not apply as written", () => {
  same(suggestionAnchor(finding("17", 18, 18), PATCH), undefined, "outside span");
  same(suggestionAnchor(finding("19", 16, 20), PATCH), undefined, "outside hunk");
  same(
    suggestionAnchor(finding("17", 16, 18, "src/other.js"), PATCH),
    undefined,
    "other file",
  );
  same(suggestionAnchor(finding("17"), ""), undefined, "withheld patch");
  const unchanged = finding("17");
  unchanged.excerpt = unchanged.excerpt.replace(">=", ">");
  same(suggestionAnchor(unchanged, PATCH), undefined, "no change");
  const twice = finding("17");
  twice.excerpt += "\n```suggestion\nagain\n```";
  same(suggestionAnchor(twice, PATCH), undefined, "two blocks");
});

Deno.test("suggestionAnchor anchors a multi-line replacement on its whole range", () => {
  const multi = finding("17-18");
  multi.excerpt = multi.excerpt.replace(
    "threshold);\n```",
    "threshold);\n  return failing;\n```",
  );
  same(suggestionAnchor(multi, PATCH), { start_line: 17, line: 18 }, "range");
});

Deno.test("readSuggestion reads a four backtick block with a fence inside", () => {
  const body = "Suggestion: `README.md:3`\n````suggestion\n```js\nrun()\n```\n````";
  same(
    readSuggestion(body),
    { path: "README.md", from: 3, to: 3, code: "```js\nrun()\n```" },
    "nested",
  );
});

Deno.test("stripSuggestion keeps the prose and the closing sentence", () => {
  same(
    stripSuggestion(finding("17").excerpt),
    `The comparison is strict.\n\n${CLOSING}`,
    "stripped",
  );
});

Deno.test("plainSuggestionFences turns a suggestion into a normal code block", () => {
  same(
    plainSuggestionFences("Try:\n```suggestion\nx\n```\n````suggestion\ny\n````"),
    "Try:\n```\nx\n```\n````\ny\n````",
    "plain",
  );
});
