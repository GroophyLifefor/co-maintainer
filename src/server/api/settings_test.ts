import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { readConfig, writeUserConfig } from "../../config.ts";

const PASSWORD = "settings-api-test";

async function withTempEnv(fn: () => Promise<void>): Promise<void> {
  const originalConfig = Deno.env.get("CM_CONFIG_PATH");
  const originalDb = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_CONFIG_PATH", `${Deno.makeTempDirSync()}/config.json`);
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    if (originalConfig === undefined) Deno.env.delete("CM_CONFIG_PATH");
    else Deno.env.set("CM_CONFIG_PATH", originalConfig);
    if (originalDb === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", originalDb);
  }
}

Deno.test("PUT /api/settings rejects a PAT GitHub refused", async () => {
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
