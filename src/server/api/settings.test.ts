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

test("changing the password with a null JSON body is a 400, not a crash", async () => {
  await withTempEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const token = (await signIn(app, PASSWORD))!;
    for (const body of [null, [], "text"]) {
      const response = await changePassword(app, token, body);
      if (response.status !== 400) {
        throw new Error(
          `body ${JSON.stringify(body)}: status ${response.status}`,
        );
      }
    }
  });
});

async function putSettings(body: unknown): Promise<Response> {
  return await handleSettingsRoute(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    new URL("http://localhost/api/settings"),
    "http://localhost:5000/github/webhook",
    memoryPasswordStore(PASSWORD),
    "test",
  );
}

test("PUT /api/settings stores a template as the default policy and clears it", async () => {
  await withTempEnv(async () => {
    const saved = await putSettings({ reviewPolicy: "trusted-auto" });
    if (saved.status !== 200) throw new Error(`status ${saved.status}`);
    if (readConfig().reviewPolicy !== "trusted-auto") {
      throw new Error(JSON.stringify(readConfig().reviewPolicy));
    }
    const cleared = await putSettings({ reviewPolicy: null });
    if (cleared.status !== 200) throw new Error(`status ${cleared.status}`);
    if (readConfig().reviewPolicy !== undefined) {
      throw new Error("the default policy was not cleared");
    }
  });
});

test("PUT /api/settings turns a policy that is exactly a template into its name", async () => {
  await withTempEnv(async () => {
    const response = await putSettings({
      reviewPolicy: {
        rules: [
          { name: "draft", when: { draft: true }, action: "skip" },
          { name: "bot author", when: { bot: true }, action: "skip" },
        ],
        default: "review",
      },
    });
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    if (readConfig().reviewPolicy !== "everyone") {
      throw new Error(JSON.stringify(readConfig().reviewPolicy));
    }
    await putSettings({
      reviewPolicy: { rules: [], default: "skip", maxRounds: 2 },
    });
    const kept = readConfig().reviewPolicy as { maxRounds?: number };
    if (typeof kept !== "object" || kept.maxRounds !== 2) {
      throw new Error("a policy with its own settings must stay an object");
    }
  });
});

test("PUT /api/settings refuses a policy it cannot read, and the simple switches", async () => {
  await withTempEnv(async () => {
    const bad = await putSettings({ reviewPolicy: { default: "maybe" } });
    if (bad.status !== 422) throw new Error(`status ${bad.status}`);
    const body = await bad.json();
    if (body.error?.code !== "invalid_policy") {
      throw new Error(JSON.stringify(body));
    }
    const legacy = await putSettings({ reviewPolicy: "legacy" });
    if (legacy.status !== 422) {
      throw new Error("the simple switches are per repository only");
    }
    if (readConfig().reviewPolicy !== undefined) {
      throw new Error("a refused policy must not be saved");
    }
  });
});

test("PUT /api/settings saves the remote BYOK policy and refuses an unknown one", async () => {
  await withTempEnv(async () => {
    const saved = await putSettings({ remoteByokPolicy: "require" });
    if (saved.status !== 200) throw new Error(`status ${saved.status}`);
    if (readConfig().remoteByokPolicy !== "require") {
      throw new Error(`policy ${readConfig().remoteByokPolicy}`);
    }
    const bad = await putSettings({ remoteByokPolicy: "sometimes" });
    if (bad.status !== 422) throw new Error(`status ${bad.status}`);
    if (readConfig().remoteByokPolicy !== "require") {
      throw new Error("a rejected policy changed the saved one");
    }
  });
});

test("PUT /api/settings will not move a saved key to another provider", async () => {
  await withTempEnv(async () => {
    await writeUserConfig({ ai: "openrouter", token: "sk-or-saved" });
    const refused = await putSettings({ ai: "anthropic" });
    if (refused.status !== 422) {
      throw new Error(`status ${refused.status}: ${await refused.text()}`);
    }
    const after = readConfig();
    if (after.ai !== "openrouter" || after.token !== "sk-or-saved") {
      throw new Error(`config changed: ${after.ai}`);
    }
    // With the new provider's key the switch goes through, and switching
    // off AI needs no key at all.
    const switched = await putSettings({
      ai: "anthropic",
      token: "sk-ant-new",
    });
    if (switched.status !== 200) throw new Error(`status ${switched.status}`);
    if (readConfig().ai !== "anthropic") throw new Error("switch not saved");
    const off = await putSettings({ ai: "none" });
    if (off.status !== 200) throw new Error(`status ${off.status}`);
  });
});
