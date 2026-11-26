/** Measures the GitHub calls one App review makes, for the load test design.
 * It runs only when named: `--flow=gh-calls`. It reports what it counted in
 * the check's detail and fails when the smallest review makes more than 9
 * calls, the count 0.7.31 reached. */
import type { AiRule } from "../fake_ai.ts";
import { finding } from "../fake_ai.ts";
import { check, defineFlow, type CheckResult, type Sim } from "../flow.ts";
import { APP_REPO, OPENED_MATH, deliverOpened, serveRepo } from "./app.ts";
import { INIT_AI } from "./init.ts";

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "one finding",
    job: "review_pull_request",
    prompt: /[\s\S]*/,
    reply: {
      findings: [
        finding({
          path: "src/math.ts",
          line: 10,
          severity: "P2",
          title: "divide does not guard a zero divisor",
          body: "divide returns Infinity when b is 0.",
        }),
      ],
    },
  },
];

function shape(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/\?.*$/, "")
    .replace(/\/[0-9a-f]{40}/g, "/:sha")
    .replace(/\d+/g, "N");
}

function checks(sim: Sim): CheckResult[] {
  const calls = sim.trace.github.filter((c) => c.step === "review");
  const byKind = new Map<string, number>();
  for (const call of calls) {
    const key = `${call.method} ${shape(call.url)}`;
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
  }
  const writes = calls.filter((c) => c.method !== "GET");
  const lines = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} x ${k}`);
  const order = calls.map((c, i) => `${i + 1}. ${c.method} ${shape(c.url)}`);
  return [
    check(
      "a small App review makes at most 9 GitHub calls (0.7.31 took it from 12)",
      calls.length > 0 && calls.length <= 9,
      `${calls.length} calls, ${writes.length} writes\n${lines.join("\n")}\n--- order\n${order.join("\n")}`,
    ),
  ];
}

export default defineFlow({
  name: "gh-calls",
  description:
    "counts the GitHub calls one App review makes, for the load test design",
  ai: AI,
  onlyWhenNamed: true,
  steps: [
    {
      name: "serve",
      async run(sim) {
        await serveRepo(sim);
        return "served";
      },
    },
    {
      name: "review",
      async run(sim) {
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        });
        const round = await deliverOpened(sim, pull);
        return round.jobs.map((j) => `${j.type} ${j.status}`).join(", ");
      },
    },
  ],
  checks,
});
