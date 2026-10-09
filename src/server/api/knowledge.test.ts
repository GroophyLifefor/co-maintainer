/** The dashboard clear routes: what they delete, and how they negotiate
 * queued jobs and a running sync before touching anything. */
import { test } from "node:test";
import { createApp } from "../app.ts";
import { closeAppDb, isAppDbOpen, openAppDb } from "../../store/app_db.ts";
import { cacheDbExists, cacheGet, cacheSet } from "../../store/cache_db.ts";
import { getJob, insertJob, setJobStatus } from "../../store/jobs.ts";
import {
  activateRepo,
  deactivateRepo,
  getRepo,
  markKnowledgeBuilt,
} from "../../store/repos.ts";
import {
  cloneDir,
  configPath,
  readConfig,
  repoWorktreesDir,
  reposDir,
  worktreesDir,
} from "../../config.ts";
import { writeUserConfig } from "../../config.ts";
import { stat } from "../../util/runtime.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../../testing/runtime.ts";

const PASSWORD = "knowledge-api-test";

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

async function withTempEnv(fn: () => Promise<void>): Promise<void> {
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
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
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

async function loggedInApp() {
  const app = createApp({ password: PASSWORD });
  const loginResponse = await app.fetch(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "co-maintainer",
      },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  const { token } = await loginResponse.json();
  return (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          "x-requested-with": "co-maintainer",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
    );
}

async function seedGuides(repo: string, files: string[]): Promise<void> {
  await mkdirPath(`${reposDir()}/${repo}`, { recursive: true });
  for (const file of files) {
    await writeTextFile(`${reposDir()}/${repo}/${file}`, "# guide\n");
  }
}

async function seedRepo(repo: string): Promise<void> {
  activateRepo(repo, 9);
  markKnowledgeBuilt(repo, "abc");
  await seedGuides(repo, ["SKILL.md", "PR_REVIEW_GUIDE.md"]);
  await cacheSet("state", repo, "{}");
  await cacheSet("pr-listing", repo, "{}");
  await writeTextFile(
    configPath(),
    JSON.stringify({
      repos: { [repo]: { maxCommits: 5 } },
    }),
  );
}

test("DELETE knowledge clears guides, settings and state", async () => {
  await withTempEnv(async () => {
    await seedRepo("acme/widgets");
    const authed = await loggedInApp();
    const response = await authed(
      "/api/repos/acme/widgets/knowledge?includeCache=1",
      { method: "DELETE" },
    );
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    if (!body.ok || body.guides !== 2 || body.settings !== true) {
      throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    }
    if (getRepo("acme/widgets")?.knowledge_built_at !== null) {
      throw new Error("knowledge_built_at survived");
    }
    if ((await cacheGet("state", "acme/widgets")) !== undefined) {
      throw new Error("skill state survived");
    }
    if ((await cacheGet("pr-listing", "acme/widgets")) !== undefined) {
      throw new Error("evidence survived includeCache");
    }
    if ("acme/widgets" in (readConfig().repos ?? {})) {
      throw new Error("saved settings survived");
    }
  });
});

test("a queued job is negotiated, then canceled on onRunning=abort", async () => {
  await withTempEnv(async () => {
    await seedRepo("acme/widgets");
    insertJob({ id: "q1", type: "init", repo: "acme/widgets" });
    const authed = await loggedInApp();

    const refused = await authed("/api/repos/acme/widgets/knowledge", {
      method: "DELETE",
    });
    if (refused.status !== 409) {
      throw new Error(`status ${refused.status}`);
    }
    const refusedBody = await refused.json();
    if (refusedBody.error?.code !== "jobs_running") {
      throw new Error(JSON.stringify(refusedBody));
    }
    if (refusedBody.error?.detail?.queued !== 1) {
      throw new Error("the queued count is missing");
    }

    const response = await authed(
      "/api/repos/acme/widgets/knowledge?onRunning=abort",
      { method: "DELETE" },
    );
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    if (getJob("q1")?.status !== "canceled") {
      throw new Error(`job is ${getJob("q1")?.status}`);
    }
    if (getRepo("acme/widgets")?.knowledge_built_at !== null) {
      throw new Error("knowledge_built_at survived");
    }
  });
});

test("a running sync refuses abort and reports it as not abortable", async () => {
  await withTempEnv(async () => {
    await seedRepo("acme/widgets");
    insertJob({ id: "r1", type: "remake", repo: "acme/widgets" });
    setJobStatus("r1", "running");
    const authed = await loggedInApp();

    const refused = await authed("/api/repos/acme/widgets/knowledge", {
      method: "DELETE",
    });
    const body = await refused.json();
    if (
      refused.status !== 409 ||
      body.error?.detail?.running?.[0]?.abortable !== false
    ) {
      throw new Error(JSON.stringify(body));
    }

    const aborted = await authed(
      "/api/repos/acme/widgets/knowledge?onRunning=abort",
      { method: "DELETE" },
    );
    const abortedBody = await aborted.json();
    if (
      aborted.status !== 409 ||
      abortedBody.error?.code !== "job_not_abortable"
    ) {
      throw new Error(JSON.stringify(abortedBody));
    }
    if (getJob("r1")?.status !== "running") {
      throw new Error("the running sync was touched");
    }
  });
});

test("a running review is abortable and does not block the clear", async () => {
  await withTempEnv(async () => {
    await seedRepo("acme/widgets");
    insertJob({ id: "v1", type: "review", repo: "acme/widgets", prNumber: 1 });
    setJobStatus("v1", "running");
    const authed = await loggedInApp();
    const response = await authed(
      "/api/repos/acme/widgets/knowledge?onRunning=abort",
      { method: "DELETE" },
    );
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    if (getRepo("acme/widgets")?.knowledge_built_at !== null) {
      throw new Error("knowledge_built_at survived");
    }
  });
});

test("an inactive repository answers 404", async () => {
  await withTempEnv(async () => {
    activateRepo("acme/widgets", 9);
    deactivateRepo("acme/widgets");
    const authed = await loggedInApp();
    const response = await authed("/api/repos/acme/widgets/knowledge", {
      method: "DELETE",
    });
    if (response.status !== 404) throw new Error(`status ${response.status}`);
  });
});

test("DELETE /api/knowledge clears every stored repository", async () => {
  await withTempEnv(async () => {
    await seedRepo("acme/widgets");
    activateRepo("acme/gadgets", 9);
    markKnowledgeBuilt("acme/gadgets", "def");
    await seedGuides("acme/gadgets", ["SKILL.md"]);
    await cacheSet("state", "acme/gadgets", "{}");
    await writeTextFile(
      configPath(),
      JSON.stringify({
        repos: {
          "acme/widgets": { maxCommits: 5 },
          "acme/gadgets": { maxCommits: 6 },
        },
      }),
    );
    const authed = await loggedInApp();
    const response = await authed("/api/knowledge", { method: "DELETE" });
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    if (body.repos?.length !== 2 || body.settings !== true) {
      throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    }
    for (const repo of ["acme/widgets", "acme/gadgets"]) {
      if (getRepo(repo)?.knowledge_built_at !== null) {
        throw new Error(`${repo} kept its knowledge stamp`);
      }
      if ((await cacheGet("state", repo)) !== undefined) {
        throw new Error(`${repo} kept its skill state`);
      }
    }
    if (readConfig().repos !== undefined) {
      throw new Error("config.repos survived");
    }
  });
});

test("DELETE /api/knowledge with includeCache clears the shared caches", async () => {
  await withTempEnv(async () => {
    await seedRepo("acme/widgets");
    await mkdirPath(cloneDir("acme/widgets"), { recursive: true });
    await mkdirPath(repoWorktreesDir("acme/widgets"), { recursive: true });
    const authed = await loggedInApp();
    const response = await authed("/api/knowledge?includeCache=1", {
      method: "DELETE",
    });
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    if (!body.cacheFile || !body.clones || !body.worktrees) {
      throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    }
    if (await cacheDbExists()) throw new Error("cache.db survived");
    if (await exists(cloneDir("acme/widgets"))) {
      throw new Error("the clone survived");
    }
    if (await exists(worktreesDir())) throw new Error("wt survived");
  });
});
