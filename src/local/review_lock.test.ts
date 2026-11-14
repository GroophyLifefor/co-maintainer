/** A local review only ever removes its own lock.
 *
 * Ctrl-C releases the lock while the process may still be finishing. A review
 * started in that window writes its own PID to the same file, and the first
 * review's later release must not delete it. */
import { test } from "node:test";
import { acquireLocalReviewLock } from "./review_lock.ts";
import { locksDir } from "../config.ts";
import { offlineEnv } from "../testing/offline_env.ts";
import {
  readDir,
  readTextFile,
  removePath,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";

async function lockFile(): Promise<string | undefined> {
  for await (const entry of readDir(locksDir())) {
    return `${locksDir()}/${entry.name}`;
  }
  return undefined;
}

test("a release leaves a lock another review wrote in the meantime", async () => {
  const dir = await tempDir({ prefix: "cm-lock-" });
  const offline = offlineEnv(dir);
  try {
    const lock = await acquireLocalReviewLock(`${dir}/repo`);
    const path = await lockFile();
    if (!path) throw new Error("no lock written");
    // Ctrl-C released it, and a second review took the lock.
    lock.releaseSync();
    await writeTextFile(path, "999999");
    lock.releaseSync();
    await lock.release();
    const now = await readTextFile(path).catch(() => "gone");
    if (now !== "999999") {
      throw new Error(`the other review's lock was removed: ${now}`);
    }
  } finally {
    offline.restore();
    await removePath(dir, { recursive: true });
  }
});

test("a release removes the review's own lock", async () => {
  const dir = await tempDir({ prefix: "cm-lock-" });
  const offline = offlineEnv(dir);
  try {
    for (const how of ["release", "releaseSync"] as const) {
      const lock = await acquireLocalReviewLock(`${dir}/repo`);
      if (how === "release") await lock.release();
      else lock.releaseSync();
      const left = await lockFile();
      if (left) throw new Error(`${how} left ${left}`);
    }
  } finally {
    offline.restore();
    await removePath(dir, { recursive: true });
  }
});
