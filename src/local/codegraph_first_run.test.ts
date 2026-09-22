/** Interactive codegraph prompt in a non-interactive run (CORE-50 / F01).
 *
 * F01: `co-maintainer review` on a fresh machine asked "Install codegraph ...?
 * [y/N]" even with stdin closed (`</dev/null`), because `process.stdin.isTTY`
 * was the only check and Windows' NUL device can present as a TTY. The prompt
 * then hung, printing `Warning: Detected unsettled top-level await`, and the
 * process exited 13. This drives the real CLI in a git worktree with codegraph
 * absent and checks it does not ask, does not hang, and does not crash.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Command,
  envToObject,
  mkdirPath,
  removePath,
  runtimeExecPath,
  runtimeRunArgs,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await new Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

/** A git worktree with one commit and a change, plus guides, so `review` gets
 * as far as the codegraph check. Codegraph is pointed at an empty tools dir so
 * `detect` reports it missing regardless of the machine. */
async function prepareWorktree(root: string): Promise<{
  worktree: string;
  configPath: string;
  reposDir: string;
  repo: string;
}> {
  const worktree = `${root}/worktree`;
  const configPath = `${root}/config.json`;
  const reposDir = `${root}/repos`;
  const repo = "e2e-codegraph/first-run";
  await mkdirPath(`${reposDir}/${repo}`, { recursive: true });
  await writeTextFile(`${reposDir}/${repo}/SKILL.md`, "# Skill\n\n- rule\n");
  await writeTextFile(
    configPath,
    `${JSON.stringify({
      auth: "gh",
      ai: "openrouter",
      token: "fake",
      highModel: "fake/model",
    })}\n`,
  );
  await mkdirPath(worktree, { recursive: true });
  await git(worktree, ["init"]);
  await git(worktree, ["config", "user.email", "t@t"]);
  await git(worktree, ["config", "user.name", "t"]);
  await writeTextFile(`${worktree}/x.ts`, "export {}\n");
  await git(worktree, ["add", "x.ts"]);
  await git(worktree, ["commit", "-m", "init"]);
  await git(worktree, ["branch", "-M", "main"]);
  await git(worktree, [
    "remote",
    "add",
    "origin",
    `https://github.com/${repo}.git`,
  ]);
  await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeTextFile(`${worktree}/x.ts`, "export const y = 1\n");
  await git(worktree, ["add", "x.ts"]);
  await git(worktree, ["commit", "-m", "change"]);
  return { worktree, configPath, reposDir, repo };
}

test("review never asks about codegraph when stdin is not a TTY", async () => {
  const root = await tempDir({ prefix: "cm-codegraph-first-" });
  try {
    const { worktree, configPath, reposDir, repo } =
      await prepareWorktree(root);
    const result = await new Command(runtimeExecPath(), {
      args: runtimeRunArgs(`${projectRoot}/main.ts`, [
        "review",
        "--json",
        `--repo=${repo}`,
        "--token=fake",
        "--high-model=fake/model",
      ]),
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: reposDir,
        // An empty tools dir: codegraph is never present, no matter the host.
        CM_TOOLS_DIR: `${root}/tools`,
        // The regression was a closed stdin looking interactive; keep it closed
        // and make sure the run still finishes.
        CM_FAKE_AI: "1",
      },
      stdout: "piped",
      stderr: "piped",
      // Before the fix this hung here waiting for an answer.
      timeoutMs: 30_000,
    }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    if (result.code === 124) {
      throw new Error(`review hung instead of finishing:\n${stderr}`);
    }
    // The F01 crash signature must be gone.
    if (result.code === 13) {
      throw new Error(`review exited 13:\n${stderr}`);
    }
    if (/unsettled top-level await/.test(stderr)) {
      throw new Error(`unsettled await in stderr:\n${stderr}`);
    }
    // And it must not have asked a question nobody could answer.
    if (/\[y\/N\]/.test(stderr)) {
      throw new Error(`review asked for input:\n${stderr}`);
    }
    // The run should still produce a JSON result, with codegraph unavailable.
    let body: { ok?: boolean; codegraph?: { state?: string } };
    try {
      body = JSON.parse(stdout) as typeof body;
    } catch {
      throw new Error(
        `stdout was not JSON (exit ${result.code}):\n${stdout}\n${stderr}`,
      );
    }
    if (body.ok === undefined) {
      throw new Error(`unexpected JSON: ${stdout}`);
    }
    if (body.codegraph?.state === "used") {
      throw new Error(`codegraph reported used but is absent: ${stdout}`);
    }
  } finally {
    await removePath(root, { recursive: true });
  }
});
