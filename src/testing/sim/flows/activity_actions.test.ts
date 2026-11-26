/** The activity-actions flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import activityActionsFlow from "./activity_actions.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("activity-actions: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(activityActionsFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own checks ran, each by name. A count would let inherited
  // checks stand in for one that did not run.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "Retry on a failed review starts one review job, and it posts a review",
    "the job and the review of one failure start one review, not two",
    "a row that did not fail has nothing to retry",
    "Dismiss marks the failure as seen: something the first time, nothing the second",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
