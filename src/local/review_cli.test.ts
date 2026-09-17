import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

Deno.test("review_cli: not_initialized without guides (E159)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cm-not-init-" });
  const configPath = `${tmp}/config.json`;
  const reposDir = `${tmp}/repos`;
  const worktree = `${tmp}/worktree`;
  const repo = "e2e-local/no-guides";
  await Deno.mkdir(worktree, { recursive: true });
  await Deno.writeTextFile(
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
  await Deno.writeTextFile(`${worktree}/x.ts`, "export {}\n");
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
  await Deno.writeTextFile(`${worktree}/x.ts`, "export const y = 1\n");
  await git(worktree, ["add", "x.ts"]);
  await git(worktree, ["commit", "-m", "change"]);

  const prev = Deno.cwd();
  Deno.chdir(worktree);
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "main.ts",
        "review",
        "--json",
        `--repo=${repo}`,
        "--disable-codegraph",
        "--token=fake",
        "--high-model=fake/model",
      ],
      cwd: projectRoot,
      env: {
        ...Deno.env.toObject(),
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
    Deno.chdir(prev);
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("review_cli: remake-before-review requires gh auth (E160)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cm-remake-" });
  const configPath = `${tmp}/config.json`;
  const reposDir = `${tmp}/repos`;
  const worktree = `${tmp}/worktree`;
  const repo = "e2e-local/remake";
  const repoDir = `${reposDir}/${repo}`;
  await Deno.mkdir(repoDir, { recursive: true });
  await Deno.writeTextFile(`${repoDir}/PR_REVIEW_GUIDE.md`, "# Guide\n");
  await Deno.mkdir(worktree, { recursive: true });
  await Deno.writeTextFile(
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
  await Deno.writeTextFile(`${worktree}/x.ts`, "export {}\n");
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
  await Deno.writeTextFile(`${worktree}/x.ts`, "export const y = 1\n");
  await git(worktree, ["add", "x.ts"]);
  await git(worktree, ["commit", "-m", "change"]);

  const prev = Deno.cwd();
  Deno.chdir(worktree);
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "main.ts",
        "review",
        "--json",
        `--repo=${repo}`,
        "--auth=pat",
        "--github-pat=fake",
        "--remake-before-review",
        "--disable-codegraph",
        "--token=fake",
        "--high-model=fake/model",
      ],
      cwd: projectRoot,
      env: {
        ...Deno.env.toObject(),
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
    Deno.chdir(prev);
    await Deno.remove(tmp, { recursive: true });
  }
});
