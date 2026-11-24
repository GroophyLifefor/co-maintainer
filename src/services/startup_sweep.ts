/** What `serve` catches up on when it starts, for pull requests it left
 * stuck while it was down. GitHub does not redeliver a webhook that failed,
 * so a push while the server was down leaves the App's blocking review on
 * the old commit and the pull request locked.
 *
 * Candidates come from app.db only: per pull request the newest review row
 * of the last 14 days, at most 50. For each:
 * - the newest posted review still blocks and GitHub's head moved: the push
 *   is replayed as a `synchronize` through the webhook's own rules, so
 *   auto-review, drafts, skip-this-pr, the round limit and the debounce all
 *   hold, and the job is only queued, never posted from here
 * - the newest posted review no longer blocks because a finding was
 *   withdrawn or dismissed: the approval that may not have posted
 * - a row left drafting with an open check run: that check is completed as
 *   failed
 *
 * It runs once, before the server listens. A rate limit stops it, and no
 * error from one pull request reaches another or the startup. */
import { isRateLimited } from "../github/client.ts";
import { readConfig, resolveRepoSettings } from "../config.ts";
import { extensionsBlock } from "../extensions/report.ts";
import { loadExtensionReport } from "../store/extensions.ts";
import { reviewBlockingFrom } from "../review/blocking.ts";
import type { GitHubClient, Json } from "../types.ts";
import { listFindingsForReview } from "../store/findings.ts";
import { getJob, listJobs } from "../store/jobs.ts";
import { getRepo } from "../store/repos.ts";
import {
  hasReviewForHead,
  latestPostedReview,
  latestPrReviewsSince,
} from "../store/reviews.ts";
import type { ReviewRow } from "../store/rows.ts";
import {
  appReviewEvent,
  approveAfterWithdrawal,
  clientFor,
  closeStaleCheck,
} from "./review.ts";
import { dispatchGithubEvent } from "./webhook.ts";

const WINDOW_DAYS = 14;
const MAX_PULLS = 50;

export type SweepResult = {
  queued: number;
  approved: number;
  closedChecks: number;
  stoppedByRateLimit: boolean;
};

function blocks(review: ReviewRow): boolean {
  const mode = reviewBlockingFrom(
    resolveRepoSettings(readConfig(), review.repo).reviewBlocking.value,
  );
  return (
    appReviewEvent(listFindingsForReview(review.id), mode) ===
      "REQUEST_CHANGES" || extensionsBlock(loadExtensionReport(review.id))
  );
}

export async function sweepStuckReviews(
  log: (message: string) => void = () => {},
  now = Date.now(),
): Promise<SweepResult> {
  const result: SweepResult = {
    queued: 0,
    approved: 0,
    closedChecks: 0,
    stoppedByRateLimit: false,
  };
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const busy = new Set(
    [...listJobs({ status: "queued" }), ...listJobs({ status: "running" })]
      .filter((job) => job.pr_number !== null)
      .map((job) => `${job.repo}#${job.pr_number}`),
  );
  for (const newest of latestPrReviewsSince(since, MAX_PULLS)) {
    const prNumber = newest.pr_number!;
    if (busy.has(`${newest.repo}#${prNumber}`)) continue;
    const repo = getRepo(newest.repo);
    if (!repo || repo.active !== 1 || !repo.installation_id) continue;
    try {
      const client: GitHubClient = clientFor(repo.installation_id);
      if (newest.status === "drafting" && newest.check_run_id) {
        const job = getJob(newest.job_id ?? "");
        if (job && job.status !== "queued" && job.status !== "running") {
          if (await closeStaleCheck(client, job, newest, (_l, m) => log(m))) {
            result.closedChecks++;
          }
        }
      }
      const posted = latestPostedReview(newest.repo, prNumber);
      if (!posted?.head_sha) continue;
      if (blocks(posted)) {
        const pr = await client.request<Json>(
          `repos/${newest.repo}/pulls/${prNumber}`,
        );
        const head = String((pr.head as Json | undefined)?.sha ?? "");
        if (String(pr.state ?? "") !== "open" || !head) continue;
        if (head === posted.head_sha) continue;
        if (hasReviewForHead(newest.repo, prNumber, head)) continue;
        const config = readConfig();
        const outcome = dispatchGithubEvent(
          "pull_request",
          {
            action: "synchronize",
            number: prNumber,
            pull_request: pr,
            repository: { full_name: newest.repo },
            installation: { id: repo.installation_id },
            sender: pr.user,
          },
          `startup-sweep-${newest.repo}-${prNumber}-${head}`,
          config.repos?.[newest.repo]?.maxPullRequestChangeLines ??
            config.defaults?.maxPullRequestChangeLines,
        );
        log(
          `${newest.repo}#${prNumber} moved to ${head.slice(0, 7)} while the server was down: ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ""}`,
        );
        if (outcome.outcome === "enqueued") result.queued++;
        continue;
      }
      const closedByPerson = listFindingsForReview(posted.id).some(
        (row) =>
          row.state === "closed" &&
          (row.close_reason === "withdrawn" ||
            row.close_reason === "dismissed"),
      );
      if (closedByPerson) {
        const approved = await approveAfterWithdrawal(
          client,
          newest.repo,
          prNumber,
          null,
          (_level, message) => log(message),
          undefined,
          true,
        );
        if (approved === "approved") {
          log(`${newest.repo}#${prNumber}: posted the approval it owed`);
          result.approved++;
        }
      }
    } catch (error) {
      if (isRateLimited(error)) {
        log("GitHub rate limited the startup sweep, it stops here");
        result.stoppedByRateLimit = true;
        break;
      }
      log(`${newest.repo}#${prNumber}: ${String(error)}`);
    }
  }
  return result;
}
