/** Run folder cleanup removes co-maintainer's own stale run folders and
 * nothing else, wherever config.json lives. */
import { test } from "node:test";
import { existsSync } from "node:fs";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import {
  extensionsRoot,
  openRunFolder,
  removeServeRunFolders,
} from "./run_folder.ts";

test("serve start removes only stale folders co-maintainer made", async () => {
  const original = getEnv("CM_CONFIG_PATH");
  const home = tempDirSync();
  // config.json moved into a home folder that holds the user's own work.
  setEnv("CM_CONFIG_PATH", `${home}/cm.json`);
  try {
    const root = extensionsRoot();
    if (root !== `${home}/co-maintainer-extensions`) throw new Error(root);
    await mkdirPath(`${home}/extensions/my-browser-ext/src`, {
      recursive: true,
    });
    await writeTextFile(`${home}/extensions/my-browser-ext/src/index.js`, "x");
    const uuid = () => crypto.randomUUID();
    const plain = `${root}/notes`;
    const noOwner = `${root}/${uuid()}`;
    const foreign = `${root}/${uuid()}`;
    await mkdirPath(plain, { recursive: true });
    await mkdirPath(noOwner, { recursive: true });
    await mkdirPath(foreign, { recursive: true });
    await writeTextFile(
      `${foreign}/owner.json`,
      JSON.stringify({ pid: 1, kind: "serve" }),
    );
    const details = {
      schemaVersion: 1 as const,
      reviewType: "pr" as const,
      repo: "acme/widgets",
      prNumber: 1,
      branch: null,
      workdir: "",
      headSha: null,
      baseSha: null,
      scope: "whole-pr",
      sinceCommit: null,
      trigger: "opened",
      round: 1,
    };
    const stale = await openRunFolder({
      runId: uuid(),
      owner: "serve",
      details,
      diff: "",
    });
    const running = await openRunFolder({
      runId: uuid(),
      owner: "serve",
      details,
      diff: "",
    });
    const removed = await removeServeRunFolders(new Set([running.runId]));
    if (removed !== 1 || existsSync(stale.dir))
      throw new Error(`removed ${removed}`);
    for (const kept of [
      plain,
      noOwner,
      foreign,
      running.dir,
      `${home}/extensions/my-browser-ext/src/index.js`,
    ]) {
      if (!existsSync(kept)) throw new Error(`${kept} was removed`);
    }
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
  }
});
