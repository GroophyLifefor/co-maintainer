import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { activateRepo, markKnowledgeBuilt } from "../../store/repos.ts";
import { recordDelivery } from "../../store/deliveries.ts";
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

const PASSWORD = "home-setup-pass";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH", "CM_REPOS_DIR"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
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

async function page(
  app: ReturnType<typeof createApp>,
  path: string,
): Promise<string> {
  const login = await app.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${PASSWORD}&next=/`,
      redirect: "manual",
    }),
  );
  const token = (login.headers.get("set-cookie") ?? "").match(
    /^cm=([^;]+)/,
  )?.[1];
  if (!token) throw new Error("no session cookie");
  return (
    await app.fetch(
      new Request(`http://localhost${path}`, {
        headers: { cookie: `cm=${token}` },
      }),
    )
  ).text();
}

/** Home "n/4 done" and /setup "n of 4 done" must come from one count. */
async function counts(
  webhookUrl: string,
): Promise<{ home: string; setup: string }> {
  const app = createApp({ password: PASSWORD, webhookUrl });
  const home = (await page(app, "/")).match(/(\d)\/4 done/)?.[1] ?? "none";
  const setup =
    (await page(app, "/setup")).match(/(\d) of 4 done/)?.[1] ?? "none";
  return { home, setup };
}

test("home and /setup show the same count on a fresh install", async () => {
  await withEnv(async () => {
    const { home, setup } = await counts("");
    if (home !== "1" || setup !== "1") {
      throw new Error(`fresh install: home ${home}, setup ${setup}`);
    }
  });
});

test("home and /setup agree while setup is half done", async () => {
  await withEnv(async () => {
    await writeUserConfig({
      auth: "gh",
      ai: "openrouter",
      token: "sk-or-x",
      lowModel: "low/model",
      highModel: "high/model",
    });
    const { home, setup } = await counts("");
    if (home !== "2" || setup !== "2") {
      throw new Error(`half done: home ${home}, setup ${setup}`);
    }
  });
});

test("/setup lists the four required steps and keeps optional ones out", async () => {
  await withEnv(async () => {
    const html = await page(createApp({ password: PASSWORD }), "/setup");
    for (const title of [
      "Models and API key",
      "GitHub access",
      "GitHub App and webhook",
      "First repository",
    ]) {
      if (!html.includes(title)) throw new Error(`missing step: ${title}`);
    }
    for (const optional of ["CLI connected", "First review"]) {
      if (html.includes(optional))
        throw new Error(`optional step counted: ${optional}`);
    }
  });
});

test("/setup says All set once the four steps are done", async () => {
  await withEnv(async () => {
    await writeUserConfig({
      auth: "gh",
      ai: "openrouter",
      token: "sk-or-x",
      lowModel: "low/model",
      highModel: "high/model",
      githubAppId: "4900449",
      githubAppPrivateKey: "PEM",
    });
    activateRepo("acme/widgets", 9);
    markKnowledgeBuilt("acme/widgets", "abc");
    recordDelivery({
      deliveryId: "d-1",
      event: "pull_request",
      action: "opened",
      repo: "acme/widgets",
      prNumber: 7,
      outcome: "queued",
    });
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "https://example.com/github/webhook",
    });
    const setup = await page(app, "/setup");
    if (!setup.includes("All set") || !setup.includes("4 of 4 done")) {
      throw new Error("/setup did not report All set");
    }
    const home = await page(app, "/");
    if (home.includes('id="finish-setup"')) {
      throw new Error("home kept the banner after setup was done");
    }
  });
});
