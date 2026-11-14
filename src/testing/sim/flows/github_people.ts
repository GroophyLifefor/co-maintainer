/** What people do on GitHub that the simulated GitHub has no helper for yet:
 * a person's review with a verdict, a pull request's age, and a comment that
 * is edited later.
 *
 * GitHub moves a pull request's `updated_at` when someone comments on it or
 * reviews it. `SimGithub.comment` and `reviewComment` do not, and `init` and
 * `sync` decide what to fetch again from `updated_at` alone, so these helpers
 * move it. They belong in `github.ts`; they live here until the core takes
 * them. */
import type { SimComment, SimGithub, SimPull, SimReview } from "../github.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO time `days` before now. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** Sets when the pull request was opened, last changed and, if it is closed,
 * closed. A pull request older than `--max-pr-months` is outside the window. */
export function age(pull: SimPull, days: number): void {
  const at = daysAgo(days);
  pull.createdAt = at;
  pull.updatedAt = at;
  if (pull.closedAt) pull.closedAt = at;
  if (pull.mergedAt) pull.mergedAt = at;
}

/** What GitHub does to a pull request when someone comments or reviews. */
export function touch(pull: SimPull, at = new Date().toISOString()): void {
  pull.updatedAt = at;
}

/** A person submits a review: `CHANGES_REQUESTED`, `APPROVED` or
 * `COMMENTED`. Not a product write, so it is not in `writes`. */
export function review(
  github: SimGithub,
  pull: SimPull,
  input: { state: string; body: string; user?: string },
): SimReview {
  const review: SimReview = {
    id: 900_000 + github.reviews.length,
    repo: pull.repo,
    number: pull.number,
    body: input.body,
    state: input.state,
    user: { login: input.user ?? "sim-maintainer", type: "User" },
    commitId: pull.headSha,
    submittedAt: new Date().toISOString(),
  };
  github.reviews.push(review);
  touch(pull);
  return review;
}

/** A person edits an earlier comment. GitHub moves the comment's
 * `updated_at`, and this assumes it moves the pull request's too, the same as
 * a new comment does. */
export function editComment(
  pull: SimPull,
  comment: SimComment,
  body: string,
): void {
  comment.body = body;
  comment.updatedAt = new Date().toISOString();
  touch(pull, comment.updatedAt);
}
