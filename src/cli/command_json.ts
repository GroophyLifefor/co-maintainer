/** `--json` for `probe`, `init` and `sync`.
 *
 * Help and the docs listed `--json` for these commands while the parser
 * refused it, and nothing wrote a JSON result for them. Each builder returns
 * the one document the command prints on stdout, in the same `schemaVersion 1`
 * envelope as `review --json` and the CLI error. Progress stays on stderr.
 */
import type { Estimate } from "../ai/estimate.ts";
import type { RunSummary } from "../util/run_summary.ts";

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
  reviewGuide: "detailed" | "single" | "skipped";
  validation: { errors: string[]; warnings: string[] };
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
