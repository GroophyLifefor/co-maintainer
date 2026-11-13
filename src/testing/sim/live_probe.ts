/** Runs one flow with the fake AI, judges its checks twice over that run, as
 * they are and with the sim saying a real model answered, and prints both as
 * one JSON line. `flows/live_checks.test.ts` starts it in its own process:
 * the flows read what the CLI printed on stdout, and inside the test runner's
 * process that stream also carries the runner's own events.
 *
 *   node src/testing/sim/live_probe.ts <flow name> */
import { type CheckResult, runFlow } from "./flow.ts";
import { FLOWS } from "./flows/index.ts";

const flow = FLOWS.find((item) => item.name === process.argv[2]);
if (!flow) {
  console.error(`No flow named ${process.argv[2]}`);
  process.exit(2);
}

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
  {
    mode: "fake",
    provider: "openrouter",
    lowModel: "simulate/low",
    highModel: "simulate/high",
    origin: performance.now(),
  },
  { step() {}, check() {}, score() {} },
);

// The checks the flow itself returned come first, then the inherited ones.
const fake = result.checks.slice(0, live.length);
console.log(
  `LIVE_PROBE ${JSON.stringify({ passed: result.passed, fake, live })}`,
);
