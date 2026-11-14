/** What preparing codegraph for a local review writes into the user's
 * repository: one line in `.git/info/exclude`, and only when an index will
 * be written there. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runCommand } from "../pr/checkout.ts";
import { isolateTestFile } from "../testing/locations.ts";
import { ensureCodegraphGitExclude } from "./codegraph_exclude.ts";
import { prepareLocalCodegraph } from "./codegraph_prepare.ts";

isolateTestFile();

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An empty git repository somewhere else than where the tests run. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "cm-codegraph-prepare-"));
  roots.push(root);
  const init = spawnSync("git", ["init", "-q"], { cwd: root });
  assert.equal(init.status, 0);
  return root;
}

const excludeLines = (root: string) =>
  readFileSync(join(root, ".git", "info", "exclude"), "utf8")
    .split("\n")
    .filter((line) => line.includes("co-maintainer-codegraph"));

test("a review without codegraph leaves .git/info/exclude alone", async () => {
  const root = repository();
  const saved = process.env.CM_TOOLS_DIR;
  // An empty tools dir: codegraph is never present, no matter the host.
  process.env.CM_TOOLS_DIR = join(root, "no-tools");
  try {
    const prepared = await prepareLocalCodegraph({
      gitRoot: root,
      enabled: true,
      allowInstall: false,
      interactive: false,
    });
    assert.equal(prepared.state, "unavailable");
    assert.deepEqual(excludeLines(root), []);
  } finally {
    if (saved === undefined) delete process.env.CM_TOOLS_DIR;
    else process.env.CM_TOOLS_DIR = saved;
  }
});

test("the exclude line goes into the repository's own file, once, wherever the command runs", async () => {
  const root = repository();
  assert.notEqual(process.cwd(), root);
  await ensureCodegraphGitExclude(root, runCommand);
  await ensureCodegraphGitExclude(root, runCommand);
  assert.deepEqual(excludeLines(root), ["/.co-maintainer-codegraph/"]);
});
