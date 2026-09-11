/** Webhook dispatch: installation bookkeeping and the skip/enqueue rules
 * for pull_request events. HTTP parsing and HMAC live in server/webhook/. */
import { enqueue } from "./jobs.ts";
import {
  deactivateRepo,
  deactivateReposForInstallation,
  getRepo,
  setInstallationId,
} from "../store/repos.ts";
import { latestPostedReview } from "../store/reviews.ts";
import {
  markInstallationRemoved,
  markInstallationSuspended,
  upsertInstallation,
} from "../store/installations.ts";

export const REVIEW_DEBOUNCE_MS = 20_000;

const PR_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);

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

function isBot(user: Record<string, unknown> | undefined): boolean {
  if (!user) return false;
  if (asString(user.type) === "Bot") return true;
  const login = asString(user.login) ?? "";
  return login.endsWith("[bot]");
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
  if (row.auto_review !== 1) {
    return {
      outcome: "skipped",
      reason: "auto-review-off",
      repo: input.repo,
      prNumber: input.prNumber,
    };
  }
  if (row.skip_drafts === 1 && input.draft) {
    return {
      outcome: "skipped",
      reason: "draft",
      repo: input.repo,
      prNumber: input.prNumber,
    };
  }
  if (row.skip_bots === 1 && input.bot) {
    return {
      outcome: "skipped",
      reason: "bot-author",
      repo: input.repo,
      prNumber: input.prNumber,
    };
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
    const last = latestPostedReview(input.repo, input.prNumber);
    if (last && last.head_sha === input.headSha) {
      return {
        outcome: "skipped",
        reason: "nothing-new-since-last-round",
        repo: input.repo,
        prNumber: input.prNumber,
      };
    }
  }
  const last = latestPostedReview(input.repo, input.prNumber);
  const incremental = row.review_scope === "incremental" &&
    Boolean(last?.head_sha);
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
  if (!PR_ACTIONS.has(action) || !repo || prNumber === undefined) {
    return { outcome: "ignored", repo, prNumber };
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
    trigger: action,
    headSha: asString(asRecord(pr?.head)?.sha),
    maxDiffLines,
  });
}

function reviewWakeEvent(
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string,
  maxDiffLines?: number,
): WebhookResult {
  const action = asString(payload.action) ?? "";
  const allowed = event === "pull_request_review"
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
  });
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
  if (
    event === "pull_request_review" ||
    event === "pull_request_review_comment"
  ) {
    return reviewWakeEvent(event, payload, deliveryId, maxDiffLines);
  }
  return { outcome: "ignored" };
}
