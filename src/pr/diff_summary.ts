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

export const READ_FULL_DIFF_TOOL: Json = {
  type: "function",
  function: {
    name: "read-full-diff",
    description:
      "Read the complete, untruncated diff for one file in this pull request's own changes. Only files whose diff was summarized (over 500 changed lines) are available this way. Everything else is already shown in full.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The file path exactly as it appears in this prompt's DIFF or PULL REQUEST section.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

// The patch is already in memory from the compare API, so this is a plain
// lookup, not a network or git call.
export function readFullDiff(
  patchByPath: Map<string, string>,
  args: unknown,
): string {
  const path = String((args as { path?: unknown } | null)?.path ?? "");
  const patch = patchByPath.get(path);
  if (patch) return numberPatch(patch);
  return patchByPath.size === 0
    ? "No large files were summarized in this review. Every file's diff is already shown in full above."
    : `No summarized diff found for \`${path}\`. Summarized files: ${[
        ...patchByPath.keys(),
      ].join(", ")}`;
}
