import { createApp } from "../app.ts";
import { hmacSha256Hex } from "./signature.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import {
  activateRepo,
  markKnowledgeBuilt,
  updateRepoSettings,
} from "../../store/repos.ts";
import { hasDelivery, listSkipped } from "../../store/deliveries.ts";
import { getQueuedJob } from "../../store/jobs.ts";
import { findReplyRequest } from "../../store/replies.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "webhook-test";
const SECRET = "webhook-secret";

async function withTempEnv(fn: () => Promise<void>): Promise<void> {
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const originalDb = getEnv("CM_APP_DB");
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
  }
}

function prBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: "opened",
    number: 11,
    pull_request: {
      number: 11,
      draft: false,
      user: { login: "octocat", type: "User" },
      additions: 8,
      deletions: 1,
      changed_files: 1,
    },
    repository: { full_name: "acme/widgets" },
    ...overrides,
  });
}

async function signedRequest(
  body: string,
  extra: Record<string, string> = {},
  secret = SECRET,
): Promise<Request> {
  const bytes = new TextEncoder().encode(body);
  const hex = await hmacSha256Hex(secret, bytes);
  return new Request("http://localhost/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": extra["x-github-delivery"] ?? crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${hex}`,
      ...extra,
    },
    body,
  });
}

test("POST /github/webhook rejects a bad HMAC when a secret is configured", async () => {
  await withTempEnv(async () => {
    const app = createApp({ password: PASSWORD, webhookSecret: SECRET });
    const response = await app.fetch(
      await signedRequest(prBody(), {}, "wrong-secret"),
    );
    if (response.status !== 401) {
      throw new Error(`expected 401, got ${response.status}`);
    }
  });
});

test("POST /github/webhook does not need a session or CSRF header", async () => {
  await withTempEnv(async () => {
    activateRepo("acme/widgets", 1);
    markKnowledgeBuilt("acme/widgets", "sha");
    const app = createApp({ password: PASSWORD });
    const body = prBody();
    const response = await app.fetch(
      new Request("http://localhost/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "del-open-1",
        },
        body,
      }),
    );
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const result = await response.json();
    if (result.outcome !== "enqueued" || !result.jobId) {
      throw new Error(`expected enqueue, got ${JSON.stringify(result)}`);
    }
    if (!getQueuedJob("acme/widgets", 11)) {
      throw new Error("no queued review job");
    }
  });
});

test("a duplicate x-github-delivery returns duplicate and does not create a second job", async () => {
  await withTempEnv(async () => {
    activateRepo("acme/widgets", 1);
    markKnowledgeBuilt("acme/widgets", "sha");
    const app = createApp({ password: PASSWORD, webhookSecret: SECRET });
    const body = prBody();
    const first = await app.fetch(
      await signedRequest(body, { "x-github-delivery": "same-id" }),
    );
    const second = await app.fetch(
      await signedRequest(body, { "x-github-delivery": "same-id" }),
    );
    if (first.status !== 200 || second.status !== 200) {
      throw new Error(`statuses ${first.status} ${second.status}`);
    }
    const firstBody = await first.json();
    const secondBody = await second.json();
    if (firstBody.outcome !== "enqueued") {
      throw new Error(`first: ${JSON.stringify(firstBody)}`);
    }
    if (secondBody.outcome !== "duplicate") {
      throw new Error(`second: ${JSON.stringify(secondBody)}`);
    }
    if (!hasDelivery("same-id")) throw new Error("delivery was not recorded");
  });
});

test("a draft pull request is recorded as skipped, not enqueued", async () => {
  await withTempEnv(async () => {
    activateRepo("acme/widgets", 1);
    markKnowledgeBuilt("acme/widgets", "sha");
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      new Request("http://localhost/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "del-draft",
        },
        body: prBody({
          pull_request: {
            number: 11,
            draft: true,
            user: { login: "octocat", type: "User" },
            additions: 8,
            deletions: 1,
            changed_files: 1,
          },
        }),
      }),
    );
    const result = await response.json();
    if (result.outcome !== "skipped" || result.reason !== "draft") {
      throw new Error(`expected skipped draft, got ${JSON.stringify(result)}`);
    }
    if (getQueuedJob("acme/widgets", 11)) {
      throw new Error("a draft was enqueued");
    }
    const skipped = listSkipped("acme/widgets");
    if (skipped.length !== 1 || skipped[0].reason !== "draft") {
      throw new Error("skip was not visible on the deliveries listing");
    }
  });
});

test("unparseable JSON is 400 and a missing delivery header is 400", async () => {
  await withTempEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const badJson = await app.fetch(
      new Request("http://localhost/github/webhook", {
        method: "POST",
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "del-bad",
        },
        body: "not-json",
      }),
    );
    if (badJson.status !== 400) {
      throw new Error(`bad json status ${badJson.status}`);
    }
    const missing = await app.fetch(
      new Request("http://localhost/github/webhook", {
        method: "POST",
        body: "{}",
      }),
    );
    if (missing.status !== 400) {
      throw new Error(`missing header status ${missing.status}`);
    }
  });
});

test("a PR mention enqueues a conversation reply job", async () => {
  await withTempEnv(async () => {
    activateRepo("acme/widgets", 1);
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      new Request("http://localhost/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issue_comment",
          "x-github-delivery": "del-reply",
        },
        body: JSON.stringify({
          action: "created",
          repository: { full_name: "acme/widgets" },
          issue: { number: 11, pull_request: { url: "pr" } },
          comment: {
            id: 501,
            body: "@co-maintainer why is this blocking?",
            user: { login: "octocat", type: "User" },
          },
        }),
      }),
    );
    const result = await response.json();
    if (result.outcome !== "enqueued" || !result.jobId) {
      throw new Error(`expected reply enqueue, got ${JSON.stringify(result)}`);
    }
    if (!findReplyRequest("acme/widgets", "issue_comment", "501")) {
      throw new Error("reply request was not persisted");
    }
  });
});

test("auto-review-off is skipped when the repo setting is off", async () => {
  await withTempEnv(async () => {
    activateRepo("acme/widgets", 1);
    updateRepoSettings("acme/widgets", { auto_review: 0 });
    markKnowledgeBuilt("acme/widgets", "sha");
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      new Request("http://localhost/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "del-off",
        },
        body: prBody(),
      }),
    );
    const result = await response.json();
    if (result.reason !== "auto-review-off") {
      throw new Error(
        `expected auto-review-off, got ${JSON.stringify(result)}`,
      );
    }
  });
});
