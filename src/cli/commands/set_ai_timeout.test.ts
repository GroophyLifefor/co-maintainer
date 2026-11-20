/** `set --ai-timeout-minutes=N`, which `config set ai-timeout-minutes N`
 * also runs: a positive whole number is saved, anything else is refused, and
 * `--unset` clears it. */
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
