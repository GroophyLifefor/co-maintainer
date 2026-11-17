/** `/co-maintainer skip-this-commit` and `/co-maintainer skip-this-pr`.
 *
 * A failed App review ends its check run as `failure`, which blocks a merge
 * where the check is required. These commands let the owner, and whoever the
 * repository's policy names, get past it. The skipped check run ends as
 * `skipped` and not `success`: both let a required check pass, but `skipped`
 * does not claim a review happened. The webhook decides who may run them and
 * ignores anyone else. This job does the GitHub side. */
import type { GitHubClient, Json } from "../types.ts";
import type { JobRow } from "../store/rows.ts";
import { getRepo } from "../store/repos.ts";
import { findNoteCommentId, listReviewsForPr } from "../store/reviews.ts";
import { getQueuedJob, getRunningJobByKey } from "../store/jobs.ts";
import { prReviewsOff, setPrReviewsOff } from "../store/subjects.ts";
import { cancel, registerHandler, type LogFn } from "./jobs.ts";
import { clientFor, resolveInstallationId } from "./review.ts";
import { redact } from "../util/redact.ts";

export const SKIP_JOB = "skip";

export type SkipJobArgs = {
  /** The two comment commands, `reviews-on` for a request that turned a
   * pull request's reviews back on, and `pr-off` for a new commit on a pull
   * request whose reviews are off. */
  command: "skip-this-commit" | "skip-this-pr" | "reviews-on" | "pr-off";
  by: string | null;
  headSha?: string | null;
};

const CHECK_NAME = "co-maintainer review";

const short = (sha: string) => sha.slice(0, 7);
const who = (by: string | null) => (by ? `\`@${by}\`` : "A maintainer");

export function skippedCommitText(sha: string, by: string | null): string {
  return `co-maintainer skipped the review of \`${short(sha)}\` at the request of ${by ? `\`@${by}\`` : "a maintainer"}. The next commit is reviewed again.`;
}

export function nothingToSkipText(sha: string): string {
  return `Nothing to skip. Only a failed review of the latest commit can be skipped, and the review of \`${short(sha)}\` did not fail.`;
}

export function reviewsOffText(by: string | null): string {
  return `${who(by)} turned co-maintainer reviews off for this pull request. Comment \`/co-maintainer review\` to turn them back on.`;
}

export const ALREADY_OFF_TEXT =
  "Reviews are already off for this pull request. Comment `/co-maintainer review` to turn them back on.";

export function reviewsOnText(by: string | null): string {
  return `${who(by)} turned co-maintainer reviews back on for this pull request.`;
}

async function comment(
  client: GitHubClient,
  job: JobRow,
  body: string,
): Promise<void> {
  if (!client.write) throw new Error("this GitHub client cannot post");
  await client.write<Json>(
    `repos/${job.repo}/issues/${job.pr_number}/comments`,
    { body },
  );
}

/** A check run for `sha` that is already done as `skipped`. It is the newest
 * run of the check on that commit, so it is the one a required check reads. */
async function skippedCheck(
  client: GitHubClient,
  job: JobRow,
  sha: string,
  title: string,
  summary: string,
  log: LogFn,
): Promise<void> {
  if (!client.createCheckRun) {
    log("info", "this GitHub client cannot create check runs");
    return;
  }
  await client.createCheckRun<Json>(`repos/${job.repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: sha,
    status: "completed",
    conclusion: "skipped",
    completed_at: new Date().toISOString(),
    output: { title, summary },
  });
}

async function githubFor(
  job: JobRow,
  client?: GitHubClient,
): Promise<GitHubClient> {
  if (client) return client;
  const id =
    getRepo(job.repo)?.installation_id ??
    (await resolveInstallationId(job.repo));
  if (id === undefined || id === null) {
    throw new Error(`no GitHub App installation stored for ${job.repo}`);
  }
  return clientFor(id);
}

export async function runSkipJob(
  job: JobRow,
  log: LogFn,
  client?: GitHubClient,
): Promise<void> {
  if (job.pr_number === null) throw new Error("skip job has no pull request");
  const args = JSON.parse(job.args || "{}") as SkipJobArgs;
  const github = await githubFor(job, client);
  const pull = await github.request<Json>(
    `repos/${job.repo}/pulls/${job.pr_number}`,
  );
  const head =
    args.headSha || String((pull.head as Json | undefined)?.sha ?? "");
  if (!head) throw new Error("the pull request has no head commit");

  switch (args.command) {
    case "skip-this-commit": {
      const review = listReviewsForPr(job.repo, job.pr_number).find(
        (row) => row.head_sha === head,
      );
      if (review?.status !== "failed") {
        await comment(github, job, nothingToSkipText(head));
        log("info", `nothing to skip on ${short(head)}`);
        return;
      }
      const text = skippedCommitText(head, args.by);
      await skippedCheck(github, job, head, "Review skipped.", text, log);
      // The failed note says the review was skipped. Without a note, or a
      // client that cannot edit one, the text is a new comment.
      const note =
        review.note_comment_id ??
        findNoteCommentId(job.repo, job.pr_number, head);
      if (note && github.patch) {
        try {
          await github.patch<Json>(
            `repos/${job.repo}/issues/comments/${note}`,
            { body: text },
          );
          log("info", `skipped ${short(head)}, the failed note says so`);
          return;
        } catch (error) {
          log(
            "info",
            `could not edit the failed note: ${redact(String(error))}`,
          );
        }
      }
      await comment(github, job, text);
      log("info", `skipped ${short(head)}`);
      return;
    }
    case "skip-this-pr": {
      if (prReviewsOff(job.repo, job.pr_number)) {
        await comment(github, job, ALREADY_OFF_TEXT);
        return;
      }
      setPrReviewsOff(job.repo, job.pr_number, args.by ?? "unknown");
      // A review that is waiting or running posts nothing.
      const key = `review:${job.repo}:${job.pr_number}`;
      for (const pending of [
        getQueuedJob(job.repo, job.pr_number),
        getRunningJobByKey(key),
      ]) {
        if (pending) cancel(pending.id, "reviews_off");
      }
      const text = reviewsOffText(args.by);
      await skippedCheck(
        github,
        job,
        head,
        "Reviews are off for this pull request.",
        text,
        log,
      );
      await comment(github, job, text);
      log("info", "reviews are off for this pull request");
      return;
    }
    case "pr-off": {
      await skippedCheck(
        github,
        job,
        head,
        "Reviews are off for this pull request.",
        reviewsOffText(args.by),
        log,
      );
      log("info", `skipped ${short(head)}, reviews are off`);
      return;
    }
    case "reviews-on": {
      await comment(github, job, reviewsOnText(args.by));
      log("info", "reviews are back on for this pull request");
      return;
    }
  }
}

export function registerSkipJobHandler(): void {
  registerHandler(SKIP_JOB, {
    run(job, log) {
      return runSkipJob(job, log);
    },
  });
}
