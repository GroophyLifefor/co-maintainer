/** `set --repo` writes the repository-scoped settings to config.json and
 * refuses a global flag it cannot honor. */
import { test } from "node:test";
import { readConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { runSet } from "./set.ts";

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

test("set --repo stores a repository's review instructions", async () => {
  await withConfig(async () => {
    await runSet(["--repo=acme/widgets", "--review-system-prompt=Focus on X."]);
    const stored = readConfig().repos?.["acme/widgets"];
    if (stored?.reviewSystemPrompt !== "Focus on X.") {
      throw new Error(JSON.stringify(stored));
    }
  });
});

test("a blank value clears the repository's instructions", async () => {
  await withConfig(async () => {
    await runSet(["--repo=acme/widgets", "--review-system-prompt=Focus on X."]);
    await runSet(["--repo=acme/widgets", "--review-system-prompt="]);
    if (
      "acme/widgets" in (readConfig().repos ?? {}) &&
      readConfig().repos?.["acme/widgets"]?.reviewSystemPrompt !== undefined
    ) {
      throw new Error("a blank value did not clear it");
    }
  });
});

test("--unset removes the repository's instructions and its cap", async () => {
  await withConfig(async () => {
    await runSet([
      "--repo=acme/widgets",
      "--review-system-prompt=Focus on X.",
      "--review-system-prompt-max-chars=20",
    ]);
    await runSet(["--repo=acme/widgets", "--unset=review-system-prompt"]);
    const afterPrompt = readConfig().repos?.["acme/widgets"];
    if (afterPrompt?.reviewSystemPrompt !== undefined) {
      throw new Error("the prompt was not unset");
    }
    if (afterPrompt?.reviewSystemPromptMaxChars !== 20) {
      throw new Error("the cap must survive an unrelated unset");
    }
    await runSet([
      "--repo=acme/widgets",
      "--unset=review-system-prompt-max-chars",
    ]);
    if (
      readConfig().repos?.["acme/widgets"]?.reviewSystemPromptMaxChars !==
      undefined
    ) {
      throw new Error("the cap was not unset");
    }
  });
});

test("the cap is enforced against the value written in the same command", async () => {
  await withConfig(async () => {
    const ok = await refused([
      "--repo=acme/widgets",
      "--review-system-prompt=way too long for five",
      "--review-system-prompt-max-chars=5",
    ]);
    if (!/--review-system-prompt: must be at most 5 characters/.test(ok)) {
      throw new Error(ok);
    }
    await runSet([
      "--repo=acme/widgets",
      "--review-system-prompt=short",
      "--review-system-prompt-max-chars=5",
    ]);
    if (readConfig().repos?.["acme/widgets"]?.reviewSystemPrompt !== "short") {
      throw new Error("the valid value was not stored");
    }
    await runSet([
      "--repo=acme/widgets",
      "--review-system-prompt=this is long enough now",
      "--review-system-prompt-max-chars=0",
    ]);
    if (
      readConfig().repos?.["acme/widgets"]?.reviewSystemPrompt !==
      "this is long enough now"
    ) {
      throw new Error("0 must mean no limit");
    }
  });
});

test("a global flag cannot be combined with --repo", async () => {
  await withConfig(async () => {
    const message = await refused(["--repo=acme/widgets", "--ai=openrouter"]);
    if (!/--ai cannot be used with --repo/.test(message)) {
      throw new Error(message);
    }
    const badRepo = await refused([
      "--repo=not-a-repo",
      "--review-system-prompt=x",
    ]);
    if (!/--repo must look like owner\/repo/.test(badRepo)) {
      throw new Error(badRepo);
    }
    const nothing = await refused(["--repo=acme/widgets"]);
    if (!/Nothing to set/.test(nothing)) throw new Error(nothing);
  });
});

test("a global --unset name is refused with --repo", async () => {
  await withConfig(async () => {
    const message = await refused([
      "--repo=acme/widgets",
      "--review-system-prompt=x",
      "--unset=ai",
    ]);
    if (!/--unset=ai cannot be used with --repo/.test(message)) {
      throw new Error(message);
    }
  });
});

test("lowering the cap re-checks the stored prompt and refuses an over-cap one", async () => {
  await withConfig(async () => {
    await runSet(["--repo=acme/widgets", "--review-system-prompt=ten chars!"]);
    const message = await refused([
      "--repo=acme/widgets",
      "--review-system-prompt-max-chars=3",
    ]);
    if (!/--review-system-prompt: must be at most 3 characters/.test(message)) {
      throw new Error(message);
    }
    if (
      readConfig().repos?.["acme/widgets"]?.reviewSystemPrompt !== "ten chars!"
    ) {
      throw new Error("a refused cap change still wrote the value");
    }
  });
});

test("a blank max-chars value clears the cap, and --unset then value sets it", async () => {
  await withConfig(async () => {
    await runSet([
      "--repo=acme/widgets",
      "--review-system-prompt-max-chars=100",
    ]);
    await runSet(["--repo=acme/widgets", "--review-system-prompt-max-chars="]);
    if (
      readConfig().repos?.["acme/widgets"]?.reviewSystemPromptMaxChars !==
      undefined
    ) {
      throw new Error("a blank value did not clear the cap");
    }
    await runSet([
      "--repo=acme/widgets",
      "--unset=review-system-prompt-max-chars",
      "--review-system-prompt-max-chars=7",
    ]);
    if (
      readConfig().repos?.["acme/widgets"]?.reviewSystemPromptMaxChars !== 7
    ) {
      throw new Error("an explicit value must win over --unset");
    }
  });
});
