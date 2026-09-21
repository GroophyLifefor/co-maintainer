import { createApp } from "../app.ts";
import { memoryPasswordStore } from "../auth.ts";
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
      memoryPasswordStore(PASSWORD),
      "test",
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
      memoryPasswordStore(PASSWORD),
      "test",
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
      memoryPasswordStore(PASSWORD),
      "test",
    );
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    if (readConfig().webhookUrl !== "https://example.com/github/webhook") {
      throw new Error("webhook URL was not saved");
    }
  });
});

const JSON_CSRF = {
  "content-type": "application/json",
  "x-requested-with": "co-maintainer",
};

async function signIn(
  app: ReturnType<typeof createApp>,
  password: string,
): Promise<string | undefined> {
  const response = await app.fetch(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: JSON_CSRF,
      body: JSON.stringify({ password }),
    }),
  );
  if (response.status !== 200) return undefined;
  return (await response.json()).token as string;
}

function changePassword(
  app: ReturnType<typeof createApp>,
  token: string,
  body: unknown,
) {
  return app.fetch(
    new Request("http://localhost/api/settings/password", {
      method: "POST",
      headers: { ...JSON_CSRF, authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}

function meStatus(app: ReturnType<typeof createApp>, token: string) {
  return app
    .fetch(
      new Request("http://localhost/api/me", {
        headers: { ...JSON_CSRF, authorization: `Bearer ${token}` },
      }),
    )
    .then((response) => response.status);
}

test("changing the password needs the current one and a valid new one", async () => {
  await withTempEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const token = (await signIn(app, PASSWORD))!;
    const wrong = await changePassword(app, token, {
      currentPassword: "not-it",
      newPassword: "a-new-password",
    });
    if (wrong.status !== 403) throw new Error(`status ${wrong.status}`);
    const weak = await changePassword(app, token, {
      currentPassword: PASSWORD,
      newPassword: "short",
    });
    if (weak.status !== 422) throw new Error(`status ${weak.status}`);
    if (!(await signIn(app, PASSWORD))) {
      throw new Error("a rejected change replaced the password");
    }
  });
});

test("changing the password swaps it and signs out the other sessions", async () => {
  await withTempEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const mine = (await signIn(app, PASSWORD))!;
    const other = (await signIn(app, PASSWORD))!;
    const response = await changePassword(app, mine, {
      currentPassword: PASSWORD,
      newPassword: "a-new-password",
    });
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${await response.text()}`);
    }
    if (await signIn(app, PASSWORD)) throw new Error("the old password works");
    if (!(await signIn(app, "a-new-password"))) {
      throw new Error("the new password does not work");
    }
    if ((await meStatus(app, mine)) !== 200) {
      throw new Error("the session that made the change was dropped");
    }
    if ((await meStatus(app, other)) !== 401) {
      throw new Error("another session survived the change");
    }
  });
});
