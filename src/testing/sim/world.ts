/** The world `e2e:simulate` runs in.
 *
 * One sandbox directory that every config, cache, repository and database path
 * points at, so a run never touches the machine's real files. A repository is
 * a real git repository inside the sandbox; the simulated GitHub in
 * `github.ts` reads it, so trees, contents, pull request files and compares
 * are what git says, not fixtures.
 *
 * Everything runs in this process: the env is set on `process.env` before any
 * product module is used, and the product reads it at call time. Each flow
 * gets its own world, so one flow's files and databases never reach another
 * flow's checks. */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { TEST_PKCS1_PEM } from "../fixtures/rsa_key.ts";
import { SimGithub } from "./github.ts";

export type SimRepo = {
  fullName: string;
  defaultBranch: string;
  /** The working repository on disk. GitHub's copy of the repository. */
  dir: string;
};

/** The credentials a run hands the product. Each is random per world, so a
 * leak check can search for it without matching ordinary text. */
export type Secrets = {
  pat: string;
  aiKey: string;
  webhookSecret: string;
  appId: string;
  appPrivateKey: string;
  /** Any further secret a flow hands the product, such as a remote token. */
  extra: Record<string, string>;
};

export type World = {
  root: string;
  /** Where every git process appends its trace2 events. */
  gitTracePath: string;
  repos: Map<string, SimRepo>;
  github: SimGithub;
  secrets: Secrets;
  createRepo(fullName: string, files: Record<string, string>): SimRepo;
  git(repo: SimRepo, args: string[]): Buffer;
  /** Merges `patch` into the product's `config.json`. */
  writeConfig(patch: Record<string, unknown>): void;
  readConfig(): Record<string, unknown>;
  /** Name and value of every secret, for the leak check. */
  secretValues(): { name: string; value: string }[];
  /** Points `GITHUB_STEP_SUMMARY` at a file in the sandbox, for a flow that
   * checks what `--output=github` writes there, and returns its path. */
  useStepSummary(): string;
  /** Deletes the sandbox and puts the shell's environment back. */
  dispose(): void;
};

const token = (prefix: string) => `${prefix}${randomBytes(12).toString("hex")}`;

/** Prefixes of the variables the product reads for a credential, a host or
 * a behavior. A key in the shell (`OPENROUTER_API_KEY`, `GH_TOKEN`) would win
 * over the world's own, and `GITHUB_STEP_SUMMARY` would reach the real job
 * summary. `world.test.ts` greps the product for every variable it reads and
 * fails when one is not covered here. */
export const PRODUCT_ENV_PREFIXES = [
  "CM_",
  "CO_MAINTAINER_",
  "OPENROUTER_",
  "OPENCODE_",
  "OPENAI_",
  "ANTHROPIC_",
  "GITHUB_",
  "GH_",
  "GIT_",
  "XDG_",
];

/** Variables the product reads that no prefix above covers. */
export const PRODUCT_ENV_NAMES = [
  "CI",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LOW_MODEL",
  "HIGH_MODEL",
];

function productReads(key: string): boolean {
  return (
    PRODUCT_ENV_NAMES.includes(key) ||
    PRODUCT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export type WorldOptions = {
  /** The AI key a live run uses. Without it the world makes up one. */
  aiKey?: string;
};

export function createWorld(worldOptions: WorldOptions = {}): World {
  const root = mkdtempSync(join(tmpdir(), "cm-simulate-"));
  const gitTracePath = join(root, "git-trace.jsonl");
  const home = join(root, "home");
  const githubDir = join(root, "github");
  mkdirSync(home, { recursive: true });
  mkdirSync(githubDir, { recursive: true });

  // The world owns the environment until `dispose` puts the shell's back.
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (productReads(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    // The product never prompts and waits on stdin, in a terminal or in CI.
    CI: "1",
    CM_CONFIG_PATH: join(root, "config.json"),
    CM_REPOS_DIR: join(root, "repos"),
    CM_APP_DB: join(root, "app.db"),
    CM_CLONES_DIR: join(root, "clones"),
    CM_TOOLS_DIR: join(root, "tools"),
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
    // The product clones `https://github.com/<repo>`. git rewrites that to the
    // sandbox's repositories, so a clone never leaves the machine and sees
    // the same commits the simulated API answers from.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(githubDir).href}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  });

  const repos = new Map<string, SimRepo>();
  const secrets: Secrets = {
    pat: token("sim-pat-"),
    aiKey: worldOptions.aiKey ?? token("sim-ai-key-"),
    webhookSecret: token("sim-webhook-"),
    appId: "424242",
    appPrivateKey: TEST_PKCS1_PEM,
    extra: {},
  };

  function git(repo: SimRepo, args: string[]): Buffer {
    const result = spawnSync("git", args, { cwd: repo.dir });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
    return result.stdout;
  }

  const configPath = join(root, "config.json");
  const readConfig = (): Record<string, unknown> =>
    existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};

  const world: World = {
    root,
    gitTracePath,
    repos,
    secrets,
    github: undefined as unknown as SimGithub,
    git,
    createRepo(fullName, files) {
      const repo: SimRepo = {
        fullName,
        defaultBranch: "main",
        dir: join(githubDir, fullName),
      };
      for (const [path, content] of Object.entries(files)) {
        const target = join(repo.dir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      git(repo, ["init", "-q", "-b", repo.defaultBranch]);
      // A partial clone and a fetch by sha are what the product asks of
      // GitHub. A plain repository refuses both unless told otherwise.
      git(repo, ["config", "uploadpack.allowFilter", "true"]);
      git(repo, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "initial"]);
      repos.set(fullName, repo);
      return repo;
    },
    writeConfig(patch) {
      writeFileSync(
        configPath,
        `${JSON.stringify({ ...readConfig(), ...patch }, null, 2)}\n`,
      );
    },
    readConfig,
    secretValues() {
      return [
        { name: "GitHub token", value: secrets.pat },
        { name: "AI key", value: secrets.aiKey },
        { name: "webhook secret", value: secrets.webhookSecret },
        // One line of the key body: the whole PEM is rarely copied intact,
        // and the header line is not secret.
        {
          name: "App private key",
          value: secrets.appPrivateKey.split("\n")[1] ?? "",
        },
        ...Object.entries(secrets.extra).map(([name, value]) => ({
          name,
          value,
        })),
      ].filter((secret) => secret.value.length >= 8);
    },
    useStepSummary() {
      const path = join(root, "github-step-summary.md");
      process.env.GITHUB_STEP_SUMMARY = path;
      return path;
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    },
  };
  world.github = new SimGithub(world);
  return world;
}
