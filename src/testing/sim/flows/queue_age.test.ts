/** The queue-age flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import queueAgeFlow from "./queue_age.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("queue-age: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(queueAgeFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own six checks ran, each by name. A count would let inherited
  // checks stand in for one that did not run.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "a review older than the limit is canceled as queued too long, with no review and no check run",
    "the pull request gets one note, with the hidden marker",
    "a second old job for the same pull request adds no second note",
    "Retry on the skipped job starts one job that reviews the pull request",
    "a skip whose note failed does not count as a note: the next old job posts it",
    "a limit of 300 minutes skips a job 6 hours old, which the default 1440 minutes would run",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
