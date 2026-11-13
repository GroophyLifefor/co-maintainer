/** What a live run would report, without a model. Each flow runs once with the
 * fake AI. Its checks are then judged twice over the same run: as they are,
 * and with the sim saying a real model answered. A live run cannot be tried
 * without a key, so this is the cheapest honest proof that the skips are
 * where they should be and nothing else moves:
 *
 * - the same checks, in the same order, with the same names;
 * - a skipped one says why, and a live run never fails it;
 * - every check that is not skipped gives the same result either way, so
 *   what a flow keeps running live is exactly what holds for any answer. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CheckResult,
  type Flow,
  type Printer,
  type RunSettings,
  runFlow,
} from "../flow.ts";
import { FLOWS } from "./index.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

const settings = (): RunSettings => ({
  mode: "fake",
  provider: "openrouter",
  lowModel: "simulate/low",
  highModel: "simulate/high",
  origin: performance.now(),
});

/** The checks of one flow as the fake AI and as a live run would see them. */
async function bothWays(flow: Flow): Promise<{
  fake: CheckResult[];
  live: CheckResult[];
  passed: boolean;
}> {
  const live: CheckResult[] = [];
  const result = await runFlow(
    {
      ...flow,
      checks: async (sim) => {
        const fake = [...((await flow.checks?.(sim)) ?? [])];
        sim.mode = "live";
        try {
          live.push(...((await flow.checks?.(sim)) ?? []));
        } finally {
          sim.mode = "fake";
        }
        return fake;
      },
    },
    settings(),
    quiet,
  );
  // The checks the flow itself returns, not the ones every flow inherits.
  const own = result.checks.slice(0, live.length);
  return { fake: own, live, passed: result.passed };
}

for (const flow of FLOWS) {
  if (!flow.checks) continue;
  test(`live checks of ${flow.name}: the same checks, skipped with a reason or unchanged`, async () => {
    const { fake, live, passed } = await bothWays(flow);
    assert.equal(passed, true);
    assert.deepEqual(
      live.map((item) => item.name),
      fake.map((item) => item.name),
    );
    for (const [index, item] of live.entries()) {
      const before = fake[index]!;
      if (item.skipped !== undefined) {
        // Skipped only because of the model, unless the flow skipped it
        // with the fake AI too (a known product bug).
        if (before.skipped === undefined) {
          assert.match(item.skipped, /^live AI: .{10,}/, item.name);
        }
        assert.equal(item.ok, true, item.name);
        continue;
      }
      assert.equal(item.ok, before.ok, item.name);
      assert.equal(item.detail, before.detail, item.name);
    }
  });
}
