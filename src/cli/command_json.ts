/** `--json` for `probe`, `init` and `sync`.
 *
 * Help and the docs listed `--json` for these commands while the parser
 * refused it, and nothing wrote a JSON result for them. Each builder returns
 * the one document the command prints on stdout, in the same `schemaVersion 1`
 * envelope as `review --json` and the CLI error. Progress stays on stderr.
 */
import type { Estimate } from "../ai/estimate.ts";
import type { RunSummary } from "../util/run_summary.ts";
import type { RuleChanges } from "../knowledge/rule_changes.ts";

export type ProbeJsonInput = {
  repo: string;
  recommended: string;
  research: {
    pullRequests: number;
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
    },
    ...(input.commitWatch ? { commitWatch: input.commitWatch } : {}),
    durationMs: input.durationMs,
  });
}

export type SetupJsonInput = {
  command: "init" | "sync";
  repo: string;
  skillPath: string;
  /** Section keys this run rewrote; empty when the guide was already current. */
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
