/** Repository settings, read the way the mock describes it: Speed with real
 * resolved values and warnings, segmented scheduled sync, blocking, policy
 * choices and one Save footer. Written before the product code, so these are
 * expected to fail until the page implements the mock. */
import { test } from "node:test";
import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import {
  activateRepo,
  getRepo,
  markKnowledgeBuilt,
} from "../../store/repos.ts";
import {
  readConfig,
  writeRepoConfig,
  writeUserConfig,
  type UserConfig,
} from "../../config.ts";
import { cacheSet } from "../../store/cache_db.ts";
import { recommendConcurrency } from "../../services/concurrency.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";

const PASSWORD = "repo-settings-vision";
const REPO = "acme/widgets";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "CM_APP_DB",
    "CM_CONFIG_PATH",
    "CM_REPOS_DIR",
    "XDG_CACHE_HOME",
  ] as const;
  const original: Record<string, string | undefined> = {};
  for (const key of keys) original[key] = getEnv(key);
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("XDG_CACHE_HOME", `${dir}/cache`);
  try {
    await openAppDb();
    activateRepo(REPO, 9);
    markKnowledgeBuilt(REPO, "abc");
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    }
  }
}

async function appSession(): Promise<{
  app: ReturnType<typeof createApp>;
  cookie: string;
}> {
  const app = createApp({
    password: PASSWORD,
    auth: { password: true, github: false },
  });
  const response = await app.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${PASSWORD}&next=/`,
      redirect: "manual",
    }),
  );
  if (response.status !== 303) {
    throw new Error(`login status ${response.status}`);
  }
  const token = response.headers.get("set-cookie")?.match(/^cm=([^;]+)/)?.[1];
  if (!token) throw new Error("the login response set no session cookie");
  return { app, cookie: `cm=${token}` };
}

async function settingsPage(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<string> {
  const response = await app.fetch(
    new Request(`http://localhost/repos/${REPO}/settings`, {
      headers: { cookie },
    }),
  );
  if (response.status !== 200) {
    throw new Error(`/repos/${REPO}/settings returned ${response.status}`);
  }
  return await response.text();
}

async function pageWith(config: {
  user?: Partial<UserConfig>;
  repo?: Record<string, unknown>;
}): Promise<string> {
  if (config.user) await writeUserConfig(config.user);
  if (config.repo) await writeRepoConfig(REPO, config.repo as never);
  const { app, cookie } = await appSession();
  return await settingsPage(app, cookie);
}

async function patchRepo(
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown; html: string }> {
  const { app, cookie } = await appSession();
  const response = await app.fetch(
    new Request(`http://localhost/api/repos/${REPO}`, {
      method: "PATCH",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-requested-with": "co-maintainer",
      },
      body: JSON.stringify(body),
    }),
  );
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json, html: await settingsPage(app, cookie) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&middot;|&#183;|&bull;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The slice of the page between two headings, so a warning or badge is
 * attributed to the right card. */
function between(html: string, start: string, ends: string[]): string {
  const from = html.indexOf(start);
  if (from === -1) return "";
  let to = html.length;
  for (const end of ends) {
    const index = html.indexOf(end, from + start.length);
    if (index !== -1 && index < to) to = index;
  }
  return html.slice(from, to);
}

function segmentAfter(html: string, marker: string): string | undefined {
  const from = html.indexOf(marker);
  if (from === -1) return undefined;
  const match = /<div class="seg"[^>]*>([\s\S]*?)<\/div>/.exec(
    html.slice(from + marker.length),
  );
  return match?.[1];
}

function selectedNumber(segment: string | undefined): number | undefined {
  if (!segment) return undefined;
  const match =
    /<button[^>]*class="[^"]*\bon\b[^"]*"[^>]*>([\s\S]*?)<\/button>/.exec(
      segment,
    );
  if (!match) return undefined;
  const number = /(\d+)/.exec(stripTags(match[1]!));
  return number ? Number(number[1]) : undefined;
}

function hasBadge(html: string, label: string): boolean {
  return new RegExp(
    `<(?:span|div)[^>]*class="[^"]*(?:badge|tag)[^"]*"[^>]*>\\s*${escapeRegExp(label)}\\s*<`,
    "i",
  ).test(html);
}

function hasChoiceLabel(html: string, label: string): boolean {
  const escaped = escapeRegExp(label);
  return new RegExp(
    `(?:>\\s*${escaped}\\s*<|>\\s*${escaped}\\s*<span|>\\s*${escaped}\\s*</div)`,
    "i",
  ).test(html);
}

function hasSelectedChoice(html: string, label: string): boolean {
  const escaped = escapeRegExp(label);
  const labelMatch = new RegExp(
    `<label[^>]*>[\\s\\S]{0,400}?${escaped}[\\s\\S]{0,400}?</label>`,
    "i",
  ).exec(html);
  if (labelMatch && /<input[^>]*type="radio"[^>]*checked/i.test(labelMatch[0])) {
    return true;
  }
  return new RegExp(
    `<button[^>]*class="[^"]*\\bon\\b[^"]*"[^>]*>[\\s\\S]{0,400}?${escaped}[\\s\\S]{0,400}?</button>`,
    "i",
  ).test(html);
}

function speedArea(html: string): string {
  return between(html, "GitHub requests at once", [
    "Scheduled sync",
    "Custom review instructions",
    "Danger",
  ]);
}

test("repo settings: Speed shows the repository override and Overridden badges", async () => {
  await withEnv(async () => {
    const html = await pageWith({
      user: {
        ai: "openrouter",
        lowModel: "paid/low",
        highModel: "paid/high",
        defaults: { ghConcurrent: 2, aiConcurrent: 4 },
      },
      repo: { ghConcurrent: 8, aiConcurrent: 6 },
    });
    const speed = speedArea(html);
    if (!speed.includes("GitHub requests at once")) {
      throw new Error("the GitHub concurrency segment is missing");
    }
    if (!speed.includes("AI calls at once")) {
      throw new Error("the AI concurrency segment is missing");
    }
    if (selectedNumber(segmentAfter(html, "GitHub requests at once")) !== 8) {
      throw new Error(
        `GitHub concurrency does not show the repo override 8: ${String(
          selectedNumber(segmentAfter(html, "GitHub requests at once")),
        )}`,
      );
    }
    if (selectedNumber(segmentAfter(html, "AI calls at once")) !== 6) {
      throw new Error(
        `AI concurrency does not show the repo override 6: ${String(
          selectedNumber(segmentAfter(html, "AI calls at once")),
        )}`,
      );
    }
    if (!hasBadge(speed, "Overridden")) {
      throw new Error("the Speed field has no Overridden badge");
    }
  });
});

test("repo settings: Speed falls back to the server defaults with Default badges", async () => {
  await withEnv(async () => {
    const html = await pageWith({
      user: {
        ai: "openrouter",
        lowModel: "paid/low",
        highModel: "paid/high",
        defaults: { ghConcurrent: 2, aiConcurrent: 4 },
      },
    });
    const speed = speedArea(html);
    if (selectedNumber(segmentAfter(html, "GitHub requests at once")) !== 2) {
      throw new Error("GitHub concurrency did not follow the server default 2");
    }
    if (selectedNumber(segmentAfter(html, "AI calls at once")) !== 4) {
      throw new Error("AI concurrency did not follow the server default 4");
    }
    if (!hasBadge(speed, "Default")) {
      throw new Error("the Speed field has no Default badge");
    }
  });
});

test("repo settings: Speed falls back to the built-in 1 and 3 with Default badges", async () => {
  await withEnv(async () => {
    const html = await pageWith({});
    const speed = speedArea(html);
    if (selectedNumber(segmentAfter(html, "GitHub requests at once")) !== 1) {
      throw new Error("GitHub concurrency did not fall back to the built-in 1");
    }
    if (selectedNumber(segmentAfter(html, "AI calls at once")) !== 3) {
      throw new Error("AI concurrency did not fall back to the built-in 3");
    }
    if (!hasBadge(speed, "Default")) {
      throw new Error("the built-in Speed values have no Default badge");
    }
  });
});

test("repo settings: the CLI equivalent shows the real concurrency values", async () => {
  await withEnv(async () => {
    const html = await pageWith({
      user: {
        ai: "openrouter",
        lowModel: "paid/low",
        highModel: "paid/high",
      },
      repo: { ghConcurrent: 8, aiConcurrent: 6 },
    });
    const speed = speedArea(html);
    if (!speed.includes("--gh-concurrent=8")) {
      throw new Error("the CLI equivalent has no real --gh-concurrent=8");
    }
    if (!speed.includes("--ai-concurrent=6")) {
      throw new Error("the CLI equivalent has no real --ai-concurrent=6");
    }
  });
});

test("repo settings: Use recommended shows the values recommendConcurrency computes", async () => {
  await withEnv(async () => {
    await writeUserConfig({
      ai: "openrouter",
      lowModel: "paid/low",
      highModel: "paid/high",
    });
    await cacheSet(
      "probe",
      REPO,
      JSON.stringify({ pullRequests: 25, commits: 10 }),
    );
    const html = await pageWith({});
    const expected = recommendConcurrency({
      githubJobs: 35,
      provider: "openrouter",
      lowModel: "paid/low",
      highModel: "paid/high",
    });
    const match = /Use recommended[^<]*\((\d+)\s*[·x/]\s*(\d+)\)/i.exec(
      stripTags(html),
    );
    if (!match) {
      throw new Error("there is no Use recommended (gh · ai) control");
    }
    if (Number(match[1]) !== expected.gh || Number(match[2]) !== expected.ai) {
      throw new Error(
        `Use recommended shows ${match[1]} · ${match[2]}, want ${expected.gh} · ${expected.ai}`,
      );
    }
  });
});

test("repo settings: a free OpenRouter model warns at AI 2 and above but not at AI 1", async () => {
  await withEnv(async () => {
    const atTwo = await pageWith({
      user: {
        ai: "openrouter",
        lowModel: "deepseek/deepseek-chat-v3.1:free",
        highModel: "paid/high",
      },
      repo: { aiConcurrent: 2 },
    });
    if (!/Free OpenRouter models hit rate limits|free OpenRouter model is in use/i.test(atTwo)) {
      throw new Error("AI 2 with a free OpenRouter model shows no free-model warning");
    }
    const atOne = await pageWith({ repo: { aiConcurrent: 1 } });
    if (/Free OpenRouter models hit rate limits|free OpenRouter model is in use/i.test(atOne)) {
      throw new Error("AI 1 with a free OpenRouter model still shows the warning");
    }
    const paid = await pageWith({
      user: {
        ai: "openrouter",
        lowModel: "paid/low",
        highModel: "paid/high",
      },
      repo: { aiConcurrent: 8 },
    });
    if (/Free OpenRouter models hit rate limits|free OpenRouter model is in use/i.test(paid)) {
      throw new Error("a paid OpenRouter model shows the free-model warning");
    }
  });
});

test("repo settings: the provider ceiling warning appears only above the ceiling", async () => {
  await withEnv(async () => {
    const above = await pageWith({
      user: { ai: "openai", lowModel: "paid/low", highModel: "paid/high" },
      repo: { aiConcurrent: 5 },
    });
    if (!/OpenAI/.test(speedArea(above)) || !/wait|slow/i.test(speedArea(above))) {
      throw new Error("OpenAI at AI 5 shows no provider-ceiling warning");
    }
    const atCeiling = await pageWith({ repo: { aiConcurrent: 4 } });
    if (/OpenAI/.test(speedArea(atCeiling))) {
      throw new Error("OpenAI at AI 4 still shows the provider-ceiling warning");
    }
    const openRouterAbove = await pageWith({
      user: {
        ai: "openrouter",
        lowModel: "paid/low",
        highModel: "paid/high",
      },
      repo: { aiConcurrent: 9 },
    });
    if (!/OpenRouter/.test(speedArea(openRouterAbove))) {
      throw new Error("OpenRouter at AI 9 shows no provider-ceiling warning");
    }
  });
});

test("repo settings: the PAT quota warning appears only for a PAT at GitHub 8 or above", async () => {
  await withEnv(async () => {
    const pat = await pageWith({
      user: {
        auth: "pat",
        ai: "openrouter",
        lowModel: "paid/low",
        highModel: "paid/high",
      },
      repo: { ghConcurrent: 8 },
    });
    if (!/5,000|5000|requests\/hour/i.test(speedArea(pat))) {
      throw new Error("a PAT at GitHub 8 shows no quota warning");
    }
    const below = await pageWith({ repo: { ghConcurrent: 7 } });
    if (/5,000|5000|requests\/hour/i.test(speedArea(below))) {
      throw new Error("a PAT at GitHub 7 still shows the quota warning");
    }
    const ghCli = await pageWith({
      user: { auth: "gh" },
      repo: { ghConcurrent: 8 },
    });
    if (/5,000|5000|requests\/hour/i.test(speedArea(ghCli))) {
      throw new Error("gh CLI at GitHub 8 shows the PAT quota warning");
    }
  });
});

test("repo settings: saving Speed stores the real GitHub and AI values", async () => {
  await withEnv(async () => {
    const result = await patchRepo({ ghConcurrent: 8, aiConcurrent: 6 });
    if (result.status !== 200) {
      throw new Error(`saving Speed returned ${result.status}`);
    }
    const repo = readConfig().repos?.[REPO];
    if (repo?.ghConcurrent !== 8 || repo?.aiConcurrent !== 6) {
      throw new Error(
        `saved Speed is ${JSON.stringify({
          gh: repo?.ghConcurrent,
          ai: repo?.aiConcurrent,
        })}, want 8/6`,
      );
    }
  });
});

test("repo settings: Scheduled sync offers Off, Daily, Weekly and Custom", async () => {
  await withEnv(async () => {
    const html = await pageWith({});
    const scheduled = between(html, "Scheduled sync", [
      "Danger",
      "Remove",
      "Custom review instructions",
    ]);
    if (!scheduled) {
      throw new Error("the Scheduled sync section is missing");
    }
    for (const label of ["Off", "Daily", "Weekly", "Custom"]) {
      if (!hasChoiceLabel(scheduled, label)) {
        throw new Error(`Scheduled sync has no ${label} choice`);
      }
    }
  });
});

test("repo settings: a saved Weekly schedule comes back selected", async () => {
  await withEnv(async () => {
    const result = await patchRepo({ remakeCron: "0 3 * * 1" });
    if (result.status !== 200) {
      throw new Error(`saving a weekly schedule returned ${result.status}`);
    }
    const scheduled = between(result.html, "Scheduled sync", [
      "Danger",
      "Remove",
      "Custom review instructions",
    ]);
    if (!hasSelectedChoice(scheduled, "Weekly")) {
      throw new Error("a saved 0 3 * * 1 schedule is not shown as Weekly");
    }
    if (readConfig().repos?.[REPO]?.remakeCron !== "0 3 * * 1") {
      throw new Error("the weekly schedule was not persisted");
    }
  });
});

test("repo settings: an invalid Custom schedule is rejected with a reason", async () => {
  await withEnv(async () => {
    const result = await patchRepo({ remakeCron: "not a cron" });
    if (result.status !== 422) {
      throw new Error(`an invalid custom cron returned ${result.status}`);
    }
    const body = result.json as { error?: { message?: string } } | undefined;
    const reason = body?.error?.message ?? "";
    if (!/cron|field|minute|hour/i.test(reason)) {
      throw new Error(`the invalid cron has no usable reason: ${JSON.stringify(body)}`);
    }
    const scheduled = between(result.html, "Scheduled sync", [
      "Danger",
      "Remove",
      "Custom review instructions",
    ]);
    if (!hasSelectedChoice(scheduled, "Custom")) {
      throw new Error("the rejected custom schedule is not shown as Custom");
    }
  });
});

test("repo settings: blocking offers model and severity with the CLI hint", async () => {
  await withEnv(async () => {
    const html = await pageWith({});
    if (!html.includes("A finding blocks the pull request when")) {
      throw new Error("the blocking field is missing");
    }
    if (!hasChoiceLabel(html, "The model says so")) {
      throw new Error("the model blocking choice is missing");
    }
    if (!hasChoiceLabel(html, "Severity is Critical or High")) {
      throw new Error("the severity blocking choice is missing");
    }
    if (!html.includes("--review-blocking=model|severity")) {
      throw new Error("the blocking CLI hint is missing");
    }
  });
});

test("repo settings: saving severity changes the real blocking mode", async () => {
  await withEnv(async () => {
    const result = await patchRepo({ reviewBlocking: "severity" });
    if (result.status !== 200) {
      throw new Error(`saving blocking returned ${result.status}`);
    }
    const config = readConfig();
    const repo = (config.repos?.[REPO] ?? {}) as Record<string, unknown>;
    const mode = repo.reviewBlocking ?? config.reviewBlocking;
    if (mode !== "severity") {
      throw new Error(`the saved blocking mode is ${JSON.stringify(mode)}`);
    }
    const blocking = between(result.html, "A finding blocks the pull request when", [
      "Custom review instructions",
      "What knowledge reads",
      "Danger",
    ]);
    if (!hasSelectedChoice(blocking, "Severity is Critical or High")) {
      throw new Error("the page does not show severity as the saved blocking mode");
    }
  });
});

test("repo settings: the policy offers Everyone, Trusted authors and Only when asked", async () => {
  await withEnv(async () => {
    const html = await pageWith({});
    const policy = between(html, "Who gets a review", [
      "How reviews run",
      "Automatic review",
      "Custom review instructions",
    ]);
    if (!policy) {
      throw new Error("the policy card is missing");
    }
    for (const label of ["Everyone", "Trusted authors", "Only when asked"]) {
      if (!hasChoiceLabel(policy, label)) {
        throw new Error(`the policy card has no ${label} choice`);
      }
    }
    if (!hasBadge(policy, "Default") && !hasBadge(policy, "Overridden")) {
      throw new Error("the policy card has no Default or Overridden badge");
    }
  });
});

test("repo settings: saving Trusted authors persists the real policy", async () => {
  await withEnv(async () => {
    const result = await patchRepo({ reviewPolicy: "trusted-auto" });
    if (result.status !== 200) {
      throw new Error(`saving the policy returned ${result.status}`);
    }
    const stored = getRepo(REPO)?.review_policy_json ?? "";
    if (!stored.includes("trusted-auto")) {
      throw new Error(`the saved policy is ${JSON.stringify(stored)}`);
    }
    const policy = between(result.html, "Who gets a review", [
      "How reviews run",
      "Automatic review",
      "Custom review instructions",
    ]);
    if (!hasSelectedChoice(policy, "Trusted authors")) {
      throw new Error("the page does not show Trusted authors as selected");
    }
  });
});

test("repo settings: the section titles are How reviews run, What knowledge reads and Danger", async () => {
  await withEnv(async () => {
    const html = await pageWith({});
    for (const title of [
      "How reviews run",
      "What knowledge reads",
      "Danger",
    ]) {
      const heading = new RegExp(
        `<h2[^>]*>[\\s\\S]{0,200}?${escapeRegExp(title)}[\\s\\S]{0,200}?</h2>`,
        "i",
      );
      if (!heading.test(html)) {
        throw new Error(`the section title ${JSON.stringify(title)} is missing`);
      }
    }
  });
});

test("repo settings: one Save changes footer and a Reset to defaults control", async () => {
  await withEnv(async () => {
    const html = await pageWith({});
    const saveChanges = (html.match(/>\s*Save changes\s*</g) ?? []).length;
    if (saveChanges !== 1) {
      throw new Error(`the page has ${saveChanges} Save changes controls, want 1`);
    }
    const reset = (html.match(/>\s*Reset to defaults\s*</g) ?? []).length;
    if (reset !== 1) {
      throw new Error(`the page has ${reset} Reset to defaults controls, want 1`);
    }
  });
});
