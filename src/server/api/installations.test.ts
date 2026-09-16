import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { activateRepo } from "../../store/repos.ts";
import { TEST_PKCS1_PEM } from "../../testing/fixtures/rsa_key.ts";

const PASSWORD = "installations-api-test";

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const original = Deno.env.get("CM_APP_DB");
  Deno.env.set("CM_APP_DB", `${Deno.makeTempDirSync()}/app.db`);
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", original);
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function loggedInApp(
  githubApp?: { appId: string; privateKeyPem: string },
) {
  const app = createApp({ password: PASSWORD, githubApp });
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
  return (path: string) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        headers: {
          "x-requested-with": "co-maintainer",
          authorization: `Bearer ${token}`,
        },
      }),
    );
}

Deno.test("GET /api/installations without a configured App reports 422, not a crash", async () => {
  await withTempDb(async () => {
    const authed = await loggedInApp(undefined);
    const response = await authed("/api/installations");
    if (response.status !== 422) throw new Error(`status ${response.status}`);
  });
});

Deno.test("GET /api/installations marks repos already active in app.db", async () => {
  await withTempDb(async () => {
    activateRepo("acme/widgets", undefined);
    const originalFetch = globalThis.fetch;
    // deno-lint-ignore require-await
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/app/installations") && url.includes("page=1")) {
        return jsonResponse([
          {
            id: 1,
            account: { login: "acme", type: "Organization" },
            suspended_at: null,
          },
        ]);
      }
      if (url.includes("/app/installations") && url.includes("page=2")) {
        return jsonResponse([]);
      }
      if (url.includes("/access_tokens")) {
        return jsonResponse({
          token: "ghs_x",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (url === "https://api.github.com/installation/repositories") {
        return jsonResponse({
          repositories: [
            { full_name: "acme/widgets", private: true },
            { full_name: "acme/other", private: false },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      const authed = await loggedInApp({
        appId: "4900449",
        privateKeyPem: TEST_PKCS1_PEM,
      });
      const response = await authed("/api/installations");
      if (response.status !== 200) {
        throw new Error(`status ${response.status}: ${await response.text()}`);
      }
      const { items } = await response.json();
      if (items.length !== 1 || items[0].accountLogin !== "acme") {
        throw new Error(`unexpected items: ${JSON.stringify(items)}`);
      }
      const repos = items[0].repos as {
        fullName: string;
        alreadyActive: boolean;
      }[];
      const widgets = repos.find((repo) => repo.fullName === "acme/widgets");
      const other = repos.find((repo) => repo.fullName === "acme/other");
      if (!widgets?.alreadyActive) {
        throw new Error("acme/widgets should be marked alreadyActive");
      }
      if (other?.alreadyActive) {
        throw new Error("acme/other should not be marked alreadyActive");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
