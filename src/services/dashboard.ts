/** Read models for dashboard pages and the JSON APIs that mirror them. */
import { reposDir } from "../config.ts";
import { getDrift } from "../store/drift.ts";
import { refreshDrift } from "./drift.ts";
import { listSkipped } from "../store/deliveries.ts";
import { listJobs } from "../store/jobs.ts";
import { getRepo, listActiveRepos } from "../store/repos.ts";
import {
  listLatestReviewsForRepo,
  listPullSummaries,
  listRecentReviews,
  listReviewsForPr,
  reviewStats,
  reviewStatsByDay,
  reviewStatsByModel,
  reviewStatsByRepo,
} from "../store/reviews.ts";
import {
  findingStatsBySeverity,
  listFindingsForReview,
} from "../store/findings.ts";
import { daysAgoIso } from "../util/time.ts";
import type { DeliveryRow, JobRow, RepoRow, ReviewRow } from "../store/rows.ts";

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
    out.push(byDay.get(day) ?? { day, reviews: 0, findings: 0, cost: 0 });
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
      cost: percentChange(previous.cost, totals.cost),
    },
    byRepo: reviewStatsByRepo(since),
    byDay: fillDays(days, reviewStatsByDay(since)),
    byModel: reviewStatsByModel(since),
    bySeverity: findingStatsBySeverity(since),
  };
}

export type RepoListItem = {
  repo: RepoRow;
  drift: ReturnType<typeof getDrift>;
  stats: ReturnType<typeof reviewStats>;
  latestJob: JobRow | undefined;
};

function latestSetupJob(fullName: string): JobRow | undefined {
  return listJobs({ repo: fullName }).find((job) =>
    job.type === "init" || job.type === "remake"
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
    recentPulls: listLatestReviewsForRepo(fullName, 8),
    latestJob: latestSetupJob(fullName),
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
    id: "skill",
    file: "SKILL.md",
    title: "Contribution skill",
    covers: "How to build, test and ship here",
  },
] as const;

export async function repoKnowledge(fullName: string) {
  const repo = requireActiveRepo(fullName);
  const docs = [];
  for (const doc of KNOWLEDGE_DOCS) {
    const path = `${reposDir()}/${fullName}/${doc.file}`;
    try {
      const text = await Deno.readTextFile(path);
      docs.push({
        ...doc,
        bytes: new TextEncoder().encode(text).byteLength,
        text,
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return { repo, drift: await refreshDrift(fullName), docs };
}

export type ActivityItem =
  | { kind: "job"; at: string; job: JobRow }
  | { kind: "review"; at: string; review: ReviewRow };

export function activityFeed(page: number, per: number) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePer = Number.isFinite(per) && per > 0 ? Math.min(per, 50) : 20;
  const items: ActivityItem[] = [
    ...listJobs().map((job) => ({
      kind: "job" as const,
      at: job.created_at,
      job,
    })),
    ...listRecentReviews(500).map((review) => ({
      kind: "review" as const,
      at: review.created_at,
      review,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const total = items.length;
  const slice = items.slice((safePage - 1) * safePer, safePage * safePer);
  return { items: slice, page: safePage, per: safePer, total };
}

export function runningJobs(): JobRow[] {
  return [
    ...listJobs({ status: "running" }),
    ...listJobs({ status: "queued" }),
  ];
}

export function skippedDeliveries(): DeliveryRow[] {
  return listSkipped();
}
