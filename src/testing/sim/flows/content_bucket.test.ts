/** The content-bucket flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import contentBucketFlow from "./content_bucket.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("content-bucket: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(contentBucketFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  // The flow's own checks ran, each by name.
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "all 3 reviews post, none is lost to the limit",
    "with 2 writes an hour, the first 2 post at once and the other 1 wait about an hour for their place",
    "check runs are not content writes: every check run completed without a content wait",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
