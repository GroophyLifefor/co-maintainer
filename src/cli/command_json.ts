/** `--json` for `probe`, `init` and `sync`.
 *
 * Help and the docs listed `--json` for these commands while the parser
 * refused it, and nothing wrote a JSON result for them. Each builder returns
 * the one document the command prints on stdout, in the same `schemaVersion 1`
 * envelope as `review --json` and the CLI error. Progress stays on stderr.
 */
import type { Estimate } from "../ai/estimate.ts";
import type { InitOption, ProbeEstimate } from "../services/probe_estimate.ts";
import type { ReviewCost } from "../ai/review_estimate.ts";
import type { RunSummary } from "../util/run_summary.ts";
import type { Contradiction, RuleChanges } from "../knowledge/rule_changes.ts";

export type ProbeJsonInput = {
  repo: string;
  recommended: string;
  research: {
    pullRequests: number;
    /** Pull requests in the recommended PR window, what `init` reads. */
    pullRequestsInWindow?: number;
    sampledPullRequests: number;
    commits: number;
    usefulCommits: number;
    maxPrMonths: number | null;
    maxCommits: number | null;
    maxPullRequestChangeLines: number | null;
    reasons: string[];
  };
  estimate: Estimate;
  /** The prose cost line, kept so a missing dollar range still says why. */
  costNote: string;
  /** The GitHub, faster option and review parts of the estimate. */
  probe?: ProbeEstimate;
  durationMs: number;
  /** Commit watch through the GitHub App. Left out when this machine has no
   * App configured, since nothing can be said then. */
  commitWatch?: { app: "on" | "off"; branch: string | null };
};

export function buildProbeJson(input: ProbeJsonInput): string {
  const { estimate } = input;
  return JSON.stringify({
    schemaVersion: 1,
    ok: true,
    command: "probe",
    repo: input.repo,
    recommended: input.recommended,
    research: input.research,
    estimate: {
      extract: estimate.extract,
      synth: estimate.synth,
      tokensIn: estimate.tokensIn.map(Math.round),
      tokensOut: estimate.tokensOut.map(Math.round),
      seconds: estimate.seconds.map(Math.round),
      usd: estimate.usd ?? null,
      cost: input.costNote,
      basis: estimate.basis,
      ...(input.probe ? probeParts(input.probe) : {}),
    },
    ...(input.commitWatch ? { commitWatch: input.commitWatch } : {}),
    durationMs: input.durationMs,
  });
}

/** GitHub calls, the whole run time, the faster option and the review cost.
 * `seconds` above stays the AI time, as it always was. */
function probeParts(probe: ProbeEstimate) {
  const option = (item: InitOption) => ({
    command: item.command,
    maxPrMonths: item.maxPrMonths ?? null,
    maxCommits: item.maxCommits ?? null,
    pullRequests: item.pullRequests,
    commits: item.commits,
    totalSeconds: item.seconds.map(Math.round),
    bottleneck: item.bottleneck,
    github: {
      calls: item.github.calls,
      seconds: item.github.seconds.map(Math.round),
      callSeconds: Math.round(item.github.callSeconds),
      quotaWaitSeconds: Math.round(item.github.quotaWaitSeconds),
      quota: item.github.quota
        ? {
            limit: item.github.quota.limit,
            remaining: item.github.quota.remaining,
            resetAt: new Date(item.github.quota.resetAt).toISOString(),
          }
        : null,
    },
    ai: {
      extract: item.ai.extract,
      synth: item.ai.synth,
      seconds: item.ai.seconds.map(Math.round),
      usd: item.ai.usd ?? null,
    },
  });
  const review = (cost: ReviewCost) => ({
    pullRequest: cost.number,
    changedLines: cost.changedLines,
    rounds: cost.rounds,
    summarized: cost.summarized,
    tokensIn: cost.tokensIn,
    tokensOut: cost.tokensOut,
    usd: cost.usd ?? null,
  });
  const { recommended } = probe;
  return {
    totalSeconds: recommended.seconds.map(Math.round),
    bottleneck: recommended.bottleneck,
    github: option(recommended).github,
    faster: probe.faster ? option(probe.faster) : null,
    review: probe.review
      ? {
          sampled: probe.review.sampled,
          median: review(probe.review.median),
          highest: review(probe.review.highest),
        }
      : null,
  };
}

export type SetupJsonInput = {
  command: "init" | "sync";
  repo: string;
  skillPath: string;
  /** Section keys this run rewrote. Empty when the guide was already current. */
  changed: string[];
  facts: number;
  pullRequests: number;
  commits: number;
  /** `kept` when this run could not rebuild the guide and kept the last one. */
  reviewGuide: "detailed" | "single" | "kept" | "skipped";
  validation: { errors: string[]; warnings: string[] };
  /** What happened to `INSTRUCTIONS.md`. `kept` means the AI gave no usable
   * answer and any earlier file stays. */
  instructions?: {
    status: "written" | "kept" | "empty" | "skipped";
    rules: number;
    reason?: string;
    counts?: {
      unsupportedSource: number;
      unknownName: number;
      overCap: number;
    };
  };
  /** The full change lists behind the `[guide]` and `[instructions]` lines,
   * or `null` when there was no earlier `RULES.json`. */
  ruleChanges?: { guide: RuleChanges; instructions: RuleChanges } | null;
  /** Old guide rules a new rule goes against. Left out when there are none. */
  contradicted?: Contradiction[];
  summary: RunSummary;
};

export function buildSetupJson(input: SetupJsonInput): string {
  const { summary } = input;
  return JSON.stringify({
    schemaVersion: 1,
    ok: true,
    command: input.command,
    repo: input.repo,
    skillPath: input.skillPath,
    changed: input.changed,
    facts: input.facts,
    pullRequests: input.pullRequests,
    commits: input.commits,
    reviewGuide: input.reviewGuide,
    validation: input.validation,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.ruleChanges !== undefined
      ? { ruleChanges: input.ruleChanges }
      : {}),
    ...(input.contradicted?.length ? { contradicted: input.contradicted } : {}),
    usage: {
      tokensIn: summary.tokensIn,
      tokensOut: summary.tokensOut,
      costUsd: summary.costUsd,
      costNote: summary.costNote ?? null,
    },
    durationMs:
      summary.durationMs === null ? null : Math.round(summary.durationMs),
  });
}
