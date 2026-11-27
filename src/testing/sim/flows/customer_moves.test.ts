/** The customer-moves flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import customerMovesFlow from "./customer_moves.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("customer-moves: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(customerMovesFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "after the data is moved, the history came along and a new pull request is reviewed once",
    "a webhook delivered again after the move starts no second review",
    "a restored backup does not make the product review a commit it already reviewed: GitHub holds this App's review, so the webhook delivered again posts nothing",
    "after app.db is lost the repository is listed again from the guides on disk with automatic review off, and a review is skipped and says so",
    "once automatic review is switched on the new pull request is reviewed once, no guides are built again, and the earlier ones are untouched",
    "no review job failed in the new database",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
