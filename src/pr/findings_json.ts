/** Structured review output (CORE-40 / F02).
 *
 * F02: findings were truncated mid-sentence (`... while \`u`) and split at the
 * wrong offsets, because the model's free-form Markdown was sliced by the
 * fallback parser. The fix is to have the model return JSON and generate the
 * Markdown ourselves, so a finding's boundaries can no longer be guessed from
 * prose. Markdown stays the internal contract — every downstream consumer
 * (`parseFindings`, carry-over, GitHub posting) keeps working unchanged.
 */
import type { Json } from "../types.ts";
import type { ParsedFinding } from "./findings.ts";

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

/** OpenRouter `response_format` for a review. Providers that ignore it still
 * get the prompt's instruction to return a fenced JSON block. */
export const FINDINGS_JSON_SCHEMA: Json = {
  type: "json_schema",
  json_schema: {
    name: "review_findings",
    strict: false,
    schema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: [...SEVERITIES] },
              blocking: { type: "boolean" },
              path: { type: "string" },
              lineFrom: { type: "integer" },
              lineTo: { type: "integer" },
              symbol: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              suggestion: { type: "string" },
            },
            required: ["severity", "path", "lineFrom", "title", "body"],
          },
        },
        previousFindings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              state: { type: "string", enum: ["open", "closed"] },
              path: { type: "string" },
              lineFrom: { type: "integer" },
              lineTo: { type: "integer" },
            },
            required: ["id", "state"],
          },
        },
      },
      required: ["findings"],
    },
  },
};

/** The prompt's contract, kept next to the schema so the two cannot drift. */
export const FINDINGS_JSON_INSTRUCTIONS = `Return a single JSON object, and nothing else, with this shape:
{"findings":[{"severity":"P1","blocking":true,"path":"src/a.ts","lineFrom":42,"lineTo":42,"symbol":"helper()","title":"The helper ignores its argument","body":"One sentence on what is wrong and its impact, then a short evidence paragraph.","suggestion":"the exact replacement lines, or omit this field"}],"previousFindings":[{"id":"F1","state":"open"}]}

Rules for the JSON:
- "severity" is exactly one of P0, P1, P2, P3. "blocking" is true or false.
- "lineFrom" and "lineTo" are numbers in the new file, copied from the DIFF
  column, never counted from the @@ header. "lineTo" may equal "lineFrom".
- "title" is one sentence naming the defect, without the severity or the path.
- "body" is the explanation. Do not repeat the title, the path, or the location
  line inside it; our code renders those. Do not add a closing sentence asking
  whether to explain more, and do not use the words Mechanism, Symptom,
  Scenario, Verified, Repro, Options, or Scope as labels.
- "suggestion" holds only the replacement source lines, with their original
  indentation, when the fix replaces the exact lines lineFrom-lineTo in one
  hunk of the same file. Omit it otherwise. Never wrap it in a code fence.
- When a fix needs removed lines, another file, or more than one hunk, omit
  "suggestion".
- Return every independently actionable finding, including none: use
  {"findings":[]} when the change is clean. Never invent a finding to fill the
  array.`;

function asNumber(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number)
    ? Math.trunc(number)
    : undefined;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Like {@link asText} but keeps the leading indentation. A suggestion is
 * source lines with their original indentation, so trimming the left edge
 * changes the code it proposes (CORE-40). Only the outer blank lines go. */
function asSource(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/^\s*\n/, "").replace(/\s+$/, "")
    : "";
}

/** Strips a Markdown fence and any prose around the JSON object. */
function extractJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

type JsonFinding = {
  severity?: unknown;
  blocking?: unknown;
  path?: unknown;
  lineFrom?: unknown;
  lineTo?: unknown;
  symbol?: unknown;
  title?: unknown;
  body?: unknown;
  suggestion?: unknown;
};

/** One JSON finding as Markdown, in the exact shape `parseFindings` reads.
 * Rendering it here is the point: the model never writes this text itself. */
function findingMarkdown(raw: JsonFinding): string | undefined {
  const path = asText(raw.path);
  const title = asText(raw.title);
  const lineFrom = asNumber(raw.lineFrom);
  if (!path || !title || lineFrom === undefined || lineFrom <= 0) {
    return undefined;
  }
  const severity = asText(raw.severity).toUpperCase();
  const level = (SEVERITIES as readonly string[]).includes(severity)
    ? severity
    : "P2";
  const impact = raw.blocking === true ? "blocking" : "non-blocking";
  const symbol = asText(raw.symbol);
  const lineTo = asNumber(raw.lineTo) ?? lineFrom;
  const span = lineTo === lineFrom ? `${lineFrom}` : `${lineFrom}-${lineTo}`;
  const suggestion = asSource(raw.suggestion);

  const lines = [
    `### [${level} · ${impact}] \`${path}\`${symbol ? ` — \`${symbol}\`` : ""}`,
    `Location: \`${path}:${span}\``,
    "",
    asText(raw.body),
  ];
  if (suggestion) {
    lines.push(
      "",
      `Suggestion: \`${path}:${span}\``,
      "```suggestion",
      suggestion,
      "```",
    );
  }
  return lines.join("\n");
}

/** Reads the structured output and renders it as Markdown. `undefined` means
 * the text was not usable JSON, so the caller falls back to the legacy
 * Markdown parser rather than dropping the review. */
export function findingsMarkdownFromJson(text: string): string | undefined {
  const parsed = extractJson(text) as
    | { findings?: unknown; previousFindings?: unknown }
    | undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const raw = Array.isArray(parsed.findings) ? parsed.findings : undefined;
  if (!raw) return undefined;

  const blocks = raw
    .map((item) =>
      item && typeof item === "object"
        ? findingMarkdown(item as JsonFinding)
        : undefined,
    )
    .filter((block): block is string => block !== undefined);

  // A JSON object whose findings were all missing a path or a title is a
  // malformed answer, not a clean review: falling back keeps it visible.
  if (raw.length > 0 && blocks.length === 0) return undefined;

  const parts = ["## Findings", ""];
  parts.push(blocks.length ? blocks.join("\n\n") : "No actionable findings.");
  const previous = Array.isArray(parsed.previousFindings)
    ? parsed.previousFindings
    : [];
  const verdicts = previous
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const value = item as Record<string, unknown>;
      const id = asText(value.id);
      const state = asText(value.state).toLowerCase();
      if (!id || (state !== "open" && state !== "closed")) return undefined;
      if (state === "closed") return `- ${id}: closed`;
      const path = asText(value.path);
      const from = asNumber(value.lineFrom);
      const to = asNumber(value.lineTo) ?? from;
      if (!path || from === undefined) return `- ${id}: open`;
      return `- ${id}: open ${path}:${from}${to !== from ? `-${to}` : ""}`;
    })
    .filter((line): line is string => line !== undefined);
  if (verdicts.length) {
    parts.push("", "## Previous findings", "", verdicts.join("\n"));
  }
  return parts.join("\n");
}

/** The findings a JSON review produced, for callers that want the objects
 * rather than the Markdown. */
export type JsonFindingResult = {
  markdown: string;
  findings: ParsedFinding[];
};
