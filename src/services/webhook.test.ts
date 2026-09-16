import { closeAppDb, openAppDb } from "../store/app_db.ts";
import {
  activateRepo,
  getRepo,
  markKnowledgeBuilt,
  updateRepoSettings,
} from "../store/repos.ts";
import { getInstallation } from "../store/installations.ts";
import { getJob, getQueuedJob } from "../store/jobs.ts";
import { insertReview, setReviewStatus } from "../store/reviews.ts";
import { insertFinding, setFindingPosted } from "../store/findings.ts";
import { findReplyRequest } from "../store/replies.ts";
import { dispatchGithubEvent, maybeEnqueueReview } from "./webhook.ts";

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
}

function readyRepo(fullName = "acme/widgets"): void {
  activateRepo(fullName, 1);
  markKnowledgeBuilt(fullName, "abc123");
}

function enqueueArgs(
  overrides: Partial<Parameters<typeof maybeEnqueueReview>[0]> = {},
) {
  return {
    repo: "acme/widgets",
    prNumber: 7,
    draft: false,
    bot: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    deliveryId: "d-1",
    trigger: "opened",
    ...overrides,
  };
}

Deno.test("maybeEnqueueReview records every skip reason and enqueues when none apply", async () => {
  await withTempDb(() => {
    const missing = maybeEnqueueReview(enqueueArgs());
    if (missing.reason !== "repo-not-active") {
      throw new Error(`expected repo-not-active, got ${missing.reason}`);
    }

    activateRepo("acme/widgets", 1);
    updateRepoSettings("acme/widgets", { auto_review: 0 });
    const off = maybeEnqueueReview(enqueueArgs());
    if (off.reason !== "auto-review-off") {
      throw new Error(`expected auto-review-off, got ${off.reason}`);
    }

    updateRepoSettings("acme/widgets", { auto_review: 1 });
    const draft = maybeEnqueueReview(enqueueArgs({ draft: true }));
    if (draft.reason !== "draft") {
      throw new Error(`expected draft, got ${draft.reason}`);
    }

    const bot = maybeEnqueueReview(enqueueArgs({ bot: true }));
    if (bot.reason !== "bot-author") {
      throw new Error(`expected bot-author, got ${bot.reason}`);
    }

    const knowledge = maybeEnqueueReview(enqueueArgs());
    if (knowledge.reason !== "no-knowledge-yet") {
      throw new Error(`expected no-knowledge-yet, got ${knowledge.reason}`);
    }

    markKnowledgeBuilt("acme/widgets", "abc123");
    const empty = maybeEnqueueReview(enqueueArgs({ changedFiles: 0 }));
    if (empty.reason !== "no-code-changes") {
      throw new Error(`expected no-code-changes, got ${empty.reason}`);
    }

    const huge = maybeEnqueueReview(
      enqueueArgs({ additions: 500, deletions: 500, maxDiffLines: 100 }),
    );
    if (huge.reason !== "diff-too-large") {
      throw new Error(`expected diff-too-large, got ${huge.reason}`);
    }

    const ok = maybeEnqueueReview(enqueueArgs({ deliveryId: "d-ok" }));
    if (ok.outcome !== "enqueued" || !ok.jobId) {
      throw new Error(`expected enqueue, got ${JSON.stringify(ok)}`);
    }
    const job = getJob(ok.jobId);
    if (job?.type !== "review" || job.pr_number !== 7) {
      throw new Error(`unexpected job ${JSON.stringify(job)}`);
    }
  });
});

Deno.test("a second pull_request for the same PR within the debounce window keeps one job", async () => {
  await withTempDb(() => {
    readyRepo();
    const first = maybeEnqueueReview(enqueueArgs({ deliveryId: "d-a" }));
    const second = maybeEnqueueReview(enqueueArgs({ deliveryId: "d-b" }));
    if (first.jobId !== second.jobId) {
      throw new Error("debounce created a second job");
    }
    if (getQueuedJob("acme/widgets", 7)?.id !== first.jobId) {
      throw new Error("the queued job is not the debounced one");
    }
  });
});

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    number: 3,
    pull_request: {
      number: 3,
      draft: false,
      user: { login: "octocat", type: "User" },
      additions: 4,
      deletions: 1,
      changed_files: 1,
      ...(overrides.pull_request as Record<string, unknown> | undefined),
    },
    repository: { full_name: "acme/widgets" },
    ...overrides,
  };
}

Deno.test("dispatchGithubEvent enqueues opened pull requests and ignores closed ones", async () => {
  await withTempDb(() => {
    readyRepo();
    if (getRepo("acme/widgets")?.installation_id !== 1) {
      throw new Error("activate did not store the installation id");
    }
    const opened = dispatchGithubEvent(
      "pull_request",
      prPayload({ installation: { id: 88 } }),
      "del-1",
    );
    if (opened.outcome !== "enqueued") {
      throw new Error(`opened should enqueue, got ${JSON.stringify(opened)}`);
    }
    if (getRepo("acme/widgets")?.installation_id !== 88) {
      throw new Error("pull_request did not store installation.id");
    }
    const closed = dispatchGithubEvent(
      "pull_request",
      prPayload({ action: "closed" }),
      "del-2",
    );
    if (closed.outcome !== "ignored") {
      throw new Error(
        `closed should be ignored, got ${JSON.stringify(closed)}`,
      );
    }
    const later = dispatchGithubEvent(
      "pull_request_review_comment",
      {
        action: "created",
        comment: { user: { login: "octocat", type: "User" } },
        pull_request: {
          number: 3,
          draft: false,
          user: { login: "octocat", type: "User" },
          additions: 4,
          deletions: 1,
          changed_files: 1,
          head: { sha: "head-new" },
        },
        repository: { full_name: "acme/widgets" },
      },
      "del-3",
    );
    if (later.outcome !== "enqueued") {
      throw new Error(
        `human review comment should enqueue, got ${JSON.stringify(later)}`,
      );
    }
  });
});

Deno.test("installation events update the installations table and deactivate on delete", async () => {
  await withTempDb(() => {
    activateRepo("acme/widgets", 42);
    const created = dispatchGithubEvent("installation", {
      action: "created",
      installation: {
        id: 42,
        account: { login: "acme", type: "Organization" },
        permissions: { pull_requests: "write" },
        events: ["pull_request"],
      },
    }, "i-1");
    if (created.reason !== "installation-created") {
      throw new Error(`unexpected created result ${JSON.stringify(created)}`);
    }
    if (getInstallation(42)?.account_login !== "acme") {
      throw new Error("installation was not upserted");
    }

    dispatchGithubEvent("installation", {
      action: "suspend",
      installation: { id: 42 },
    }, "i-2");
    if (!getInstallation(42)?.suspended_at) {
      throw new Error("suspend did not stick");
    }
    dispatchGithubEvent("installation", {
      action: "unsuspend",
      installation: { id: 42 },
    }, "i-3");
    if (getInstallation(42)?.suspended_at) {
      throw new Error("unsuspend left suspended_at set");
    }

    dispatchGithubEvent("installation", {
      action: "deleted",
      installation: { id: 42 },
    }, "i-4");
    if (!getInstallation(42)?.removed_at) {
      throw new Error("delete did not mark removed");
    }
    if (getRepo("acme/widgets")?.active !== 0) {
      throw new Error("delete did not deactivate the installation's repos");
    }
  });
});

Deno.test("installation_repositories.added binds repos and removed deactivates them", async () => {
  await withTempDb(() => {
    activateRepo("acme/new", undefined);
    activateRepo("acme/keep", 1);
    activateRepo("acme/drop", 1);
    dispatchGithubEvent("installation_repositories", {
      action: "added",
      installation: { id: 7 },
      repositories_added: [{ full_name: "acme/new" }],
    }, "r-0");
    if (getRepo("acme/new")?.installation_id !== 7) {
      throw new Error("added repo did not store its installation");
    }
    dispatchGithubEvent("installation_repositories", {
      action: "removed",
      repositories_removed: [{ full_name: "acme/drop" }],
    }, "r-1");
    if (getRepo("acme/drop")?.active !== 0) {
      throw new Error("removed repo stayed active");
    }
    if (getRepo("acme/keep")?.active !== 1) {
      throw new Error("an unrelated repo was deactivated");
    }
  });
});

Deno.test("a bot review comment is skipped as own-comment", async () => {
  await withTempDb(() => {
    readyRepo();
    const result = dispatchGithubEvent("pull_request_review_comment", {
      action: "created",
      comment: { user: { login: "co-maintainer-beta[bot]", type: "Bot" } },
      pull_request: {
        number: 7,
        draft: false,
        changed_files: 1,
        additions: 1,
        deletions: 0,
        head: { sha: "h2" },
      },
      repository: { full_name: "acme/widgets" },
    }, "own-1");
    if (result.reason !== "own-comment") {
      throw new Error(`expected own-comment, got ${JSON.stringify(result)}`);
    }
  });
});

Deno.test("a review comment on the same head as the last posted review is skipped", async () => {
  await withTempDb(() => {
    readyRepo();
    insertReview({
      id: "rev-last",
      repo: "acme/widgets",
      prNumber: 7,
      jobId: "job-last",
      headSha: "same-head",
      baseSha: "base",
      scope: "whole-pr",
      model: "fake",
    });
    setReviewStatus("rev-last", "posted");
    const result = dispatchGithubEvent("pull_request_review", {
      action: "submitted",
      review: { user: { login: "octocat", type: "User" } },
      pull_request: {
        number: 7,
        draft: false,
        changed_files: 1,
        additions: 1,
        deletions: 0,
        head: { sha: "same-head" },
      },
      repository: { full_name: "acme/widgets" },
    }, "stale-1");
    if (result.reason !== "nothing-new-since-last-round") {
      throw new Error(`expected nothing-new, got ${JSON.stringify(result)}`);
    }
  });
});

Deno.test("inline replies and PR mentions enqueue reply jobs", async () => {
  await withTempDb(() => {
    readyRepo();
    insertReview({
      id: "rev-bot",
      repo: "acme/widgets",
      prNumber: 3,
      jobId: "job-bot",
      headSha: "head",
      baseSha: "base",
      scope: "whole-pr",
      model: "fake",
    });
    setReviewStatus("rev-bot", "posted");
    insertFinding({
      id: "finding-bot",
      reviewId: "rev-bot",
      severity: "P1",
      path: "src/app.ts",
      lineFrom: 4,
      lineTo: 4,
      title: "Bad branch",
      bodyMd: "The branch is wrong.",
    });
    setFindingPosted("finding-bot", "comment-bot");

    const inline = dispatchGithubEvent(
      "pull_request_review_comment",
      {
        action: "created",
        comment: {
          id: 101,
          in_reply_to_id: "comment-bot",
          body: "Why is this blocking?",
          path: "src/app.ts",
          line: 4,
          commit_id: "head",
          user: { login: "octocat", type: "User" },
        },
        pull_request: { number: 3, head: { sha: "head" } },
        repository: { full_name: "acme/widgets" },
      },
      "reply-1",
    );
    if (inline.outcome !== "enqueued" || !inline.jobId) {
      throw new Error(`inline reply was not queued: ${JSON.stringify(inline)}`);
    }
    if (
      findReplyRequest("acme/widgets", "review_comment", "101")
        ?.target_comment_id !== "comment-bot"
    ) {
      throw new Error("inline reply did not retain its thread target");
    }

    const unrelated = dispatchGithubEvent(
      "issue_comment",
      {
        action: "created",
        comment: {
          id: 103,
          body: "This is a normal PR comment.",
          user: { login: "octocat", type: "User" },
        },
        issue: { number: 3, pull_request: { url: "pr" } },
        repository: { full_name: "acme/widgets" },
      },
      "reply-ignored",
    );
    if (unrelated.reason !== "no-app-mention") {
      throw new Error(
        `unrelated comment was queued: ${JSON.stringify(unrelated)}`,
      );
    }

    const mention = dispatchGithubEvent(
      "issue_comment",
      {
        action: "created",
        comment: {
          id: 102,
          body: "@co-maintainer can you clarify this?",
          user: { login: "octocat", type: "User" },
        },
        issue: { number: 3, pull_request: { url: "pr" } },
        installation: { app_slug: "co-maintainer-beta" },
        repository: { full_name: "acme/widgets" },
      },
      "reply-2",
    );
    if (mention.outcome !== "enqueued" || !mention.jobId) {
      throw new Error(`mention was not queued: ${JSON.stringify(mention)}`);
    }
  });
});
