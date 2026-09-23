/** Structured review output (CORE-40 / F02).
 *
 * F02: the model's free-form Markdown was sliced by the fallback parser, so a
 * finding ended mid-token (`... while \`u`) and the next one started in the
 * middle of another finding's prose. The model now returns JSON and our code
 * renders the Markdown, so a finding's boundaries are never guessed. These
 * tests pin the two halves: the JSON answer renders exactly the Markdown
 * `parseFindings` reads, and the legacy parser still handles an answer that is
 * not JSON (a provider that ignores `response_format`).
 */
import { test } from "node:test";
import { parseFindings } from "./findings.ts";
import { findingsMarkdownFromJson } from "./findings_json.ts";
import {
  F02_COLON_MARKDOWN,
  F02_EXPECTED_PATHS,
  F02_JSON,
} from "../testing/fixtures/review_output.ts";

function must(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what}: got undefined`);
  return value;
}

const JSON_ANSWER = JSON.stringify({
  findings: [
    {
      severity: "P1",
      blocking: true,
      path: "src/util/split.ts",
      lineFrom: 42,
      lineTo: 44,
      symbol: "splitOnce()",
      title: "splitOnce drops the separator when it is the last character",
      body: "The loop stops before the final index, so a separator at the end is never trimmed. Callers that pass a trailing delimiter get a silent empty tail.",
      suggestion: "  return at === source.length - 1 ? source : rest;",
    },
    {
      severity: "P2",
      blocking: false,
      path: "src/util/split.ts",
      lineFrom: 80,
      title: "The helper name does not match what it returns",
      body: "It returns a list, not a single value. The name misleads every caller.",
    },
  ],
  previousFindings: [{ id: "F1", state: "closed" }],
});

test("a JSON answer renders Markdown the parser reads back whole", () => {
  const markdown = must(findingsMarkdownFromJson(JSON_ANSWER), "json answer");
  const findings = parseFindings(markdown);
  if (findings.length !== 2) {
    throw new Error(`expected 2 findings, got ${findings.length}`);
  }
  const [first, second] = findings;
  // The defect F02 described: the first finding was cut off mid-token. Every
  // field the model supplied survives the round trip intact.
  if (first.from !== 42 || first.to !== 44) {
    throw new Error(`first span: ${first.from}-${first.to}`);
  }
  if (first.severity !== "P1" || first.blocking !== true) {
    throw new Error(
      `first severity/impact: ${first.severity}/${first.blocking}`,
    );
  }
  if (first.symbol !== "splitOnce()") {
    throw new Error(`first symbol: ${first.symbol}`);
  }
  if (!first.excerpt.includes("never trimmed")) {
    throw new Error(`first excerpt lost the body: ${first.excerpt}`);
  }
  if (/while\s*`?\w*$/.test(first.excerpt)) {
    throw new Error(
      `first excerpt looks truncated mid-token: ${first.excerpt}`,
    );
  }
  // Second finding starts where its own heading is, not inside the first one.
  if (second.from !== 80) throw new Error(`second line: ${second.from}`);
  if (!second.excerpt.startsWith("It returns a list")) {
    throw new Error(`second excerpt starts off-target: ${second.excerpt}`);
  }
});

test("the rendered finding keeps the line span the model chose", () => {
  const markdown = must(findingsMarkdownFromJson(JSON_ANSWER), "json answer");
  if (!markdown.includes("Location: `src/util/split.ts:42-44`")) {
    throw new Error(`no span in the location line:\n${markdown}`);
  }
  // The suggestion is a fenced `suggestion` block carrying only source lines.
  if (!markdown.includes("```suggestion\n  return at ===")) {
    throw new Error(`suggestion block missing:\n${markdown}`);
  }
  if (!markdown.includes("## Previous findings")) {
    throw new Error(`previous findings missing:\n${markdown}`);
  }
  if (!markdown.includes("- F1: closed")) {
    throw new Error(`verdict missing:\n${markdown}`);
  }
});

test("a clean review renders the no-findings line, not a heading", () => {
  const markdown = must(
    findingsMarkdownFromJson('{"findings":[]}'),
    "empty findings",
  );
  if (!markdown.includes("No actionable findings.")) {
    throw new Error(`no clean line:\n${markdown}`);
  }
  if (parseFindings(markdown).length !== 0) {
    throw new Error("a clean review parsed as findings");
  }
});

test("prose or a missing object is not JSON, so the caller can fall back", () => {
  if (
    findingsMarkdownFromJson("I could not find anything useful.") !== undefined
  ) {
    throw new Error("plain prose was accepted as JSON");
  }
  if (findingsMarkdownFromJson('{"notes":"hi"}') !== undefined) {
    throw new Error("an object without findings was accepted");
  }
  if (
    findingsMarkdownFromJson('{"findings":[{"body":"no path"}]}') !== undefined
  ) {
    throw new Error("findings with no usable path were accepted");
  }
});

test("a fenced JSON block is still read", () => {
  // Providers without structured output ignore `response_format`, so the
  // prompt also asks for a fenced block. Both shapes must work.
  const markdown = must(
    findingsMarkdownFromJson(
      `Here you go:\n\n\`\`\`json\n${JSON_ANSWER}\n\`\`\``,
    ),
    "fenced answer",
  );
  if (!markdown.includes("src/util/split.ts:42-44")) {
    throw new Error(`fenced answer did not render:\n${markdown}`);
  }
});

test("the legacy parser accepts a colon separator and an omitted symbol", () => {
  // The exact F02 trigger: the model wrote `:` instead of the em dash, so the
  // old regex rejected the heading and the fallback sliced by offsets.
  const colon = parseFindings(`## Findings

### [P2 · non-blocking] \`src/a.ts\`: \`helper()\`
Location: \`src/a.ts:10\`

The helper ignores its argument.

### [P3 · non-blocking] \`src/b.ts\`
Location: \`src/b.ts:3-4\`

This name does not match what it returns.
`);
  if (colon.length !== 2) throw new Error(`colon headings: ${colon.length}`);
  if (colon[0].from !== 10 || colon[0].symbol !== "helper()") {
    throw new Error(`first colon finding: ${JSON.stringify(colon[0])}`);
  }
  // The heading itself may omit the symbol; the Location line still supplies
  // the path.
  if (colon[1].path !== "src/b.ts" || colon[1].symbol !== undefined) {
    throw new Error(`second colon finding: ${JSON.stringify(colon[1])}`);
  }
});

test("the reconstructed F02 answer no longer splits mid-token", () => {
  // The colon-separated Markdown from the report. Before the regex fix both
  // headings were rejected and the parser sliced `while \`u` into one finding
  // and `s it through ...` into the next. The headings are now recognised, so
  // each finding keeps its own span and its own prose.
  const findings = parseFindings(F02_COLON_MARKDOWN);
  if (findings.length !== F02_EXPECTED_PATHS.length) {
    throw new Error(`recovered ${findings.length} findings`);
  }
  if (
    findings.map((item) => item.path).join(",") !== F02_EXPECTED_PATHS.join(",")
  ) {
    throw new Error(`paths: ${findings.map((item) => item.path).join(",")}`);
  }
  for (const finding of findings) {
    // The old parser sliced the answer at a fixed offset, so a body ended
    // mid-token (`... while \`u`). A real boundary never does.
    if (/while\s*`?\w*$/.test(finding.excerpt)) {
      throw new Error(`still cut mid-token: ${finding.excerpt}`);
    }
  }
  if (!findings[0].excerpt.includes("never observes the deadline")) {
    throw new Error(`first body incomplete: ${findings[0].excerpt}`);
  }
  // The second finding's excerpt starts at its own prose, not inside the
  // first one's.
  if (!findings[1].excerpt.startsWith("When the response is empty")) {
    throw new Error(`second excerpt start: ${findings[1].excerpt}`);
  }
});

test("the F02 findings survive the JSON round trip whole", () => {
  const markdown = must(findingsMarkdownFromJson(F02_JSON), "F02 json");
  const findings = parseFindings(markdown);
  if (
    findings.map((item) => item.path).join(",") !== F02_EXPECTED_PATHS.join(",")
  ) {
    throw new Error(`paths: ${findings.map((item) => item.path).join(",")}`);
  }
  if (findings[0].from !== 120 || findings[0].to !== 118) {
    throw new Error(`first span: ${findings[0].from}-${findings[0].to}`);
  }
  // Every body the model supplied is present in full, so a JSON consumer and
  // the CLI show the same text.
  const bodies = [
    "The loop re-reads the condition but has no deadline",
    "passes it through the package's public entry point",
  ];
  for (let index = 0; index < bodies.length; index++) {
    if (!findings[index].excerpt.includes(bodies[index])) {
      throw new Error(`body ${index} lost: ${findings[index].excerpt}`);
    }
  }
});

/** A parser can only guess a finding's boundary if the renderer left one; this
 * walks many answers with prose of different lengths and checks each excerpt
 * is exactly the body that went in, never a slice of its neighbour (CORE-40). */
test("boundaries hold across many finding shapes", () => {
  for (let index = 0; index < 60; index++) {
    const body = `body-${index} `.repeat((index % 7) + 1).trim();
    const next = `next-${index} `.repeat((index % 5) + 1).trim();
    const markdown = must(
      findingsMarkdownFromJson(
        JSON.stringify({
          findings: [
            {
              severity: "P2",
              blocking: false,
              path: `src/f${index}.ts`,
              lineFrom: index + 1,
              title: `title ${index}`,
              body,
            },
            {
              severity: "P3",
              blocking: false,
              path: `src/g${index}.ts`,
              lineFrom: index + 100,
              title: `other ${index}`,
              body: next,
            },
          ],
        }),
      ),
      `answer ${index}`,
    );
    const findings = parseFindings(markdown);
    if (findings.length !== 2) {
      throw new Error(`answer ${index}: ${findings.length} findings`);
    }
    if (findings[0].excerpt !== body) {
      throw new Error(
        `answer ${index}: first excerpt is ${findings[0].excerpt}`,
      );
    }
    if (findings[1].excerpt !== next) {
      throw new Error(
        `answer ${index}: second excerpt is ${findings[1].excerpt}`,
      );
    }
  }
});
