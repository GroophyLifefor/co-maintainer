/** Concurrency limits for GitHub and AI work. A repository may override the
 * server defaults, and both may override the built-in values. The
 * recommendation here is advisory only: nothing calls it to change saved
 * settings. */
import { readConfig, type UserConfig } from "../config.ts";

export type Concurrency = { gh: number; ai: number };

export type ConcurrencyWarning = {
  kind: "free-model" | "provider-ceiling" | "pat-quota";
  message: string;
};

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;
export const BUILTIN_CONCURRENCY: Concurrency = { gh: 1, ai: 3 };

function checkedConcurrency(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_CONCURRENCY ||
    value > MAX_CONCURRENCY
  ) {
    throw new Error(
      `${label} must be an integer between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`,
    );
  }
  return value;
}

/** Repo override, then server default, then built-in, field by field. */
export function resolveConcurrency(
  repo: string,
  config: UserConfig = readConfig(),
): Concurrency {
  const repoConfig = config.repos?.[repo] ?? {};
  const defaults = config.defaults ?? {};
  return {
    gh:
      checkedConcurrency(repoConfig.ghConcurrent, "ghConcurrent") ??
      checkedConcurrency(defaults.ghConcurrent, "ghConcurrent") ??
      BUILTIN_CONCURRENCY.gh,
    ai:
      checkedConcurrency(repoConfig.aiConcurrent, "aiConcurrent") ??
      checkedConcurrency(defaults.aiConcurrent, "aiConcurrent") ??
      BUILTIN_CONCURRENCY.ai,
  };
}

function isFreeModel(model: string | undefined): boolean {
  return model?.toLowerCase().includes(":free") === true;
}

export function aiCeiling(input: {
  provider: string;
  lowModel?: string;
  highModel?: string;
}): number {
  if (input.provider === "openrouter") {
    return isFreeModel(input.lowModel) || isFreeModel(input.highModel) ? 1 : 8;
  }
  if (
    input.provider === "openai" ||
    input.provider === "anthropic" ||
    input.provider === "opencode-zen" ||
    input.provider === "opencode-go"
  ) {
    return 4;
  }
  return 0;
}

function githubJobs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** A starting point for a repository's settings. Pure: it never writes. */
export function recommendConcurrency(input: {
  githubJobs: number;
  provider: string;
  lowModel?: string;
  highModel?: string;
}): Concurrency {
  const jobs = githubJobs(input.githubJobs);
  if (jobs === 0) return { gh: 0, ai: 0 };
  const ghTier = jobs < 20 ? 2 : jobs < 100 ? 4 : 8;
  const gh = Math.min(jobs, ghTier, MAX_CONCURRENCY);
  const ai = Math.min(jobs, aiCeiling(input), MAX_CONCURRENCY);
  return { gh, ai };
}

/** Warnings are advisory: they never change or block the chosen values. */
export function concurrencyWarnings(input: {
  provider: string;
  lowModel?: string;
  highModel?: string;
  gh: number;
  ai: number;
  auth?: "gh" | "pat";
}): ConcurrencyWarning[] {
  const warnings: ConcurrencyWarning[] = [];
  const free =
    input.provider === "openrouter" &&
    (isFreeModel(input.lowModel) || isFreeModel(input.highModel));
  if (free && input.ai >= 2) {
    warnings.push({
      kind: "free-model",
      message:
        "A free OpenRouter model is in use with AI concurrency above 1. Free models are slow and rate limited.",
    });
  }
  const ceiling = aiCeiling(input);
  if (input.ai > ceiling) {
    warnings.push({
      kind: "provider-ceiling",
      message: `${input.provider} allows about ${ceiling} AI calls at once. Calls above that will wait.`,
    });
  }
  if (input.auth === "pat" && input.gh >= 8) {
    warnings.push({
      kind: "pat-quota",
      message:
        "A PAT allows 5,000 requests/hour. GitHub concurrency 8 can exhaust the quota.",
    });
  }
  return warnings;
}
