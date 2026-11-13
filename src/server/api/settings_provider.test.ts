import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { readConfig, writeUserConfig, type UserConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const PASSWORD = "settings-provider-pass";

async function put(
  config: Partial<UserConfig>,
  body: Record<string, unknown>,
): Promise<{ status: number; code?: string; after: UserConfig }> {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ...config });
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
        body: JSON.stringify(body),
      }),
    );
    const json = (await response.json().catch(() => ({}))) as {
      error?: { code?: string };
      code?: string;
    };
    return {
      status: response.status,
      code: json.error?.code ?? json.code,
      after: readConfig(),
    };
  } finally {
    await closeAppDb();
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
    await removePath(dir, { recursive: true }).catch(() => {});
  }
}

test("a key sent with no provider is refused with provider_required and nothing is saved", async () => {
  for (const ai of [undefined, "none"] as const) {
    const result = await put(ai ? { ai } : {}, { token: "sk-or-v1-new" });
    if (result.status !== 422 || result.code !== "provider_required") {
      throw new Error(`ai=${ai}: ${result.status} ${result.code}`);
    }
    if (result.after.token)
      throw new Error(`ai=${ai}: the key was saved anyway`);
  }
});

test("choosing none while sending a key is refused too", async () => {
  const result = await put(
    { ai: "openrouter", token: "old" },
    { ai: "none", token: "sk-new" },
  );
  if (result.status !== 422 || result.code !== "provider_required") {
    throw new Error(`${result.status} ${result.code}`);
  }
  if (result.after.token !== "old" || result.after.ai !== "openrouter") {
    throw new Error("the saved provider and key changed");
  }
});

test("a key with a provider in the same request still saves", async () => {
  const result = await put({}, { ai: "openrouter", token: "sk-or-v1-new" });
  if (result.status !== 200) throw new Error(`status ${result.status}`);
  if (
    result.after.token !== "sk-or-v1-new" ||
    result.after.ai !== "openrouter"
  ) {
    throw new Error("the key and provider were not saved");
  }
});
