import { writeRepoConfig, writeUserConfig } from "../config.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, getRepo } from "../store/repos.ts";
import { buildSetupHandler, enqueueSetup, optionsFromConfig } from "./setup.ts";
import { claimAndRun, getLogsSince, registerHandler } from "./jobs.ts";
import type { Options } from "../types.ts";

async function withTempConfigAndDb(fn: () => Promise<void>): Promise<void> {
  const originalConfig = Deno.env.get("CM_CONFIG_PATH");
  const originalDb = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_CONFIG_PATH", `${Deno.makeTempDirSync()}/config.json`);
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (originalConfig === undefined) Deno.env.delete("CM_CONFIG_PATH");
    else Deno.env.set("CM_CONFIG_PATH", originalConfig);
    if (originalDb === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", originalDb);
  }
}

Deno.test("optionsFromConfig resolves from global and repo config, ai off by default", async () => {
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

Deno.test("optionsFromConfig prefers repo-level overrides over global config", async () => {
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

Deno.test("optionsFromConfig throws a clear error when auth=pat has no token", async () => {
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

Deno.test("optionsFromConfig throws a clear error when AI is enabled but incomplete", async () => {
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

Deno.test("buildSetupHandler merges the job's override onto config defaults and captures logs", async () => {
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
      seenOptions?.repo !== "acme/widgets" || seenOptions?.command !== "init"
    ) {
      throw new Error("repo/command were not set from the job row");
    }
    const lines = getLogsSince(id);
    if (
      !lines.some((line) =>
        line.message.includes("[fetch] pretending to fetch")
      )
    ) {
      throw new Error("the fake runner's log() call did not reach job_logs");
    }
    if (!getRepo("acme/widgets")?.knowledge_built_at) {
      throw new Error("init did not stamp knowledge_built_at");
    }
  });
});

Deno.test("a remake job with no cached state runs init instead of failing", async () => {
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
