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
    "a restored backup keeps the product reviewing, and a pull request whose review it does not remember is reviewed once more at most",
    "after the disk is lost a review waits for the guides, says so, and posts nothing",
    "once the guides are built again the new pull request is reviewed once and the earlier ones are untouched",
    "no review job failed in the new database",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
