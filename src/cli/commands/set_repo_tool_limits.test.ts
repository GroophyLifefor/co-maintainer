/** `set --repo` stores the review tool limits (issue 79) the way
 * `--review-read-diff-max-chars` is stored, and a review reads them back. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { toolBudgetChars, toolResultMaxChars } from "../../ai/tool_gate.ts";
import { searchMaxContextLines } from "../../tools/search_non_code.ts";
import { renderCommandHelp } from "./registry.ts";
import { runSet } from "./set.ts";
import { isolateTestFile } from "../../testing/locations.ts";

isolateTestFile();

async function withConfig(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    await fn();
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
  }
}

const REPO = "--repo=acme/widgets";
const limits = () => {
  const repo = readConfig().repos?.["acme/widgets"];
  return [
    toolResultMaxChars(repo),
    toolBudgetChars(repo),
    searchMaxContextLines(repo),
  ];
};

test("the three limits default, store, and take 0 or -1 as no limit", async () => {
  await withConfig(async () => {
    assert.deepEqual(limits(), [8000, 40_000, 3]);
    await runSet([
      REPO,
      "--review-tool-result-max-chars=500",
      "--review-tool-budget-chars=2000",
      "--review-search-max-context-lines=1",
    ]);
    const stored = readConfig().repos?.["acme/widgets"];
    assert.equal(stored?.reviewToolResultMaxChars, 500);
    assert.equal(stored?.reviewToolBudgetChars, 2000);
    assert.equal(stored?.reviewSearchMaxContextLines, 1);
    assert.deepEqual(limits(), [500, 2000, 1]);
    await runSet([
      REPO,
      "--review-tool-result-max-chars=0",
      "--review-tool-budget-chars=-1",
      "--review-search-max-context-lines=0",
    ]);
    assert.deepEqual(limits(), [null, null, null]);
  });
});

test("a blank value and --unset go back to the default", async () => {
  await withConfig(async () => {
    await runSet([
      REPO,
      "--review-tool-result-max-chars=500",
      "--review-tool-budget-chars=2000",
      "--review-search-max-context-lines=1",
    ]);
    await runSet([REPO, "--review-tool-result-max-chars="]);
    await runSet([REPO, "--unset=review-tool-budget-chars"]);
    await runSet([REPO, "--unset=reviewSearchMaxContextLines"]);
    assert.deepEqual(limits(), [8000, 40_000, 3]);
  });
});

test("a limit must be an integer", async () => {
  await withConfig(async () => {
    await assert.rejects(
      runSet([REPO, "--review-tool-budget-chars=lots"]),
      /--review-tool-budget-chars must be an integer/,
    );
  });
});

test("the flags are in the set command's help", () => {
  const help = renderCommandHelp("set") ?? "";
  for (const flag of [
    "--review-tool-result-max-chars",
    "--review-tool-budget-chars",
    "--review-search-max-context-lines",
  ]) {
    assert.ok(help.includes(flag), flag);
  }
});
