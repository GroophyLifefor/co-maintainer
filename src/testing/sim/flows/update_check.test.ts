/** The update-check flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import updateCheckFlow from "./update_check.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("update-check: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(updateCheckFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own checks ran, each by name. A count would let inherited
  // checks stand in for one that did not run.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "a server with no update address offers no update",
    "a newer stable release is offered with its notes link",
    "a pre-release is not offered",
    "the update request is one POST to the host's address naming the version",
    "an older version and one that is not the latest are refused with nothing sent",
    "What's new lists the sections after the running version, newest first, up to the latest",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
