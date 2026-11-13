/** The guide-sources flow, run end to end under `npm test`.
 *
 * It runs in its own process, as `npm run e2e:simulate` does. The flow reads
 * what the CLI printed on stdout, and inside the test runner's process that
 * stream also carries the runner's own events. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = dirname(
  dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
);

test("guide-sources: the flow passes, with no failing step or check", () => {
  const result = spawnSync(
    process.execPath,
    [join(projectRoot, "scripts/e2e_simulate.ts"), "--flow=guide-sources"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, CM_FAKE_AI: "1" },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  const failures = output.split("\n").filter((line) => line.startsWith("FAIL"));
  assert.deepEqual(failures, []);
  assert.equal(result.status, 0, output);
  assert.ok(output.includes("e2e:simulate ok"), output);
});
