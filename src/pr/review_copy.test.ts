/** The copy guard for CORE-83 / D11.
 *
 * Product text avoids the em dash and, in prose, the semicolon. The rule
 * matters in three places at once: the model prompt (the model copies what it
 * reads there into a finding), the CLI and dashboard text a person reads, and
 * the Markdown comment posted to GitHub.
 *
 * This scans the user-visible modules for a literal `—` outside a comment and
 * runs the shared renderers. The one allowlist entry is the legacy finding
 * parser, which accepts an em dash heading so a comment posted before 0.5.0
 * still parses. */
import { test } from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readDir, readTextFile } from "../util/runtime.ts";
import { humanCopy } from "../services/review.ts";
import {
  REVIEW_COPY_RULE,
  SEVERITY_LEGEND,
  severitySection,
} from "./review_copy.ts";
import {
  CODEGRAPH_DIFF_VERIFICATION,
  MERMAID_GUIDANCE,
  NO_DIAGRAM_RULES,
  reviewSystemPrompt,
} from "./reviewer.ts";
import { formatHumanReview } from "../cli/review_result.ts";

const srcRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Files allowed to keep a literal em dash: the backward-compatible heading
 * regex in `findings.ts`, the legacy heading reader in `review_result.ts`, and
 * the doc + guard in `review_copy.ts`. Test files are skipped entirely. */
const ALLOWED = new Set([
  "pr/findings.ts",
  "cli/review_result.ts",
  "pr/review_copy.ts",
]);

/** Removes block and line comments so a JSDoc em dash is not a violation.
 * Whatever em dash survives sits in code or a string literal. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "node_modules") continue;
      yield* walk(path);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

test("no em dash in user-visible source outside the legacy parser", async () => {
  const offenders: string[] = [];
  for await (const path of walk(srcRoot)) {
    const rel = relative(srcRoot, path).replaceAll("\\", "/");
    if (rel.endsWith(".test.ts") || ALLOWED.has(rel)) continue;
    const text = await readTextFile(path);
    const lines = withoutComments(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("\u2014")) {
        offenders.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `em dash in product text (CORE-83):\n${offenders.join("\n")}`,
    );
  }
});

/** Keeps a semicolon that belongs to a protocol string, not prose. Content
 * headers, a JSON fragment, and a `findings.ts` regex are the shapes that
 * legitimately carry one. */
const SEMICOLON_ALLOWED =
  /charset=|application\/json|LOCATION_LINE|[\\[\]]|[{}()=<>|&+*?]/;

test("no stray semicolon in a user-visible string outside code shapes", async () => {
  const offenders: string[] = [];
  for await (const path of walk(srcRoot)) {
    const rel = relative(srcRoot, path).replaceAll("\\", "/");
    if (rel.endsWith(".test.ts") || ALLOWED.has(rel)) continue;
    const text = await readTextFile(path);
    const lines = withoutComments(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Only a lowercase word followed by `; ` inside a quoted or template
      // string is prose. Everything else (statements, for-loops) is code.
      if (!/[a-z]; [a-z]/.test(lines[i])) continue;
      const inString =
        /"[^"]*[a-z]; [a-z][^"]*"/.test(lines[i]) ||
        /`[^`]*[a-z]; [a-z][^`]*`/.test(lines[i]);
      if (!inString || SEMICOLON_ALLOWED.test(lines[i])) continue;
      offenders.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `prose semicolon in product text (CORE-83):\n${offenders.join("\n")}`,
    );
  }
});

test("the review copy rule names both banned marks", () => {
  if (!REVIEW_COPY_RULE.includes("em dash")) {
    throw new Error(`copy rule does not name the em dash: ${REVIEW_COPY_RULE}`);
  }
  if (!REVIEW_COPY_RULE.includes("semicolon")) {
    throw new Error(
      `copy rule does not name the semicolon: ${REVIEW_COPY_RULE}`,
    );
  }
});

test("the severity legend and section are clean", () => {
  const rendered = severitySection();
  if (rendered.includes("\u2014") || rendered.includes(";")) {
    throw new Error(`severity section is not clean:\n${rendered}`);
  }
  for (const row of SEVERITY_LEGEND) {
    const text = `${row.level} ${row.name} ${row.description}`;
    if (text.includes("\u2014") || text.includes(";")) {
      throw new Error(`severity row is not clean: ${text}`);
    }
  }
});

test("every user-facing prompt constant is clean", () => {
  const prompts: Array<[string, string]> = [
    ["MERMAID_GUIDANCE", MERMAID_GUIDANCE],
    ["NO_DIAGRAM_RULES", NO_DIAGRAM_RULES],
    ["CODEGRAPH_DIFF_VERIFICATION", CODEGRAPH_DIFF_VERIFICATION],
    ["reviewSystemPrompt(true)", reviewSystemPrompt(true)],
    ["reviewSystemPrompt(false)", reviewSystemPrompt(false)],
  ];
  for (const [name, value] of prompts) {
    if (value.includes("\u2014")) {
      throw new Error(`${name} still contains an em dash`);
    }
  }
});

test("the shared human review format prints no em dash", () => {
  const output = formatHumanReview({
    title: "co-maintainer review · owner/repo",
    stats: "2 files · +3 −1",
    guideBuiltAt: "2026-09-23T00:00:00.000Z",
    codegraphState: "used",
    findings: [
      {
        state: "new",
        severity: "P1",
        blocking: true,
        path: "src/a.ts",
        lineFrom: 4,
        lineTo: 4,
        title: "[P1 · blocking] `src/a.ts`: `run()`",
        body: "The guard is inverted.",
        suggestion: null,
      },
    ],
  });
  if (output.includes("\u2014")) {
    throw new Error(`human review output kept an em dash:\n${output}`);
  }
});

test("humanCopy keeps the legacy heading dash and removes semicolons", () => {
  const cleaned = humanCopy("Broken — really; see `a; b`");
  // The dash survives because a legacy finding title uses it as a separator.
  if (!cleaned.includes("\u2014")) {
    throw new Error(`legacy heading separator was rewritten: ${cleaned}`);
  }
  if (cleaned.includes("really;")) {
    throw new Error(`prose semicolon survived: ${cleaned}`);
  }
  if (!cleaned.includes("`a; b`")) {
    throw new Error(`inline code was rewritten: ${cleaned}`);
  }
});
