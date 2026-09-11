/** Exercises every store module against a real (temp-file) app.db — the
 * schema and the query layer together. */
import { closeAppDb, openAppDb } from "./app_db.ts";
import {
  getInstallation,
  listInstallations,
  markInstallationRemoved,
  markInstallationSuspended,
  upsertInstallation,
} from "./installations.ts";
import {
  activateRepo,
  deactivateRepo,
  getRepo,
  listActiveRepos,
  markKnowledgeBuilt,
  updateRepoSettings,
} from "./repos.ts";
import {
  getJob,
  getQueuedJob,
  insertJob,
  listJobs,
  setJobStatus,
} from "./jobs.ts";
import { appendLog, listLogs } from "./job_logs.ts";
import {
  getReview,
  insertReview,
  listReviewsForPr,
  setReviewStatus,
} from "./reviews.ts";
import {
  insertFinding,
  listFindingsForReview,
  setFindingPosted,
} from "./findings.ts";
import { hasDelivery, listSkipped, recordDelivery } from "./deliveries.ts";
import {
  deleteExpiredSessions,
  deleteSession,
  getSession,
  insertSession,
} from "./sessions.ts";
import { getDrift, upsertDrift } from "./drift.ts";

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

Deno.test("installations: upsert, suspend, remove round-trip", async () => {
  await withTempDb(() => {
    upsertInstallation({
      id: 1,
      account_login: "acme",
      account_type: "Organization",
      permissions: { pull_requests: "write" },
      events: ["pull_request"],
    });
    if (getInstallation(1)?.account_login !== "acme") {
      throw new Error("installation was not stored");
    }
    if (listInstallations().length !== 1) throw new Error("listing missed it");
    markInstallationSuspended(1, true);
    if (!getInstallation(1)?.suspended_at) {
      throw new Error("suspend did not stick");
    }
    markInstallationRemoved(1);
    if (!getInstallation(1)?.removed_at) {
      throw new Error("removal did not stick");
    }
  });
});

Deno.test("repos: activate, settings patch, deactivate, drift", async () => {
  await withTempDb(() => {
    activateRepo("acme/widgets", 1);
    if (!getRepo("acme/widgets")?.active) throw new Error("repo not active");
    if (getRepo("acme/widgets")?.auto_review !== 1) {
      throw new Error("activate should turn auto-review on");
    }
    if (listActiveRepos().length !== 1) throw new Error("listing missed it");
    updateRepoSettings("acme/widgets", { auto_review: 0 });
    if (getRepo("acme/widgets")?.auto_review !== 0) {
      throw new Error("settings patch did not stick");
    }
    markKnowledgeBuilt("acme/widgets", "deadbeef");
    if (getRepo("acme/widgets")?.knowledge_base_sha !== "deadbeef") {
      throw new Error("knowledge stamp did not stick");
    }
    deactivateRepo("acme/widgets");
    if (listActiveRepos().length !== 0) {
      throw new Error("deactivate did not remove it");
    }

    upsertDrift({
      repo: "acme/widgets",
      as_of: new Date().toISOString(),
      prs_since: 3,
      commits_since: 10,
      files_changed: 5,
    });
    if (getDrift("acme/widgets")?.prs_since !== 3) {
      throw new Error("drift was not stored");
    }
  });
});

Deno.test("jobs and job_logs: insert, transition, resumable log stream", async () => {
  await withTempDb(() => {
    insertJob({
      id: "job-1",
      type: "review",
      repo: "acme/widgets",
      prNumber: 5,
    });
    if (getJob("job-1")?.status !== "queued") throw new Error("not queued");
    if (getQueuedJob("acme/widgets", 5)?.id !== "job-1") {
      throw new Error("getQueuedJob did not find it");
    }
    setJobStatus("job-1", "running");
    if (!getJob("job-1")?.started_at) throw new Error("started_at not set");
    setJobStatus("job-1", "failed", { error: "boom" });
    const finished = getJob("job-1");
    if (finished?.status !== "failed" || finished.error !== "boom") {
      throw new Error("failure transition did not stick");
    }
    if (!finished.finished_at) throw new Error("finished_at not set");
    if (listJobs({ repo: "acme/widgets" }).length !== 1) {
      throw new Error("listJobs filter by repo failed");
    }

    const first = appendLog("job-1", "info", "starting");
    const second = appendLog("job-1", "info", "still going");
    if (first !== 1 || second !== 2) throw new Error("seq did not increment");
    if (listLogs("job-1").length !== 2) {
      throw new Error("listLogs missed a line");
    }
    if (listLogs("job-1", 1).length !== 1) {
      throw new Error(
        "resumable listLogs(fromSeq) did not skip the first line",
      );
    }
  });
});

Deno.test("reviews and findings: draft, post, list newest round first", async () => {
  await withTempDb(() => {
    insertReview({
      id: "rev-1",
      repo: "acme/widgets",
      prNumber: 5,
      jobId: "job-1",
      headSha: "h1",
      baseSha: "b1",
      scope: "whole-pr",
      model: "test-model",
    });
    if (getReview("rev-1")?.status !== "drafting") {
      throw new Error("not drafting");
    }
    setReviewStatus("rev-1", "posted", {
      posted_review_id: "gh-1",
      findings_count: 1,
    });
    const posted = getReview("rev-1");
    if (posted?.status !== "posted" || posted.posted_review_id !== "gh-1") {
      throw new Error("posted transition did not stick");
    }

    insertReview({
      id: "rev-2",
      repo: "acme/widgets",
      prNumber: 5,
      jobId: "job-2",
      headSha: "h2",
      baseSha: "h1",
      scope: "incremental",
      model: "test-model",
      round: 2,
    });
    const listed = listReviewsForPr("acme/widgets", 5);
    if (listed.length !== 2 || listed[0].id !== "rev-2") {
      throw new Error("reviews are not ordered newest round first");
    }

    insertFinding({
      id: "f-1",
      reviewId: "rev-1",
      severity: "P2",
      path: "src/a.ts",
      lineFrom: 10,
      title: "Example",
      bodyMd: "Body",
    });
    setFindingPosted("f-1", "comment-1");
    const findings = listFindingsForReview("rev-1");
    if (
      findings.length !== 1 || findings[0].posted_comment_id !== "comment-1"
    ) {
      throw new Error("finding was not stored or posted correctly");
    }
  });
});

Deno.test("deliveries: dedupe and the skipped listing", async () => {
  await withTempDb(() => {
    recordDelivery({
      deliveryId: "d-1",
      event: "pull_request",
      action: "opened",
      repo: "acme/widgets",
      outcome: "enqueued",
    });
    if (!hasDelivery("d-1")) throw new Error("delivery was not recorded");
    if (hasDelivery("d-2")) {
      throw new Error("false positive on an unseen delivery");
    }

    recordDelivery({
      deliveryId: "d-3",
      event: "pull_request",
      action: "opened",
      repo: "acme/widgets",
      outcome: "skipped",
      reason: "draft",
    });
    const skipped = listSkipped("acme/widgets");
    if (skipped.length !== 1 || skipped[0].reason !== "draft") {
      throw new Error("skipped listing did not surface the reason");
    }
  });
});

Deno.test("sessions: valid, expired, and deleted", async () => {
  await withTempDb(() => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    insertSession("hash-valid", "admin", future);
    insertSession("hash-expired", "admin", past);
    if (getSession("hash-valid")?.username !== "admin") {
      throw new Error("valid session was not returned");
    }
    if (getSession("hash-expired") !== undefined) {
      throw new Error("expired session was returned as valid");
    }
    deleteSession("hash-valid");
    if (getSession("hash-valid") !== undefined) {
      throw new Error("deleted session was still returned");
    }
    deleteExpiredSessions();
  });
});
