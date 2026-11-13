/** The leak check finds a secret however it got out: encoded, split, sent
 * to the wrong host in a header, or written anywhere in the sandbox. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Flow, runFlow, type Sim } from "./flow.ts";
import { SAMPLE_REPO_NAME } from "./sample_repo.ts";

const NAME = "no secret in the trace, logs, files or GitHub";

async function leak(run: (sim: Sim) => Promise<void> | void) {
  const flow: Flow = {
    name: "leak-fixture",
    description: "test fixture",
    steps: [
      {
        name: "leak",
        async run(sim) {
          sim.repo(SAMPLE_REPO_NAME);
          sim.github.openPull(SAMPLE_REPO_NAME, {
            title: "t",
            files: { "x.txt": "x\n" },
          });
          await run(sim);
        },
      },
    ],
  };
  const result = await runFlow(
    flow,
    {
      mode: "fake",
      provider: "openrouter",
      lowModel: "l",
      highModel: "h",
      origin: performance.now(),
    },
    { step() {}, check() {}, score() {} },
  );
  const check = result.checks.find((item) => item.name === NAME)!;
  return check;
}

async function post(sim: Sim, body: string) {
  const { PatClient } = await import("../../github/pat.ts");
  await new PatClient(sim.world.secrets.pat).write(
    `repos/${SAMPLE_REPO_NAME}/issues/1/comments`,
    { body },
  );
}

test("a clean flow passes, and the check names what it did not search", async () => {
  const check = await leak(async (sim) => post(sim, "nothing to see"));
  assert.equal(check.ok, true, check.detail);
  assert.match(check.detail, /not searched: config\.json/);
});

test("the token base64-encoded in a posted body is found, at any offset", async () => {
  for (const prefix of ["", "x", "x-access-token:"]) {
    const check = await leak((sim) =>
      post(
        sim,
        `auth ${Buffer.from(`${prefix}${sim.world.secrets.pat}`).toString("base64")}`,
      ),
    );
    assert.equal(check.ok, false, `prefix "${prefix}"`);
    assert.match(check.detail, /GitHub token in posted to GitHub/);
  }
});

test("the token split across two lines is found", async () => {
  const check = await leak((sim) => {
    const pat = sim.world.secrets.pat;
    return post(sim, `${pat.slice(0, 10)}\n${pat.slice(10)}`);
  });
  assert.equal(check.ok, false);
});

test("the token sent as the key to the AI host is found", async () => {
  const check = await leak(async (sim) => {
    await fetch("https://openrouter.ai/api/v1/models", {
      headers: { authorization: `Bearer ${sim.world.secrets.pat}` },
    });
  });
  assert.equal(check.ok, false);
  assert.match(check.detail, /GitHub token sent to openrouter\.ai/);
});

test("the token written to a file in the clones directory is found", async () => {
  const check = await leak((sim) => {
    const dir = join(sim.paths.clonesDir, "sim", "sample");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), sim.world.secrets.pat);
  });
  assert.equal(check.ok, false);
  assert.match(
    check.detail,
    /GitHub token in file clones\/sim\/sample\/notes\.txt/,
  );
});

test("a minted installation token is a secret held to GitHub", async () => {
  let names: string[] = [];
  const check = await leak(async (sim) => {
    const { AppJwtClient } = await import("../../github/app.ts");
    const app = new AppJwtClient(
      sim.world.secrets.appId,
      sim.world.secrets.appPrivateKey,
    );
    const token = await app.installationToken(sim.github.installation.id);
    names = sim.world.secretValues().map((secret) => secret.name);
    await fetch("https://openrouter.ai/api/v1/models", {
      headers: { authorization: `Bearer ${token}` },
    });
  });
  assert.ok(names.includes("installation token 1"));
  assert.match(check.detail, /installation token 1 sent to openrouter\.ai/);
});
