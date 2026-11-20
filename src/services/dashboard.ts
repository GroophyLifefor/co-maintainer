/** Read models for dashboard pages and the JSON APIs that mirror them. */
import { listRuleEvents } from "../store/rule_events.ts";
import { reposDir } from "../config.ts";
import { getDrift } from "../store/drift.ts";
import { refreshDrift } from "./drift.ts";
import { listSkipped } from "../store/deliveries.ts";
import { listJobs } from "../store/jobs.ts";
import { findingCountsByRepo } from "../store/finding_list.ts";
import {
  aiCostTotals,
  aiCostsBy,
  aiCostsByKind,
  listAiCostsForExport,
} from "../store/ai_costs.ts";
import { warningsForJobs } from "./job_warnings.ts";
import { openFailures, openFailuresByRepo } from "./open_failures.ts";
import {
  listActivity,
  settledFailureCount,
  type ActivityStoreFilter,
} from "../store/activity.ts";
import { getRepo, listActiveRepos } from "../store/repos.ts";
import {
  listLatestReviewsForRepo,
  listPullSummaries,
  listReviewsForPr,
  reviewStats,
  reviewStatsByDay,
  reviewStatsByKind,
  reviewStatsByModel,
  reviewStatsByRemoteToken,
  listRemoteReviewsForRepo,
  reviewStatsByRepo,
  listUsageReviews,
  usageChoices,
  type UsageScope,
} from "../store/reviews.ts";
import { listFindingsForReview } from "../store/findings.ts";
import { daysAgoIso } from "../util/time.ts";
import {
  findingStatsBySeverity,
  listFindingsPage,
  repositoriesWithFindings,
  type FindingFilter,
} from "../store/finding_list.ts";
import { loadExtensionReport } from "../store/extensions.ts";
import { listPushReviewsForRepo, listWatchIssues } from "../store/watch.ts";
import { pushVia } from "./watch_status.ts";
import type { DeliveryRow, JobRow, RepoRow } from "../store/rows.ts";
import { isNotFound, readTextFile } from "../util/runtime.ts";

export function requireActiveRepo(fullName: string): RepoRow {
  const row = getRepo(fullName);
  if (!row || row.active !== 1) {
    throw new RepoNotFound(fullName);
  }
  return row;
}

export class RepoNotFound extends Error {
  constructor(fullName: string) {
    super(`no active repository ${fullName}`);
    this.name = "RepoNotFound";
  }
}

/** Undefined rather than a made up percentage when the earlier window had
 * nothing to grow from, so the page can leave the trend line out instead of
 * printing an infinite jump. */
function percentChange(before: number, after: number): number | undefined {
  if (!before) return undefined;
  return Math.round(((after - before) / before) * 100);
}

/** A day with no reviews still has to occupy a slot, otherwise the bar chart
 * silently closes the gap and a quiet week reads like a busy one. */
function fillDays(
  days: number,
  rows: ReturnType<typeof reviewStatsByDay>,
): ReturnType<typeof reviewStatsByDay> {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const out = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = daysAgoIso(back).slice(0, 10);
    out.push(
      byDay.get(day) ?? {
        day,
        reviews: 0,
        findings: 0,
        cost: 0,
        knownCount: 0,
        unknownCount: 0,
        byokUsd: 0,
        byokKnownCount: 0,
        byokUnknownCount: 0,
      },
    );
  }
  return out;
}

/** The Usage page for a range, narrowed to one repository, one pull request
 * author, or both. */
type CostFields = {
  cost: number;
  knownCount: number;
  unknownCount: number;
  byokUsd: number;
  byokKnownCount: number;
  byokUnknownCount: number;
};

/** Adds the spend of knowledge builds, replies and watch comments to a row
 * that holds review spend, so every Usage figure is the whole bill. */
function withAiCost<T extends CostFields>(row: T, extra?: CostFields): T {
  if (!extra) return row;
  return {
    ...row,
    cost: row.cost + extra.cost,
    knownCount: row.knownCount + extra.knownCount,
    unknownCount: row.unknownCount + extra.unknownCount,
  };
}

function emptyStats(): ReturnType<typeof reviewStats> {
  return {
    reviews: 0,
    completed: 0,
    notPosted: 0,
    pullRequests: 0,
    findings: 0,
    cost: 0,
    knownCount: 0,
    unknownCount: 0,
    byokUsd: 0,
    byokKnownCount: 0,
    byokUnknownCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    failed: 0,
    avgDurationMs: 0,
  };
}

/** Review rows keyed by `keyOf`, with the AI spend for the same key added and
 * a row made for a key that has spend but no review. */
function mergeBy<
  T extends CostFields & { tokensIn?: number; tokensOut?: number },
>(
  rows: T[],
  keyOf: (row: T) => string,
  extra: (CostFields & { key: string; tokensIn: number; tokensOut: number })[],
  make: (key: string) => T,
): T[] {
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));
  for (const spend of extra) {
    const row = byKey.get(spend.key) ?? make(spend.key);
    const merged = withAiCost(row, spend);
    if (merged.tokensIn !== undefined) merged.tokensIn += spend.tokensIn;
    if (merged.tokensOut !== undefined) merged.tokensOut += spend.tokensOut;
    byKey.set(spend.key, merged);
  }
  return [...byKey.values()].sort((a, b) => b.cost - a.cost);
}

export function statsForRange(range: string, scope: UsageScope = {}) {
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const since = daysAgoIso(days);
  const aiNow = aiCostTotals(since, scope);
  const aiBefore = aiCostTotals(daysAgoIso(days * 2), scope, since);
  const reviewTotals = reviewStats(since, scope.repo, undefined, scope.author);
  const totals = {
    ...withAiCost(reviewTotals, aiNow),
    tokensIn: reviewTotals.tokensIn + aiNow.tokensIn,
    tokensOut: reviewTotals.tokensOut + aiNow.tokensOut,
  };
  const previous = withAiCost(
    reviewStats(daysAgoIso(days * 2), scope.repo, since, scope.author),
    aiBefore,
  );
  const aiByDay = new Map(
    aiCostsBy("day", since, scope).map((row) => [row.key, row]),
  );
  return {
    days,
    since,
    scope,
    choices: usageChoices(since),
    totals,
    previous,
    change: {
      pullRequests: percentChange(previous.pullRequests, totals.pullRequests),
      findings: percentChange(previous.findings, totals.findings),
      // A trend line over a partly unknown total would compare an amount to
      // one that is not the same thing, so it is left out rather than misled.
      cost:
        totals.unknownCount > 0 || previous.unknownCount > 0
          ? undefined
          : percentChange(previous.cost, totals.cost),
    },
    byRepo: (() => {
      // Findings are counted the way the Findings list counts them, newest
      // copy only, so each row opens a list with its own number in it.
      const findings = findingCountsByRepo({
        state: "all",
        sinceIso: since,
        repo: scope.repo,
        author: scope.author,
      });
      return mergeBy(
        reviewStatsByRepo(since, scope),
        (row) => row.repo,
        aiCostsBy("repo", since, scope),
        (repo) => ({ ...emptyStats(), repo }),
      ).map((row) => ({ ...row, findings: findings.get(row.repo) ?? 0 }));
    })(),
    byDay: fillDays(days, reviewStatsByDay(since, scope)).map((row) =>
      withAiCost(row, aiByDay.get(row.day)),
    ),
    byModel: mergeBy(
      reviewStatsByModel(since, scope),
      (row) => row.model,
      aiCostsBy("model", since, scope),
      (model) => ({ ...emptyStats(), model }),
    ),
    byRemoteToken: reviewStatsByRemoteToken(since, scope),
    // Counted the way the Findings list counts, so each row opens a list
    // with its own number in it.
    bySeverity: findingStatsBySeverity({
      state: "all",
      sinceIso: since,
      repo: scope.repo,
      author: scope.author,
    }),
    byKind: reviewStatsByKind(since, scope),
    // Knowledge builds, replies and watch comments, with the spend each
    // recorded. They have no pull request author, so an author filter leaves
    // them out.
    aiByKind: scope.author ? undefined : aiCostsByKind(since, scope),
    setupRuns: scope.author
      ? undefined
      : listJobs().filter(
          (job) =>
            (job.type === "init" || job.type === "remake") &&
            job.created_at >= since &&
            (!scope.repo || job.repo === scope.repo),
        ).length,
  };
}

/** The rows the Usage Export button downloads, the same range and filters
 * as the page. */
export function usageExportRows(
  range: string,
  scope: UsageScope = {},
): ReturnType<typeof listUsageReviews> {
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const since = daysAgoIso(days);
  // Knowledge builds, replies and watch comments are on the page's Spent
  // figure, so they are rows here too.
  const spend = listAiCostsForExport(since, scope).map((row) => ({
    created_at: row.at,
    repo: row.repo,
    pr_number: null,
    author: null,
    kind: row.kind,
    model: row.model ?? "unknown",
    tokens_in: Number(row.tokens_in),
    tokens_out: Number(row.tokens_out),
    cost: row.cost_usd,
    cost_status: (row.cost_usd === null ? "unknown" : "known") as
      | "known"
      | "unknown",
    billed_to: "server" as const,
    findings_count: 0,
    status: "done",
    branch: null,
    extensions_cost: null,
  }));
  return [...listUsageReviews(since, scope), ...spend].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
}

export type RepoListItem = {
  repo: RepoRow;
  drift: ReturnType<typeof getDrift>;
  stats: ReturnType<typeof reviewStats>;
  /** Open failures, the count the menu badge and the failed list share. */
  openFailures: number;
  latestJob: JobRow | undefined;
};

function latestSetupJob(fullName: string): JobRow | undefined {
  return listJobs({ repo: fullName }).find(
    (job) => job.type === "init" || job.type === "remake",
  );
}

export function listReposForHome(): RepoListItem[] {
  const since = daysAgoIso(30);
  const failures = openFailuresByRepo();
  return listActiveRepos().map((repo) => ({
    repo,
    drift: getDrift(repo.full_name),
    stats: reviewStats(since, repo.full_name),
    openFailures: failures.get(repo.full_name) ?? 0,
    latestJob: latestSetupJob(repo.full_name),
  }));
}

export function repoOverview(fullName: string) {
  const repo = requireActiveRepo(fullName);
  const since = daysAgoIso(30);
  return {
    repo,
    drift: getDrift(fullName),
    stats: reviewStats(since, fullName),
    openFailures: openFailures(fullName),
    bySeverity: findingStatsBySeverity({
      repo: fullName,
      state: "all",
      sinceIso: since,
    }),
    recentPulls: listLatestReviewsForRepo(fullName, 8).map((review) => ({
      ...review,
      severities: listFindingsForReview(review.id).map((f) => f.severity),
    })),
    latestJob: latestSetupJob(fullName),
    ruleEvents: listRuleEvents(fullName, 10),
  };
}

export function repoRemoteReviews(fullName: string, limit = 30) {
  requireActiveRepo(fullName);
  const since = daysAgoIso(30);
  return {
    items: listRemoteReviewsForRepo(fullName, limit, 0, since),
    stats: reviewStats(since, fullName),
  };
}

/** The Pushes tab: each commit watch review with its findings by severity,
 * how the push arrived, and the issues it opened. */
export function repoPushes(fullName: string, limit = 50) {
  requireActiveRepo(fullName);
  const issues = listWatchIssues(fullName);
  return {
    items: listPushReviewsForRepo(fullName, limit).map((review) => {
      const severities = listFindingsForReview(review.id).map(
        (f) => f.severity,
      );
      const count = (severity: string) =>
        severities.filter((s) => s === severity).length;
      return {
        ...review,
        via: pushVia(fullName, review),
        p0: count("P0"),
        p1: count("P1"),
        p2: count("P2"),
        p3: count("P3"),
        issuesOpened: issues.filter(
          (issue) => issue.opened_review_id === review.id,
        ).length,
      };
    }),
    openIssues: issues.filter((issue) => issue.state === "open").length,
  };
}

export function repoPulls(fullName: string, page: number, per: number) {
  requireActiveRepo(fullName);
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePer = Number.isFinite(per) && per > 0 ? Math.min(per, 50) : 20;
  const { items, total } = listPullSummaries(
    fullName,
    safePer,
    (safePage - 1) * safePer,
  );
  return {
    items,
    page: safePage,
    per: safePer,
    total,
    stats: reviewStats(daysAgoIso(30), fullName),
  };
}

export function prDetail(fullName: string, prNumber: number) {
  requireActiveRepo(fullName);
  const reviews = listReviewsForPr(fullName, prNumber);
  return {
    prNumber,
    reviews: reviews.map((review) => ({
      ...review,
      findings: listFindingsForReview(review.id).map((finding) => ({
        ...finding,
        repeatOf: finding.first_seen_review_id ?? undefined,
      })),
      extensions: loadExtensionReport(review.id),
    })),
  };
}

const KNOWLEDGE_DOCS = [
  {
    id: "guide",
    file: "PR_REVIEW_GUIDE.md",
    title: "Review guide",
    covers: "Checks learned from past review comments",
  },
  {
    id: "detailed",
    file: "PR_REVIEW_DETAILED_GUIDE.md",
    title: "Detailed guide",
    covers: "Evidence behind the review checks",
  },
  {
    id: "codebase",
    file: "CODEBASE.md",
    title: "Codebase notes",
    covers: "Layout, style and test conventions",
  },
  {
    id: "instructions",
    file: "INSTRUCTIONS.md",
    title: "Repository instructions",
    covers: "Rules from the agent instruction files",
  },
  {
    id: "skill",
    file: "SKILL.md",
    title: "Contribution skill",
    covers: "How to build, test and ship here",
  },
] as const;

export async function repoKnowledge(fullName: string) {
  const repo = requireActiveRepo(fullName);
  const { withKnowledgeLock } = await import("../review/guides.ts");
  return withKnowledgeLock(fullName, async () => {
    const docs = [];
    for (const doc of KNOWLEDGE_DOCS) {
      const path = `${reposDir()}/${fullName}/${doc.file}`;
      try {
        const text = await readTextFile(path);
        docs.push({
          ...doc,
          bytes: new TextEncoder().encode(text).byteLength,
          text,
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return { repo, drift: await refreshDrift(fullName), docs };
  });
}

/** One page of the Findings list. The repository choices are only read for
 * the all-repositories list, which passes `withRepos`. */
export function findingsList(
  filter: FindingFilter,
  page: number,
  per: number,
  withRepos = false,
) {
  const { items, total } = listFindingsPage(filter, per, (page - 1) * per);
  return {
    items,
    total,
    repos: withRepos ? repositoriesWithFindings() : [],
  };
}

/** One page of the Activity list: one row per review, one per other job. */
export function activityFeed(
  page: number,
  per: number,
  filter: ActivityStoreFilter = {},
) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePer = Number.isFinite(per) && per > 0 ? Math.min(per, 50) : 20;
  const { items, total } = listActivity(
    filter,
    safePer,
    (safePage - 1) * safePer,
  );
  // A finished job that logged a problem gets a mark on its row.
  const warnings = Object.fromEntries(
    [
      ...warningsForJobs(
        items.flatMap((row) =>
          row.job?.status === "done" ? [row.job.id] : [],
        ),
      ),
    ].map(([id, warning]) => [id, warning.problem]),
  );
  return {
    items,
    warnings,
    page: safePage,
    per: safePer,
    total,
    // Only the failed list hides dismissed and resolved failures, and says
    // how many it hid.
    settled:
      filter.state === "failed" && !filter.withSettled
        ? settledFailureCount(filter)
        : 0,
  };
}

export function runningJobs(): JobRow[] {
  return [
    ...listJobs({ status: "running" }),
    ...listJobs({ status: "queued" }),
  ];
}

export function skippedDeliveries(repo?: string): DeliveryRow[] {
  return listSkipped(repo);
}
