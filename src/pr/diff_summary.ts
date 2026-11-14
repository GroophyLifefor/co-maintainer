import type { AiProvider, AiResponse, Json } from "../types.ts";
import { numberPatch } from "./hunks.ts";

export const DIFF_SUMMARY_THRESHOLD = 500;

export function needsSummary(changes: number, patch: string): boolean {
  return patch !== "" && changes > DIFF_SUMMARY_THRESHOLD;
}

// No system prompt, low max output: a mechanical description, not reasoning.
export async function summarizeDiff(
  path: string,
  patch: string,
  provider: AiProvider,
  usage?: (response: AiResponse) => Promise<void>,
): Promise<string> {
  const response = await provider.complete({
    job: "summarize_large_diff",
    prompt: `Summarize this diff for \`${path}\` in 3-5 sentences: what changed, the
mechanism, and precisely which branches, patterns, or call paths are affected.
Do not speculate beyond what the diff shows. Do not suggest fixes or judge
whether the change is correct. Only describe it.

${patch}`,
    maxTokens: 500,
  });
  if (usage) await usage(response);
  return response.text.trim();
}

/** Default for `reviewReadDiffMaxChars`: the most characters one
 * `read-full-diff` answer returns. Every tool result is sent again in each
 * later round of the tool loop, so one big read would otherwise be paid for
 * many times. */
export const DEFAULT_READ_DIFF_MAX_CHARS = 20_000;

/** The repository's cap on one `read-full-diff` answer, or `null` for no
 * limit. Unset takes the default, and 0 or a negative number means no limit,
 * the same rule as `reviewSystemPromptMaxChars`. */
export function readDiffMaxChars(
  repoConfig: { reviewReadDiffMaxChars?: number } | undefined,
): number | null {
  const raw = repoConfig?.reviewReadDiffMaxChars;
  if (raw === undefined) return DEFAULT_READ_DIFF_MAX_CHARS;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

export const READ_FULL_DIFF_TOOL: Json = {
  type: "function",
  function: {
    name: "read-full-diff",
    description:
      "Read the diff of one changed file in pages. Use it for a file whose diff is cut off, summarized, or listed under NOT SHOWN. Files shown in full are already in the prompt. offset and limit count diff lines from 0, and every line keeps its line number in the new file. A long answer is cut and ends with the offset to call again with.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The file path exactly as it appears in this prompt's DIFF or PULL REQUEST section.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The first diff line to return, counted from 0.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "The most diff lines to return.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

/** What `read-full-diff` knows about one changed file. */
export type ReadableDiff = {
  state: "full" | "partial" | "summarized" | "dropped" | "withheld";
  patch: string;
};

function lineArg(value: unknown, fallback: number, least: number): number {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < least) return Number.NaN;
  return number;
}

// The patch is already in memory from the compare API or git, so this is a
// plain lookup, not a network or git call.
export function readFullDiff(
  files: Map<string, ReadableDiff>,
  args: unknown,
  maxChars: number | null = DEFAULT_READ_DIFF_MAX_CHARS,
): string {
  const input = (args ?? {}) as {
    path?: unknown;
    offset?: unknown;
    limit?: unknown;
  };
  const path = String(input.path ?? "");
  const file = files.get(path);
  if (!file) {
    const readable = [...files]
      .filter(([, item]) => item.state !== "full" && item.state !== "withheld")
      .map(([name]) => name);
    return readable.length === 0
      ? "Every file's diff is already shown in full above."
      : `No changed file \`${path}\` can be read in this review. Files you can read: ${readable.join(", ")}`;
  }
  if (file.state === "full") {
    return `The whole diff of \`${path}\` is already shown in the DIFF section.`;
  }
  if (file.state === "withheld" || file.patch === "") {
    return `There is no diff text for \`${path}\` to read.`;
  }
  const lines = numberPatch(file.patch).split("\n");
  const offset = lineArg(input.offset, 0, 0);
  const limit = lineArg(input.limit, lines.length, 1);
  if (Number.isNaN(offset) || Number.isNaN(limit)) {
    return "offset must be a whole number of 0 or more, and limit a whole number of 1 or more.";
  }
  if (offset >= lines.length) {
    return `\`${path}\` has ${lines.length} diff lines, so offset=${offset} is past the end.`;
  }
  const end = Math.min(lines.length, offset + limit);
  const out: string[] = [];
  let used = 0;
  let next = offset;
  while (next < end) {
    const line = lines[next]!;
    const add = line.length + (out.length > 0 ? 1 : 0);
    if (maxChars !== null && used + add > maxChars) {
      // A single line longer than the cap is cut rather than returned whole,
      // so no answer goes past the cap. The marker says so, because the rest
      // of that line cannot be read with any offset.
      if (out.length === 0) {
        out.push(
          `${line.slice(0, maxChars)}\n[line cut at ${maxChars} characters, the rest of this line cannot be read]`,
        );
        next++;
      }
      break;
    }
    out.push(line);
    used += add;
    next++;
  }
  const more =
    next < lines.length ? `\n[more: call again with offset=${next}]` : "";
  return `${out.join("\n")}${more}`;
}
