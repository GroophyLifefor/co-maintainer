/** The job-warnings flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import jobWarningsFlow from "./job_warnings.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("job-warnings: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(jobWarningsFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own checks ran, each by name. A count would let inherited
  // checks stand in for one that did not run.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "the review posts and the job is done although GitHub refused the check run",
    "the job carries a warning that names the Checks permission",
    "a review with no refusal has no warning",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
