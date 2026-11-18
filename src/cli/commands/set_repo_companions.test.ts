/** `set --repo=owner/app --companions=...` stores the repositories a review
 * may read as companions (issue 81). */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { readConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { renderCommandHelp } from "./registry.ts";
import { runSet } from "./set.ts";
import { isolateTestFile } from "../../testing/locations.ts";

isolateTestFile();

async function withConfig(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  const dir = tempDirSync();
  try {
    setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
    await fn();
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
    rmSync(dir, { recursive: true, force: true });
  }
}

const REPO = "--repo=owner/app";
const stored = () => readConfig().repos?.["owner/app"]?.companions;

test("--companions stores the list, a blank value and --unset clear it", async () => {
  await withConfig(async () => {
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      await runSet([REPO, "--companions=owner/docs,owner/vscode-ext"]);
    } finally {
      console.log = log;
    }
    assert.deepEqual(stored(), ["owner/docs", "owner/vscode-ext"]);
    assert.ok(
      printed.includes(
        "[set] updated owner/app: companions=owner/docs,owner/vscode-ext",
      ),
      printed.join("\n"),
    );
    await runSet([REPO, "--companions="]);
    assert.equal(stored(), undefined);
    await runSet([REPO, "--companions=owner/docs"]);
    await runSet([REPO, "--unset=companions"]);
    assert.equal(stored(), undefined);
  });
});

test("--companions refuses a bad list and needs --repo", async () => {
  await withConfig(async () => {
    await assert.rejects(
      runSet([REPO, "--companions=docs"]),
      /--companions: docs is not owner\/repo/,
    );
    await assert.rejects(
      runSet([REPO, "--companions=owner/app"]),
      /--companions: owner\/app is the repository itself/,
    );
    await assert.rejects(
      runSet([REPO, "--companions=a/1,a/2,a/3,a/4,a/5,a/6"]),
      /--companions: at most 5 repositories/,
    );
    await assert.rejects(
      runSet(["--companions=owner/docs"]),
      /--companions needs --repo/,
    );
    assert.equal(stored(), undefined);
  });
});

test("--companions is in the set command's help", () => {
  assert.ok((renderCommandHelp("set") ?? "").includes("--companions"));
});
