import { dirname, join } from "node:path";
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

test("review_cli: not_initialized without guides (E159)", async () => {
  const tmp = await tempDir({ prefix: "cm-not-init-" });
  const configPath = `${tmp}/config.json`;
  const reposDir = `${tmp}/repos`;
  const worktree = `${tmp}/worktree`;
  const repo = "e2e-local/no-guides";
  await mkdirPath(worktree, { recursive: true });
  await writeTextFile(
    configPath,
    JSON.stringify({
      auth: "gh",
      ai: "openrouter",
      token: "fake",
      highModel: "fake/model",
    }),
  );
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

  try {
    const result = await new Command(runtimeExecPath(), {
      args: runtimeRunArgs(join(projectRoot, "main.ts"), [
        "review",
        "--json",
        `--repo=${repo}`,
        "--disable-codegraph",
        "--token=fake",
        "--high-model=fake/model",
      ]),
      // The child runs the entrypoint with its own cwd set to the temp worktree.
      // `process.chdir` here would not reach it, and then the child would inspect
      // whatever HEAD the CI checkout happens to be on (detached on a PR, which
      // is the `detached_head` failure this test exists to avoid).
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: reposDir,
        CM_FAKE_AI: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const body = JSON.parse(new TextDecoder().decode(result.stdout));
    if (body.ok !== false || body.error?.code !== "not_initialized") {
      throw new Error(JSON.stringify(body));
    }
    if (body.exitCode !== 2) {
      throw new Error(`exitCode ${body.exitCode}`);
    }
  } finally {
    await removePath(tmp, { recursive: true });
  }
});

test("review_cli: remake-before-review requires gh auth (E160)", async () => {
  const tmp = await tempDir({ prefix: "cm-remake-" });
  const configPath = `${tmp}/config.json`;
  const reposDir = `${tmp}/repos`;
  const worktree = `${tmp}/worktree`;
  const repo = "e2e-local/remake";
  const repoDir = `${reposDir}/${repo}`;
  await mkdirPath(repoDir, { recursive: true });
  await writeTextFile(`${repoDir}/PR_REVIEW_GUIDE.md`, "# Guide\n");
  await mkdirPath(worktree, { recursive: true });
  await writeTextFile(
    configPath,
    JSON.stringify({
      auth: "pat",
      ai: "openrouter",
      token: "fake",
      highModel: "fake/model",
      githubPat: "pat",
    }),
  );
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

  try {
    const result = await new Command(runtimeExecPath(), {
      args: runtimeRunArgs(join(projectRoot, "main.ts"), [
        "review",
        "--json",
        `--repo=${repo}`,
        "--auth=pat",
        "--github-pat=fake",
        "--remake-before-review",
        "--disable-codegraph",
        "--token=fake",
        "--high-model=fake/model",
      ]),
      // Same reason as the first test: the child's cwd carries the temp
      // worktree, not this process's own HEAD.
      cwd: worktree,
      env: {
        ...envToObject(),
        CM_CONFIG_PATH: configPath,
        CM_REPOS_DIR: reposDir,
        CM_FAKE_AI: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const body = JSON.parse(new TextDecoder().decode(result.stdout));
    if (body.ok !== false || body.error?.code !== "usage") {
      throw new Error(JSON.stringify(body));
    }
  } finally {
    await removePath(tmp, { recursive: true });
  }
});
