import { writeUserConfig } from "../config.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo } from "../store/repos.ts";
import { buildSetupHandler, enqueueSetup } from "./setup.ts";
import { claimAndRun, registerHandler } from "./jobs.ts";
import { getJob } from "../store/jobs.ts";
import type { GitHubClient, Options } from "../types.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

const KEY =
  "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";

async function withTempConfigAndDb(fn: () => Promise<void>): Promise<void> {
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const originalDb = getEnv("CM_APP_DB");
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    try {
      await closeAppDb();
    } finally {
      if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
      else setEnv("CM_CONFIG_PATH", originalConfig);
      if (originalDb === undefined) deleteEnv("CM_APP_DB");
      else setEnv("CM_APP_DB", originalDb);
    }
  }
}

type Seen = { options?: Options; client?: GitHubClient };

async function runJob(
  type: "init" | "remake",
  args: Partial<Options> & Record<string, unknown> = {},
): Promise<{ seen: Seen; status: string | undefined; error?: string }> {
  const seen: Seen = {};
  registerHandler(
    type,
    buildSetupHandler((options, _signal, client) => {
      seen.options = options;
      seen.client = client;
      return Promise.resolve();
    }),
  );
  const { id } = enqueueSetup("acme/widgets", type, args);
  await claimAndRun();
  const job = getJob(id);
  return { seen, status: job?.status, error: job?.error ?? undefined };
}

const APP_ONLY = {
  auth: "pat",
  ai: "openrouter",
  token: "tok",
  lowModel: "low/model",
  highModel: "high/model",
  githubAppId: "123",
  githubAppPrivateKey: KEY,
} as const;

test("a server with the App and no PAT runs init and remake as the App", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({ ...APP_ONLY });
    activateRepo("acme/widgets", 4242);
    for (const type of ["init", "remake"] as const) {
      const { seen, status, error } = await runJob(type);
      if (status !== "done" || !seen.client) {
        throw new Error(`${type}: ${status} ${error} client=${seen.client}`);
      }
    }
  });
});

test("the options a job keeps hold no installation id, key or token", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({ ...APP_ONLY });
    activateRepo("acme/widgets", 4242);
    const { seen, status } = await runJob("init");
    const text = JSON.stringify(seen.options);
    if (status !== "done") throw new Error(`status ${status}`);
    if (text.includes("4242")) {
      throw new Error("an installation id reached the options");
    }
    if (text.includes("not-a-real-key") || text.includes("installation")) {
      throw new Error("the App key or an installation reached the options");
    }
  });
});

test("without an App, init still needs the PAT that auth=pat names", async () => {
  await withTempConfigAndDb(async () => {
    await writeUserConfig({ ...APP_ONLY, githubAppId: undefined });
    activateRepo("acme/widgets", undefined);
    const { seen, status, error } = await runJob("init");
    if (status === "done" || seen.client || !/PAT/.test(error ?? "")) {
      throw new Error(`${status} ${error} client=${seen.client}`);
    }
  });
});
