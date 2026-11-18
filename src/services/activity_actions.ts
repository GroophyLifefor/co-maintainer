/** Retry and Dismiss for the failed rows of the Activity list, one row or a
 * selection. A row is named by its key: `job:<id>`, or `review:<id>` for a
 * review whose job row is gone. */
import { getJob } from "../store/jobs.ts";
import { getRepo } from "../store/repos.ts";
import { getReview, getReviewByJobId } from "../store/reviews.ts";
import { dismissAllFailures, dismissFailures } from "../store/failures.ts";
import { enqueueManualReview } from "./review.ts";
import { enqueueSetup } from "./setup.ts";
import type { JobRow, ReviewRow } from "../store/rows.ts";

/** What a retry starts: a new review of the same pull request with the same
 * model, or a sync of the repository. */
export type RetryTarget =
  | { kind: "review"; repo: string; pr: number; model?: string }
  | { kind: "sync"; repo: string };

/** The model a failed review ran with. A manual or webhook review does not
 * put it in its job args, and the review row records the one it resolved.
 * "unknown" is what a review stores when no model was set. */
export function modelOf(
  args: Record<string, unknown>,
  review: ReviewRow | undefined,
): string | undefined {
  if (review?.model && review.model !== "unknown") return review.model;
  return typeof args.model === "string" && args.model.trim()
    ? args.model
    : undefined;
}

function argsOf(job: JobRow | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(job?.args || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** What Retry would start for a failed row, or nothing when the row did not
 * fail, its repository is gone, or its kind has no retry. A push or a CLI
 * review is retried where it came from, not from here. */
export function retryTarget(
  job: JobRow | undefined,
  review: ReviewRow | undefined,
): RetryTarget | undefined {
  const failed = job?.status === "failed" || review?.status === "failed";
  if (!failed) return undefined;
  const repo = job?.repo ?? review?.repo;
  if (!repo || getRepo(repo)?.active !== 1) return undefined;
  const type = job?.type ?? (review?.kind === "pr" ? "review" : undefined);
  if (type === "init" || type === "remake") return { kind: "sync", repo };
  const pr = job?.pr_number ?? review?.pr_number;
  if (type === "review" && pr) {
    const model = modelOf(argsOf(job), review);
    return { kind: "review", repo, pr, ...(model ? { model } : {}) };
  }
  return undefined;
}

/** The job and the review a key names. */
export function rowOfKey(key: string): {
  job: JobRow | undefined;
  review: ReviewRow | undefined;
} {
  const [kind, id] = [
    key.slice(0, key.indexOf(":")),
    key.slice(key.indexOf(":") + 1),
  ];
  if (kind === "job" && id) {
    const job = getJob(id);
    return { job, review: job ? getReviewByJobId(job.id) : undefined };
  }
  if (kind === "review" && id) return { job: undefined, review: getReview(id) };
  return { job: undefined, review: undefined };
}

/** Starts a retry for each failed row. Two rows of the same pull request
 * start one review. Returns the new job ids and how many rows had nothing to
 * retry. */
export function retryRows(keys: string[]): {
  jobIds: string[];
  skipped: number;
} {
  const jobIds: string[] = [];
  const started = new Set<string>();
  let skipped = 0;
  for (const key of keys) {
    const { job, review } = rowOfKey(key);
    const target = retryTarget(job, review);
    const once = target
      ? target.kind === "review"
        ? `review:${target.repo}#${target.pr}`
        : `sync:${target.repo}`
      : "";
    if (!target || started.has(once)) {
      skipped++;
      continue;
    }
    started.add(once);
    const { id } =
      target.kind === "review"
        ? enqueueManualReview(target.repo, target.pr, { model: target.model })
        : enqueueSetup(target.repo, "remake");
    jobIds.push(id);
  }
  return { jobIds, skipped };
}

/** Marks the failed rows as seen. */
export function dismissRows(keys: string[]): number {
  const jobs: string[] = [];
  const reviews: string[] = [];
  for (const key of keys) {
    if (key.startsWith("job:")) jobs.push(key.slice(4));
    else if (key.startsWith("review:")) reviews.push(key.slice(7));
  }
  return dismissFailures({ jobs, reviews });
}

/** Marks every failure not seen yet as seen, of one repository or of all. */
export function dismissAll(repo?: string): number {
  return dismissAllFailures(repo);
}
