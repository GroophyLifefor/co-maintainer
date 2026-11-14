/** `set --repo --review-read-diff-max-chars` stores the cap on one
 * `read-full-diff` answer the same way the other repository settings are
 * stored, and a review reads it back through `readDiffMaxChars`. */
import { test } from "node:test";
import { readConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { readDiffMaxChars } from "../../pr/diff_summary.ts";
import { renderCommandHelp } from "./registry.ts";
import { runSet } from "./set.ts";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
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

async function refused(args: string[]): Promise<string> {
  try {
    await runSet(args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`accepted ${args.join(" ")}`);
}

function cap(): number | null {
  return readDiffMaxChars(readConfig().repos?.["acme/widgets"]);
}

test("set --repo stores the read-full-diff cap and a review reads it", async () => {
  await withConfig(async () => {
    if (cap() !== 20_000) throw new Error(`default: ${cap()}`);
    await runSet(["--repo=acme/widgets", "--review-read-diff-max-chars=5000"]);
    const stored = readConfig().repos?.["acme/widgets"];
    if (stored?.reviewReadDiffMaxChars !== 5000) {
      throw new Error(JSON.stringify(stored));
    }
    if (cap() !== 5000) throw new Error(`stored: ${cap()}`);
    await runSet(["--repo=acme/widgets", "--review-read-diff-max-chars=0"]);
    if (cap() !== null) throw new Error(`0 means no limit: ${cap()}`);
  });
});

test("a blank value and --unset both go back to the default", async () => {
  await withConfig(async () => {
    await runSet(["--repo=acme/widgets", "--review-read-diff-max-chars=5000"]);
    await runSet(["--repo=acme/widgets", "--review-read-diff-max-chars="]);
    if (cap() !== 20_000) throw new Error(`blank: ${cap()}`);
    await runSet(["--repo=acme/widgets", "--review-read-diff-max-chars=5000"]);
    await runSet(["--repo=acme/widgets", "--unset=review-read-diff-max-chars"]);
    if (cap() !== 20_000) throw new Error(`unset: ${cap()}`);
  });
});

test("the cap must be an integer and needs --repo", async () => {
  await withConfig(async () => {
    const notNumber = await refused([
      "--repo=acme/widgets",
      "--review-read-diff-max-chars=lots",
    ]);
    if (!notNumber.includes("must be an integer")) throw new Error(notNumber);
  });
});

test("the flag is in the set command's help", () => {
  const help = renderCommandHelp("set") ?? "";
  if (!help.includes("--review-read-diff-max-chars")) throw new Error(help);
});
