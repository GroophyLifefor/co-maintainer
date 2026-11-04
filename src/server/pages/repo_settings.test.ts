/** The Settings page carries a card for the repository's own review
 * instructions. */
import { test } from "node:test";
import { renderRepoSettings } from "./repo_settings.ts";
import type { RepoRow } from "../../store/rows.ts";
import { createApp } from "../app.ts";
import { closeAppDb, getAppDb, openAppDb } from "../../store/app_db.ts";
import { appendLog } from "../../store/job_logs.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import { activateRepo, markKnowledgeBuilt } from "../../store/repos.ts";
import { writeUserConfig } from "../../config.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";

function row(): RepoRow {
  return {
    full_name: "acme/widgets",
    installation_id: 7,
    active: 1,
    auto_review: 1,
    review_scope: "whole-pr",
    skip_drafts: 1,
    skip_bots: 1,
    knowledge_built_at: null,
    knowledge_base_sha: null,
    settings: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
    use_codegraph: 0,
    review_policy_json: null,
  };
}

test("the settings page shows the stored instructions and cap", async () => {
  const response = renderRepoSettings("alice", row(), {
    reviewSystemPrompt: "Focus on the parser.",
    reviewSystemPromptMaxChars: 123,
  });
  const html = await response.text();
  if (!html.includes("Custom review instructions")) {
    throw new Error("the card heading is missing");
  }
  if (!html.includes("Focus on the parser.")) {
    throw new Error("the stored instruction is missing");
  }
  if (!html.includes('value="123"')) {
    throw new Error("the stored cap is missing");
  }
});

test("the settings page shows an empty field and the default cap when unset", async () => {
  const response = renderRepoSettings("alice", row(), {});
  const html = await response.text();
  if (!html.includes('id="system-prompt"')) {
    throw new Error("the textarea is missing");
  }
  if (!html.includes("8000")) {
    throw new Error("the default cap is not shown");
  }
});

const PASSWORD = "repo-settings-rate-limit";
const REPO = "acme/widgets";
const WAIT_LOG_TYPE = "rate_limit_wait";

type WaitInput = {
  service: "openrouter" | "github";
  stage: string;
  reason: string;
  seconds: number;
};

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

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

async function cookieSession(
  app: ReturnType<typeof createApp>,
): Promise<string> {
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
  const cookie = response.headers.get("set-cookie") ?? "";
  const token = cookie.match(/^cm=([^;]+)/)?.[1];
  if (!token) throw new Error(`no session cookie: ${cookie}`);
  return `cm=${token}`;
}

async function page(
  app: ReturnType<typeof createApp>,
  cookie: string,
  path: string,
): Promise<string> {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, { headers: { cookie } }),
  );
  if (response.status !== 200) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return await response.text();
}

function seedRepo(name: string): void {
  activateRepo(name, 9);
  markKnowledgeBuilt(name, "abc");
}

function appendWait(jobId: string, wait: WaitInput): void {
  appendLog(
    jobId,
    "warn",
    JSON.stringify({
      type: WAIT_LOG_TYPE,
      service: wait.service,
      stage: wait.stage,
      reason: wait.reason,
      seconds: wait.seconds,
    }),
  );
}

function seedJob(options: {
  id: string;
  repo: string;
  createdAt: string;
  waits?: WaitInput[];
}): void {
  insertJob({ id: options.id, type: "remake", repo: options.repo });
  setJobStatus(options.id, "done");
  getAppDb()
    .prepare(
      `UPDATE jobs SET created_at = ?, started_at = ?, finished_at = ? WHERE id = ?`,
    )
    .run(options.createdAt, options.createdAt, options.createdAt, options.id);
  for (const wait of options.waits ?? []) appendWait(options.id, wait);
}

test("the job page and repository settings show the same last sync waits", async () => {
  await withEnv(async () => {
    seedRepo(REPO);
    seedJob({
      id: "job-last-sync",
      repo: REPO,
      createdAt: "2026-01-02T10:00:00.000Z",
      waits: [
        {
          service: "openrouter",
          stage: "extract facts",
          reason: "429 Too Many Requests",
          seconds: 30,
        },
        {
          service: "openrouter",
          stage: "extract facts",
          reason: "429 Too Many Requests",
          seconds: 30,
        },
      ],
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const jobText = visibleText(
      await page(app, cookie, "/activity/job-last-sync"),
    );
    const settingsText = visibleText(
      await page(app, cookie, `/repos/${REPO}/settings`),
    );

    for (const [name, text] of [
      ["job page", jobText],
      ["repository settings", settingsText],
    ] as const) {
      if (!/asked to slow down/i.test(text)) {
        throw new Error(`${name} does not say a service asked to slow down`);
      }
      if (!/OpenRouter/.test(text)) {
        throw new Error(`${name} does not name OpenRouter`);
      }
      if (!/(?:\b2\s+waits\b|twice)/i.test(text)) {
        throw new Error(`${name} does not show the wait count`);
      }
      if (!/\b60\s*(?:s|sec|seconds)\b/i.test(text)) {
        throw new Error(`${name} does not show the 60 second total`);
      }
    }
  });
});

test("two OpenRouter waits of 30 seconds read as twice with 30 seconds each time", async () => {
  await withEnv(async () => {
    seedRepo(REPO);
    seedJob({
      id: "job-twice",
      repo: REPO,
      createdAt: "2026-01-02T10:00:00.000Z",
      waits: [
        {
          service: "openrouter",
          stage: "extract facts",
          reason: "429 Too Many Requests",
          seconds: 30,
        },
        {
          service: "openrouter",
          stage: "extract facts",
          reason: "429 Too Many Requests",
          seconds: 30,
        },
      ],
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const settingsText = visibleText(
      await page(app, cookie, `/repos/${REPO}/settings`),
    );

    if (!/Last sync/i.test(settingsText)) {
      throw new Error("the last sync alert is missing");
    }
    if (!/OpenRouter/.test(settingsText)) {
      throw new Error("the alert does not name OpenRouter");
    }
    if (!/asked to slow down twice/i.test(settingsText)) {
      throw new Error("the alert does not say the service asked twice");
    }
    if (!/waited 30\s*s each time/i.test(settingsText)) {
      throw new Error("the alert does not say 30 seconds each time");
    }
  });
});

test("different wait durations are not summarized as each time", async () => {
  await withEnv(async () => {
    seedRepo(REPO);
    seedJob({
      id: "job-different",
      repo: REPO,
      createdAt: "2026-01-02T10:00:00.000Z",
      waits: [
        {
          service: "openrouter",
          stage: "extract facts",
          reason: "429 Too Many Requests",
          seconds: 5,
        },
        {
          service: "openrouter",
          stage: "extract facts",
          reason: "429 Too Many Requests",
          seconds: 15,
        },
      ],
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const settingsText = visibleText(
      await page(app, cookie, `/repos/${REPO}/settings`),
    );

    if (!/Last sync/i.test(settingsText)) {
      throw new Error("the last sync alert is missing");
    }
    if (!/\b5\s*(?:s|sec|seconds)\b/i.test(settingsText)) {
      throw new Error("the alert does not show the 5 second wait");
    }
    if (!/\b15\s*(?:s|sec|seconds)\b/i.test(settingsText)) {
      throw new Error("the alert does not show the 15 second wait");
    }
    if (!/\b20\s*(?:s|sec|seconds)\b/i.test(settingsText)) {
      throw new Error("the alert does not show the 20 second total");
    }
    if (/each time/i.test(settingsText)) {
      throw new Error("different durations were summarized as each time");
    }
  });
});

test("a latest sync with no waits shows no last sync warning", async () => {
  await withEnv(async () => {
    seedRepo(REPO);
    seedJob({
      id: "job-no-waits",
      repo: REPO,
      createdAt: "2026-01-02T10:00:00.000Z",
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const settingsText = visibleText(
      await page(app, cookie, `/repos/${REPO}/settings`),
    );
    const jobText = visibleText(
      await page(app, cookie, "/activity/job-no-waits"),
    );

    if (/Last sync|asked to slow down/i.test(settingsText)) {
      throw new Error(
        "the settings page warned although the latest sync waited",
      );
    }
    if (/asked to slow down/i.test(jobText)) {
      throw new Error("the job page warned although the job never waited");
    }
  });
});

test("an older sync job's waits do not become the latest last sync warning", async () => {
  await withEnv(async () => {
    seedRepo(REPO);
    seedJob({
      id: "job-old-waits",
      repo: REPO,
      createdAt: "2026-01-01T10:00:00.000Z",
      waits: [
        {
          service: "openrouter",
          stage: "extract facts",
          reason: "429 Too Many Requests",
          seconds: 30,
        },
      ],
    });
    seedJob({
      id: "job-latest-clean",
      repo: REPO,
      createdAt: "2026-01-02T10:00:00.000Z",
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const settingsText = visibleText(
      await page(app, cookie, `/repos/${REPO}/settings`),
    );

    if (/asked to slow down/i.test(settingsText)) {
      throw new Error(
        "an older job's waits were shown as the latest last sync",
      );
    }
  });
});

test("another repository's waits do not leak into this repository's last sync warning", async () => {
  await withEnv(async () => {
    seedRepo("acme/widgets");
    seedRepo("acme/gadgets");
    seedJob({
      id: "job-widgets",
      repo: "acme/widgets",
      createdAt: "2026-01-02T10:00:00.000Z",
    });
    seedJob({
      id: "job-gadgets",
      repo: "acme/gadgets",
      createdAt: "2026-01-02T10:00:00.000Z",
      waits: [
        {
          service: "openrouter",
          stage: "extract facts",
          reason: "429 Too Many Requests",
          seconds: 30,
        },
      ],
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const widgetsText = visibleText(
      await page(app, cookie, "/repos/acme/widgets/settings"),
    );
    const gadgetsText = visibleText(
      await page(app, cookie, "/repos/acme/gadgets/settings"),
    );

    if (/asked to slow down/i.test(widgetsText)) {
      throw new Error("another repository's waits leaked into this page");
    }
    if (!/asked to slow down/i.test(gadgetsText)) {
      throw new Error(
        "the repository with waits did not show its own last sync warning",
      );
    }
  });
});
