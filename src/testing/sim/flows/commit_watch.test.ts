/** The commit-watch flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import commitWatchFlow from "./commit_watch.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("commit-watch: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(commitWatchFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own checks ran, each by name. A count would let inherited
  // checks stand in for one that did not run.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "a push with a flaw opens one issue",
    "the push review ran as a job and finished",
    "the commit watch check run on the pushed commit is completed",
    "the same delivery again makes no write and no new issue",
    "a push with nothing wrong opens no issue",
    "a push to another branch is ignored: no job, no write",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
