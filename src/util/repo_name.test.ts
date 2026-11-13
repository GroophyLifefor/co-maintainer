/** Issue #67: `owner/repo` typed in another case is the same repository. */
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { canonicalRepoName } from "./repo_name.ts";
import { writeRepoConfig } from "../config.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo } from "../store/repos.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

async function sandbox(
  fn: (dir: string) => Promise<void> | void,
): Promise<void> {
  const keys = ["CM_CONFIG_PATH", "CM_REPOS_DIR", "CM_APP_DB"] as const;
  const saved = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  try {
    await fn(dir);
  } finally {
    keys.forEach((key, index) => {
      const value = saved[index];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
  }
}

function expect(actual: string, wanted: string): void {
  if (actual !== wanted) throw new Error(`got ${actual}, want ${wanted}`);
}

test("a repository seen for the first time is stored in lower case", async () => {
  await sandbox(() => {
    expect(
      canonicalRepoName("GroophyLifefor/Co-Maintainer"),
      "groophylifefor/co-maintainer",
    );
    expect(canonicalRepoName("not a repo"), "not a repo");
  });
});

test("an existing config entry keeps its spelling", async () => {
  await sandbox(async () => {
    await writeRepoConfig("GroophyLifefor/cm-dx-lab", { maxPrMonths: 12 });
    expect(
      canonicalRepoName("groophylifefor/CM-DX-LAB"),
      "GroophyLifefor/cm-dx-lab",
    );
  });
});

test("an existing guide folder keeps its spelling", async () => {
  await sandbox((dir) => {
    mkdirSync(`${dir}/repos/Acme/Widgets`, { recursive: true });
    expect(canonicalRepoName("acme/widgets"), "Acme/Widgets");
  });
});

test("an existing app.db row keeps its spelling, ahead of the rest", async () => {
  await sandbox(async (dir) => {
    mkdirSync(`${dir}/repos/acme/widgets`, { recursive: true });
    await openAppDb();
    try {
      activateRepo("ACME/Widgets", 1);
      expect(canonicalRepoName("acme/WIDGETS"), "ACME/Widgets");
    } finally {
      await closeAppDb();
    }
  });
});
