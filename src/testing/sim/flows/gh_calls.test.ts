/** The gh-calls flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import ghCallsFlow from "./gh_calls.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("gh-calls: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(ghCallsFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own checks ran, each by name. A count would let inherited
  // checks stand in for one that did not run.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "a small App review makes at most 9 GitHub calls (0.7.31 took it from 12)",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
