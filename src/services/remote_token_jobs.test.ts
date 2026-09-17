import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { getJob, insertJob } from "../store/jobs.ts";
import { getAppDb } from "../store/app_db.ts";
import {
  getReviewByJobId,
  insertRemoteReview,
  listRemoteReviewsForRepo,
} from "../store/reviews.ts";
import { insertRemoteToken } from "../store/remote_tokens.ts";
import { cancel } from "./jobs.ts";
import { cancelRemoteJobsForToken } from "./remote_token_jobs.ts";

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

Deno.test("cancelRemoteJobsForToken marks queued remote review aborted", async () => {
  await withTempDb(async () => {
    insertRemoteToken("tok", "laptop", "hash");
    insertRemoteReview({
      id: "rev-1",
      subjectId: "sub-1",
      repo: "o/r",
      branch: "main",
      tokenId: "tok",
      tokenName: "laptop",
      jobId: "job-1",
      scope: "remote",
      model: "test",
    });
    insertJob({
      id: "job-1",
      type: "remote_review",
      repo: "o/r",
      queueKey: "remote:o/r:main:tok",
    });
    cancelRemoteJobsForToken("tok", "token_deactivated");
    if (getJob("job-1")?.status !== "canceled") {
      throw new Error("job should be canceled");
    }
    const review = getReviewByJobId("job-1");
    if (review?.status !== "aborted") {
      throw new Error(`review should be aborted, got ${review?.status}`);
    }
  });
});

Deno.test("listRemoteReviewsForRepo respects sinceIso", async () => {
  await withTempDb(async () => {
    insertRemoteReview({
      id: "rev-old",
      subjectId: "s",
      repo: "o/r",
      branch: "main",
      tokenId: "t",
      tokenName: "n",
      jobId: "job-old",
      scope: "remote",
      model: "m",
    });
    getAppDb().prepare(
      `UPDATE reviews SET created_at = ? WHERE id = ?`,
    ).run("2020-01-01T00:00:00.000Z", "rev-old");
    insertRemoteReview({
      id: "rev-new",
      subjectId: "s",
      repo: "o/r",
      branch: "main",
      tokenId: "t",
      tokenName: "n",
      jobId: "job-new",
      scope: "remote",
      model: "m",
    });
    const since = "2026-01-01T00:00:00.000Z";
    const items = listRemoteReviewsForRepo("o/r", 10, 0, since);
    if (items.length !== 1 || items[0].id !== "rev-new") {
      throw new Error(`expected only rev-new, got ${items.map((r) => r.id)}`);
    }
  });
});

Deno.test("cancel() on queued remote review aborts the review row", async () => {
  await withTempDb(async () => {
    insertRemoteReview({
      id: "rev-2",
      subjectId: "sub-2",
      repo: "o/r",
      branch: "dev",
      tokenId: "tok2",
      tokenName: "x",
      jobId: "job-2",
      scope: "remote",
      model: "test",
    });
    insertJob({
      id: "job-2",
      type: "remote_review",
      repo: "o/r",
      queueKey: "remote:o/r:dev:tok2",
    });
    if (!cancel("job-2")) throw new Error("cancel failed");
    if (getReviewByJobId("job-2")?.status !== "aborted") {
      throw new Error("review row should be aborted");
    }
  });
});
