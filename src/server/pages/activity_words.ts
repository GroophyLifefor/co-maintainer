/** Plain sentences for the codes jobs, skips and cancels store. One table
 * for every page, so the Activity list, the skipped list and the job page
 * say the same thing for the same code. A code with no entry is never shown
 * raw: it becomes words, and a stored sentence is shown as it is. */
import type { JobRow } from "../../store/rows.ts";

/** What each kind of job did, in the past tense. A review names its pull
 * request elsewhere on the row, so the label stays short. */
const JOB_KINDS: Record<string, string> = {
  init: "Set up repository",
  remake: "Synced knowledge",
  review: "Reviewed pull request",
  skip: "Skipped a review",
  reply: "Replied in a thread",
  push_review: "Reviewed a push",
  push_check: "Updated the commit watch check",
  remote_review: "Reviewed from the CLI",
  watch_comment: "Answered a commit watch issue",
};

/** The kinds a person can filter the Activity list by, with the job types
 * each one covers. */
export const ACTIVITY_KINDS: { id: string; label: string; types: string[] }[] =
  [
    { id: "review", label: "Reviews", types: ["review"] },
    { id: "push", label: "Pushes", types: ["push_review", "push_check"] },
    { id: "cli", label: "CLI", types: ["remote_review"] },
    { id: "setup", label: "Setup and sync", types: ["init", "remake"] },
    { id: "skip", label: "Skips", types: ["skip"] },
    { id: "reply", label: "Replies", types: ["reply", "watch_comment"] },
  ];

/** The words for a skip job, by the command that asked for it. */
const SKIP_COMMANDS: Record<string, string> = {
  "skip-this-commit": "Skipped the review of one commit on request",
  "skip-this-pr": "Turned reviews off for this pull request",
  "reviews-on": "Turned reviews back on for this pull request",
  "pr-off": "Skipped: reviews are off for this pull request",
};

/** Why a delivery was skipped or ignored, or why a push was not reviewed. */
const REASONS: Record<string, string> = {
  draft: "Skipped: a draft pull request",
  "bot-author": "Skipped: opened by a bot",
  "repo-not-active": "Skipped: the repository is not added yet",
  "auto-review-off": "Skipped: automatic review is off",
  "no-knowledge-yet": "Skipped: the knowledge is not built yet",
  "diff-too-large": "Skipped: the diff is too large",
  "no-code-changes": "Skipped: no code changes",
  "own-comment": "Skipped: the bot's own comment",
  "nothing-new-since-last-round": "Skipped: nothing new since the last review",
  "duplicate-reply": "Skipped: this comment was already answered",
  "no-app-mention": "Skipped: the comment does not mention the bot",
  "no-changes": "Skipped: the push changed nothing",
  "range-extend": "Skipped: this push needs a wider diff than GitHub sent",
  "already-reviewed": "Skipped: this push was already reviewed",
  "not-initialized": "Skipped: the repository is not set up yet",
  "not-default-branch": "Ignored: the push is not on the default branch",
  "branch-deleted": "Ignored: the branch was deleted",
  "not-a-watch-issue": "Ignored: not a commit watch issue",
  "installation-created": "The GitHub App was installed",
  "installation-deleted": "The GitHub App was uninstalled",
  "installation-suspended": "The GitHub App was suspended",
  "installation-unsuspended": "The GitHub App was resumed",
  "repositories-added": "Repositories were added to the GitHub App",
  "repositories-removed": "Repositories were removed from the GitHub App",
};

/** Why a job was canceled. */
const CANCEL_REASONS: Record<string, string> = {
  dashboard_canceled: "Canceled from the dashboard",
  superseded: "Replaced by a newer job",
  merged: "Folded into the review of a newer push",
  client_timeout: "No sync from the CLI",
  client_canceled: "Canceled from the CLI",
  token_deactivated: "Token was deactivated",
  token_deleted: "Token was deleted",
  repo_deactivated: "Repository was removed from the dashboard",
  server_restarted: "Server restarted during the job",
};

/** A code such as `some-new-reason` read out as words. A stored sentence,
 * one with a space in it, is already words and stays as it is. */
function codeAsWords(code: string, prefix: string): string {
  if (/\s/.test(code.trim())) return code.trim().replace(/\.$/, "");
  const words = code.replace(/[-_]+/g, " ").trim();
  return words ? `${prefix}${words}` : prefix.replace(/: $/, "");
}

function parseArgs(job: Pick<JobRow, "args">): Record<string, unknown> {
  try {
    const parsed = JSON.parse(job.args || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** What a job did, as the Activity list and the job page name it. */
export function jobKindText(job: Pick<JobRow, "type">): string {
  return JOB_KINDS[job.type] ?? codeAsWords(job.type, "Ran ");
}

/** The detail line under a job: which skip command, for a skip job. Empty
 * when the kind says it all. */
export function jobDetailText(job: Pick<JobRow, "type" | "args">): string {
  if (job.type !== "skip") return "";
  const command = parseArgs(job).command;
  return typeof command === "string" ? (SKIP_COMMANDS[command] ?? "") : "";
}

/** Why a delivery was skipped or ignored. `outcome` words a delivery that
 * stored no reason. */
export function reasonText(
  reason: string | null | undefined,
  outcome?: string,
): string {
  if (!reason) {
    if (outcome === "error") return "Could not handle this event";
    if (outcome === "ignored") return "Ignored: nothing to do for this event";
    return "Skipped";
  }
  const known = REASONS[reason];
  if (known) return known;
  const access = /^no-write-access:\s*(.+)$/.exec(reason);
  if (access) {
    return `Skipped: the commenter has no write access (${access[1]!.toLowerCase()})`;
  }
  return codeAsWords(reason, "Skipped: ");
}

/** Why a job was canceled. */
export function cancelReasonText(reason: string | null | undefined): string {
  if (!reason) return "Canceled";
  return CANCEL_REASONS[reason] ?? codeAsWords(reason, "Canceled: ");
}

/** Every code with its own sentence, for the test that keeps each one
 * readable. */
export const WORDED_CODES = {
  jobKinds: Object.keys(JOB_KINDS),
  skipCommands: Object.keys(SKIP_COMMANDS),
  reasons: Object.keys(REASONS),
  cancelReasons: Object.keys(CANCEL_REASONS),
};
