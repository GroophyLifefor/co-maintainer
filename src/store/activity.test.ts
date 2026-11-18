import { test } from "node:test";
import assert from "node:assert/strict";
import { closeAppDb, openAppDb } from "./app_db.ts";
import { activityStamp } from "./activity.ts";
import { insertJob, setJobStatus } from "./jobs.ts";
import { appendLog } from "./job_logs.ts";
import { recordDelivery } from "./deliveries.ts";
import { dismissFailures } from "./failures.ts";
import { insertReview } from "./reviews.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";
import { withDashboard } from "../testing/dashboard_pages.ts";

isolateTestFile();

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

test("the stamp moves on every change the Activity page shows, and only then", async () => {
  await withDb(async () => {
    const steps: [string, () => void][] = [
      [
        "a job is queued",
        () => insertJob({ id: "j1", type: "review", repo: "a/b", prNumber: 1 }),
      ],
      ["it starts", () => setJobStatus("j1", "running")],
      ["a running job logs", () => void appendLog("j1", "info", "working")],
      ["it fails", () => setJobStatus("j1", "failed", { error: "x" })],
      ["it is dismissed", () => void dismissFailures({ jobs: ["j1"] })],
      [
        "a delivery is skipped",
        () =>
          recordDelivery({
            deliveryId: "d1",
            event: "pull_request",
            repo: "a/b",
            prNumber: 2,
            outcome: "skipped",
            reason: "draft",
          }),
      ],
      [
        "a review is written",
        () =>
          insertReview({
            id: "r1",
            repo: "a/b",
            prNumber: 1,
            jobId: "j1",
            headSha: "h",
            baseSha: "b",
            scope: "whole-pr",
            model: "m",
          }),
      ],
    ];
    let before = activityStamp();
    assert.equal(activityStamp(), before, "the stamp moved with no change");
    for (const [name, step] of steps) {
      await tick();
      step();
      const after = activityStamp();
      assert.notEqual(after, before, `the stamp did not move when ${name}`);
      before = after;
    }
    // A log line of a finished job changes nothing on the list.
    appendLog("j1", "info", "late line");
    assert.equal(activityStamp(), before);
  });
});

test("the page carries the same stamp the poll endpoint answers", async () => {
  await withDashboard(async (get, send) => {
    const page = (await get("/activity")).html;
    const stamp = /id="activity-root" data-stamp="([^"]*)"/.exec(page)?.[1];
    const polled = await send("GET", "/api/activity/stamp");
    assert.equal(polled.status, 200);
    assert.equal(
      polled.json.stamp,
      stamp?.replace(/&#124;|&amp;/g, (m) => (m === "&amp;" ? "&" : "|")),
    );
  });
});
