/** The review-policy flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import reviewPolicyFlow from "./review_policy.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("review-policy: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(reviewPolicyFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own checks ran, each by name. A count would let inherited
  // checks stand in for one that did not run.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "a pull request from the owner is reviewed once",
    "a draft is not reviewed",
    "a pull request from a bot is not reviewed",
    "a first-time contributor's pull request waits: no review when opened, none after a stranger asks",
    "the owner's request gets the first-time contributor a review",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
