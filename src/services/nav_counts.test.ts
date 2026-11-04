import { navCounts } from "./nav_counts.ts";
import { listReposForHome } from "./dashboard.ts";
import { closeAppDb, getAppDb, openAppDb } from "../store/app_db.ts";
import { writeUserConfig } from "../config.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { insertReview, setReviewStatus } from "../store/reviews.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { test } from "node:test";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
  }
}

function failedReview(id: string, repo: string, daysAgo = 0): void {
  insertReview({
    id,
    repo,
    prNumber: 7,
    jobId: `job-${id}`,
    headSha: "h",
    baseSha: "b",
    scope: "full",
    model: "m",
  });
  setReviewStatus(id, "failed", {});
  if (daysAgo > 0) {
    getAppDb()
      .prepare(`UPDATE reviews SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - daysAgo * 86_400_000).toISOString(), id);
  }
}

test("a fresh install counts nothing and shows setup progress", async () => {
  await withEnv(async () => {
    const counts = navCounts("");
    if (counts.repos !== 0 || counts.failed !== 0 || counts.setup !== "1/4") {
      throw new Error(JSON.stringify(counts));
    }
  });
});

test("the counts match the repository list and its 30 day failed column", async () => {
  await withEnv(async () => {
    activateRepo("acme/widgets", 9);
    markKnowledgeBuilt("acme/widgets", "abc");
    activateRepo("acme/gadgets", 9);
    failedReview("r1", "acme/widgets");
    failedReview("r2", "acme/gadgets");
    // Outside the 30 day window of the list, so not counted.
    failedReview("r3", "acme/widgets", 40);
    const counts = navCounts("");
    const rows = listReposForHome();
    const listFailed = rows.reduce((sum, row) => sum + row.stats.failed, 0);
    if (counts.repos !== rows.length || counts.repos !== 2) {
      throw new Error(`repos ${counts.repos}, list ${rows.length}`);
    }
    if (counts.failed !== listFailed || counts.failed !== 2) {
      throw new Error(`failed ${counts.failed}, list ${listFailed}`);
    }
    if (counts.setup !== "2/4") throw new Error(`setup ${counts.setup}`);
  });
});
