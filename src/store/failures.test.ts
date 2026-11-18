import { test } from "node:test";
import { closeAppDb, getAppDb, openAppDb } from "./app_db.ts";
import {
  dismissAllFailures,
  dismissFailures,
  openFailureCount,
} from "./failures.ts";
import { insertReview, setReviewStatus } from "./reviews.ts";
import { getJob, insertJob, setJobStatus } from "./jobs.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

const SINCE = "2000-01-01T00:00:00.000Z";

async function withDb(fn: () => void | Promise<void>): Promise<void> {
  const original = getEnv("CM_APP_DB");
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
    await removePath(dir, { recursive: true }).catch(() => {});
  }
}

function review(id: string, jobId: string, pr: number, status: string): void {
  insertReview({
    id,
    repo: "acme/widgets",
    prNumber: pr,
    jobId,
    headSha: id,
    baseSha: "b",
    scope: "whole-pr",
    model: "m",
  });
  setReviewStatus(id, status, {});
}

function failedJob(id: string, pr: number): void {
  insertJob({ id, type: "review", repo: "acme/widgets", prNumber: pr });
  setJobStatus(id, "failed", { error: "boom" });
}

function seen(table: "jobs" | "reviews", id: string): string | null {
  return (
    getAppDb()
      .prepare<{
        seen_at: string | null;
      }>(`SELECT seen_at FROM ${table} WHERE id = ?`)
      .get(id)?.seen_at ?? null
  );
}

test("a failure counts until it is dismissed, and stays in the history", async () => {
  await withDb(() => {
    failedJob("j1", 7);
    review("r1", "j1", 7, "failed");
    failedJob("j2", 8);
    if (openFailureCount(SINCE) !== 2) {
      throw new Error(`expected 2, got ${openFailureCount(SINCE)}`);
    }
    dismissFailures({ jobs: ["j1"] });
    if (!seen("jobs", "j1") || !seen("reviews", "r1")) {
      throw new Error("dismissing a job must mark its review too");
    }
    if (openFailureCount(SINCE) !== 1) throw new Error("j2 still counts");
    if (getJob("j1")?.status !== "failed") {
      throw new Error("a dismissed failure keeps its row and status");
    }
  });
});

test("Dismiss all marks every failure of one repository or of all", async () => {
  await withDb(() => {
    failedJob("j1", 7);
    insertJob({ id: "j3", type: "review", repo: "acme/gadgets", prNumber: 1 });
    setJobStatus("j3", "failed", { error: "boom" });
    dismissAllFailures("acme/widgets");
    if (!seen("jobs", "j1") || seen("jobs", "j3")) {
      throw new Error("Dismiss all with a repository touched another one");
    }
    dismissAllFailures();
    if (openFailureCount(SINCE) !== 0) throw new Error("left one open");
  });
});

test("dismissing touches only failed rows", async () => {
  await withDb(() => {
    insertJob({ id: "ok", type: "review", repo: "acme/widgets", prNumber: 7 });
    setJobStatus("ok", "done");
    if (dismissFailures({ jobs: ["ok"] }) !== 0 || seen("jobs", "ok")) {
      throw new Error("a done job was marked as seen");
    }
  });
});

test("a posted review resolves the earlier failures of its pull request only", async () => {
  await withDb(() => {
    failedJob("j1", 7);
    review("r1", "j1", 7, "failed");
    failedJob("j2", 7);
    failedJob("j9", 9);
    review("r9", "j9", 9, "failed");
    insertJob({ id: "j3", type: "review", repo: "acme/widgets", prNumber: 7 });
    review("r3", "j3", 7, "posted");
    const resolved = (table: string, id: string) =>
      getAppDb()
        .prepare<{
          resolved_by: string | null;
        }>(`SELECT resolved_by FROM ${table} WHERE id = ?`)
        .get(id)?.resolved_by;
    if (resolved("reviews", "r1") !== "r3" || resolved("jobs", "j2") !== "r3") {
      throw new Error("the earlier failures of #7 were not resolved by r3");
    }
    if (resolved("reviews", "r9") || resolved("jobs", "j9")) {
      throw new Error("a review of #7 resolved a failure of #9");
    }
    if (openFailureCount(SINCE) !== 1) {
      throw new Error(`only #9 is open, got ${openFailureCount(SINCE)}`);
    }
  });
});
