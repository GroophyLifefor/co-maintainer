import type { Json } from "../types.ts";

export type ProbeResult = {
  includePullRequests: boolean;
  includePullRequestChanges: boolean;
  includeCommitHistory: boolean;
  maxPrYears?: number;
  maxCommits?: number;
  maxPullRequestChangeLines?: number;
  report: Json;
  reasons: string[];
};

function year(value: unknown): number {
  return new Date(String(value)).getFullYear();
}

function percentile(values: number[], percentage: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentage) - 1)
  ];
}

function isMerge(commit: Json): boolean {
  const message = String((commit.commit as Json | undefined)?.message ?? "");
  return message.startsWith("Merge ") ||
    (Array.isArray(commit.parents) && commit.parents.length > 1);
}

function isConventional(commit: Json): boolean {
  return /^(feat|fix|docs|refactor|test|build|ci|chore|perf|style)(\(.+\))?!?:\s/i
    .test(
      String((commit.commit as Json | undefined)?.message ?? ""),
    );
}

function commitStats(
  commits: Json[],
): { mergeRatio: number; conventionalRatio: number } {
  if (!commits.length) return { mergeRatio: 0, conventionalRatio: 0 };
  return {
    mergeRatio: commits.filter(isMerge).length / commits.length,
    conventionalRatio: commits.filter(isConventional).length / commits.length,
  };
}

function recommendCommitWindow(commits: Json[]): number | undefined {
  if (commits.length <= 300) return undefined;
  const useful = commits.filter((commit) => !isMerge(commit));
  if (useful.length < 100) return undefined;
  const recent = commitStats(commits.slice(0, 100));
  let stableThrough = 100;
  for (let start = 100; start < commits.length; start += 100) {
    const window = commits.slice(start, start + 100);
    const stats = commitStats(window);
    const stable = Math.abs(stats.mergeRatio - recent.mergeRatio) <= 0.15 &&
      Math.abs(stats.conventionalRatio - recent.conventionalRatio) <= 0.15;
    if (!stable) break;
    stableThrough = start + window.length;
  }
  return stableThrough < commits.length ? stableThrough : undefined;
}

function recommendPrWindow(
  pulls: Json[],
  latestReleaseAt?: string,
): number | undefined {
  if (!pulls.length) return undefined;
  const years = new Map<number, number>();
  for (const pull of pulls) {
    const itemYear = year(pull.updated_at);
    years.set(itemYear, (years.get(itemYear) ?? 0) + 1);
  }
  const oldest = Math.min(...years.keys());
  const current = new Date().getFullYear();
  const span = current - oldest + 1;
  if (pulls.length <= 150 || span <= 3) return undefined;

  const recentTwoYears =
    pulls.filter((pull) => year(pull.updated_at) >= current - 1).length;
  const releaseAgeMonths = latestReleaseAt
    ? (Date.now() - new Date(latestReleaseAt).getTime()) /
      (30.44 * 24 * 60 * 60 * 1_000)
    : Infinity;
  if (
    recentTwoYears >= 100 &&
    (releaseAgeMonths <= 18 || recentTwoYears / pulls.length >= 0.35)
  ) {
    return 2;
  }

  const target = pulls.length * 0.85;
  let covered = 0;
  let windowYears = 0;
  while (windowYears < span && (covered < target || windowYears < 2)) {
    windowYears++;
    covered += years.get(current - windowYears + 1) ?? 0;
  }
  return windowYears < span ? windowYears : undefined;
}

export function analyzeProbe(
  meta: Json,
  pulls: Json[],
  detailSamples: Json[],
  commits: Json[],
): ProbeResult {
  const years = new Map<number, number>();
  for (const pull of pulls) {
    const itemYear = year(pull.updated_at);
    years.set(itemYear, (years.get(itemYear) ?? 0) + 1);
  }

  const diffs = detailSamples.map((detail) =>
    Number(detail.additions ?? 0) + Number(detail.deletions ?? 0)
  ).filter((value) => value >= 0);
  const medianDiff = percentile(diffs, 0.5);
  const p90Diff = percentile(diffs, 0.9);
  const maxDiff = Math.max(...diffs, 0);
  const latestReleaseAt = String(meta.latest_release_at ?? "");
  const maxPrYears = recommendPrWindow(pulls, latestReleaseAt);
  const maxCommits = recommendCommitWindow(commits);
  const commitSignal = commitStats(commits);
  const usefulCommits = commits.filter((commit) => !isMerge(commit)).length;
  const includeCommitHistory = usefulCommits >= 20 &&
    commitSignal.mergeRatio < 0.75;
  const includeChanges = pulls.length > 0 && diffs.length > 0;
  const maxChangeLines =
    includeChanges && diffs.length >= 10 && p90Diff < maxDiff
      ? Math.max(100, Math.ceil(p90Diff / 100) * 100)
      : undefined;
  const reasons: string[] = [];

  if (maxPrYears) {
    const releaseAgeMonths = latestReleaseAt
      ? (Date.now() - new Date(latestReleaseAt).getTime()) /
        (30.44 * 24 * 60 * 60 * 1_000)
      : Infinity;
    reasons.push(
      releaseAgeMonths <= 18
        ? `A release from ${
          latestReleaseAt.slice(0, 10)
        } is recent; use the last ${maxPrYears} years to prioritize the current contribution and release process.`
        : `The last ${maxPrYears} years cover at least 85% of pull requests; older history is a minority.`,
    );
  } else if (pulls.length) {
    reasons.push(
      "Pull request volume or history span is small enough to keep all PR years.",
    );
  }
  if (includeCommitHistory) {
    reasons.push(
      `${usefulCommits} non-merge commits contain enough signal to analyze commit conventions.`,
    );
  } else if (commits.length) {
    reasons.push(
      "Commit history is mostly merge/noise commits, so it is not recommended as a source.",
    );
  }
  if (maxChangeLines) {
    reasons.push(
      `The sampled diff p90 is ${p90Diff} lines; the cap keeps the largest outliers out while retaining about 90% of sampled diffs.`,
    );
  }

  return {
    includePullRequests: pulls.length > 0,
    includePullRequestChanges: includeChanges,
    includeCommitHistory,
    maxPrYears,
    maxCommits: includeCommitHistory ? maxCommits : undefined,
    maxPullRequestChangeLines: maxChangeLines,
    reasons,
    report: {
      pullRequests: pulls.length,
      pullRequestYears: Object.fromEntries([...years.entries()].sort()),
      sampledPullRequests: detailSamples.length,
      diffLines: {
        median: medianDiff,
        p90: p90Diff,
        maximum: maxDiff,
      },
      commits: commits.length,
      usefulCommits,
      commitSignal,
      defaultBranch: String(meta.default_branch ?? "main"),
      latestReleaseAt: latestReleaseAt || undefined,
    },
  };
}
