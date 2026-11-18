import { test } from "node:test";
import assert from "node:assert/strict";
import { closeAppDb, getAppDb, openAppDb } from "./app_db.ts";
import { rememberPullTitle } from "./pull_titles.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

test("a pull request keeps its author when a later call names none", async () => {
  const original = getEnv("CM_APP_DB");
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  try {
    await openAppDb();
    const author = () =>
      getAppDb()
        .prepare<{ author: string | null }>(
          `SELECT author FROM pull_titles WHERE repo = ? AND pr_number = ?`,
        )
        .get("acme/widgets", 7)?.author;
    rememberPullTitle("acme/widgets", 7, "First title");
    assert.equal(author(), null);
    rememberPullTitle("acme/widgets", 7, "First title", "octocat");
    assert.equal(author(), "octocat");
    rememberPullTitle("acme/widgets", 7, "Second title");
    assert.equal(author(), "octocat");
  } finally {
    // The rest runs even when closing fails, so no state leaks into the
    // next test.
    try {
      await closeAppDb();
    } finally {
      if (original === undefined) deleteEnv("CM_APP_DB");
      else setEnv("CM_APP_DB", original);
      await removePath(dir, { recursive: true }).catch(() => {});
    }
  }
});
