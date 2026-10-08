/** Webhook dispatch: installation bookkeeping and the skip/enqueue rules
 * for pull_request events. HTTP parsing and HMAC live in server/webhook/. */
import { enqueue } from "./jobs.ts";
import {
  deactivateRepo,
  deactivateReposForInstallation,
  getRepo,
  setInstallationId,
} from "../store/repos.ts";
import { findFindingByPostedComment } from "../store/findings.ts";
import {
  createReplyRequestAndJob,
  findReplyByPostedComment,
} from "../store/replies.ts";
import { latestPostedReview } from "../store/reviews.ts";
import { getQueuedJob } from "../store/jobs.ts";
import type { RepoRow } from "../store/rows.ts";
import {
  markInstallationRemoved,
  markInstallationSuspended,
  upsertInstallation,
} from "../store/installations.ts";
import { readConfig } from "../config.ts";
import {
  carriesEarlierRequest,
  evaluatePolicy,
  isRequestCommand,
  legacyPolicy,
  parsePolicy,
  type Association,
  type ReviewPolicy,
} from "./review_policy.ts";

export const REVIEW_DEBOUNCE_MS = 20_000;

const PR_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);

/** The policy that governs a repository. A repository pinned to `"legacy"`, and
 * one with nothing stored and no server default, follow the three old
 * switches. A stored value that no longer parses does too, so a bad edit
 * degrades to today's behavior rather than to a silent stop. */
export function policySource(row: RepoRow): {
  policy: ReviewPolicy;
  /** True when the three old switches are what decides. */
  legacy: boolean;
} {
  const switches = { policy: legacyPolicy(row), legacy: true };
  let value: unknown;
  if (row.review_policy_json !== null) {
    try {
      value = JSON.parse(row.review_policy_json);
    } catch {
      return switches;
    }
    if (value === "legacy") return switches;
  } else {
    value = readConfig().reviewPolicy;
    if (value === undefined) return switches;
  }
  const parsed = parsePolicy(value);
  return parsed.ok ? { policy: parsed.value, legacy: false } : switches;
}

export function policyForRepo(row: RepoRow): ReviewPolicy {
  return policySource(row).policy;
}

export type WebhookResult = {
  outcome: "enqueued" | "skipped" | "ignored" | "error";
  reason?: string;
  repo?: string;
  prNumber?: number;
  jobId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function appSlug(payload: Record<string, unknown>): string | undefined {
  return asString(asRecord(payload.installation)?.app_slug);
}

function hasAppMention(body: string, slug?: string): boolean {
  const candidates = [slug, "co-maintainer"].filter((value): value is string =>
    Boolean(value),
  );
  return candidates.some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffix = candidate === "co-maintainer" ? "(?:-[a-z0-9-]+)?" : "";
    return new RegExp(`(^|[^\\w-])@${escaped}${suffix}(?![\\w-])`, "i").test(
      body,
    );
  });
}

function isBot(user: Record<string, unknown> | undefined): boolean {
  if (!user) return false;
  if (asString(user.type) === "Bot") return true;
  const login = asString(user.login) ?? "";
  return login.endsWith("[bot]");
}

function labelNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((label) => asString(asRecord(label)?.name))
    .filter((name): name is string => Boolean(name));
}

/** The policy facts a pull request object carries. `fork` is true when the head
 * lives in another repository, or in none because the fork was deleted. */
function pullRequestFacts(
  pr: Record<string, unknown> | undefined,
  repo: string,
): {
  association?: string;
  fork?: boolean;
  labels?: string[];
  targetBranch?: string;
} {
  const head = asRecord(pr?.head);
  const headRepo = asString(asRecord(head?.repo)?.full_name);
  return {
    association: asString(pr?.author_association),
    fork: head ? headRepo?.toLowerCase() !== repo.toLowerCase() : undefined,
    labels: labelNames(pr?.labels),
    targetBranch: asString(asRecord(pr?.base)?.ref),
  };
}

/** A comment request is decided from the issue payload, which says nothing
 * about the fork, the target branch or the size. The review job asks again
 * with the pull request it fetched, so a comment can never get past the size
 * cap or a rule that a label request would hit. Returns why the review must
 * not run, or undefined. */
export function requestedReviewBlocked(
  repo: string,
  pr: Record<string, unknown>,
): string | undefined {
  const row = getRepo(repo);
  if (!row || row.active !== 1) return "repo-not-active";
  const config = readConfig();
  const maxDiffLines =
    config.repos?.[repo]?.maxPullRequestChangeLines ??
    config.defaults?.maxPullRequestChangeLines;
  const changedLines =
    (asNumber(pr.additions) ?? 0) + (asNumber(pr.deletions) ?? 0);
  if (maxDiffLines !== undefined && changedLines > maxDiffLines) {
    return "diff-too-large";
  }
  const decision = evaluatePolicy(policyForRepo(row), {
    ...pullRequestFacts(pr, repo),
    draft: asBool(pr.draft),
    bot: isBot(asRecord(pr.user)),
    changedLines,
  });
  return decision.action === "skip" ? decision.reason : undefined;
}

export function maybeEnqueueReview(input: {
  repo: string;
  prNumber: number;
  draft: boolean;
  bot: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  deliveryId: string;
  trigger: string;
  headSha?: string;
  maxDiffLines?: number;
  /** What the pull request payload said about its author and shape. Left out
   * when GitHub did not send it, and a rule that asks about it then skips. */
  association?: string;
  fork?: boolean;
  labels?: string[];
  targetBranch?: string;
  /** Set when a maintainer asked for this review by label or comment. The
   * reaction endpoint is where the App acknowledges it once the job starts. */
  request?: { reaction: string };
}): WebhookResult {
  const row = getRepo(input.repo);
  if (!row || row.active !== 1) {
    return {
      outcome: "skipped",
      reason: "repo-not-active",
      repo: input.repo,
      prNumber: input.prNumber,
    };
  }
  const policy = policyForRepo(row);
  const decision = evaluatePolicy(policy, {
    association: input.association,
    fork: input.fork,
    draft: input.draft,
    bot: input.bot,
    labels: input.labels,
    targetBranch: input.targetBranch,
    changedLines:
      input.changedFiles >= 0 ? input.additions + input.deletions : undefined,
  });
  const skipped = (reason: string): WebhookResult => ({
    outcome: "skipped",
    reason,
    repo: input.repo,
    prNumber: input.prNumber,
  });
  const earlier = latestPostedReview(input.repo, input.prNumber);
  if (decision.action === "skip") return skipped(decision.reason);
  if (decision.action === "on-request" && !input.request) {
    const asked =
      earlier !== undefined ||
      getQueuedJob(input.repo, input.prNumber) !== undefined;
    if (!carriesEarlierRequest(policy, asked)) {
      return skipped(decision.reason);
    }
  }
  if (!row.knowledge_built_at) {
    return {
      outcome: "skipped",
      reason: "no-knowledge-yet",
      repo: input.repo,
      prNumber: input.prNumber,
    };
  }
  if (input.changedFiles === 0) {
    return {
      outcome: "skipped",
      reason: "no-code-changes",
      repo: input.repo,
      prNumber: input.prNumber,
    };
  }
  if (
    input.maxDiffLines !== undefined &&
    input.additions + input.deletions > input.maxDiffLines
  ) {
    return {
      outcome: "skipped",
      reason: "diff-too-large",
      repo: input.repo,
      prNumber: input.prNumber,
    };
  }
  if (
    (input.trigger === "review" || input.trigger === "review-comment") &&
    input.headSha
  ) {
    if (earlier && earlier.head_sha === input.headSha) {
      return skipped("nothing-new-since-last-round");
    }
  }
  if (
    policy.maxRounds !== undefined &&
    earlier &&
    earlier.round >= policy.maxRounds
  ) {
    return skipped(
      `Round limit reached: ${earlier.round} of ${policy.maxRounds} reviews.`,
    );
  }
  const last = earlier;
  const incremental =
    row.review_scope === "incremental" && Boolean(last?.head_sha);
  const { id } = enqueue({
    type: "review",
    repo: input.repo,
    prNumber: input.prNumber,
    deliveryId: input.deliveryId,
    debounceMs: REVIEW_DEBOUNCE_MS,
    args: {
      trigger: input.trigger,
      scope: incremental ? "incremental" : "whole-pr",
      sinceCommit: incremental ? last!.head_sha : undefined,
      round: last ? last.round + 1 : 1,
      requestReaction: input.request?.reaction,
    },
  });
  return {
    outcome: "enqueued",
    repo: input.repo,
    prNumber: input.prNumber,
    jobId: id,
  };
}

function applyInstallation(payload: Record<string, unknown>): WebhookResult {
  const installation = asRecord(payload.installation);
  const id = asNumber(installation?.id);
  if (id === undefined) return { outcome: "ignored" };
  const action = asString(payload.action);
  const account = asRecord(installation?.account);
  if (action === "created") {
    upsertInstallation({
      id,
      account_login: asString(account?.login) ?? "",
      account_type: asString(account?.type) ?? "User",
      permissions: installation?.permissions ?? {},
      events: Array.isArray(installation?.events)
        ? installation.events.map(String)
        : [],
    });
    return { outcome: "ignored", reason: "installation-created" };
  }
  if (action === "deleted") {
    markInstallationRemoved(id);
    deactivateReposForInstallation(id);
    return { outcome: "ignored", reason: "installation-deleted" };
  }
  if (action === "suspend") {
    markInstallationSuspended(id, true);
    return { outcome: "ignored", reason: "installation-suspended" };
  }
  if (action === "unsuspend") {
    markInstallationSuspended(id, false);
    return { outcome: "ignored", reason: "installation-unsuspended" };
  }
  return { outcome: "ignored" };
}

function applyInstallationRepositories(
  payload: Record<string, unknown>,
): WebhookResult {
  const action = asString(payload.action);
  const installationId = asNumber(asRecord(payload.installation)?.id);
  if (action === "added" && installationId !== undefined) {
    const added = payload.repositories_added;
    if (Array.isArray(added)) {
      for (const item of added) {
        const fullName = asString(asRecord(item)?.full_name);
        if (fullName) setInstallationId(fullName, installationId);
      }
    }
    return { outcome: "ignored", reason: "repositories-added" };
  }
  if (action === "removed") {
    const removed = payload.repositories_removed;
    if (Array.isArray(removed)) {
      for (const item of removed) {
        const fullName = asString(asRecord(item)?.full_name);
        if (fullName) deactivateRepo(fullName);
      }
    }
    return { outcome: "ignored", reason: "repositories-removed" };
  }
  return { outcome: "ignored", reason: "repositories-added" };
}

function pullRequestEvent(
  payload: Record<string, unknown>,
  deliveryId: string,
  maxDiffLines?: number,
): WebhookResult {
  const action = asString(payload.action) ?? "";
  const pr = asRecord(payload.pull_request);
  const repo = asString(asRecord(payload.repository)?.full_name);
  const prNumber = asNumber(pr?.number) ?? asNumber(payload.number);
  const labeled = action === "labeled";
  if (
    (!PR_ACTIONS.has(action) && !labeled) ||
    !repo ||
    prNumber === undefined
  ) {
    return { outcome: "ignored", repo, prNumber };
  }
  // A label only means something when it is the repository's request label.
  // Adding it already takes triage rights, so no further check is made.
  if (labeled) {
    const row = getRepo(repo);
    const added = asString(asRecord(payload.label)?.name);
    if (
      !row ||
      !added ||
      added.toLowerCase() !== policyForRepo(row).requestLabel.toLowerCase()
    ) {
      return { outcome: "ignored", repo, prNumber };
    }
  }
  const user = asRecord(pr?.user);
  const installationId = asNumber(asRecord(payload.installation)?.id);
  if (installationId !== undefined) setInstallationId(repo, installationId);
  return maybeEnqueueReview({
    repo,
    prNumber,
    draft: asBool(pr?.draft),
    bot: isBot(user),
    additions: asNumber(pr?.additions) ?? 0,
    deletions: asNumber(pr?.deletions) ?? 0,
    changedFiles: asNumber(pr?.changed_files) ?? -1,
    deliveryId,
    trigger: labeled ? "request-label" : action,
    headSha: asString(asRecord(pr?.head)?.sha),
    maxDiffLines,
    ...pullRequestFacts(pr, repo),
    request: labeled
      ? { reaction: `repos/${repo}/issues/${prNumber}/reactions` }
      : undefined,
  });
}

function reviewWakeEvent(
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string,
  maxDiffLines?: number,
): WebhookResult {
  const action = asString(payload.action) ?? "";
  const allowed =
    event === "pull_request_review"
      ? action === "submitted"
      : action === "created";
  const pr = asRecord(payload.pull_request);
  const repo = asString(asRecord(payload.repository)?.full_name);
  const prNumber = asNumber(pr?.number);
  if (!allowed || !repo || prNumber === undefined) {
    return { outcome: "ignored", repo, prNumber };
  }
  const actor = asRecord(
    event === "pull_request_review"
      ? asRecord(payload.review)?.user
      : asRecord(payload.comment)?.user,
  );
  if (isBot(actor)) {
    return {
      outcome: "skipped",
      reason: "own-comment",
      repo,
      prNumber,
    };
  }
  const installationId = asNumber(asRecord(payload.installation)?.id);
  if (installationId !== undefined) setInstallationId(repo, installationId);
  return maybeEnqueueReview({
    repo,
    prNumber,
    draft: asBool(pr?.draft),
    bot: false,
    additions: asNumber(pr?.additions) ?? 0,
    deletions: asNumber(pr?.deletions) ?? 0,
    changedFiles: asNumber(pr?.changed_files) ?? -1,
    deliveryId,
    trigger: event === "pull_request_review" ? "review" : "review-comment",
    headSha: asString(asRecord(pr?.head)?.sha),
    maxDiffLines,
    ...pullRequestFacts(pr, repo),
  });
}

function replyTarget(
  repo: string,
  prNumber: number,
  parentCommentId: string,
): string | undefined {
  if (findFindingByPostedComment(repo, prNumber, parentCommentId)) {
    return parentCommentId;
  }
  return (
    findReplyByPostedComment(repo, prNumber, parentCommentId)
      ?.target_comment_id ?? undefined
  );
}

function enqueueReply(
  payload: Record<string, unknown>,
  deliveryId: string,
  sourceKind: "review_comment" | "issue_comment",
  sourceCommentId: string,
  repo: string,
  prNumber: number,
  sourceBody: string,
  sourceAuthor: string | undefined,
  targetCommentId?: string,
  sourcePath?: string,
  sourceLine?: number,
  sourceCommitId?: string,
): WebhookResult {
  const installationId = asNumber(asRecord(payload.installation)?.id);
  if (installationId !== undefined) setInstallationId(repo, installationId);
  const row = getRepo(repo);
  if (!row || row.active !== 1) {
    return {
      outcome: "skipped",
      reason: "repo-not-active",
      repo,
      prNumber,
    };
  }
  const result = createReplyRequestAndJob({
    repo,
    prNumber,
    sourceKind,
    sourceCommentId,
    targetCommentId,
    sourceBody: sourceBody.slice(0, 20_000),
    sourceAuthor,
    sourcePath,
    sourceLine,
    sourceCommitId,
    deliveryId,
  });
  if (!result.created) {
    return {
      outcome: "skipped",
      reason: "duplicate-reply",
      repo,
      prNumber,
      jobId: result.request.job_id ?? undefined,
    };
  }
  return {
    outcome: "enqueued",
    repo,
    prNumber,
    jobId: result.request.job_id ?? undefined,
  };
}

function reviewCommentEvent(
  payload: Record<string, unknown>,
  deliveryId: string,
  maxDiffLines?: number,
): WebhookResult {
  const comment = asRecord(payload.comment);
  const repo = asString(asRecord(payload.repository)?.full_name);
  const pr = asRecord(payload.pull_request);
  const prNumber = asNumber(pr?.number);
  const action = asString(payload.action) ?? "";
  const sourceId = comment?.id;
  const parentId = comment?.in_reply_to_id;
  const author = asRecord(comment?.user);
  if (action !== "created" || !repo || prNumber === undefined) {
    return { outcome: "ignored", repo, prNumber };
  }
  if (isBot(author)) {
    return {
      outcome: "skipped",
      reason: "own-comment",
      repo,
      prNumber,
    };
  }
  if (
    (typeof sourceId === "number" || typeof sourceId === "string") &&
    (typeof parentId === "number" || typeof parentId === "string")
  ) {
    const target = replyTarget(repo, prNumber, String(parentId));
    if (target) {
      return enqueueReply(
        payload,
        deliveryId,
        "review_comment",
        String(sourceId),
        repo,
        prNumber,
        asString(comment?.body) ?? "",
        asString(author?.login),
        target,
        asString(comment?.path),
        asNumber(comment?.line) ?? asNumber(comment?.original_line),
        asString(comment?.commit_id),
      );
    }
  }
  return reviewWakeEvent(
    "pull_request_review_comment",
    payload,
    deliveryId,
    maxDiffLines,
  );
}

function issueCommentEvent(
  payload: Record<string, unknown>,
  deliveryId: string,
): WebhookResult {
  const action = asString(payload.action) ?? "";
  const issue = asRecord(payload.issue);
  const comment = asRecord(payload.comment);
  const repo = asString(asRecord(payload.repository)?.full_name);
  const prNumber = asNumber(issue?.number);
  const sourceId = comment?.id;
  const author = asRecord(comment?.user);
  const body = asString(comment?.body) ?? "";
  if (
    action !== "created" ||
    !repo ||
    prNumber === undefined ||
    !asRecord(issue?.pull_request) ||
    (typeof sourceId !== "number" && typeof sourceId !== "string")
  ) {
    return { outcome: "ignored", repo, prNumber };
  }
  if (isBot(author)) {
    return {
      outcome: "skipped",
      reason: "own-comment",
      repo,
      prNumber,
    };
  }
  const row = getRepo(repo);
  if (row?.active === 1) {
    const policy = policyForRepo(row);
    if (isRequestCommand(body, policy.requestCommand)) {
      const commenter = asString(comment?.author_association) ?? "NONE";
      if (!policy.requesters.includes(commenter as Association)) {
        return {
          outcome: "skipped",
          reason: `Not allowed to request a review: ${commenter} is not one of ${policy.requesters.join(", ")}.`,
          repo,
          prNumber,
        };
      }
      const installationId = asNumber(asRecord(payload.installation)?.id);
      if (installationId !== undefined) setInstallationId(repo, installationId);
      // An issue payload carries no head, base or diff size, so rules about
      // the fork, the target branch and the size do not match here.
      return maybeEnqueueReview({
        repo,
        prNumber,
        draft: asBool(issue?.draft),
        bot: isBot(asRecord(issue?.user)),
        additions: 0,
        deletions: 0,
        changedFiles: -1,
        deliveryId,
        trigger: "request-comment",
        association: asString(issue?.author_association),
        labels: labelNames(issue?.labels),
        request: {
          reaction: `repos/${repo}/issues/comments/${String(sourceId)}/reactions`,
        },
      });
    }
  }
  if (!hasAppMention(body, appSlug(payload))) {
    return {
      outcome: "ignored",
      reason: "no-app-mention",
      repo,
      prNumber,
    };
  }
  return enqueueReply(
    payload,
    deliveryId,
    "issue_comment",
    String(sourceId),
    repo,
    prNumber,
    body,
    asString(author?.login),
  );
}

export function dispatchGithubEvent(
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string,
  maxDiffLines?: number,
): WebhookResult {
  if (event === "installation") return applyInstallation(payload);
  if (event === "installation_repositories") {
    return applyInstallationRepositories(payload);
  }
  if (event === "pull_request") {
    return pullRequestEvent(payload, deliveryId, maxDiffLines);
  }
  if (event === "pull_request_review_comment") {
    return reviewCommentEvent(payload, deliveryId, maxDiffLines);
  }
  if (event === "pull_request_review") {
    return reviewWakeEvent(event, payload, deliveryId, maxDiffLines);
  }
  if (event === "issue_comment") return issueCommentEvent(payload, deliveryId);
  return { outcome: "ignored" };
}
