import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import {
  activateRepo,
  markKnowledgeBuilt,
  updateRepoSettings,
} from "../../store/repos.ts";
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

const PASSWORD = "repos-filter-test";

async function withSeed(
  fn: (get: (path: string) => Promise<unknown>) => Promise<void>,
) {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  try {
    await openAppDb();
    await writeUserConfig({
      auth: "gh",
      ai: "none",
      githubAppId: "4900449",
      githubAppPrivateKey: "PEM",
    });
    activateRepo("acme/widgets", 9);
    markKnowledgeBuilt("acme/widgets", "abc");
    activateRepo("acme/gadgets", 9);
    markKnowledgeBuilt("acme/gadgets", "abc");
    updateRepoSettings("acme/gadgets", { auto_review: 0 });
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
    await fn(async (path) =>
      (
        await app.fetch(
          new Request(`http://localhost${path}`, {
            headers: {
              "x-requested-with": "co-maintainer",
              authorization: `Bearer ${token}`,
            },
          }),
        )
      ).json(),
    );
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

type Listed = { items: { full_name: string }[] };

const names = (body: unknown) =>
  (body as Listed).items.map((r) => r.full_name).join(",");

test("GET /api/repos without parameters still lists every active repo", async () => {
  await withSeed(async (get) => {
    const got = names(await get("/api/repos"));
    if (got !== "acme/gadgets,acme/widgets") throw new Error(got);
  });
});

test("GET /api/repos filters by status and q", async () => {
  await withSeed(async (get) => {
    const cases: [string, string][] = [
      ["/api/repos?status=reviewing", "acme/widgets"],
      ["/api/repos?status=paused", "acme/gadgets"],
      ["/api/repos?q=WID", "acme/widgets"],
      ["/api/repos?q=acme&status=paused", "acme/gadgets"],
    ];
    for (const [path, want] of cases) {
      const got = names(await get(path));
      if (got !== want) throw new Error(`${path}: ${got}`);
    }
  });
});
