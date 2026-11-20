/** The global AI settings through `set`, which `config set` also runs:
 * `--ai-timeout-minutes=N` and `--global-reasoning-effort=LEVEL`. A valid
 * value is saved, anything else is refused, and `--unset` clears it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
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
    await removePath(dir, { recursive: true }).catch(() => {});
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

test("set --ai-timeout-minutes saves minutes, refuses a bad value and unsets", async () => {
  await withConfig(async () => {
    await runSet(["--ai-timeout-minutes=20"]);
    assert.equal(readConfig().aiTimeoutMinutes, 20);
    for (const bad of ["0", "-3", "abc", "1.5", ""]) {
      const message = await refused([`--ai-timeout-minutes=${bad}`]);
      assert.match(message, /positive whole number|Nothing to set/, bad);
    }
    assert.equal(readConfig().aiTimeoutMinutes, 20);
    await runSet(["--unset=ai-timeout-minutes"]);
    assert.equal(readConfig().aiTimeoutMinutes, undefined);
  });
});

test("set --global-reasoning-effort saves a level, refuses an unknown one and unsets", async () => {
  await withConfig(async () => {
    await runSet(["--global-reasoning-effort=default"]);
    assert.equal(readConfig().globalReasoningEffort, "default");
    const message = await refused(["--global-reasoning-effort=medium"]);
    assert.match(
      message,
      /must be one of: none, low, default, high, xhigh, max/,
    );
    assert.equal(readConfig().globalReasoningEffort, "default");
    await runSet(["--unset=global-reasoning-effort"]);
    assert.equal(readConfig().globalReasoningEffort, undefined);
  });
});
