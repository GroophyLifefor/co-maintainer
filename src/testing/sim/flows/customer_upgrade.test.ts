/** The customer-upgrade flow, run end to end under `npm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Printer, RunSettings } from "../flow.ts";
import { runFlow } from "../flow.ts";
import customerUpgradeFlow from "./customer_upgrade.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

test("customer-upgrade: the flow passes, with no failing step or check", async () => {
  const result = await runFlow(customerUpgradeFlow, settings(), quiet);
  const failed = [
    ...result.steps.filter((step) => !step.ok),
    ...result.checks.filter((check) => !check.ok),
  ];
  assert.deepEqual(failed, []);
  const names = result.checks.map((check) => check.name);
  for (const name of [
    "an app.db from an older release is backed up first, migrated to the current schema, and keeps its repository and job history",
    "reviews carry on after the upgrade: a new pull request is reviewed once",
    "a server started from a moved config file and data folder reads its settings and reviews once",
  ]) {
    assert.ok(names.includes(name), `the check did not run: ${name}`);
  }
});
