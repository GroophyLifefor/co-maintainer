import { test } from "node:test";
import { readConfig } from "../../config.ts";
import { createSession, verifySession } from "../../server/auth.ts";
import { appDbPath, closeAppDb, openAppDb } from "../../store/app_db.ts";
import { verifyPasswordHash } from "../../util/password.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../../testing/runtime.ts";
import { runSet } from "./set.ts";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

async function withSandbox(fn: () => Promise<void>): Promise<void> {
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const originalDb = getEnv("CM_APP_DB");
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  try {
    await fn();
  } finally {
    await closeAppDb();
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
    await removePath(dir, { recursive: true }).catch(() => {});
  }
}

test("set --password works while a serve holds app.db and signs out older sessions", async () => {
  await withSandbox(async () => {
    await openAppDb();
    const before = await createSession();
    await closeAppDb();
    // The parent (the test runner) is alive and is not this process, so the
    // lock reads as a running serve, the way the cloud's `docker exec` sees it.
    await writeTextFile(`${appDbPath()}.lock`, String(process.ppid));

    await runSet(["--password=a-new-password"]);

    const config = readConfig();
    if (
      !config.dashboardPasswordHash ||
      !(await verifyPasswordHash(
        "a-new-password",
        config.dashboardPasswordHash,
      ))
    ) {
      throw new Error("the new password was not saved");
    }
    if (!config.credentialsChangedAt) {
      throw new Error("the credential change time was not saved");
    }

    await writeTextFile(`${appDbPath()}.lock`, "999999999");
    await openAppDb();
    if (await verifySession(before.token)) {
      throw new Error("a session from before the change still signs in");
    }
    const after = await createSession();
    if (!(await verifySession(after.token))) {
      throw new Error("a session from after the change was refused");
    }
  });
});

test("set without a credential leaves existing sessions alone", async () => {
  await withSandbox(async () => {
    await runSet(["--review-blocking=model"]);
    if (readConfig().credentialsChangedAt !== undefined) {
      throw new Error("a non-credential setting recorded a credential change");
    }
  });
});
