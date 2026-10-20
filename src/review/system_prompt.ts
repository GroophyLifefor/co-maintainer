/** The per-repository custom review instructions and the cap on them. The
 * block is appended to the built-in reviewer system prompt (role, diagram
 * rules and guide) as a separate section, so the built-in instructions are
 * always kept. */
import type { Options } from "../types.ts";
import type { RepoConfig } from "../config.ts";

/** Default cap on `reviewSystemPrompt`, in characters. */
export const DEFAULT_REVIEW_SYSTEM_PROMPT_MAX_CHARS = 8000;

/** The repository's cap, or `null` for no limit. Unset takes the default; a
 * non-positive value means unlimited. */
export function reviewSystemPromptLimit(
  repoConfig: Pick<RepoConfig, "reviewSystemPromptMaxChars"> | undefined,
): number | null {
  const raw = repoConfig?.reviewSystemPromptMaxChars;
  if (raw === undefined) return DEFAULT_REVIEW_SYSTEM_PROMPT_MAX_CHARS;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const floored = Math.floor(raw);
  return floored > 0 ? floored : null;
}

/** The problem with a custom prompt, or `null` when it is fine. Blank text is
 * allowed and means "off". */
export function checkReviewSystemPrompt(
  text: string,
  limit: number | null,
): string | null {
  if (limit !== null && text.length > limit) {
    return `must be at most ${limit} characters (got ${text.length})`;
  }
  return null;
}

/** The extra system-prompt section for a review, or `""` when none applies.
 * A per-run override replaces the repository's own section, and a per-run add
 * is appended after it. A blank per-run value counts as absent, so an empty
 * override file keeps the repository's own section rather than dropping it. */
export function reviewSystemPromptBlock(
  options: Pick<
    Options,
    | "reviewSystemPrompt"
    | "reviewSystemPromptAdd"
    | "reviewSystemPromptOverride"
  >,
): string {
  const override = options.reviewSystemPromptOverride?.trim();
  const base = override ? override : options.reviewSystemPrompt?.trim();
  const add = options.reviewSystemPromptAdd?.trim();
  const parts = [base, add].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return "";
  return `\n\nCUSTOM REVIEW INSTRUCTIONS:\n${parts.join("\n\n")}`;
}
