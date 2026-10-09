/** The shared clear service: what disappears, what stays, and when a database
 * must not be created just to delete from it. */
import { test } from "node:test";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  readDir,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import {
  appDbPath,
  backupPaths,
  closeAppDb,
  isAppDbOpen,
  openAppDb,
} from "../store/app_db.ts";
import { cacheDbExists, cacheGet, cacheSet } from "../store/cache_db.ts";
import { activateRepo, getRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { getDrift, upsertDrift } from "../store/drift.ts";
import { getJob, insertJob, setJobStatus } from "../store/jobs.ts";
import {
  cacheDbPath,
  cloneDir,
  configPath,
  locksDir,
  readConfig,
  repoWorktreesDir,
  reposDir,
  toolsDir,
  worktreesDir,
} from "../config.ts";
import { stat } from "../util/runtime.ts";
import {
  cancelOrphanedJobs,
  cancelQueuedJobs,
  clearAllKnowledge,
  clearRepo,
  isSafeRepoName,
  listStoredRepos,
  uninstallData,
} from "./clear.ts";

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

/** Every path the service reads is pointed at one throwaway directory, so a
 * test can never touch the real config, guides or databases. */
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
    // Close before restoring the env: the lock path is read at close time.
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

async function seedGuides(repo: string, files: string[]): Promise<void> {
  await mkdirPath(`${reposDir()}/${repo}`, { recursive: true });
  for (const file of files) {
    await writeTextFile(`${reposDir()}/${repo}/${file}`, "# guide\n");
  }
}

async function seedCache(repo: string): Promise<void> {
  await cacheSet("state", repo, "{}");
  await cacheSet("pr-listing", repo, "{}");
  await cacheSet("probe", repo, "{}");
  await cacheSet("ai-jobs", `${repo}:low`, "{}");
  await cacheSet("cost", `${repo}:job`, "{}");
  await cacheSet("local-review", `${repo}\u0000/root\u0000main`, "{}");
}

test("clearRepo forgets knowledge and settings and keeps fetched evidence", async () => {
  await sandbox(async () => {
    await openAppDb();
    activateRepo("acme/widgets", undefined);
    markKnowledgeBuilt("acme/widgets", "abc");
    upsertDrift({
      repo: "acme/widgets",
      as_of: new Date().toISOString(),
      prs_since: 1,
      prs_updated: 0,
      commits_since: 1,
      files_changed: 1,
    });
    await seedGuides("acme/widgets", ["PR_REVIEW_GUIDE.md", "SKILL.md"]);
    await seedCache("acme/widgets");
    await writeTextFile(
      configPath(),
      JSON.stringify({ repos: { "acme/widgets": { maxCommits: 5 } } }),
    );

    const result = await clearRepo("acme/widgets");
    if (result.guides !== 2) throw new Error(`guides ${result.guides}`);
    if (!result.settings) throw new Error("settings were not reported");
    if (await exists(`${reposDir()}/acme/widgets`)) {
      throw new Error("the guide directory survived");
    }
    if (getRepo("acme/widgets")?.knowledge_built_at !== null) {
      throw new Error("knowledge_built_at survived");
    }
    if (getDrift("acme/widgets") !== undefined) {
      throw new Error("drift survived");
    }
    if ((await cacheGet("state", "acme/widgets")) !== undefined) {
      throw new Error("skill state survived");
    }
    if ((await cacheGet("pr-listing", "acme/widgets")) === undefined) {
      throw new Error("evidence was deleted without includeCache");
    }
    if ("acme/widgets" in (readConfig().repos ?? {})) {
      throw new Error("the saved repo settings survived");
    }
  });
});

test("includeCache removes evidence, clones, worktrees and the legacy state", async () => {
  await sandbox(async (dir) => {
    await seedGuides("acme/widgets", ["SKILL.md"]);
    await seedCache("acme/widgets");
    await mkdirPath(cloneDir("acme/widgets"), { recursive: true });
    await mkdirPath(repoWorktreesDir("acme/widgets"), { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      await mkdirPath(".cache/acme/widgets", { recursive: true });
      await writeTextFile(".cache/acme/widgets/state.json", "{}");

      const result = await clearRepo("acme/widgets", { includeCache: true });
      if (result.cacheRows !== 6) throw new Error(`rows ${result.cacheRows}`);
      if (!result.clones || !result.worktrees) {
        throw new Error("clone or worktree was not reported");
      }
      for (const [namespace, key] of [
        ["state", "acme/widgets"],
        ["pr-listing", "acme/widgets"],
        ["probe", "acme/widgets"],
        ["ai-jobs", "acme/widgets:low"],
        ["cost", "acme/widgets:job"],
        ["local-review", "acme/widgets\u0000/root\u0000main"],
      ] as const) {
        if ((await cacheGet(namespace, key)) !== undefined) {
          throw new Error(`${namespace} row survived`);
        }
      }
      if (await exists(cloneDir("acme/widgets"))) {
        throw new Error("the clone survived");
      }
      if (await exists(repoWorktreesDir("acme/widgets"))) {
        throw new Error("the worktrees survived");
      }
      if (await exists(".cache/acme/widgets")) {
        throw new Error("the legacy state survived");
      }
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("clearAllKnowledge keeps the cache database without includeCache", async () => {
  await sandbox(async () => {
    await openAppDb();
    activateRepo("acme/widgets", undefined);
    markKnowledgeBuilt("acme/widgets", "abc");
    await seedGuides("acme/widgets", ["SKILL.md"]);
    await seedGuides("acme/gadgets", ["SKILL.md", "CODEBASE.md"]);
    await seedCache("acme/widgets");
    await cacheSet("state", "acme/gadgets", "{}");
    await writeTextFile(
      configPath(),
      JSON.stringify({
        repos: {
          "acme/widgets": {},
          "acme/remembered": {},
        },
      }),
    );

    const result = await clearAllKnowledge();
    const names = result.repos.map((repo) => repo.repo);
    for (const wanted of ["acme/gadgets", "acme/remembered", "acme/widgets"]) {
      if (!names.includes(wanted)) throw new Error(`missed ${wanted}`);
    }
    if (!result.settings) throw new Error("settings were not reported");
    if (readConfig().repos !== undefined) {
      throw new Error("config.repos survived");
    }
    if (!(await cacheDbExists())) throw new Error("cache.db was deleted");
    if ((await cacheGet("state", "acme/widgets")) !== undefined) {
      throw new Error("skill state survived");
    }
    if ((await cacheGet("pr-listing", "acme/widgets")) === undefined) {
      throw new Error("evidence was deleted without includeCache");
    }
    if ((await cacheGet("state", "acme/gadgets")) !== undefined) {
      throw new Error("second repo state survived");
    }
    for await (const entry of readDir(reposDir())) {
      throw new Error(`an owner directory survived: ${entry.name}`);
    }
  });
});

test("clearAllKnowledge with includeCache takes the cache database with it", async () => {
  await sandbox(async () => {
    await seedGuides("acme/widgets", ["SKILL.md"]);
    await seedCache("acme/widgets");
    await mkdirPath(cloneDir("acme/widgets"), { recursive: true });
    await mkdirPath(repoWorktreesDir("acme/widgets"), { recursive: true });

    const result = await clearAllKnowledge({ includeCache: true });
    if (!result.cacheFile) throw new Error("cache.db was not reported");
    if (!result.clones || !result.worktrees) {
      throw new Error("clones or worktrees were not reported");
    }
    if (await cacheDbExists()) throw new Error("cache.db survived");
    if (await exists(cloneDir("acme/widgets"))) {
      throw new Error("the clone survived");
    }
    if (await exists(worktreesDir())) throw new Error("wt survived");
  });
});

test("clearAllKnowledge drops repository names that would escape the repos root", async () => {
  await sandbox(async (dir) => {
    await seedGuides("acme/widgets", ["SKILL.md"]);
    await seedGuides("other/repo", ["SKILL.md"]);
    // A hand-edited config can hold a key that resolves outside its own
    // directory. `acme/..` is the repos root and `../..` is the sandbox.
    await writeTextFile(
      configPath(),
      JSON.stringify({
        repos: { "acme/..": {}, "../..": {}, "acme/widgets": {} },
      }),
    );
    await writeTextFile(`${dir}/sentinel.txt`, "keep\n");

    const listed = await listStoredRepos();
    if (listed.join(",") !== "acme/widgets,other/repo") {
      throw new Error(`unsafe names leaked into the list: ${listed.join(",")}`);
    }

    const result = await clearAllKnowledge();
    if (result.repos.length !== 2) {
      throw new Error(`cleared ${result.repos.length} repositories`);
    }
    if (!(await exists(`${dir}/sentinel.txt`))) {
      throw new Error("the clear escaped the repos root");
    }
    if (!(await exists(reposDir()))) {
      throw new Error("the repos root itself was deleted");
    }
    if (readConfig().repos !== undefined) {
      throw new Error("the unsafe config entries survived");
    }
  });
});

test("clear never creates a database that was not there", async () => {
  await sandbox(async () => {
    await seedGuides("acme/widgets", ["SKILL.md"]);
    await clearRepo("acme/widgets");
    if (await cacheDbExists()) throw new Error("cache.db was created");
    if (await exists(appDbPath())) throw new Error("app.db was created");
  });
});

test("queued jobs are canceled and orphaned running rows are finished", async () => {
  await sandbox(async () => {
    await openAppDb();
    insertJob({ id: "q1", type: "init", repo: "acme/widgets" });
    insertJob({ id: "r1", type: "remake", repo: "acme/widgets" });
    setJobStatus("r1", "running");
    insertJob({ id: "other", type: "init", repo: "acme/other" });

    if (cancelQueuedJobs(["acme/widgets"]) !== 1) {
      throw new Error("queued job was not canceled");
    }
    if (cancelOrphanedJobs(["acme/widgets"]) !== 1) {
      throw new Error("orphaned job was not canceled");
    }
    if (getJob("q1")?.status !== "canceled") {
      throw new Error(`q1 ${getJob("q1")?.status}`);
    }
    if (getJob("q1")?.cancel_reason !== "knowledge_cleared") {
      throw new Error("q1 lost its cancel reason");
    }
    if (getJob("r1")?.status !== "canceled") {
      throw new Error(`r1 ${getJob("r1")?.status}`);
    }
    if (getJob("other")?.status !== "queued") {
      throw new Error("a job for another repo was canceled");
    }
  });
});

test("evidence deletion does not touch a repository that shares the prefix", async () => {
  await sandbox(async () => {
    await cacheSet("cost", "acme/foo_bar:1", "{}");
    await cacheSet("cost", "acme/fooXbar:1", "{}");
    await clearRepo("acme/foo_bar", { includeCache: true });
    if ((await cacheGet("cost", "acme/foo_bar:1")) !== undefined) {
      throw new Error("the target row survived");
    }
    if ((await cacheGet("cost", "acme/fooXbar:1")) === undefined) {
      throw new Error("LIKE wildcards hit another repository");
    }
  });
});

test("isSafeRepoName rejects path escapes", () => {
  for (const bad of [
    "../..",
    "acme/..",
    "acme/",
    "/widgets",
    "a b/c",
    "a/b c",
  ]) {
    if (isSafeRepoName(bad)) throw new Error(`${bad} was accepted`);
  }
  for (const good of ["acme/widgets", "acme/widgets.js", "acme/foo_bar-baz"]) {
    if (!isSafeRepoName(good)) throw new Error(`${good} was rejected`);
  }
});

test("listStoredRepos unions guide directories and remembered settings", async () => {
  await sandbox(async () => {
    await seedGuides("acme/widgets", ["SKILL.md"]);
    await seedGuides("acme/gadgets", ["SKILL.md"]);
    await writeTextFile(`${reposDir()}/loose-file.txt`, "x");
    await writeTextFile(
      configPath(),
      JSON.stringify({ repos: { "acme/remembered": {} } }),
    );
    const repos = await listStoredRepos();
    if (repos.join(",") !== "acme/gadgets,acme/remembered,acme/widgets") {
      throw new Error(`unexpected list: ${repos.join(",")}`);
    }
  });
});

test("uninstallData removes every data path and the empty parent directories", async () => {
  await sandbox(async (dir) => {
    await seedGuides("acme/widgets", ["SKILL.md"]);
    await writeTextFile(configPath(), "{}\n");
    await cacheSet("state", "acme/widgets", "{}");
    await mkdirPath(cloneDir("acme/widgets"), { recursive: true });
    await mkdirPath(repoWorktreesDir("acme/widgets"), { recursive: true });
    await mkdirPath(locksDir(), { recursive: true });
    await writeTextFile(`${locksDir()}/deadbeef.lock`, "1");
    await mkdirPath(toolsDir(), { recursive: true });
    // Left open on purpose: uninstall must close it before deleting.
    await openAppDb();

    const result = await uninstallData();
    for (const target of [
      configPath(),
      cacheDbPath(),
      appDbPath(),
      backupPaths().version,
      reposDir(),
      cloneDir("acme/widgets"),
      worktreesDir(),
      locksDir(),
      toolsDir(),
      `${dir}/config/co-maintainer`,
      `${dir}/cache/co-maintainer`,
    ]) {
      if (await exists(target)) throw new Error(`${target} survived`);
    }
    if (!result.paths.includes(configPath())) {
      throw new Error("the config was not reported as removed");
    }
  });
});
