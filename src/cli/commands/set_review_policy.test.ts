import { test } from "node:test";
import { readConfig } from "../../config.ts";
import { writeTextFile } from "../../util/runtime.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { runSet } from "./set.ts";

async function withConfig(fn: (dir: string) => Promise<void>): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    await fn(dir);
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

test("set --review-policy stores a template name and refuses an unknown one", async () => {
  await withConfig(async () => {
    await runSet(["--review-policy=trusted-auto"]);
    if (readConfig().reviewPolicy !== "trusted-auto") {
      throw new Error(JSON.stringify(readConfig().reviewPolicy));
    }
    const message = await refused(["--review-policy=bogus"]);
    if (!/unknown template "bogus"/.test(message)) throw new Error(message);
    if (readConfig().reviewPolicy !== "trusted-auto") {
      throw new Error("a refused value must not overwrite the stored one");
    }
  });
});

test("set --review-policy-file stores a valid policy and says what is wrong with a bad one", async () => {
  await withConfig(async (dir) => {
    const good = `${dir}/policy.json`;
    await writeTextFile(
      good,
      JSON.stringify({
        rules: [
          {
            name: "newcomers",
            when: { association: ["NONE"] },
            action: "skip",
          },
        ],
        default: "review",
      }),
    );
    await runSet([`--review-policy-file=${good}`]);
    const stored = readConfig().reviewPolicy as { default?: string };
    if (typeof stored !== "object" || stored.default !== "review") {
      throw new Error(JSON.stringify(stored));
    }

    const bad = `${dir}/bad.json`;
    await writeTextFile(bad, JSON.stringify({ default: "maybe" }));
    const message = await refused([`--review-policy-file=${bad}`]);
    if (!/--review-policy-file: default must be one of/.test(message)) {
      throw new Error(message);
    }

    const notJson = `${dir}/notjson.json`;
    await writeTextFile(notJson, "{oops");
    if (
      !/Could not read a JSON policy/.test(
        await refused([`--review-policy-file=${notJson}`]),
      )
    ) {
      throw new Error("invalid JSON must be named as such");
    }
  });
});

test("set refuses both policy flags together, and --unset clears the default", async () => {
  await withConfig(async (dir) => {
    const file = `${dir}/policy.json`;
    await writeTextFile(file, JSON.stringify({ default: "skip" }));
    const message = await refused([
      "--review-policy=everyone",
      `--review-policy-file=${file}`,
    ]);
    if (!/only one of --review-policy or --review-policy-file/.test(message)) {
      throw new Error(message);
    }
    await runSet(["--review-policy=everyone"]);
    await runSet(["--unset=review-policy"]);
    if (readConfig().reviewPolicy !== undefined) {
      throw new Error("the default was not cleared");
    }
  });
});
