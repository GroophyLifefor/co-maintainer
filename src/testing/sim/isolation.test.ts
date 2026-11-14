/** Flows run one after another in one process. A flow must pass the same
 * whether it runs alone, first or after another. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Flow, type FlowResult, runFlow } from "./flow.ts";
import { SAMPLE_REPO_NAME } from "./sample_repo.ts";

async function token(sim: Parameters<Flow["steps"][number]["run"]>[0]) {
  sim.repo(SAMPLE_REPO_NAME);
  const { AppJwtClient } = await import("../../github/app.ts");
  return new AppJwtClient(
    sim.world.secrets.appId,
    sim.world.secrets.appPrivateKey,
  ).installationToken(sim.github.installation.id);
}

const mints: Flow = {
  name: "mints",
  description: "mints an installation token",
  steps: [{ name: "mint", run: async (sim) => void (await token(sim)) }],
};

const faulted: Flow = {
  name: "faulted",
  description: "the token route fails once",
  steps: [
    {
      name: "mint",
      expectError: true,
      async run(sim) {
        sim.faults.add({
          target: "github",
          kind: "500",
          path: "/access_tokens",
        });
        await token(sim);
      },
    },
  ],
};

async function inOrder(...flows: Flow[]): Promise<FlowResult[]> {
  const results: FlowResult[] = [];
  for (const flow of flows) {
    results.push(
      await runFlow(
        flow,
        {
          mode: "fake",
          provider: "openrouter",
          lowModel: "l",
          highModel: "h",
          origin: performance.now(),
        },
        { step() {}, check() {}, score() {} },
      ),
    );
  }
  return results;
}

const failed = (results: FlowResult[]) =>
  results.flatMap((result) =>
    result.checks
      .filter((check) => !check.ok)
      .map((check) => `${result.name}: ${check.name} ${check.detail}`),
  );

test("a token fault fires whether its flow runs first or after another", async () => {
  for (const order of [
    [mints, faulted],
    [faulted, mints],
  ]) {
    const results = await inOrder(...order);
    assert.deepEqual(failed(results), []);
    assert.ok(results.every((result) => result.passed));
  }
});
