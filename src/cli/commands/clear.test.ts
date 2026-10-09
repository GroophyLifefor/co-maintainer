/** `co-maintainer clear`: targets, confirmations, the serve guard and the
 * pending-job question, all through the real dispatch. */
import { test } from "node:test";
import { run, reportCliError } from "../main.ts";
import {
  closeAppDb,
  appDbPath,
  isAppDbOpen,
  openAppDb,
} from "../../store/app_db.ts";
import { getJob, insertJob } from "../../store/jobs.ts";
import {
  getRepo,
  activateRepo,
  markKnowledgeBuilt,
} from "../../store/repos.ts";
import { cacheGet, cacheSet } from "../../store/cache_db.ts";
import { configPath, readConfig, reposDir } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../../testing/runtime.ts";

type Captured = { stdout: string; stderr: string; exitCode: number };

class ExitSentinel extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** Runs the CLI with `console` and `process.exit` stood down, like the
 * registry tests, so one test can observe many paths. */
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

async function seedGuides(repo: string): Promise<void> {
  await mkdirPath(`${reposDir()}/${repo}`, { recursive: true });
  await writeTextFile(`${reposDir()}/${repo}/SKILL.md`, "# guide\n");
}

test("clear owner/repo deletes the guides and the saved settings", async () => {
  await sandbox(async () => {
    await seedGuides("acme/widgets");
    await cacheSet("state", "acme/widgets", "{}");
    await writeTextFile(
      configPath(),
      JSON.stringify({ repos: { "acme/widgets": { maxCommits: 5 } } }),
    );
    const result = await capture(["clear", "acme/widgets"]);
    if (result.exitCode !== 0) {
      throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
    }
    if (!result.stdout.includes("Cleared acme/widgets: 1 guide file(s)")) {
      throw new Error(`unexpected output: ${result.stdout}`);
    }
    if ((readConfig().repos ?? {})["acme/widgets"] !== undefined) {
      throw new Error("the saved settings survived");
    }
    if ((await cacheGet("state", "acme/widgets")) !== undefined) {
      throw new Error("the skill state survived");
    }
  });
});

test("clear without a target is a usage error", async () => {
  await sandbox(async () => {
    const result = await capture(["clear"]);
    if (result.exitCode !== 2) throw new Error(`exit ${result.exitCode}`);
    if (!result.stderr.includes("clear needs one target")) {
      throw new Error(result.stderr);
    }
  });
});

test("clear rejects a path escape", async () => {
  await sandbox(async () => {
    const result = await capture(["clear", "../.."]);
    if (result.exitCode !== 2) throw new Error(`exit ${result.exitCode}`);
    if (!result.stderr.includes("Repository must look like owner/repo")) {
      throw new Error(result.stderr);
    }
  });
});

test("clear suggests the closest flag for a typo", async () => {
  await sandbox(async () => {
    const result = await capture(["clear", "acme/widgets", "--include-cach"]);
    if (result.exitCode !== 2) throw new Error(`exit ${result.exitCode}`);
    if (!result.stderr.includes("Did you mean --include-cache?")) {
      throw new Error(result.stderr);
    }
  });
});

test("clear refuses while a live serve holds the lock", async () => {
  await sandbox(async () => {
    await writeTextFile(`${appDbPath()}.lock`, String(process.pid));
    const result = await capture(["clear", "acme/widgets"]);
    if (result.exitCode !== 2) throw new Error(`exit ${result.exitCode}`);
    if (!result.stderr.includes("serve process")) {
      throw new Error(result.stderr);
    }
  });
});

test("clear all needs --yes when there is no terminal", async () => {
  await sandbox(async () => {
    await seedGuides("acme/widgets");
    const result = await capture(["clear", "all"]);
    if (result.exitCode !== 2) throw new Error(`exit ${result.exitCode}`);
    if (!result.stderr.includes("clear all needs your confirmation")) {
      throw new Error(result.stderr);
    }
    if (!result.stderr.includes("pass --yes")) {
      throw new Error(result.stderr);
    }
  });
});

test("clear all --yes clears every stored repository", async () => {
  await sandbox(async () => {
    await seedGuides("acme/widgets");
    await seedGuides("acme/gadgets");
    const result = await capture(["clear", "all", "--yes"]);
    if (result.exitCode !== 0) {
      throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
    }
    if (!result.stdout.includes("Cleared 2 repositories.")) {
      throw new Error(result.stdout);
    }
  });
});

test("a queued job is canceled so the clear is not undone later", async () => {
  await sandbox(async () => {
    await seedGuides("acme/widgets");
    await openAppDb();
    insertJob({ id: "q1", type: "init", repo: "acme/widgets" });
    // The real CLI never holds app.db when it starts: the command opens it.
    await closeAppDb();
    const result = await capture(["clear", "acme/widgets", "--yes"]);
    if (result.exitCode !== 0) {
      throw new Error(`exit ${result.exitCode}: ${result.stderr}`);
    }
    if (!result.stdout.includes("Canceled 1 job(s).")) {
      throw new Error(result.stdout);
    }
    await openAppDb();
    try {
      if (getJob("q1")?.status !== "canceled") {
        throw new Error(`job is ${getJob("q1")?.status}`);
      }
    } finally {
      await closeAppDb();
    }
  });
});

test("clearing twice reports that there is nothing left", async () => {
  await sandbox(async () => {
    await seedGuides("acme/widgets");
    await capture(["clear", "acme/widgets"]);
    const again = await capture(["clear", "acme/widgets"]);
    if (again.exitCode !== 0) throw new Error(`exit ${again.exitCode}`);
    if (!again.stdout.includes("Nothing to clear for acme/widgets.")) {
      throw new Error(again.stdout);
    }
  });
});

test("clear keeps knowledge that belongs to another repository", async () => {
  await sandbox(async () => {
    await openAppDb();
    activateRepo("acme/widgets", undefined);
    activateRepo("acme/gadgets", undefined);
    markKnowledgeBuilt("acme/widgets", "a");
    markKnowledgeBuilt("acme/gadgets", "b");
    await seedGuides("acme/widgets");
    await seedGuides("acme/gadgets");
    await closeAppDb();

    await capture(["clear", "acme/widgets", "--yes"]);
    await openAppDb();
    try {
      if (getRepo("acme/gadgets")?.knowledge_built_at === null) {
        throw new Error("the neighbor lost its knowledge stamp");
      }
      if (getRepo("acme/widgets")?.knowledge_built_at !== null) {
        throw new Error("the target kept its knowledge stamp");
      }
    } finally {
      await closeAppDb();
    }
  });
});
