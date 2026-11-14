/** The CLI pull request carry-over flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import carryFlow from "./cli_pr_carry.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("cli-pr-carry: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(carryFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // Every check that is skipped says why.
  for (const check of result.checks.filter((item) => item.skipped)) {
    assert.ok(check.skipped!.length > 20, check.name);
  }
  // The flow's own checks ran, not only the inherited ones.
  assert.ok(result.checks.length > 40);
});
