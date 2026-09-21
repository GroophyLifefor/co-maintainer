import { writeRepoConfig, writeUserConfig } from "../config.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, getRepo } from "../store/repos.ts";
import {
  buildSetupHandler,
  enqueueSetup,
  optionsFromConfig,
  runInitOrRemake,
} from "./setup.ts";
import { cacheDelete } from "../store/cache_db.ts";
import { readState } from "../store/skill_state.ts";
import { testOptions } from "../testing/helpers.ts";
import { claimAndRun, getLogsSince, registerHandler } from "./jobs.ts";
import type { Options } from "../types.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { test } from "node:test";

async function withTempConfigAndDb(fn: () => Promise<void>): Promise<void> {
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const originalDb = getEnv("CM_APP_DB");
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
  }
}

test("optionsFromConfig resolves from global and repo config, ai off by default", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({ auth: "gh" });
    const options = optionsFromConfig("acme/widgets", "init");
    if (options.command !== "init" || options.repo !== "acme/widgets") {
      throw new Error("command/repo not set correctly");
    }
    if (options.auth !== "gh" || options.ai !== "none") {
      throw new Error("did not fall back to global config defaults");
    }
  });
});

test("optionsFromConfig prefers repo-level overrides over global config", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({
      auth: "gh",
      githubPat: "irrelevant-for-this-test",
    });
    await writeRepoConfig("acme/widgets", { auth: "pat" });
    const options = optionsFromConfig("acme/widgets", "init");
    if (options.auth !== "pat") {
      throw new Error("repo-level auth override was not honored");
    }
  });
});

test("optionsFromConfig throws a clear error when auth=pat has no token", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({ auth: "pat" });
    let threw = false;
    try {
      optionsFromConfig("acme/widgets", "init");
    } catch (error) {
      threw = true;
      if (!String(error).includes("github-pat")) {
        throw new Error("error did not point at the fix");
      }
    }
    if (!threw) throw new Error("expected a throw for missing PAT");
  });
});

test("optionsFromConfig throws a clear error when AI is enabled but incomplete", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({ auth: "gh", ai: "openrouter" });
    let threw = false;
    try {
      optionsFromConfig("acme/widgets", "init");
    } catch (error) {
      threw = true;
      if (!String(error).includes("co-maintainer set")) {
        throw new Error("error did not point at the fix");
      }
    }
    if (!threw) throw new Error("expected a throw for incomplete AI setup");
  });
});

test("buildSetupHandler merges the job's override onto config defaults and captures logs", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({ auth: "gh" });
    activateRepo("acme/widgets", undefined);
    let seenOptions: Options | undefined;
    const { log } = await import("../util/log.ts");
    const handler = buildSetupHandler((options) => {
      seenOptions = options;
      log("fetch", "pretending to fetch");
      return Promise.resolve();
    });
    registerHandler("init", handler);
    const { id } = enqueueSetup("acme/widgets", "init", { maxCommits: 42 });
    await claimAndRun();

    if (seenOptions?.maxCommits !== 42) {
      throw new Error("job-level override did not reach Options");
    }
    if (
      seenOptions?.repo !== "acme/widgets" ||
      seenOptions?.command !== "init"
    ) {
      throw new Error("repo/command were not set from the job row");
    }
    const lines = getLogsSince(id);
    if (
      !lines.some((line) =>
        line.message.includes("[fetch] pretending to fetch"),
      )
    ) {
      throw new Error("the fake runner's log() call did not reach job_logs");
    }
    if (!getRepo("acme/widgets")?.knowledge_built_at) {
      throw new Error("init did not stamp knowledge_built_at");
    }
  });
});

test("a remake job with no cached state runs init instead of failing", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({ auth: "gh" });
    activateRepo("acme/fresh", undefined);
    let seen: Options | undefined;
    const handler = buildSetupHandler((options) => {
      seen = options;
      return Promise.resolve();
    });
    registerHandler("remake", handler);
    enqueueSetup("acme/fresh", "remake");
    await claimAndRun();
    if (seen?.command !== "init") {
      throw new Error(`expected init fallback, got ${seen?.command}`);
    }
  });
});

test("cli init opens app.db itself and still writes the cache", async () => {
  const root = tempDirSync();
  const repo = `acme/cli-${crypto.randomUUID()}`;
  const original = {
    config: getEnv("CM_CONFIG_PATH"),
    db: getEnv("CM_APP_DB"),
    repos: getEnv("CM_REPOS_DIR"),
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) deleteEnv(name);
    else setEnv(name, value);
  };
  setEnv("CM_CONFIG_PATH", `${root}/config.json`);
  setEnv("CM_APP_DB", `${root}/app.db`);
  setEnv("CM_REPOS_DIR", `${root}/repos`);
  await closeAppDb();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ default_branch: "main", full_name: repo }), {
      status: 200,
    })) as typeof fetch;
  try {
    await writeUserConfig({ auth: "pat", githubPat: "test-token", ai: "none" });
    await runInitOrRemake(
      testOptions({
        command: "init",
        repo,
        auth: "pat",
        githubPat: "test-token",
        ai: "none",
        includeCodebase: false,
        includePullRequests: false,
        includePullRequestChanges: false,
        includeCommitHistory: false,
        includeHowRepoWorks: false,
      }),
    );
    const state = await readState(repo);
    if (!state) throw new Error("init did not write state");
  } finally {
    globalThis.fetch = previousFetch;
    await cacheDelete("state", repo);
    await closeAppDb();
    restore("CM_CONFIG_PATH", original.config);
    restore("CM_APP_DB", original.db);
    restore("CM_REPOS_DIR", original.repos);
  }
});
