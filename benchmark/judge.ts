import { OpenRouterProvider } from "../src/ai/openrouter.ts";
import type { AiResponse } from "../src/types.ts";
import type { ParsedFinding } from "../src/pr/findings.ts";

export type JudgeGold = {
  path: string;
  from: number;
  to: number;
  quote: string;
  why: string;
};

/** Asks a cheap model whether any leftover (unmatched-by-line) prediction and
 * gold entry describe the same underlying defect, regardless of file/line —
 * a model often points at the fix site while a human reviewer points at the
 * line that triggered the comment, a few lines (or files) apart. */
export async function judgeMatches(
  token: string,
  model: string,
  predicted: ParsedFinding[],
  gold: JudgeGold[],
  predictedIndices: number[],
  goldIndices: number[],
  usage?: (response: AiResponse) => Promise<void>,
): Promise<{ predicted: number; gold: number }[]> {
  if (predictedIndices.length === 0 || goldIndices.length === 0) return [];
  const provider = new OpenRouterProvider(token, model);
  const prompt = `Each PREDICTED finding and each GOLD finding below describes a
possible code defect in the same pull request. For each pair that describes
the SAME underlying defect (even if the file or line differs — one may point
at the fix site, the other at the line that triggered the comment), return
that pair. Do not pair findings that are merely in the same area of code but
describe a different problem. Each index may appear in at most one pair.
Return only a JSON array like [{"predicted":0,"gold":1}], or [] if none match.

PREDICTED:
${
    predictedIndices.map((i) => {
      const item = predicted[i];
      return `${i}. ${item.path}:${item.from}-${item.to} — ${item.heading}\n${item.excerpt}`;
    }).join("\n\n")
  }

GOLD:
${
    goldIndices.map((i) => {
      const item = gold[i];
      return `${i}. ${item.path}:${item.from}-${item.to} — ${item.quote}\n${item.why}`;
    }).join("\n\n")
  }`;
  const response = await provider.complete({
    job: "judge_match",
    system:
      "You judge whether two code-review findings describe the same underlying defect. Be conservative: only pair genuine matches.",
    prompt,
    maxTokens: 2_000,
  });
  if (usage) await usage(response);
  let parsed: unknown;
  try {
    const cleaned = response.text.trim().replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const usedPredicted = new Set<number>();
  const usedGold = new Set<number>();
  const pairs: { predicted: number; gold: number }[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { predicted: p, gold: g } = item as {
      predicted?: number;
      gold?: number;
    };
    if (
      typeof p !== "number" || typeof g !== "number" ||
      !predictedIndices.includes(p) || !goldIndices.includes(g) ||
      usedPredicted.has(p) || usedGold.has(g)
    ) continue;
    usedPredicted.add(p);
    usedGold.add(g);
    pairs.push({ predicted: p, gold: g });
  }
  return pairs;
}
