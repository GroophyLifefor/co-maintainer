/** The budget-admission flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import budgetAdmissionFlow from "./budget_admission.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("budget-admission: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(budgetAdmissionFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own checks ran, each by name.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "with 70 requests left, some reviews start and the rest stay queued: not all, not none",
    "nothing fails or meets a GitHub rate limit while the budget is low",
    "after the reset the queued reviews run, and every pull request has exactly one review",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
