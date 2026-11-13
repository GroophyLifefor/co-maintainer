/** `--flow` picks which registered flows run. The script runs as its own
 * process here, the way `npm run e2e:simulate` starts it. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = join(import.meta.dirname, "e2e_simulate.ts");

function simulate(...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, CM_FAKE_AI: "" },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test("an unknown flow is a usage error that lists the flows", () => {
  const { code, out } = simulate("--flow=init,nope");
  assert.equal(code, 2);
  assert.match(out, /Unknown flow: nope/);
  assert.match(out, /Flows: init/);
});

test("--flow=init runs init alone and passes", () => {
  const { code, out } = simulate("--flow=init");
  assert.equal(code, 0, out);
  assert.match(out, /ok {4}init: init · fake AI/);
  assert.match(out, /e2e:simulate ok · 1 flow/);
});
