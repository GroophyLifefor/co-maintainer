/** The product's `GhClient` reaches the simulated GitHub through the runner
 * seam, and maps its answers with its own error handling. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Faults } from "./faults.ts";
import { ghStandIn, parseGhApi } from "./gh_stand_in.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "./sample_repo.ts";
import { Trace } from "./trace.ts";
import { createWorld } from "./world.ts";

const world = createWorld();
world.createRepo(SAMPLE_REPO_NAME, SAMPLE_REPO);
const trace = new Trace(performance.now());
const faults = new Faults();
const { GhClient, setGhRunner } = await import("../../github/gh.ts");
setGhRunner(ghStandIn({ github: world.github, trace, faults }));
after(() => {
  setGhRunner(undefined);
  world.dispose();
});

test("parseGhApi reads the method and the endpoint", () => {
  assert.deepEqual(parseGhApi(["api", "repos/o/r"]), {
    method: "GET",
    endpoint: "repos/o/r",
  });
  assert.deepEqual(
    parseGhApi(["api", "-X", "POST", "repos/o/r/issues", "--input", "-"]),
    { method: "POST", endpoint: "repos/o/r/issues" },
  );
  assert.equal(parseGhApi(["pr", "view", "1"]), undefined);
});

test("a read and a write go through gh to the simulated GitHub", async () => {
  const client = new GhClient();
  const repo = await client.request<{ full_name: string }>(
    `repos/${SAMPLE_REPO_NAME}`,
  );
  assert.equal(repo.full_name, SAMPLE_REPO_NAME);
  const pull = world.github.openPull(SAMPLE_REPO_NAME, {
    title: "t",
    files: { "x.txt": "x\n" },
  });
  await client.write(
    `repos/${SAMPLE_REPO_NAME}/issues/${pull.number}/comments`,
    {
      body: "from gh",
    },
  );
  const write = world.github.writes.at(-1)!;
  assert.equal(write.via, "gh");
  assert.deepEqual(write.body, { body: "from gh" });
  assert.equal(write.actor, world.github.tokenUser.login);
  assert.ok(trace.github.every((call) => call.via === "gh" && call.handled));
});

test("a 404 becomes the product's own repo_not_found error", async () => {
  await assert.rejects(new GhClient().request("repos/nobody/nothing"), {
    code: "repo_not_found",
  });
  // After a failure the client asks `gh api rate_limit` whether to wait.
  const missing = trace.github.findLast((call) => call.url.includes("nobody"));
  assert.equal(missing!.handled, false);
});

test("a rate-limit fault is waited out through gh api rate_limit", async () => {
  faults.add({ target: "github", kind: "rate-limit", path: "/git/trees" });
  const tree = await new GhClient().request<{ tree: unknown[] }>(
    `repos/${SAMPLE_REPO_NAME}/git/trees/main`,
  );
  assert.ok(tree.tree.length > 0);
  assert.deepEqual(faults.unused(), []);
  const calls = trace.github
    .slice(-3)
    .map((call) => new URL(call.url).pathname);
  assert.deepEqual(calls, [
    `/repos/${SAMPLE_REPO_NAME}/git/trees/main`,
    "/rate_limit",
    `/repos/${SAMPLE_REPO_NAME}/git/trees/main`,
  ]);
});
