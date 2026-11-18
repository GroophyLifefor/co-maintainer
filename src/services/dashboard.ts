/** Read models for dashboard pages and the JSON APIs that mirror them. */
import { listRuleEvents } from "../store/rule_events.ts";
import { reposDir } from "../config.ts";
import { getDrift } from "../store/drift.ts";
import { refreshDrift } from "./drift.ts";
import { listSkipped } from "../store/deliveries.ts";
import { listJobs } from "../store/jobs.ts";
import { warningsForJobs } from "./job_warnings.ts";
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

export function statsForRange(range: string) {
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const since = daysAgoIso(days);
  const totals = reviewStats(since);
  const previous = reviewStats(daysAgoIso(days * 2), undefined, since);
  return {
    days,
    since,
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
    byRepo: reviewStatsByRepo(since),
    byDay: fillDays(days, reviewStatsByDay(since)),
    byModel: reviewStatsByModel(since),
    byRemoteToken: reviewStatsByRemoteToken(since),
    // Counted the way the Findings list counts, so each row opens a list
    // with its own number in it.
    bySeverity: findingStatsBySeverity({ state: "all", sinceIso: since }),
    byKind: reviewStatsByKind(since),
    // Init and sync record no cost, only that they ran.
    setupRuns: listJobs().filter(
      (job) =>
        (job.type === "init" || job.type === "remake") &&
        job.created_at >= since,
    ).length,
  };
}

export type RepoListItem = {
  repo: RepoRow;
  drift: ReturnType<typeof getDrift>;
  stats: ReturnType<typeof reviewStats>;
  latestJob: JobRow | undefined;
};

function latestSetupJob(fullName: string): JobRow | undefined {
  return listJobs({ repo: fullName }).find(
    (job) => job.type === "init" || job.type === "remake",
  );
}

export function listReposForHome(): RepoListItem[] {
  const since = daysAgoIso(30);
  return listActiveRepos().map((repo) => ({
    repo,
    drift: getDrift(repo.full_name),
    stats: reviewStats(since, repo.full_name),
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
