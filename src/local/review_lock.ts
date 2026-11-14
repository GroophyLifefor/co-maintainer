import { locksDir } from "../config.ts";
import { ReviewCliError } from "./git_ops.ts";
import {
  isNotFound,
  isProcessAlive,
  mkdir,
  readTextFile,
  readTextFileSync,
  remove,
  removeSync,
  writeTextFile,
} from "../util/runtime.ts";

async function lockPath(gitRoot: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(gitRoot),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
  const dir = locksDir();
  await mkdir(dir, { recursive: true });
  return `${dir}/${hex}.lock`;
}

export type LocalReviewLock = {
  release: () => Promise<void>;
  /** For signal handlers — must not await before exit. */
  releaseSync: () => void;
};

/** One local review per repo root. */
export async function acquireLocalReviewLock(
  gitRoot: string,
): Promise<LocalReviewLock> {
  const path = await lockPath(gitRoot);
  let existingPid: number | undefined;
  try {
    existingPid = Number((await readTextFile(path)).trim());
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (
    existingPid !== undefined &&
    Number.isInteger(existingPid) &&
    isProcessAlive(existingPid)
  ) {
    throw new ReviewCliError(
      "usage",
      `Another co-maintainer review is running in this repository (PID ${existingPid}).`,
    );
  }
  const pid = String(process.pid);
  await writeTextFile(path, pid);
  // Ctrl-C releases the lock while this process may still be finishing. A
  // review started in that window writes its own PID here, so a release only
  // removes a lock that still names this process.
  const releaseSync = () => {
    try {
      if (readTextFileSync(path).trim() === pid) removeSync(path);
    } catch {
      // already removed
    }
  };
  return {
    release: async () => {
      try {
        if ((await readTextFile(path)).trim() === pid) await remove(path);
      } catch {
        // already removed
      }
    },
    releaseSync,
  };
}
