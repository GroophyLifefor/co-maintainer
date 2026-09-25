/** Wire-level CLI harness (CORE-03).
 *
 * Runs `main.ts` as a real child process with isolated config, cache, repos and
 * temp directories, a fake `gh` on `CM_GH_BIN`, and optionally a fake
 * OpenRouter server. Nothing here is a unit-test fake: the point is to exercise
 * the same spawn, PATH, `.cmd` and network paths a user hits.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envToObject,
  makeTempDir,
  mkdir,
  remove,
  writeTextFile,
} from "../util/runtime.ts";
import { commandOutput } from "../util/runtime.ts";
import { runtimeExecPath, runtimeRunArgs } from "./runtime.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fakeGhDir = join(projectRoot, "src/testing/fake_gh");

export type RunCliOptions = {
  args: string[];
  /** Working directory for the CLI. Defaults to the project root. */
  cwd?: string;
  /** Extra environment on top of the isolated defaults. */
  env?: Record<string, string | undefined>;
  /** Reuse a config file written by a previous run. */
  configPath?: string;
  /** Reuse a repos directory written by a previous run. */
  reposDir?: string;
  /** `ok`, `notfound`, `forbidden`, `noauth`, or `empty-stderr`. */
  ghMode?: "ok" | "notfound" | "forbidden" | "noauth" | "empty-stderr";
  /** Overrides `CM_OPENROUTER_URL`; a fake server's url goes here. */
  openrouterUrl?: string;
};

export type CliResult = {
  /** The child's exit code; 124 means the timeout killed it. */
  code: number;
  stdout: string;
  stderr: string;
  /** Instant when the run finished, for ordering against external state. */
  finishedAt: number;
  /** Where the run's config, cache and repos live, for assertions. */
  home: string;
  configPath: string;
  reposDir: string;
};

export type CliHarness = {
  /** A directory every run shares unless overridden, removed by `cleanup`. */
  home: string;
  run: (options: RunCliOptions) => Promise<CliResult>;
  cleanup: () => Promise<void>;
};

/** The command and argument prefix the harness puts in front of `api`. On
 * Windows the fake runs as `node gh.mjs` because Node cannot resolve an
 * extensionless command to a `.cmd` through PATH, and a shell would mangle an
 * endpoint's `?`/`&`. */
export function fakeGhBin(): { command: string; script: string } {
  return { command: process.execPath, script: join(fakeGhDir, "gh.mjs") };
}

export async function createCliHarness(): Promise<CliHarness> {
  const home = await makeTempDir({ prefix: "cm-harness-" });
  const gh = fakeGhBin();

  async function run(options: RunCliOptions): Promise<CliResult> {
    const configPath = options.configPath ?? `${home}/config/config.json`;
    const reposDir = options.reposDir ?? `${home}/repos`;
    const ghLog = `${home}/gh-calls.log`;
    // `writeConfig` creates the directory it resolves from the platform
    // (`APPDATA` on Windows, `XDG_CONFIG_HOME` elsewhere), which is not
    // necessarily the directory of an explicit `CM_CONFIG_PATH`. Without this
    // the first write into a fresh harness home fails with ENOENT.
    await mkdir(dirname(configPath), { recursive: true });
    const env: Record<string, string | undefined> = {
      ...envToObject(),
      CM_CONFIG_PATH: configPath,
      CM_REPOS_DIR: reposDir,
      CM_CLONES_DIR: `${home}/clones`,
      APPDATA: `${home}/appdata`,
      LOCALAPPDATA: `${home}/localappdata`,
      XDG_CONFIG_HOME: `${home}/config`,
      XDG_CACHE_HOME: `${home}/cache`,
      XDG_DATA_HOME: `${home}/data`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.longpaths",
      GIT_CONFIG_VALUE_0: "true",
      CM_GH_BIN: gh.command,
      CM_GH_SCRIPT: gh.script,
      CM_FAKE_GH_LOG: ghLog,
      ...(options.ghMode ? { CM_FAKE_GH_MODE: options.ghMode } : {}),
      ...(options.openrouterUrl
        ? { CM_OPENROUTER_URL: options.openrouterUrl }
        : {}),
      ...options.env,
      // The fake gh is a `.cmd` on Windows; the CLI passes `shell` for that
      // path, so no PATH edit is needed here.
    };
    const spawnOptions = {
      args: runtimeRunArgs("main.ts", options.args),
      cwd: options.cwd ?? projectRoot,
      env,
      stdout: "piped" as const,
      stderr: "piped" as const,
    };
    const result = await commandOutput(runtimeExecPath(), spawnOptions);
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      finishedAt: Date.now(),
      home,
      configPath,
      reposDir,
    };
  }

  return {
    home,
    run,
    cleanup: () => remove(home, { recursive: true }),
  };
}

/** Writes a config file with the values a run needs (provider, token,
 * models), creating its directory so a test does not have to pass five flags. */
export async function writeHarnessConfig(
  configPath: string,
  values: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeTextFile(configPath, `${JSON.stringify(values, null, 2)}\n`);
}
