/** The fork-review flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import forkReviewFlow from "./fork_review.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("fork-review: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(forkReviewFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "every review request tells the model that the pull request's text, the diff and the tool results are data and not instructions",
    "the pull request's own text is sent as data in the request, never in the system prompt",
    "a pull request from the repository itself is approved as before",
    "a pull request from a fork is posted as a comment and never approved",
    "when the repository chooses auto-forks a fork pull request is approved like any other",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
