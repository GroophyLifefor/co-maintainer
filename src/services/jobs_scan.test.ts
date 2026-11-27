/** What one pass of the scheduler asks the database, with a long queue.
 *
 * A review that the budget holds back must not cost a query per queued job on
 * every pass: with thousands queued that kept the process busy for as long as
 * the budget was out. The count of statements is what is asserted, because a
 * timing would depend on the machine. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeAppDb, getAppDb, openAppDb } from "../store/app_db.ts";
import { insertJob, getJob } from "../store/jobs.ts";
import { activateRepo } from "../store/repos.ts";
import { noteRateLimit, resetBudgetsForTest } from "../github/budget.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";
import { claimNextEligible, registerHandler } from "./jobs.ts";

isolateTestFile();

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
}

const RESET = Math.floor(Date.now() / 1000) + 3600;
const limits = (remaining: number, reset = RESET) =>
  new Headers({
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(reset),
    "x-ratelimit-resource": "core",
  });

/** Counts the statements prepared while `run` goes. */
function countStatements<T>(run: () => T): { result: T; count: number } {
  const db = getAppDb() as unknown as {
    prepare: (...args: unknown[]) => unknown;
  };
  const original = db.prepare.bind(db);
  let count = 0;
  db.prepare = (...args: unknown[]) => {
    count++;
    return original(...args);
  };
  try {
    const result = run();
    return { result, count };
  } finally {
    db.prepare = original;
  }
}

function queueReviews(repo: string, from: number, count: number): void {
  for (let i = from; i < from + count; i++) {
    insertJob({
      id: `${repo}-${i}`,
      type: "review",
      repo,
      prNumber: i,
      args: { trigger: "pull_request" },
      deliveryId: `${repo}-d${i}`,
      queueKey: `${repo}#${i}`,
    });
  }
}

test("a pass held back by the budget asks the database a few things, not one per queued job", async () => {
  registerHandler("review", { run: async () => {} });
  await withTempDb(async () => {
    resetBudgetsForTest();
    activateRepo("blocked/repo", 11);
    queueReviews("blocked/repo", 0, 2000);
    // Nothing left: no review of installation 11 may start.
    noteRateLimit(11, limits(0));
    const first = countStatements(() => claimNextEligible(1_000));
    assert.equal(first.result, undefined);
    assert.ok(first.count < 40, `the pass prepared ${first.count} statements`);
    // The next passes know nothing has changed and ask almost nothing.
    const again = countStatements(() => claimNextEligible(1_100));
    assert.equal(again.result, undefined);
    assert.ok(again.count <= 4, `a repeated pass prepared ${again.count}`);
    assert.equal(getJob("blocked/repo-0")?.status, "queued");
  });
});

test("another installation's review starts while one is held back, the oldest first", async () => {
  registerHandler("review", { run: async () => {} });
  await withTempDb(async () => {
    resetBudgetsForTest();
    activateRepo("blocked/repo", 11);
    activateRepo("free/repo", 22);
    queueReviews("blocked/repo", 0, 300);
    queueReviews("free/repo", 0, 3);
    noteRateLimit(11, limits(0));
    const claimed = claimNextEligible(1_000);
    assert.equal(claimed?.repo, "free/repo");
    assert.equal(claimed?.id, "free/repo-0");
    assert.equal(claimNextEligible(1_050)?.id, "free/repo-1");
  });
});

test("a job that arrives, a new hour and a review that ends each end the hold at once", async () => {
  registerHandler("review", { run: async () => {} });
  await withTempDb(async () => {
    resetBudgetsForTest();
    activateRepo("blocked/repo", 11);
    queueReviews("blocked/repo", 0, 50);
    noteRateLimit(11, limits(0));
    assert.equal(claimNextEligible(1_000), undefined);
    assert.equal(claimNextEligible(1_100), undefined, "held");
    // A job of another installation arrives.
    activateRepo("free/repo", 22);
    queueReviews("free/repo", 0, 1);
    assert.equal(claimNextEligible(1_200)?.repo, "free/repo");
    // A new hour with budget again.
    noteRateLimit(11, limits(4990, RESET + 3600));
    assert.equal(claimNextEligible(1_300)?.repo, "blocked/repo");
  });
});
