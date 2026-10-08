/** Review policies through the webhook. Real app.db, realistic
 * payloads, no mocks: the engine's own tables are in review_policy.test.ts. */
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { writeUserConfig } from "../config.ts";
import {
  activateRepo,
  markKnowledgeBuilt,
  updateRepoSettings,
} from "../store/repos.ts";
import { getJob } from "../store/jobs.ts";
import { insertReview, setReviewStatus } from "../store/reviews.ts";
import { dispatchGithubEvent, requestedReviewBlocked } from "./webhook.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { test } from "node:test";

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const original = getEnv("CM_APP_DB");
  const originalConfig = getEnv("CM_CONFIG_PATH");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  // A repository with no stored policy reads the server default from the
  // config, so the tests must not see the developer's own config.json.
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
  }
}

function readyRepo(fullName = "acme/widgets"): void {
  activateRepo(fullName, 1);
  markKnowledgeBuilt(fullName, "abc123");
}

const MEMBER = "MEMBER";
const NEWCOMER = "FIRST_TIME_CONTRIBUTOR";

function setPolicy(value: unknown, repo = "acme/widgets"): void {
  updateRepoSettings(repo, { review_policy_json: JSON.stringify(value) });
}

function policyPayload(
  action: string,
  pr: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    number: 7,
    pull_request: {
      number: 7,
      draft: false,
      user: { login: "octocat", type: "User" },
      author_association: MEMBER,
      additions: 4,
      deletions: 1,
      changed_files: 1,
      head: { sha: "h1", repo: { full_name: "acme/widgets" } },
      base: { ref: "main" },
      labels: [],
      ...pr,
    },
    repository: { full_name: "acme/widgets" },
    ...extra,
  };
}

function commentPayload(body: string, association: string, id = 900) {
  return {
    action: "created",
    issue: {
      number: 7,
      pull_request: { url: "https://api.github.com/x" },
      user: { login: "octocat", type: "User" },
      author_association: NEWCOMER,
      draft: false,
      labels: [],
    },
    comment: {
      id,
      body,
      user: { login: "maintainer", type: "User" },
      author_association: association,
    },
    repository: { full_name: "acme/widgets" },
  };
}

function jobArgs(jobId: string | undefined): Record<string, unknown> {
  const job = jobId ? getJob(jobId) : undefined;
  if (!job) throw new Error("no job");
  return JSON.parse(job.args) as Record<string, unknown>;
}

function wake(deliveryId: string, sha: string) {
  return dispatchGithubEvent(
    "pull_request_review",
    {
      action: "submitted",
      review: { user: { login: "octocat", type: "User" } },
      pull_request: {
        number: 7,
        draft: false,
        author_association: NEWCOMER,
        changed_files: 1,
        additions: 1,
        deletions: 0,
        head: { sha, repo: { full_name: "acme/widgets" } },
        base: { ref: "main" },
      },
      repository: { full_name: "acme/widgets" },
    },
    deliveryId,
  );
}

function postedReview(id: string, head: string, round = 1): void {
  insertReview({
    id,
    repo: "acme/widgets",
    prNumber: 7,
    jobId: `job-${id}`,
    headSha: head,
    baseSha: "base",
    scope: "whole-pr",
    model: "fake",
    round,
  });
  setReviewStatus(id, "posted");
}

test("trusted-auto reviews a member and holds a first time contributor", async () => {
  await withTempDb(() => {
    readyRepo();
    setPolicy("trusted-auto");
    const member = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened"),
      "p-1",
    );
    if (member.outcome !== "enqueued") throw new Error(JSON.stringify(member));
    const newcomer = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened", { author_association: NEWCOMER }),
      "p-2",
    );
    if (
      newcomer.outcome !== "skipped" ||
      newcomer.reason !== "Default rule: waiting for a maintainer request."
    ) {
      throw new Error(JSON.stringify(newcomer));
    }
  });
});

test("a skipped pull request names the rule that skipped it", async () => {
  await withTempDb(() => {
    readyRepo();
    setPolicy({
      rules: [
        { when: { draft: true }, action: "skip" },
        {
          name: "first time contributor",
          when: { association: [NEWCOMER] },
          action: "on-request",
        },
      ],
      default: "review",
    });
    const result = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened", { author_association: NEWCOMER }),
      "p-3",
    );
    if (
      result.reason !==
      "Rule 2 (first time contributor): waiting for a maintainer request."
    ) {
      throw new Error(JSON.stringify(result));
    }
  });
});

test("a fork rule reads the head repository and the target branch", async () => {
  await withTempDb(() => {
    readyRepo();
    setPolicy({
      rules: [
        { name: "fork", when: { fork: true }, action: "skip" },
        {
          name: "release",
          when: { targetBranch: ["release"] },
          action: "skip",
        },
      ],
      default: "review",
    });
    const own = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened"),
      "f-1",
    );
    if (own.outcome !== "enqueued") throw new Error(JSON.stringify(own));
    const fork = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened", {
        head: { sha: "h2", repo: { full_name: "stranger/widgets" } },
      }),
      "f-2",
    );
    if (!fork.reason?.startsWith("Rule 1 (fork)")) {
      throw new Error(JSON.stringify(fork));
    }
    const deleted = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened", { head: { sha: "h3", repo: null } }),
      "f-3",
    );
    if (!deleted.reason?.startsWith("Rule 1 (fork)")) {
      throw new Error(`a deleted fork is a fork: ${JSON.stringify(deleted)}`);
    }
    const release = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened", { base: { ref: "release" } }),
      "f-4",
    );
    if (!release.reason?.startsWith("Rule 2 (release)")) {
      throw new Error(JSON.stringify(release));
    }
  });
});

test("the request label starts a review on a pull request waiting for one", async () => {
  await withTempDb(() => {
    readyRepo();
    setPolicy("on-request-only");
    const waiting = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened"),
      "l-1",
    );
    if (waiting.outcome !== "skipped") throw new Error(JSON.stringify(waiting));

    const other = dispatchGithubEvent(
      "pull_request",
      policyPayload("labeled", {}, { label: { name: "bug" } }),
      "l-2",
    );
    if (other.outcome !== "ignored") {
      throw new Error(`another label is ignored: ${JSON.stringify(other)}`);
    }

    const asked = dispatchGithubEvent(
      "pull_request",
      policyPayload("labeled", {}, { label: { name: "Co-Maintainer:Review" } }),
      "l-3",
    );
    if (asked.outcome !== "enqueued") throw new Error(JSON.stringify(asked));
    const args = jobArgs(asked.jobId);
    if (
      args.trigger !== "request-label" ||
      args.requestReaction !== "repos/acme/widgets/issues/7/reactions"
    ) {
      throw new Error(JSON.stringify(args));
    }
  });
});

test("a request comment needs an allowed author and starts the review", async () => {
  await withTempDb(() => {
    readyRepo();
    setPolicy("on-request-only");
    const allowed = dispatchGithubEvent(
      "issue_comment",
      commentPayload("/co-maintainer review", "COLLABORATOR"),
      "c-1",
    );
    if (allowed.outcome !== "enqueued") {
      throw new Error(JSON.stringify(allowed));
    }
    const args = jobArgs(allowed.jobId);
    if (
      args.trigger !== "request-comment" ||
      args.requestReaction !==
        "repos/acme/widgets/issues/comments/900/reactions"
    ) {
      throw new Error(JSON.stringify(args));
    }

    const stranger = dispatchGithubEvent(
      "issue_comment",
      commentPayload("/co-maintainer review", "NONE", 901),
      "c-2",
    );
    if (
      stranger.outcome !== "skipped" ||
      !stranger.reason?.startsWith("Not allowed to request a review: NONE")
    ) {
      throw new Error(JSON.stringify(stranger));
    }

    const chatter = dispatchGithubEvent(
      "issue_comment",
      commentPayload("thanks, please /co-maintainer review later", MEMBER, 902),
      "c-3",
    );
    if (chatter.outcome !== "ignored") {
      throw new Error(
        `only a leading command counts: ${JSON.stringify(chatter)}`,
      );
    }
  });
});

test("a policy that skips a pull request cannot be overridden by a request comment", async () => {
  await withTempDb(() => {
    readyRepo();
    setPolicy({
      rules: [
        { name: "newcomer", when: { association: [NEWCOMER] }, action: "skip" },
      ],
      default: "on-request",
    });
    const result = dispatchGithubEvent(
      "issue_comment",
      commentPayload("/co-maintainer review", "OWNER"),
      "s-1",
    );
    if (
      result.outcome !== "skipped" ||
      !result.reason?.startsWith("Rule 1 (newcomer)")
    ) {
      throw new Error(JSON.stringify(result));
    }
  });
});

test("activity on a pull request waiting for a request does not start a review", async () => {
  await withTempDb(() => {
    readyRepo();
    setPolicy("on-request-only");
    const first = wake("w-1", "h1");
    if (first.outcome !== "skipped") throw new Error(JSON.stringify(first));
  });
});

test("the head scope wants a new request per commit, the pull-request scope carries one", async () => {
  await withTempDb(() => {
    readyRepo();
    postedReview("rev-1", "h1");

    setPolicy({ default: "on-request", approvalScope: "head" });
    const head = wake("w-2", "h2");
    if (head.outcome !== "skipped") {
      throw new Error(`head scope must not carry: ${JSON.stringify(head)}`);
    }
    const push = dispatchGithubEvent(
      "pull_request",
      policyPayload("synchronize", { author_association: NEWCOMER }),
      "w-3",
    );
    if (push.outcome !== "skipped") {
      throw new Error(`a push needs a new request: ${JSON.stringify(push)}`);
    }

    setPolicy({ default: "on-request", approvalScope: "pull-request" });
    const carried = dispatchGithubEvent(
      "pull_request",
      policyPayload("synchronize", { author_association: NEWCOMER }),
      "w-4",
    );
    if (carried.outcome !== "enqueued") {
      throw new Error(`pull-request scope carries: ${JSON.stringify(carried)}`);
    }
  });
});

test("the round limit stops the webhook and leaves everything below it alone", async () => {
  await withTempDb(() => {
    readyRepo();
    setPolicy({ default: "review", maxRounds: 2 });
    postedReview("rev-1", "h1", 1);
    const below = dispatchGithubEvent(
      "pull_request",
      policyPayload("synchronize"),
      "r-1",
    );
    if (below.outcome !== "enqueued") throw new Error(JSON.stringify(below));

    postedReview("rev-2", "h2", 2);
    const reached = dispatchGithubEvent(
      "pull_request",
      policyPayload("synchronize", {
        head: { sha: "h3", repo: { full_name: "acme/widgets" } },
      }),
      "r-2",
    );
    if (
      reached.outcome !== "skipped" ||
      reached.reason !== "Round limit reached: 2 of 2 reviews."
    ) {
      throw new Error(JSON.stringify(reached));
    }
    const asked = dispatchGithubEvent(
      "issue_comment",
      commentPayload("/co-maintainer review", MEMBER, 903),
      "r-3",
    );
    if (asked.outcome !== "skipped") {
      throw new Error(
        `a request obeys the limit too: ${JSON.stringify(asked)}`,
      );
    }
  });
});

test("a repository without its own policy takes the server default, a pinned one keeps its switches", async () => {
  await withTempDb(async () => {
    readyRepo("acme/widgets");
    readyRepo("acme/pinned");
    updateRepoSettings("acme/pinned", { review_policy_json: '"legacy"' });
    await writeUserConfig({ reviewPolicy: "on-request-only" });

    const inherits = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened"),
      "d-1",
    );
    if (inherits.outcome !== "skipped") {
      throw new Error(JSON.stringify(inherits));
    }
    const pinned = dispatchGithubEvent(
      "pull_request",
      {
        ...policyPayload("opened"),
        repository: { full_name: "acme/pinned" },
      },
      "d-2",
    );
    if (pinned.outcome !== "enqueued") throw new Error(JSON.stringify(pinned));
  });
});

test("a stored policy that no longer parses falls back to the switches", async () => {
  await withTempDb(() => {
    readyRepo();
    updateRepoSettings("acme/widgets", { review_policy_json: "{not json" });
    const broken = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened"),
      "b-1",
    );
    if (broken.outcome !== "enqueued") throw new Error(JSON.stringify(broken));
    setPolicy({ default: "maybe" });
    const invalid = dispatchGithubEvent(
      "pull_request",
      policyPayload("opened"),
      "b-2",
    );
    if (invalid.outcome !== "enqueued") {
      throw new Error(JSON.stringify(invalid));
    }
  });
});

test("a comment request is checked again against the fetched pull request", async () => {
  await withTempDb(async () => {
    readyRepo();
    setPolicy({
      rules: [{ name: "fork", when: { fork: true }, action: "skip" }],
      default: "on-request",
    });
    await writeUserConfig({ defaults: { maxPullRequestChangeLines: 5000 } });
    // The comment itself is accepted: an issue payload has no fork or size.
    const asked = dispatchGithubEvent(
      "issue_comment",
      commentPayload("/co-maintainer review", MEMBER),
      "c-1",
    );
    if (asked.outcome !== "enqueued") throw new Error(JSON.stringify(asked));

    const pr = policyPayload("opened").pull_request;
    if (requestedReviewBlocked("acme/widgets", pr) !== undefined) {
      throw new Error("a small pull request from the repo itself was blocked");
    }
    const fork = requestedReviewBlocked("acme/widgets", {
      ...pr,
      head: { sha: "h1", repo: { full_name: "outsider/widgets" } },
    });
    if (!fork?.startsWith("Rule 1 (fork)")) throw new Error(String(fork));
    const huge = requestedReviewBlocked("acme/widgets", {
      ...pr,
      additions: 90_000,
    });
    if (huge !== "diff-too-large") throw new Error(String(huge));
  });
});
