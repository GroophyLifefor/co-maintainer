import { createApp } from "../app.ts";
import { handleSettingsRoute } from "./settings.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { readConfig, writeUserConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "settings-api-test";

async function withTempEnv(fn: () => Promise<void>): Promise<void> {
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const originalDb = getEnv("CM_APP_DB");
  setEnv("CM_CONFIG_PATH", `${tempDirSync()}/config.json`);
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
  }
}

test("PUT /api/settings rejects a PAT GitHub refused", async () => {
  await withTempEnv(async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;
    try {
      const app = createApp({ password: PASSWORD });
      const login = await app.fetch(
        new Request("http://localhost/api/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-requested-with": "co-maintainer",
          },
          body: JSON.stringify({ password: PASSWORD }),
        }),
      );
      const { token } = await login.json();
      const response = await app.fetch(
        new Request("http://localhost/api/settings", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-requested-with": "co-maintainer",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            auth: "pat",
            githubPat: "ghp_nope",
          }),
        }),
      );
      if (response.status !== 422) {
        throw new Error(`status ${response.status}: ${await response.text()}`);
      }
      if (readConfig().githubPat) {
        throw new Error("a rejected PAT was stored");
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

test("PUT /api/settings rejects non-integer defaults", async () => {
  await withTempEnv(async () => {
    const response = await handleSettingsRoute(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaults: { maxPrMonths: 1.5 },
        }),
      }),
      new URL("http://localhost/api/settings"),
      "http://localhost:5000/github/webhook",
    );
    if (response.status !== 422) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
  });
});

test("PUT /api/settings merges non-int default keys", async () => {
  await withTempEnv(async () => {
    await writeUserConfig({
      defaults: { maxCommits: 2, keepMe: true } as never,
    });
    const response = await handleSettingsRoute(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaults: { maxCommits: 4, keepMe: true, added: "yes" },
        }),
      }),
      new URL("http://localhost/api/settings"),
      "http://localhost:5000/github/webhook",
    );
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    const saved = readConfig().defaults as Record<string, unknown>;
    if (
      saved.maxCommits !== 4 ||
      saved.keepMe !== true ||
      saved.added !== "yes"
    ) {
      throw new Error(JSON.stringify(saved));
    }
  });
});

test("PUT /api/settings saves a public webhook URL", async () => {
  await withTempEnv(async () => {
    const response = await handleSettingsRoute(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          webhookUrl: "https://example.com/github/webhook",
        }),
      }),
      new URL("http://localhost/api/settings"),
      "http://localhost:5000/github/webhook",
    );
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    if (readConfig().webhookUrl !== "https://example.com/github/webhook") {
      throw new Error("webhook URL was not saved");
    }
  });
});
