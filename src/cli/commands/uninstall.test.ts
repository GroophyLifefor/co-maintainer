/** `co-maintainer uninstall`: it deletes every data path, leaves the npm
 * package alone and says how to remove that too. */
import { test } from "node:test";
import { run, reportCliError } from "../main.ts";
import {
  appDbPath,
  closeAppDb,
  isAppDbOpen,
  openAppDb,
} from "../../store/app_db.ts";
import { cacheSet } from "../../store/cache_db.ts";
import { cacheDbPath, configPath, reposDir, toolsDir } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../../testing/runtime.ts";
import { stat } from "../../util/runtime.ts";

type Captured = { stdout: string; stderr: string; exitCode: number };

class ExitSentinel extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

async function capture(args: string[]): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  const previousExit = process.exit;
  const previousCode = process.exitCode;
  let exitCode: number | undefined;
  console.log = (...parts: unknown[]) => stdout.push(parts.join(" "));
  console.error = (...parts: unknown[]) => stderr.push(parts.join(" "));
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitSentinel(code ?? 0);
  }) as typeof process.exit;
  process.exitCode = undefined;
  try {
    await run(args);
  } catch (thrown) {
    if (!(thrown instanceof ExitSentinel)) reportCliError(thrown);
  } finally {
    console.log = log;
    console.error = error;
    process.exit = previousExit;
    exitCode ??= process.exitCode;
    process.exitCode = previousCode;
  }
  return {
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    exitCode: exitCode ?? 0,
  };
}

const ENV_NAMES = [
  "CM_CONFIG_PATH",
  "CM_REPOS_DIR",
  "CM_APP_DB",
  "CM_CLONES_DIR",
  "CM_TOOLS_DIR",
  "XDG_CACHE_HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_CONFIG_HOME",
];

async function sandbox(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = tempDirSync();
  const saved = new Map(ENV_NAMES.map((name) => [name, getEnv(name)] as const));
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CLONES_DIR", `${dir}/clones`);
  setEnv("CM_TOOLS_DIR", `${dir}/tools`);
  setEnv("XDG_CACHE_HOME", `${dir}/cache`);
  setEnv("XDG_CONFIG_HOME", `${dir}/config`);
  setEnv("LOCALAPPDATA", `${dir}/localappdata`);
  setEnv("APPDATA", `${dir}/appdata`);
  try {
    await fn(dir);
  } finally {
    if (isAppDbOpen()) await closeAppDb();
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
    await removePath(dir, { recursive: true }).catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("uninstall deletes every data path and prints the npm command", async () => {
  await sandbox(async (dir) => {
    await mkdirPath(`${reposDir()}/acme/widgets`, { recursive: true });
    await writeTextFile(configPath(), "{}\n");
    await cacheSet("state", "acme/widgets", "{}");
    await mkdirPath(toolsDir(), { recursive: true });
    await openAppDb();
    await closeAppDb();

    const result = await capture(["uninstall", "--yes"]);
    if (result.exitCode !== 0) {
      throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
    }
    for (const target of [
      configPath(),
      cacheDbPath(),
      appDbPath(),
      reposDir(),
      toolsDir(),
      `${dir}/config/co-maintainer`,
      `${dir}/cache/co-maintainer`,
    ]) {
      if (await exists(target)) throw new Error(`${target} survived`);
    }
    if (!result.stdout.includes("npm uninstall -g co-maintainer")) {
      throw new Error(result.stdout);
    }
  });
});

test("uninstall without --yes needs a terminal", async () => {
  await sandbox(async () => {
    const result = await capture(["uninstall"]);
    if (result.exitCode !== 2) throw new Error(`exit ${result.exitCode}`);
    if (!result.stderr.includes("Uninstall needs your confirmation")) {
      throw new Error(result.stderr);
    }
  });
});

test("uninstall refuses while a live serve holds the lock", async () => {
  await sandbox(async () => {
    await writeTextFile(`${appDbPath()}.lock`, String(process.pid));
    const result = await capture(["uninstall", "--yes"]);
    if (result.exitCode !== 2) throw new Error(`exit ${result.exitCode}`);
    if (!result.stderr.includes("serve process")) {
      throw new Error(result.stderr);
    }
  });
});

test("uninstall rejects an unknown flag", async () => {
  await sandbox(async () => {
    const result = await capture(["uninstall", "--forse"]);
    if (result.exitCode !== 2) throw new Error(`exit ${result.exitCode}`);
    if (!/Unknown option: --forse/.test(result.stderr)) {
      throw new Error(result.stderr);
    }
  });
});
