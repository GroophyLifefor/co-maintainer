/** A git working copy and an isolated home for running `review` as a child
 * process. Config, cache, locks and guides all live under one temp directory,
 * so a test never touches the developer's own. Shared by tests only. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Command,
  envToObject,
  mkdirPath,
  removePath,
  runtimeRunArgs,
  tempDir,
  writeTextFile,
} from "./runtime.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export type LocalReviewSandbox = {
  /** The temp directory everything lives in, removed by `cleanup`. */
  home: string;
  repo: string;
  worktree: string;
  /** Where the local review lock files go. Empty when no review holds one. */
  locksDir: string;
  /** The child's environment, with the AI calls sent to `openrouterUrl`. */
  env: (openrouterUrl: string) => Record<string, string | undefined>;
  /** `main.ts review ...extra` as runtime arguments. */
  reviewArgs: (extra?: string[]) => string[];
  cleanup: () => Promise<void>;
};

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

/** A repository with guides and a branch one commit ahead of `origin/main`.
 * With `clean`, the branch is `origin/main` itself, so there is nothing to
 * review. */
export async function createLocalReviewSandbox(
  options: { clean?: boolean } = {},
): Promise<LocalReviewSandbox> {
  const home = await tempDir({ prefix: "cm-local-review-" });
  const repo = "sandbox/local-review";
  const worktree = `${home}/worktree`;
  await mkdirPath(`${home}/repos/${repo}`, { recursive: true });
  await writeTextFile(
    `${home}/repos/${repo}/PR_REVIEW_GUIDE.md`,
    "# Guide\n\n- Check the change.\n",
  );
  await mkdirPath(`${home}/config`, { recursive: true });
  await writeTextFile(
    `${home}/config/config.json`,
    JSON.stringify({
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    }),
  );
  await mkdirPath(worktree, { recursive: true });
  await git(worktree, ["init"]);
  await git(worktree, ["config", "user.email", "t@t"]);
  await git(worktree, ["config", "user.name", "t"]);
  await writeTextFile(`${worktree}/x.ts`, "export {};\n");
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
  if (!options.clean) {
    await writeTextFile(
      `${worktree}/x.ts`,
      "export const y = 1 / Number(0);\n",
    );
    await git(worktree, ["add", "x.ts"]);
    await git(worktree, ["commit", "-m", "change"]);
  }
  return {
    home,
    repo,
    worktree,
    locksDir: `${home}/cache/co-maintainer/locks`,
    env: (openrouterUrl) => ({
      ...envToObject(),
      CM_CONFIG_PATH: `${home}/config/config.json`,
      CM_REPOS_DIR: `${home}/repos`,
      CM_CLONES_DIR: `${home}/clones`,
      APPDATA: `${home}/appdata`,
      LOCALAPPDATA: `${home}/localappdata`,
      XDG_CONFIG_HOME: `${home}/config`,
      XDG_CACHE_HOME: `${home}/cache`,
      XDG_DATA_HOME: `${home}/data`,
      CM_OPENROUTER_URL: openrouterUrl,
      // The suite runs with the fake AI on. These tests count the calls that
      // reach the fake OpenRouter server, so the real provider path is used.
      CM_FAKE_AI: undefined,
      CM_FAKE_REVIEW_FILE: undefined,
      CI: "1",
    }),
    reviewArgs: (extra = []) =>
      runtimeRunArgs(join(projectRoot, "main.ts"), [
        "review",
        `--repo=${repo}`,
        "--disable-codegraph",
        ...extra,
      ]),
    cleanup: () => removePath(home, { recursive: true }),
  };
}
