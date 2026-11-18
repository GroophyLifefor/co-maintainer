import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedHome } from "../../testing/isolated_home.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { activateRepo, getRepo, setDefaultBranch } from "../../store/repos.ts";
import { defaultBranchForRepo } from "./routes.ts";

test("the default branch is read from the repository row, not from git", async () => {
  await withIsolatedHome(async () => {
    await openAppDb();
    try {
      activateRepo("acme/widgets", 1);
      // No clone exists, so git could not answer. The stored name must win.
      assert.equal(await defaultBranchForRepo("acme/widgets"), null);
      setDefaultBranch("acme/widgets", "trunk");
      assert.equal(await defaultBranchForRepo("acme/widgets"), "trunk");
    } finally {
      await closeAppDb();
    }
  });
});

test("a blank branch name never replaces a stored one", async () => {
  await withIsolatedHome(async () => {
    await openAppDb();
    try {
      activateRepo("acme/widgets", 1);
      setDefaultBranch("acme/widgets", "main");
      setDefaultBranch("acme/widgets", "  ");
      assert.equal(getRepo("acme/widgets")?.default_branch, "main");
    } finally {
      await closeAppDb();
    }
  });
});
