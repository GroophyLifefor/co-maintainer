import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig, type UserConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "settings-ai-pass";
const KEY = "sk-or-v1-abcdef0123456789428";

async function aiPage(config: Partial<UserConfig>): Promise<string> {
  const keys = [
    "CM_APP_DB",
    "CM_CONFIG_PATH",
    "OPENROUTER_API_KEY",
    "CO_MAINTAINER_TOKEN",
  ];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  deleteEnv("OPENROUTER_API_KEY");
  deleteEnv("CO_MAINTAINER_TOKEN");
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ...config });
    const app = createApp({ password: PASSWORD });
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
    return await (
      await app.fetch(
        new Request("http://localhost/settings/ai", {
          headers: { cookie: `cm=${token}` },
        }),
      )
    ).text();
  } finally {
    await closeAppDb();
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
  }
}

const SAVED = {
  ai: "openrouter" as const,
  token: KEY,
  highModel: "openai/gpt-4.1-mini",
  lowModel: "google/gemini-2.5-flash-lite",
};

test("a saved key is shown masked with a Replace button, never in full", async () => {
  const html = await aiPage(SAVED);
  if (html.includes(KEY) || html.includes("abcdef0123456789")) {
    throw new Error("the saved key leaked into the page");
  }
  if (
    !html.includes(
      '<span class="inp mono key-mask">sk-or-v1-••••••••428</span>',
    )
  ) {
    throw new Error("no masked key");
  }
  if (
    !/<button type="button" class="btn gh sm" id="replace-key">Replace<\/button>/.test(
      html,
    )
  ) {
    throw new Error("no Replace button");
  }
  if (!/<input id="token" type="password"[^>]*hidden/.test(html)) {
    throw new Error("the key input is not hidden behind Replace");
  }
});

test("with no saved key the key input is shown and there is nothing to replace", async () => {
  const html = await aiPage({ ai: "openrouter" });
  if (html.includes('id="replace-key"') || html.includes("key-mask")) {
    throw new Error("an empty key offered Replace");
  }
  if (/<input id="token" type="password"[^>]*hidden/.test(html)) {
    throw new Error("the key input is hidden with no key saved");
  }
});

test("a key that was never checked is not called Verified", async () => {
  const html = await aiPage(SAVED);
  if (html.includes("Verified"))
    throw new Error("the page claims a verification that never ran");
});

test("each field names its CLI equivalent", async () => {
  const html = await aiPage(SAVED);
  for (const flag of [
    "--ai=openrouter",
    "--ai-key=…",
    "--high-model=…",
    "--low-model=…",
  ]) {
    if (!html.includes(`<div class="cli"><code>${flag}</code>`)) {
      throw new Error(`no CLI hint ${flag}`);
    }
  }
});

test("models are labelled Review and Extraction, with the CLI's high/low names", async () => {
  const html = await aiPage(SAVED);
  if (!html.includes('<label for="high">Review model</label>'))
    throw new Error("no Review model label");
  if (!html.includes('<label for="low">Extraction model</label>'))
    throw new Error("no Extraction model label");
  if (!html.includes("High model") || !html.includes("Low model")) {
    throw new Error("the CLI's high/low model names are gone");
  }
});
