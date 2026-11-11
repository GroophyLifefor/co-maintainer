/** The world `e2e:simulate` runs in.
 *
 * One sandbox directory that every config, cache, repository and database path
 * points at, so a run never touches the machine's real files. A repository is
 * a real git repository inside the sandbox; the simulated GitHub in
 * `fetch.ts` reads it, so trees and contents are what git says, not fixtures.
 *
 * Everything runs in this process: the env is set on `process.env` before any
 * product module is imported, and the product reads it at call time. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type SimRepo = {
  fullName: string;
  defaultBranch: string;
  /** The working repository on disk. */
  dir: string;
};

export type World = {
  root: string;
  /** Where every git process appends its trace2 events. */
  gitTracePath: string;
  repos: Map<string, SimRepo>;
  createRepo(fullName: string, files: Record<string, string>): SimRepo;
  git(repo: SimRepo, args: string[]): Buffer;
  dispose(): void;
};

export function createWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "cm-simulate-"));
  const gitTracePath = join(root, "git-trace.jsonl");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  // A `CM_*` variable left in the shell (`CM_OPENROUTER_URL`, `CM_FAKE_AI`)
  // would send the product somewhere the simulation does not answer.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CM_")) delete process.env[key];
  }
  Object.assign(process.env, {
    CM_CONFIG_PATH: join(root, "config.json"),
    CM_REPOS_DIR: join(root, "repos"),
    CM_APP_DB: join(root, "app.db"),
    CM_CLONES_DIR: join(root, "clones"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    // Windows and macOS derive the cache and config directories from these.
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    HOME: home,
    USERPROFILE: home,
    GIT_AUTHOR_NAME: "e2e simulate",
    GIT_AUTHOR_EMAIL: "simulate@example.com",
    GIT_COMMITTER_NAME: "e2e simulate",
    GIT_COMMITTER_EMAIL: "simulate@example.com",
    GIT_TRACE2_EVENT: gitTracePath,
  });

  const repos = new Map<string, SimRepo>();

  function git(repo: SimRepo, args: string[]): Buffer {
    const result = spawnSync("git", args, { cwd: repo.dir });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
    return result.stdout;
  }

  return {
    root,
    gitTracePath,
    repos,
    git,
    createRepo(fullName, files) {
      const repo: SimRepo = {
        fullName,
        defaultBranch: "main",
        dir: join(root, "github", fullName),
      };
      for (const [path, content] of Object.entries(files)) {
        const target = join(repo.dir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      git(repo, ["init", "-q", "-b", repo.defaultBranch]);
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "initial"]);
      repos.set(fullName, repo);
      return repo;
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
