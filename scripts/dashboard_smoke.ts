/** Dashboard browser smoke test.
 *
 *   npm run dashboard:smoke
 *
 * Starts the real `co-maintainer serve` against a throwaway config, repo
 * directory and app.db seeded with one repository, then drives a headless
 * Chromium through every page the router can render. A console error or an
 * uncaught page error fails the run — the dashboard's inline scripts only
 * misbehave in a browser, which no `node:test` can see.
 *
 * The `bindToggle` and `loadRemoteTokens` crashes that once hit these pages are gone
 * from the marks below: the helper is inlined into `<head>` ahead of every
 * page script, and the token list waits for `DOMContentLoaded`. Everything
 * here must be clean now.
 *
 * `SMOKE_SHOTS=<dir>` also saves a screenshot of the review policy editor,
 * so a change to it can be looked at, not only asserted.
 *
 * CI runs this only on the ubuntu job (`npx playwright install --with-deps
 * chromium`); the Windows test job does not pay for a browser.
 */
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import { openAppDb, closeAppDb } from "../src/store/app_db.ts";
import { readConfig, writeRepoConfig, writeUserConfig } from "../src/config.ts";
import { parseRemakeCron } from "../src/services/remake_cron.ts";
import { activateRepo, markKnowledgeBuilt } from "../src/store/repos.ts";
import { insertReview, setReviewStatus } from "../src/store/reviews.ts";
import { KNOWN_COST } from "../src/testing/fixtures/cost.ts";
import { insertFinding } from "../src/store/findings.ts";
import { insertJob, setJobStatus } from "../src/store/jobs.ts";
import { upsertDrift } from "../src/store/drift.ts";
import { recordDelivery } from "../src/store/deliveries.ts";
import {
  commandSpawn,
  makeTempDir,
  mkdir,
  remove,
  setEnv,
  stat,
  writeTextFile,
} from "../src/util/runtime.ts";
import { cacheGet, cacheSet } from "../src/store/cache_db.ts";
import { Database } from "../src/store/sqlite.ts";
import { runtimeExecPath, runtimeRunArgs } from "../src/testing/runtime.ts";
import { VERSION } from "../src/version.ts";

const PASSWORD = "dashboard-smoke-pass";
const REPO = "acme/widgets";
const RUN_JOB = "job-live-smoke";
const LONG_CODE = `const veryLong = "${"x".repeat(300)}";`;
const GUIDE = [
  "# Review guide",
  "",
  "Keep **helpers** honest.",
  "",
  "## Rules",
  "",
  "- Match nodes by `id`.",
  "- Add a test for every change.",
  "",
  "```ts",
  LONG_CODE,
  "```",
  "",
].join("\n");

const PAGES = [
  "/",
  "/setup",
  "/repos/new",
  "/activity",
  "/analytics",
  "/settings",
  "/activity/job-fail",
  "/__ui",
];

const REPO_PAGES = [
  `/repos/${REPO}`,
  `/repos/${REPO}/pulls`,
  `/repos/${REPO}/pulls/7`,
  `/repos/${REPO}/knowledge`,
  `/repos/${REPO}/settings`,
  `/repos/${REPO}/remote`,
];

const SETTINGS_PAGES = [
  "/settings/ai",
  "/settings/github",
  "/settings/defaults",
  "/settings/remote",
  "/settings/server",
  "/settings/sign-in",
  "/settings/danger",
];

/** App pages, minus the debug component gallery, which has its own layout. */
const SHELL_PAGES = PAGES.filter((path) => path !== "/__ui");

/** Which nav item should carry the active mark for a resolved pathname. Repo
 * pages live under the Reviews group's Repositories item. Returns undefined
 * for a path whose active item is not part of this contract. */
function expectedActive(pathname: string): string | undefined {
  if (pathname === "/" || pathname.startsWith("/repos/")) return "/";
  if (pathname === "/setup") return "/setup";
  if (pathname === "/activity" || pathname.startsWith("/activity/")) {
    return "/activity";
  }
  if (pathname === "/usage") return "/usage";
  if (pathname.startsWith("/settings/")) return pathname;
  return undefined;
}

type Issue = {
  path: string;
  kind: "console" | "pageerror" | "text";
  text: string;
};

/** A free port for `serve`, so parallel runs and a busy machine never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kills `serve` and waits for it to actually exit, at most once. `serve`
 * only stops on a signal, so `output()` before a kill would wait forever;
 * this is what makes the error path report instead of hang. The collected
 * output is cached because `output()` is not idempotent: a second call
 * registers fresh listeners on a child that already closed and never
 * settles. */
async function stopServe(): Promise<void> {
  if (!serve || serveStopped) return;
  serveStopped = true;
  serve.kill("SIGTERM");
  serveOutput = await serve.output().catch(() => undefined);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`serve did not come up at ${url} within ${timeoutMs}ms`);
}

/** Every knob `serve` reads for where it keeps state, pointed at the sandbox
 * so the smoke can never touch the machine's real config or databases. */
function sandboxEnv(sandbox: string): Record<string, string | undefined> {
  return {
    ...process.env,
    CM_CONFIG_PATH: join(sandbox, "config.json"),
    CM_REPOS_DIR: join(sandbox, "repos"),
    CM_APP_DB: join(sandbox, "app.db"),
    CM_CLONES_DIR: join(sandbox, "clones"),
    APPDATA: join(sandbox, "appdata"),
    LOCALAPPDATA: join(sandbox, "localappdata"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_DATA_HOME: join(sandbox, "data"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.longpaths",
    GIT_CONFIG_VALUE_0: "true",
  };
}

async function seed(): Promise<void> {
  activateRepo(REPO, 9);
  markKnowledgeBuilt(REPO, "abc");
  await cacheSet("state", REPO, "{}");
  await cacheSet("cost", `${REPO}:smoke`, "{}");
  upsertDrift({
    repo: REPO,
    as_of: new Date().toISOString(),
    prs_since: 2,
    prs_updated: 1,
    commits_since: 4,
    files_changed: 3,
  });
  // Terminal states only: a queued job would be picked up by serve's worker
  // loop and reach for GitHub and an AI provider.
  insertJob({ id: "job-fail", type: "remake", repo: REPO });
  setJobStatus("job-fail", "failed", {
    error:
      "Error: remake requires a previous init or remake for this repository",
  });
  insertJob({ id: "job-rev", type: "review", repo: REPO, prNumber: 7 });
  setJobStatus("job-rev", "done");
  insertReview({
    id: "rev-old",
    repo: REPO,
    prNumber: 7,
    jobId: "job-old",
    headSha: "oldhead",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 1,
  });
  setReviewStatus("rev-old", "posted", {
    findings_count: 1,
    ...KNOWN_COST(0.01),
  });
  insertFinding({
    id: "f-old",
    reviewId: "rev-old",
    severity: "P1",
    path: "src/legacy.ts",
    lineFrom: 9,
    lineTo: 9,
    title: "old finding",
    bodyMd: "This finding belongs to an earlier review.",
  });
  insertReview({
    id: "rev-1",
    repo: REPO,
    prNumber: 7,
    jobId: "job-rev",
    headSha: "deadbeef",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 2,
  });
  setReviewStatus("rev-1", "posted", {
    findings_count: 1,
    ...KNOWN_COST(0.02),
    tokens_in: 12000,
    tokens_out: 3400,
    duration_ms: 90000,
  });
  insertFinding({
    id: "f-1",
    reviewId: "rev-1",
    severity: "P2",
    path: "src/app.ts",
    lineFrom: 4,
    lineTo: 4,
    title: "unused value",
    bodyMd: "Use the argument or drop it.",
    firstSeenReviewId: "rev-0",
  });
  // A real free model: cost is known and genuinely $0, unlike the two rounds
  // below whose cost never got recorded. Both must stay visually distinct:
  // "$0.00" here, "unknown" there, never the other way round.
  insertReview({
    id: "rev-free",
    repo: REPO,
    prNumber: 7,
    jobId: "job-free",
    headSha: "f0f0f0f",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 3,
  });
  setReviewStatus("rev-free", "posted", {
    findings_count: 0,
    ...KNOWN_COST(0),
  });
  insertReview({
    id: "rev-unknown",
    repo: REPO,
    prNumber: 7,
    jobId: "job-unknown",
    headSha: "abcabc1",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 4,
  });
  setReviewStatus("rev-unknown", "posted", {
    findings_count: 0,
    cost_status: "unknown",
    cost_note: "provider_did_not_report",
  });
  recordDelivery({
    deliveryId: "d-1",
    event: "pull_request",
    action: "opened",
    repo: REPO,
    prNumber: 8,
    outcome: "skipped",
    reason: "draft",
  });
  recordDelivery({
    deliveryId: "d-2",
    event: "pull_request",
    action: "opened",
    repo: REPO,
    prNumber: 9,
    outcome: "skipped",
    reason: "Rule 3 (trusted author): waiting for a maintainer request.",
  });
}

const sandbox = await makeTempDir({ prefix: "cm-dashboard-smoke-" });
const env = sandboxEnv(sandbox);
let serve: ReturnType<typeof commandSpawn> | undefined;
let serveStopped = false;
let serveOutput:
  | Awaited<ReturnType<ReturnType<typeof commandSpawn>["output"]>>
  | undefined;

// The child gets the sandbox env, and this process needs it too for the
// in-process seeding below to land in the same files.
for (const [name, value] of Object.entries(env)) {
  if (value !== undefined) setEnv(name, value);
}

/** A direct connection to the sandbox database. `openAppDb()` cannot be used
 * here: `serve` owns the pid lock for as long as it runs. */
function sandboxDatabase(): Database {
  const path = env.CM_APP_DB;
  if (!path) throw new Error("the sandbox app.db path is missing");
  return new Database(path);
}

function insertRunningJob(): void {
  const db = sandboxDatabase();
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs
         (id, type, repo, pr_number, status, args, created_at, started_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(
      RUN_JOB,
      "remake",
      REPO,
      null,
      JSON.stringify({
        stages: [
          { name: "Read code", state: "done", detail: "112 files" },
          {
            name: "Read pull requests",
            state: "current",
            detail: "31 of 50",
            percent: 62,
          },
          { name: "Extract facts", state: "pending" },
          { name: "Write the guides", state: "pending" },
        ],
        spent: 0.008,
        estimate: 0.05,
      }),
      now,
      now,
    );
    const samples = [
      ["info", "read code · 112 files"],
      ["dim", "fetch PR 1/36 · download diff"],
      ["ok", "fetch PR 20/36 done · 2 comments · 1 review"],
      ["warn", "fetch PR 35/50 skipped: diff too large"],
      ["error", "ai synth_guide failed · retrying once"],
    ] as const;
    for (let index = 0; index < 45; index++) {
      const sample = samples[index % samples.length]!;
      db.prepare(
        `INSERT INTO job_logs (job_id, seq, at, level, message)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        RUN_JOB,
        index + 1,
        new Date(Date.now() - (45 - index) * 1000).toISOString(),
        sample[0],
        `${sample[1]} · line ${index + 1}`,
      );
    }
  } finally {
    db.close();
  }
}

function finishRunningJob(): void {
  const db = sandboxDatabase();
  try {
    db.prepare(
      "UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), RUN_JOB);
  } finally {
    db.close();
  }
}

function appendRunningLog(level: string, message: string): number {
  const db = sandboxDatabase();
  try {
    const max =
      db
        .prepare<{ max_seq: number | null }>(
          `SELECT MAX(seq) AS max_seq FROM job_logs WHERE job_id = ?`,
        )
        .get(RUN_JOB)?.max_seq ?? 0;
    const seq = max + 1;
    db.prepare(
      `INSERT INTO job_logs (job_id, seq, at, level, message)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(RUN_JOB, seq, new Date().toISOString(), level, message);
    return seq;
  } finally {
    db.close();
  }
}

function updateRunningJobArgs(args: unknown): void {
  const db = sandboxDatabase();
  try {
    db.prepare("UPDATE jobs SET args = ? WHERE id = ?").run(
      JSON.stringify(args),
      RUN_JOB,
    );
  } finally {
    db.close();
  }
}

/** The repository settings controls the mock shows: Speed, scheduled sync,
 * blocking, the policy choices and the single Save footer. Every check records
 * an issue instead of throwing, so one missing card still reports the rest. */
async function checkRepoSettingsVision(
  page: import("playwright").Page,
  base: string,
  issues: Issue[],
): Promise<void> {
  const path = `/repos/${REPO}/settings`;
  const add = (text: string): void => {
    issues.push({ path, kind: "text", text });
  };
  const open = async (): Promise<void> => {
    await page.goto(`${base}${path}`, { waitUntil: "load" });
    await sleep(300);
  };
  const saveChanges = page.getByRole("button", { name: "Save changes" });
  const reset = page.getByRole("button", { name: "Reset to defaults" });
  const save = async (): Promise<boolean> => {
    if ((await saveChanges.count()) !== 1) return false;
    await saveChanges.click();
    await sleep(600);
    return true;
  };
  const segAfter = (label: string) =>
    page.locator(
      `xpath=//*[text()[contains(.,"${label}")]]/following::div[contains(@class,"seg")][1]`,
    );
  const selectedClass = async (
    locator: import("playwright").Locator,
  ): Promise<string> =>
    (await locator.getAttribute("class").catch(() => "")) ?? "";

  await writeUserConfig({
    auth: "gh",
    ai: "openrouter",
    lowModel: "paid/low",
    highModel: "paid/high",
    defaults: { ghConcurrent: 2, aiConcurrent: 4 },
  });
  await writeRepoConfig(REPO, { ghConcurrent: 8, aiConcurrent: 6 });
  await open();

  const text = await page.locator("body").innerText();
  for (const title of ["How reviews run", "What knowledge reads", "Danger"]) {
    if ((await page.locator(`h2:has-text("${title}")`).count()) === 0) {
      add(`the section title ${JSON.stringify(title)} is missing`);
    }
  }
  const saveCount = await saveChanges.count();
  if (saveCount !== 1) {
    add(`the page has ${saveCount} Save changes controls, want 1`);
  }
  const resetCount = await reset.count();
  if (resetCount !== 1) {
    add(`the page has ${resetCount} Reset to defaults controls, want 1`);
  }

  const ghSeg = segAfter("GitHub requests at once");
  const aiSeg = segAfter("AI calls at once");
  if ((await ghSeg.count()) === 0) {
    add("the Speed card has no GitHub concurrency segment");
  } else {
    const selected = await ghSeg
      .locator("button.on")
      .first()
      .innerText()
      .catch(() => "");
    if (!selected.trim().startsWith("8")) {
      add(`the GitHub segment shows ${JSON.stringify(selected)}, want 8`);
    }
  }
  if ((await aiSeg.count()) === 0) {
    add("the Speed card has no AI concurrency segment");
  } else {
    const selected = await aiSeg
      .locator("button.on")
      .first()
      .innerText()
      .catch(() => "");
    if (!selected.trim().startsWith("6")) {
      add(`the AI segment shows ${JSON.stringify(selected)}, want 6`);
    }
  }
  if (!/Overridden/i.test(text)) {
    add("the Speed card has no Overridden badge");
  }
  if (
    !text.includes("--gh-concurrent=8") ||
    !text.includes("--ai-concurrent=6")
  ) {
    add(
      "the Speed card's CLI equivalent does not show --gh-concurrent=8 --ai-concurrent=6",
    );
  }

  const useRecommended = page.getByRole("button", { name: /Use recommended/i });
  if ((await useRecommended.count()) === 0) {
    add("the Speed card has no Use recommended control");
  } else {
    const label = (await useRecommended.first().innerText()) ?? "";
    const match = /\((\d+)\s*[·x/]\s*(\d+)\)/.exec(label);
    if (!match) {
      add(`Use recommended has no readable values: ${JSON.stringify(label)}`);
    } else if (await save()) {
      const repo = readConfig().repos?.[REPO];
      if (
        repo?.ghConcurrent !== Number(match[1]) ||
        repo?.aiConcurrent !== Number(match[2])
      ) {
        add(
          `Use recommended showed ${match[1]} · ${match[2]} but saved ${repo?.ghConcurrent} · ${repo?.aiConcurrent}`,
        );
      }
    }
  }
  await open();

  if ((await reset.count()) === 1) {
    await reset.click();
    await sleep(300);
    await save();
    const repo = readConfig().repos?.[REPO];
    if (repo?.ghConcurrent !== undefined || repo?.aiConcurrent !== undefined) {
      add(
        `Reset left the repo Speed override: ${JSON.stringify({
          gh: repo?.ghConcurrent,
          ai: repo?.aiConcurrent,
        })}`,
      );
    }
    await open();
    if ((await ghSeg.count()) > 0) {
      const selected = await ghSeg
        .locator("button.on")
        .first()
        .innerText()
        .catch(() => "");
      if (!selected.trim().startsWith("2")) {
        add(
          `after Reset the GitHub segment shows ${JSON.stringify(selected)}, want the default 2`,
        );
      }
    }
  }

  const scheduled = segAfter("Scheduled sync");
  if ((await scheduled.count()) === 0) {
    add("Scheduled sync has no Off/Daily/Weekly/Custom segment");
  } else {
    for (const label of ["Off", "Daily", "Weekly", "Custom"]) {
      if (
        (await scheduled
          .getByRole("button", { name: label, exact: true })
          .count()) === 0
      ) {
        add(`Scheduled sync has no ${label} choice`);
      }
    }
    const custom = scheduled.getByRole("button", {
      name: "Custom",
      exact: true,
    });
    const cron = page.locator("#cron");
    if ((await custom.count()) === 1 && (await cron.count()) === 1) {
      await custom.click();
      await sleep(200);
      if (!(await cron.isVisible())) {
        add("choosing Custom does not reveal the cron field");
      }
      const issuesBefore = issues.length;
      await cron.fill("not a cron");
      if (await save()) {
        const reason = await page
          .locator("[data-fail], #toasts")
          .innerText()
          .catch(() => "");
        if (!/cron|field|minute|hour/i.test(reason)) {
          add("an invalid custom cron showed no reason");
        }
      }
      for (let index = issues.length - 1; index >= issuesBefore; index--) {
        const issue = issues[index]!;
        if (issue.kind === "console" && issue.text.includes("422")) {
          issues.splice(index, 1);
        }
      }
      await open();
      const weekly = segAfter("Scheduled sync").getByRole("button", {
        name: "Weekly",
        exact: true,
      });
      if ((await weekly.count()) === 1) {
        await weekly.click();
        if (await save()) {
          const saved = readConfig().repos?.[REPO]?.remakeCron;
          if (!saved) {
            add("choosing Weekly did not save a cron");
          } else {
            try {
              parseRemakeCron(saved);
            } catch (error) {
              add(`the saved Weekly cron is invalid: ${String(error)}`);
            }
          }
        }
        await open();
        const selectedWeekly = segAfter("Scheduled sync").getByRole("button", {
          name: "Weekly",
          exact: true,
        });
        if (
          !(await selectedClass(selectedWeekly)).split(/\s+/).includes("on")
        ) {
          add("the saved Weekly schedule is not selected after reload");
        }
      }
    }
  }

  const blocking = page.locator(
    'xpath=//*[text()[contains(.,"The model says so")]]/ancestor::div[contains(@class,"seg")][1]',
  );
  if ((await blocking.count()) === 0) {
    add("blocking has no model/severity segment");
  } else {
    const severity = blocking.getByRole("button", {
      name: "Severity is Critical or High",
      exact: true,
    });
    if ((await severity.count()) === 0) {
      add("blocking has no Severity is Critical or High choice");
    }
    if (!text.includes("--review-blocking=model|severity")) {
      add("blocking has no --review-blocking=model|severity hint");
    }
    if ((await severity.count()) === 1) {
      await severity.click();
      if (await save()) {
        const config = readConfig();
        const repo = (config.repos?.[REPO] ?? {}) as Record<string, unknown>;
        const mode = repo.reviewBlocking ?? config.reviewBlocking;
        if (mode !== "severity") {
          add(`saving severity stored ${JSON.stringify(mode)}`);
        }
      }
    }
    await open();
    const selectedSeverity = page
      .locator(
        'xpath=//*[text()[contains(.,"The model says so")]]/ancestor::div[contains(@class,"seg")][1]',
      )
      .getByRole("button", {
        name: "Severity is Critical or High",
        exact: true,
      });
    if (!(await selectedClass(selectedSeverity)).split(/\s+/).includes("on")) {
      add("the saved severity blocking mode is not selected after reload");
    }
  }

  const policy = page.locator('.card:has-text("Who gets a review")').first();
  for (const label of ["Everyone", "Trusted authors", "Only when asked"]) {
    if ((await policy.getByText(label, { exact: true }).count()) === 0) {
      add(`the policy card has no ${label} choice`);
    }
  }
  const policyText = await policy.innerText().catch(() => "");
  if (!/Default|Overridden/.test(policyText)) {
    add("the policy card has no Default or Overridden badge");
  }
  const trustedRadio = policy.locator(
    'label:has-text("Trusted authors") input[type="radio"]',
  );
  const trustedButton = policy.getByRole("button", {
    name: "Trusted authors",
    exact: true,
  });
  let choseTrusted = false;
  if ((await trustedRadio.count()) > 0) {
    await trustedRadio.first().check();
    choseTrusted = true;
  } else if ((await trustedButton.count()) > 0) {
    await trustedButton.first().click();
    choseTrusted = true;
  }
  if (!choseTrusted) {
    add("the Trusted authors policy choice is not usable");
  } else if (await save()) {
    const db = sandboxDatabase();
    try {
      const stored =
        db
          .prepare<{ review_policy_json: string | null }>(
            "SELECT review_policy_json FROM repos WHERE full_name = ?",
          )
          .get(REPO)?.review_policy_json ?? "";
      if (!stored.includes("trusted-auto")) {
        add(`saving Trusted authors stored ${JSON.stringify(stored)}`);
      }
    } finally {
      db.close();
    }
  }
  await open();
  const reloadedPolicy = page
    .locator('.card:has-text("Who gets a review")')
    .first();
  const checkedRadio = reloadedPolicy.locator(
    'label:has-text("Trusted authors") input[type="radio"]:checked',
  );
  const checkedButton = reloadedPolicy.locator(
    'button.on:has-text("Trusted authors")',
  );
  if (
    (await checkedRadio.count()) === 0 &&
    (await checkedButton.count()) === 0
  ) {
    add("the saved Trusted authors policy is not selected after reload");
  }

  await writeUserConfig({
    ai: "openrouter",
    lowModel: "deepseek/deepseek-chat-v3.1:free",
    highModel: "paid/high",
  });
  await writeRepoConfig(REPO, { aiConcurrent: 2 });
  await open();
  const freeWarning = page.getByText(
    /Free OpenRouter models hit rate limits|free OpenRouter model is in use/i,
  );
  if ((await freeWarning.count()) === 0) {
    add("AI 2 with a free OpenRouter model shows no warning");
  }
  const aiSegment = segAfter("AI calls at once");
  if ((await aiSegment.count()) > 0) {
    const one = aiSegment.getByRole("button", { name: "1", exact: true });
    if ((await one.count()) === 1) {
      await one.click();
      await sleep(200);
      if (
        (await page
          .getByText(
            /Free OpenRouter models hit rate limits|free OpenRouter model is in use/i,
          )
          .count()) > 0
      ) {
        add("the free-model warning did not clear at AI 1");
      }
      const two = aiSegment.getByRole("button", { name: "2", exact: true });
      if ((await two.count()) === 1) {
        await two.click();
        if (await save()) {
          const saved = readConfig().repos?.[REPO]?.aiConcurrent;
          if (saved !== 2) {
            add(`the free-model warning blocked saving AI 2 (saved ${saved})`);
          }
        }
      }
    }
  }
}

try {
  await mkdir(`${env.CM_REPOS_DIR}/${REPO}`, { recursive: true });
  await writeTextFile(`${env.CM_REPOS_DIR}/${REPO}/PR_REVIEW_GUIDE.md`, GUIDE);
  await writeUserConfig({ auth: "gh", ai: "none" });
  await openAppDb();
  try {
    await seed();
  } finally {
    await closeAppDb();
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  serve = commandSpawn(runtimeExecPath(), {
    args: runtimeRunArgs("main.ts", [
      "serve",
      `--port=${port}`,
      `--password=${PASSWORD}`,
      "--debug",
    ]),
    cwd: join(import.meta.dirname, ".."),
    env,
    stdout: "piped",
    stderr: "piped",
  });
  await waitForServer(`${base}/login`, 60_000);
  console.log(`serve up on ${base}`);

  const browser = await chromium.launch();
  const issues: Issue[] = [];
  try {
    const page = await browser.newPage();
    // Derive the path from the live URL instead of a loop variable: the
    // post-login redirect lands on `/` before the loop starts, and a stale
    // label would blame the login page for an error on home.
    const pathOf = (): string => {
      try {
        return new URL(page.url()).pathname;
      } catch {
        return page.url();
      }
    };
    const visionShot = async (name: string): Promise<void> => {
      const dir = process.env.SMOKE_SHOTS;
      if (dir) {
        await page.screenshot({
          path: join(dir, `${name}.png`),
          fullPage: true,
        });
      }
    };
    const contrastCheck = async (path: string): Promise<void> => {
      const name =
        path === "/"
          ? "home"
          : path === "/settings/ai"
            ? "settings-ai"
            : "repo-settings";
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((dark) => {
          document.documentElement.classList.toggle("dark", dark);
        }, theme === "dark");
        await sleep(120);
        const data = (await page.evaluate(() => {
          const lum = (rgb: string): number => {
            const parts = (rgb.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
            const channel = (value: number): number => {
              const v = value / 255;
              return v <= 0.03928
                ? v / 12.92
                : Math.pow((v + 0.055) / 1.055, 2.4);
            };
            return (
              0.2126 * channel(parts[0] ?? 0) +
              0.7152 * channel(parts[1] ?? 0) +
              0.0722 * channel(parts[2] ?? 0)
            );
          };
          const ratio = (a: string, b: string): number => {
            const first = lum(a);
            const second = lum(b);
            const light = Math.max(first, second);
            const dark = Math.min(first, second);
            return (light + 0.05) / (dark + 0.05);
          };
          const composite = (fg: string, bg: string): string => {
            const f = (fg.match(/[\d.]+/g) ?? []).map(Number);
            const b = (bg.match(/[\d.]+/g) ?? []).map(Number);
            const alpha = f[3] ?? 1;
            const channel = (index: number): number =>
              Math.round(
                (f[index] ?? 0) * alpha + (b[index] ?? 0) * (1 - alpha),
              );
            return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
          };
          const pick = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const style = getComputedStyle(el);
            let bg = style.backgroundColor;
            const card = el.closest(".card");
            const base = card
              ? getComputedStyle(card).backgroundColor
              : getComputedStyle(document.body).backgroundColor;
            const alpha = Number((bg.match(/[\d.]+/g) ?? [])[3] ?? 1);
            if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = base;
            else if (alpha < 1) bg = composite(bg, base);
            const borderWidth = Math.max(
              parseFloat(style.borderTopWidth),
              parseFloat(style.borderRightWidth),
              parseFloat(style.borderBottomWidth),
              parseFloat(style.borderLeftWidth),
            );
            const borderColor = style.borderBottomColor;
            return {
              bg,
              fg: style.color,
              ratio: ratio(style.color, bg),
              bgLum: lum(bg),
              borderColor,
              borderWidth,
              borderRatio: ratio(borderColor, bg),
              borderLum: lum(borderColor),
            };
          };
          return {
            primary: pick(".primary"),
            btn: pick("button.btn"),
            input: pick('input:not([type="checkbox"]):not([type="radio"])'),
            select: pick("select"),
            hint: pick(".hint"),
            help: pick(".help"),
            ft: pick(".card .ft"),
            stepN: pick(".steps .n"),
            stepLi: pick(".steps li"),
            th: pick("th"),
          };
        })) as Record<
          string,
          {
            bg: string;
            fg: string;
            ratio: number;
            bgLum: number;
            borderColor: string;
            borderWidth: number;
            borderRatio: number;
            borderLum: number;
          } | null
        >;
        for (const [label, item] of Object.entries(data)) {
          if (!item) continue;
          if (item.ratio < 4.5) {
            issues.push({
              path,
              kind: "text",
              text: `${theme} ${label} contrast ${item.ratio.toFixed(2)} is below 4.5`,
            });
          }
          if (
            theme === "dark" &&
            (label === "input" || label === "select" || label === "ft") &&
            item.bgLum > 0.3
          ) {
            issues.push({
              path,
              kind: "text",
              text: `${theme} ${label} background is too bright`,
            });
          }
          if (
            theme === "dark" &&
            (label === "input" || label === "select") &&
            item.borderWidth > 0 &&
            item.borderRatio < 1.5
          ) {
            issues.push({
              path,
              kind: "text",
              text: `${theme} ${label} border contrast ${item.borderRatio.toFixed(2)} is too low`,
            });
          }
          if (
            theme === "dark" &&
            (label === "hint" || label === "help") &&
            item.ratio < 4.5
          ) {
            issues.push({
              path,
              kind: "text",
              text: `${theme} ${label} contrast ${item.ratio.toFixed(2)} is below 4.5`,
            });
          }
          if (theme === "dark" && label === "stepN" && item.bgLum > 0.3) {
            issues.push({
              path,
              kind: "text",
              text: `${theme} setup number circle is too bright`,
            });
          }
          if (
            theme === "dark" &&
            label === "stepLi" &&
            item.borderWidth > 0 &&
            item.borderLum > 0.3
          ) {
            issues.push({
              path,
              kind: "text",
              text: `${theme} setup separator is too bright`,
            });
          }
          if (theme === "dark" && label === "th" && item.bgLum > 0.3) {
            issues.push({
              path,
              kind: "text",
              text: `${theme} table header is too bright`,
            });
          }
        }
        if (process.env.SMOKE_SHOTS) {
          await page.screenshot({
            path: join(process.env.SMOKE_SHOTS, `${name}-${theme}.png`),
            fullPage: true,
          });
        }
      }
      await page.evaluate(() =>
        document.documentElement.classList.remove("dark"),
      );
    };
    // One listener for the whole run, plus a per-navigation set of failed
    // requests so each page is judged on its own.
    let failedRequests = new Set<string>();
    page.on("console", (message) => {
      if (message.type() === "error") {
        issues.push({ path: pathOf(), kind: "console", text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      issues.push({
        path: pathOf(),
        kind: "pageerror",
        text: error.message,
      });
    });
    page.on("requestfailed", (request) => {
      failedRequests.add(request.url());
    });

    await page.goto(`${base}/login`, { waitUntil: "load" });
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL(`${base}/`, { timeout: 15_000 }),
      page.click('button[type="submit"]'),
    ]);
    console.log("signed in");

    for (const path of [...PAGES, ...REPO_PAGES]) {
      failedRequests = new Set<string>();
      const response = await page.goto(`${base}${path}`, {
        waitUntil: "load",
      });
      if (response && response.status() !== 200) {
        throw new Error(`${path} returned ${response.status()}`);
      }
      // Inline and deferred page scripts settle a tick after `load`.
      await sleep(400);
      for (const url of failedRequests) {
        issues.push({
          path,
          kind: "console",
          text: `request failed: ${url}`,
        });
      }
      if (path === "/settings") {
        const list =
          (await page.locator("#remote-token-list").textContent()) ?? "";
        if (list.includes("Could not load tokens.")) {
          issues.push({
            path,
            kind: "text",
            text: "Could not load tokens.",
          });
        }
      }
      if (path === "/settings") {
        const boxes = await page
          .locator('input[type="checkbox"]')
          .evaluateAll((inputs) =>
            inputs.map((input) => {
              const box = input.getBoundingClientRect();
              const label = input.closest("label");
              const range = document.createRange();
              range.selectNodeContents(label ?? input);
              const line = range.getBoundingClientRect();
              const middle = box.top + box.height / 2;
              return {
                id: input.id,
                width: box.width,
                sameLine: middle >= line.top && middle <= line.bottom,
                textOnBoxLine: label !== null && line.height < box.height * 2.5,
              };
            }),
          );
        if (boxes.length === 0) {
          issues.push({ path, kind: "text", text: "no checkbox found" });
        }
        for (const box of boxes) {
          if (box.width >= 32 || !box.sameLine || !box.textOnBoxLine) {
            issues.push({
              path,
              kind: "text",
              text: `checkbox #${box.id} is ${Math.round(box.width)}px wide or off its label line`,
            });
          }
        }
      }
      // The seeded PR carries a real $0.00 review and an unknown-cost one:
      // the page must show both, and never turn the unknown one
      // into the same $0.00 as the free one.
      if (
        [
          "/activity",
          "/analytics",
          `/repos/${REPO}`,
          `/repos/${REPO}/pulls`,
          `/repos/${REPO}/pulls/7`,
        ].includes(path)
      ) {
        const body = await page.locator("body").innerText();
        if (!body.includes("unknown")) {
          issues.push({
            path,
            kind: "text",
            text: "an unknown-cost review is missing its unknown label",
          });
        }
      }
      if (path === `/repos/${REPO}/pulls/7`) {
        const body = await page.locator("body").innerText();
        if (!body.includes("$0.00")) {
          issues.push({
            path,
            kind: "text",
            text: "the free review's real $0.00 did not render",
          });
        }
      }
      if (path === "/") await visionShot("home");
      if (path === "/") await contrastCheck(path);
      if (path === "/analytics") await visionShot("usage");
      if (path === "/activity") await visionShot("activity");
      if (path === `/repos/${REPO}`) await visionShot("repo");
      if (path === `/repos/${REPO}/settings`) {
        await visionShot("repo-settings");
      }
      console.log(`visited ${path}`);
    }

    // --- Server page: the status rows describe this process, not just the
    // saved config. The port and data directory are unique to this sandbox.
    await page.goto(`${base}/settings/server`, { waitUntil: "load" });
    await sleep(250);
    const serverRows = await page.evaluate(() => {
      const rows: Record<string, string> = {};
      document.querySelectorAll("dt").forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === "DD") {
          rows[(dt.textContent ?? "").trim()] = (dd.textContent ?? "").trim();
        }
      });
      document.querySelectorAll("tr").forEach((tr) => {
        const cells = tr.querySelectorAll("td");
        if (cells.length === 2) {
          rows[(cells[0]!.textContent ?? "").trim()] = (
            cells[1]!.textContent ?? ""
          ).trim();
        }
      });
      return rows;
    });
    const expectedDataDir = join(env.XDG_CACHE_HOME ?? "", "co-maintainer");
    for (const [label, value] of [
      ["Version", VERSION],
      ["Port", String(port)],
      ["Behind a proxy", "No"],
      ["Data", expectedDataDir],
    ] as const) {
      const actual = serverRows[label];
      if (actual === undefined) {
        issues.push({
          path: "/settings/server",
          kind: "text",
          text: `the server page has no ${label} row`,
        });
      } else if (!actual.includes(value)) {
        issues.push({
          path: "/settings/server",
          kind: "text",
          text: `${label} shows ${JSON.stringify(actual)}, want ${JSON.stringify(value)}`,
        });
      }
    }
    for (const id of [
      "max-jobs",
      "remote-timeout",
      "remote-per-token",
      "remote-tool-chars",
    ]) {
      if ((await page.locator(`#${id}`).count()) !== 1) {
        issues.push({
          path: "/settings/server",
          kind: "text",
          text: `the server page lost the #${id} field`,
        });
      }
    }
    await page.fill("#max-jobs", "-1");
    await page.click("#save-server");
    let sawLimitReason = true;
    try {
      await page.waitForFunction(
        () => {
          const box = document.querySelector("#server [data-fail]");
          return Boolean(
            box && /positive whole number/i.test(box.textContent ?? ""),
          );
        },
        null,
        { timeout: 2000 },
      );
    } catch {
      sawLimitReason = false;
    }
    if (!sawLimitReason) {
      issues.push({
        path: "/settings/server",
        kind: "text",
        text: "an invalid job limit did not show its reason",
      });
    }
    if ((await page.locator("#toasts").innerText()).includes("Saved")) {
      issues.push({
        path: "/settings/server",
        kind: "text",
        text: "an invalid job limit showed Saved",
      });
    }
    await page.fill("#max-jobs", "2");
    await page.click("#save-server");
    let sawSavedLimit = true;
    try {
      await page.waitForFunction(
        () =>
          (document.querySelector("#toasts")?.textContent ?? "").includes(
            "Saved",
          ),
        null,
        { timeout: 3000 },
      );
    } catch {
      sawSavedLimit = false;
    }
    if (!sawSavedLimit) {
      issues.push({
        path: "/settings/server",
        kind: "text",
        text: "a valid job limit did not save",
      });
    }
    await page.reload({ waitUntil: "load" });
    if ((await page.locator("#max-jobs").inputValue()) !== "2") {
      issues.push({
        path: "/settings/server",
        kind: "text",
        text: "the saved job limit did not round-trip",
      });
    }
    console.log("server page runtime values work");

    // --- Document viewer: markdown, Copy, Download, missing documents and a
    // long code block. All three read paths must start from the same file.
    const docPath = `/repos/${REPO}/knowledge?view=guide`;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}${docPath}`, { waitUntil: "load" });
    await sleep(300);
    const docState = await page.evaluate(() => {
      const source = document.querySelector('[data-doc-source="guide"]');
      const download = document.querySelector('a[data-doc-download="guide"]');
      return {
        markdown: Boolean(document.querySelector(".markdown")),
        heading: document.querySelector(".markdown h2")?.textContent ?? "",
        strong: document.querySelector(".markdown strong")?.textContent ?? "",
        code: document.querySelector(".markdown code")?.textContent ?? "",
        copy: Boolean(document.querySelector('[data-copy-doc="guide"]')),
        source: source?.textContent ?? "",
        download: download?.getAttribute("href") ?? "",
      };
    });
    if (!docState.markdown) {
      issues.push({
        path: docPath,
        kind: "text",
        text: "the document is not rendered as markdown",
      });
    }
    if (docState.heading !== "Rules") {
      issues.push({
        path: docPath,
        kind: "text",
        text: `the markdown heading is ${JSON.stringify(docState.heading)}`,
      });
    }
    if (docState.strong !== "helpers") {
      issues.push({
        path: docPath,
        kind: "text",
        text: "the markdown bold is missing",
      });
    }
    if (docState.code !== "id") {
      issues.push({
        path: docPath,
        kind: "text",
        text: "the markdown inline code is missing",
      });
    }
    if (!docState.copy) {
      issues.push({
        path: docPath,
        kind: "text",
        text: "the document has no Copy control",
      });
    } else {
      await page.evaluate(() => {
        (window as unknown as Record<string, string>).__copied = "";
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: (text: string) => {
              (window as unknown as Record<string, string>).__copied = text;
              return Promise.resolve();
            },
          },
        });
      });
      await page.click('[data-copy-doc="guide"]');
      await sleep(200);
      const copied = await page.evaluate(
        () =>
          (window as unknown as Record<string, string | undefined>).__copied,
      );
      if (copied !== GUIDE) {
        issues.push({
          path: docPath,
          kind: "text",
          text: "Copy copied a different text than the raw document",
        });
      }

      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error("denied")) },
        });
        document.execCommand = () => false;
        const host = document.getElementById("toasts");
        if (host) host.replaceChildren();
      });
      await page.click('[data-copy-doc="guide"]');
      await sleep(300);
      const toastText = await page.locator("#toasts").innerText();
      if (
        !/copy failed|could not copy|copy did not work|clipboard.*(failed|unavailable|blocked)/i.test(
          toastText,
        )
      ) {
        issues.push({
          path: docPath,
          kind: "text",
          text: "a failed copy was not reported",
        });
      }
      if (/\bCopied\b/.test(toastText)) {
        issues.push({
          path: docPath,
          kind: "text",
          text: "a failed copy still showed Copied",
        });
      }
    }
    if (!docState.source) {
      issues.push({
        path: docPath,
        kind: "text",
        text: "the document has no raw Copy source",
      });
    } else if (docState.source !== GUIDE) {
      issues.push({
        path: docPath,
        kind: "text",
        text: "the Copy source differs from the raw document",
      });
    }
    if (!docState.download) {
      issues.push({
        path: docPath,
        kind: "text",
        text: "the document has no Download link",
      });
    } else {
      const download = await page.request.get(
        new URL(docState.download, base).toString(),
      );
      const headers = download.headers();
      const body = await download.text();
      if (download.status() !== 200) {
        issues.push({
          path: docPath,
          kind: "text",
          text: `Download returned ${download.status()}`,
        });
      }
      if (!/^text\/markdown\b/i.test(headers["content-type"] ?? "")) {
        issues.push({
          path: docPath,
          kind: "text",
          text: `Download content type is ${JSON.stringify(headers["content-type"])}`,
        });
      }
      if (
        !/filename="?PR_REVIEW_GUIDE\.md"?/i.test(
          headers["content-disposition"] ?? "",
        )
      ) {
        issues.push({
          path: docPath,
          kind: "text",
          text: `Download filename is ${JSON.stringify(headers["content-disposition"])}`,
        });
      }
      if (body !== GUIDE) {
        issues.push({
          path: docPath,
          kind: "text",
          text: "Download content differs from the document",
        });
      }
    }

    const missingDoc = await page.goto(
      `${base}/repos/${REPO}/knowledge?view=missing`,
      { waitUntil: "load" },
    );
    if (!missingDoc || missingDoc.status() !== 404) {
      issues.push({
        path: "/repos/acme/widgets/knowledge?view=missing",
        kind: "text",
        text: `a missing document returned ${missingDoc?.status()}`,
      });
    }
    const traversalDoc = await page.goto(
      `${base}/repos/${REPO}/knowledge?view=${encodeURIComponent("../../../../etc/passwd")}`,
      { waitUntil: "load" },
    );
    if (!traversalDoc || traversalDoc.status() !== 404) {
      issues.push({
        path: "/repos/acme/widgets/knowledge?view=traversal",
        kind: "text",
        text: `a path outside the repository returned ${traversalDoc?.status()}`,
      });
    }

    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${base}${docPath}`, { waitUntil: "load" });
    await sleep(300);
    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (docOverflow > 1) {
      issues.push({
        path: docPath,
        kind: "text",
        text: `the document overflows horizontally at 375px by ${docOverflow}px`,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    console.log("document view copy and download work");

    // Component gallery (A1). It only exists with `--debug`, so it proves the
    // icon sprite resolves and the two themes are genuinely different, and it
    // is the surface the visual baseline is captured from.
    await page.goto(`${base}/__ui`, { waitUntil: "load" });
    await sleep(400);
    const spriteProblem = await page.evaluate(() => {
      const symbol = document.querySelector("#i-git-pull-request");
      const use = document.querySelector('use[href="#i-git-pull-request"]');
      if (!symbol || !use) return "the sprite or a use is missing";
      const box = use.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return "the icon did not paint";
      return "";
    });
    if (spriteProblem) {
      issues.push({ path: "/__ui", kind: "text", text: spriteProblem });
    }
    const theme = await page.evaluate(() => {
      const light = document.querySelector(".app");
      const dark = document.querySelector(".dark .app");
      return {
        light: light ? getComputedStyle(light).backgroundColor : "",
        dark: dark ? getComputedStyle(dark).backgroundColor : "",
      };
    });
    if (!theme.light || theme.light === theme.dark) {
      issues.push({
        path: "/__ui",
        kind: "text",
        text: "light and dark do not use different backgrounds",
      });
    }

    // The shared Copy control must copy the visible code, and a rejected
    // clipboard must be reported instead of claiming success.
    const codeCopy = page.locator("[data-copy]").first();
    if ((await codeCopy.count()) === 0) {
      issues.push({
        path: "/__ui",
        kind: "text",
        text: "the component gallery has no Copy control",
      });
    } else {
      const codeText = await codeCopy.evaluate((button) => {
        const box = button.closest(".code");
        return box?.querySelector("span:not(.lbl)")?.textContent ?? "";
      });
      await page.evaluate(() => {
        (window as unknown as Record<string, string>).__copied = "";
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: (text: string) => {
              (window as unknown as Record<string, string>).__copied = text;
              return Promise.resolve();
            },
          },
        });
      });
      await codeCopy.click();
      await sleep(200);
      const copiedCode = await page.evaluate(
        () =>
          (window as unknown as Record<string, string | undefined>).__copied,
      );
      if (copiedCode !== codeText) {
        issues.push({
          path: "/__ui",
          kind: "text",
          text: "the code Copy control copied a different text",
        });
      }

      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error("denied")) },
        });
        document.execCommand = () => false;
        const host = document.getElementById("toasts");
        if (host) host.replaceChildren();
      });
      await codeCopy.click();
      await sleep(300);
      const copyToast = await page.locator("#toasts").innerText();
      if (
        !/copy failed|could not copy|copy did not work|clipboard.*(failed|unavailable|blocked)/i.test(
          copyToast,
        )
      ) {
        issues.push({
          path: "/__ui",
          kind: "text",
          text: "a failed copy was not reported",
        });
      }
      if (/\bCopied\b/.test(copyToast)) {
        issues.push({
          path: "/__ui",
          kind: "text",
          text: "a failed copy still showed Copied",
        });
      }
    }

    if (process.env.SMOKE_SHOTS) {
      await page.screenshot({
        path: join(process.env.SMOKE_SHOTS, "ui-light.png"),
        fullPage: true,
      });
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await sleep(150);
      await page.screenshot({
        path: join(process.env.SMOKE_SHOTS, "ui-dark.png"),
        fullPage: true,
      });
      await page.evaluate(() =>
        document.documentElement.classList.remove("dark"),
      );
    }
    console.log("component gallery renders");

    // The review policy editor, driven the way a maintainer would.
    const shot = async (name: string): Promise<void> => {
      const dir = process.env.SMOKE_SHOTS;
      if (dir)
        await page.screenshot({
          path: join(dir, `${name}.png`),
          fullPage: true,
        });
    };
    const controlIssues = async (scope: string): Promise<string[]> =>
      await page.locator(scope).evaluate((root) => {
        const problems: string[] = [];
        for (const control of root.querySelectorAll("input, select")) {
          const id = control.id;
          const named =
            control.closest("label") !== null ||
            (id !== "" && root.querySelector(`label[for="${id}"]`) !== null);
          if (!named) problems.push(`#${id || "(no id)"} has no label`);
          if (control.getAttribute("type") === "checkbox") {
            const width = control.getBoundingClientRect().width;
            if (width >= 32)
              problems.push(`checkbox #${id} is ${Math.round(width)}px wide`);
          }
        }
        return problems;
      });
    const summaryHas = async (text: string): Promise<void> => {
      await page.waitForFunction(
        (wanted) =>
          document
            .querySelector("#policy-summary")
            ?.textContent?.includes(wanted),
        text,
        { timeout: 5000 },
      );
    };

    await page.goto(`${base}/repos/${REPO}/settings`, { waitUntil: "load" });
    if ((await page.locator("#policy-template").inputValue()) !== "legacy") {
      throw new Error(
        "a repository nobody gave a policy must show the simple switches",
      );
    }
    if ((await page.locator("#auto").count()) !== 1) {
      throw new Error(
        "the switches must be shown while the repository follows them",
      );
    }
    await shot("policy-legacy");

    await page.selectOption("#policy-template", "trusted-auto");
    await summaryHas("waits for a maintainer request");
    await page.click("#policy-details summary");
    await page.click("#add-rule");
    await page.fill("#r3-name", "newcomers");
    await page.check("#r3-a-FIRST_TIME_CONTRIBUTOR");
    await page.selectOption("#r3-action", "skip");
    await summaryHas("first time contributors are not reviewed");
    if ((await page.locator("#policy-template").inputValue()) !== "custom") {
      throw new Error(
        "editing a rule must turn the template into custom rules",
      );
    }
    const editorIssues = await controlIssues("#policy-card");
    for (const problem of editorIssues) {
      issues.push({
        path: `/repos/${REPO}/settings`,
        kind: "text",
        text: problem,
      });
    }
    await shot("policy-custom");

    const issuesBefore = issues.length;
    await page.fill("#p-max", "0");
    await page.waitForSelector("#policy-problem:not([hidden])", {
      timeout: 5000,
    });
    if (!(await page.locator("#save-policy").isDisabled())) {
      throw new Error("a policy the server refuses must not be saveable");
    }
    // The refusal is a 422 on purpose, and the browser logs it as a console
    // error. That one line is expected here and nowhere else.
    for (let i = issues.length - 1; i >= issuesBefore; i--) {
      if (issues[i]!.kind === "console" && issues[i]!.text.includes("422")) {
        issues.splice(i, 1);
      }
    }
    await page.fill("#p-max", "");
    await page.waitForFunction(
      () => !document.querySelector("#save-policy")?.hasAttribute("disabled"),
      null,
      { timeout: 5000 },
    );

    await page.click("#save-policy");
    await page.waitForFunction(
      () => !document.querySelector("#save-policy")?.hasAttribute("disabled"),
      null,
      { timeout: 5000 },
    );
    await sleep(400);
    if ((await page.locator("#policy-template").inputValue()) !== "custom") {
      throw new Error("the saved custom policy did not come back as custom");
    }
    if (await page.locator("#auto").isVisible()) {
      throw new Error("the switches must be hidden once a policy decides");
    }
    if ((await page.locator("#r3-name").inputValue()) !== "newcomers") {
      throw new Error("the saved rule did not come back");
    }

    await page.selectOption("#policy-template", "legacy");
    await page.click("#save-policy");
    await page.waitForFunction(
      () => !document.querySelector("#save-policy")?.hasAttribute("disabled"),
      null,
      { timeout: 5000 },
    );
    await sleep(400);
    if (!(await page.locator("#auto").isVisible())) {
      throw new Error("going back to the simple switches must show them again");
    }
    console.log("review policy editor works");

    await page.goto(`${base}/settings`, { waitUntil: "load" });
    await page.selectOption("#def-policy", "trusted-auto");
    const described =
      (await page.locator("#def-policy-desc").textContent()) ?? "";
    if (!described.includes("Owners, members and collaborators")) {
      throw new Error(
        `the default policy description did not update: ${described}`,
      );
    }
    await page.click("#save-def");
    await page.waitForFunction(
      () => !document.querySelector("#save-def")?.hasAttribute("disabled"),
      null,
      { timeout: 5000 },
    );
    await sleep(400);
    if ((await page.locator("#def-policy").inputValue()) !== "trusted-auto") {
      throw new Error("the server default policy did not stick");
    }
    console.log("server default policy works");

    await page.goto(`${base}/repos/new`, { waitUntil: "load" });
    const cliDisclosure = page
      .locator('details:has-text("CLI equivalent")')
      .first();
    if ((await cliDisclosure.count()) === 0) {
      issues.push({
        path: "/repos/new",
        kind: "text",
        text: "the add repository page has no CLI equivalent disclosure",
      });
    } else {
      const cliOpen = await cliDisclosure.evaluate(
        (element) => (element as HTMLDetailsElement).open,
      );
      if (cliOpen) {
        issues.push({
          path: "/repos/new",
          kind: "text",
          text: "the CLI equivalent is open on first load",
        });
      }
      const cliSummary = cliDisclosure.locator("summary").first();
      if ((await cliSummary.count()) === 0) {
        issues.push({
          path: "/repos/new",
          kind: "text",
          text: "the CLI equivalent disclosure has no summary",
        });
      } else {
        await cliSummary.focus();
        await page.keyboard.press("Enter");
        const opened = await cliDisclosure.evaluate(
          (element) => (element as HTMLDetailsElement).open,
        );
        if (!opened) {
          issues.push({
            path: "/repos/new",
            kind: "text",
            text: "the keyboard did not open the CLI equivalent",
          });
        }
        if (!(await cliDisclosure.innerText()).includes("co-maintainer init")) {
          issues.push({
            path: "/repos/new",
            kind: "text",
            text: "the CLI equivalent has no command",
          });
        }
      }
    }
    await page.evaluate(() => {
      // The plan step normally comes from a GitHub preview, which this
      // sandbox cannot reach, so the page is handed a plan directly.
      (window as unknown as { showPlan: (plan: unknown) => void }).showPlan({
        repo: "acme/other",
        command: "co-maintainer init acme/other",
        patch: {},
        reasons: [],
        estimate: {
          extract: 1,
          synth: 1,
          tokensIn: [1, 2],
          tokensOut: [1, 2],
          seconds: [1, 2],
          usd: null,
          estimateBasis: "history",
        },
      });
    });
    const radios = await page.locator('input[name="policy"]').count();
    if (radios !== 3)
      throw new Error(`expected 3 policy choices, found ${radios}`);
    if (!(await page.locator("#policy-trusted-auto").isChecked())) {
      throw new Error(
        "the server default must be pre-selected when adding a repository",
      );
    }
    for (const problem of await controlIssues("#plan")) {
      issues.push({ path: "/repos/new", kind: "text", text: problem });
    }
    console.log("add repository policy choice works");

    await page.goto(`${base}/activity`, { waitUntil: "load" });
    const reviewNow = page.locator("[data-post$='/pulls/9/review']");
    if ((await reviewNow.count()) !== 1) {
      throw new Error(
        "a pull request waiting for a request needs a Review now button",
      );
    }
    if ((await page.locator("[data-post$='/pulls/8/review']").count()) !== 0) {
      throw new Error("a skipped draft must not offer Review now");
    }
    if (!((await reviewNow.getAttribute("aria-label")) ?? "").includes("#9")) {
      throw new Error("the Review now button must name its pull request");
    }
    console.log("review now button shown");

    // --- Job page and live log panel: append-only, selection, tail, jump,
    // pause/resume, clear, level colors, themes and overflow. These checks are
    // red until `renderJob` renders the live panel and the client wires it.
    insertRunningJob();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/activity/${RUN_JOB}`, { waitUntil: "load" });
    await sleep(500);

    const panel = page.locator(".logpanel");
    if ((await panel.count()) !== 1) {
      throw new Error("the running job page has no log panel");
    }
    const log = panel.locator(".log");
    const logLines = log.locator(".line");
    const lineCount = (): Promise<number> => logLines.count();
    const waitForMessage = async (message: string): Promise<void> => {
      try {
        await page.waitForFunction(
          (wanted) =>
            Array.from(
              document.querySelectorAll(".logpanel .log .line .msg"),
            ).some((node) => node.textContent === wanted),
          message,
          { timeout: 8000 },
        );
      } catch {
        throw new Error(`the log panel never showed: ${message}`);
      }
    };

    const initialCount = await lineCount();
    if (initialCount < 5) {
      throw new Error(
        `the log panel shows ${initialCount} lines, want at least 5`,
      );
    }
    const firstLine = await logLines.first().evaluate((line) => ({
      className: line.className,
      timestamp: line.querySelector(".t")?.textContent ?? "",
      message: line.querySelector(".msg")?.textContent ?? "",
    }));
    if (!/^line lv-(info|dim|ok|warn|error)$/.test(firstLine.className)) {
      throw new Error(`a log line has no level class: ${firstLine.className}`);
    }
    if (!/\d{2}:\d{2}:\d{2}/.test(firstLine.timestamp)) {
      throw new Error(
        `a log line has no clock timestamp: ${JSON.stringify(firstLine)}`,
      );
    }
    if (!firstLine.message) {
      throw new Error("a log line has no message");
    }
    const levels = await logLines.evaluateAll((lines) =>
      Array.from(
        new Set(
          lines.map((line) => line.className.match(/lv-(\w+)/)?.[1] ?? ""),
        ),
      ),
    );
    for (const level of ["info", "dim", "ok", "warn", "error"]) {
      if (!levels.includes(level)) {
        throw new Error(`the log panel has no ${level} line`);
      }
    }

    const levelColors = await page.evaluate(() => {
      const found: Record<string, string> = {};
      for (const level of ["info", "dim", "ok", "warn", "error"]) {
        const line = document.querySelector(`.logpanel .log .line.lv-${level}`);
        if (!line) continue;
        const message = line.querySelector(".msg") ?? line;
        found[level] = getComputedStyle(message).color;
      }
      return found;
    });
    for (const level of ["info", "dim", "ok", "warn", "error"]) {
      if (!levelColors[level]) {
        throw new Error(`no ${level} line to compare colors`);
      }
    }
    if (new Set(Object.values(levelColors)).size < 5) {
      throw new Error(
        `log levels do not use distinct colors: ${JSON.stringify(levelColors)}`,
      );
    }

    await page.evaluate(() => {
      (window as unknown as Record<string, string>).__logMarker = "kept";
      document
        .querySelectorAll(".logpanel .log .line")
        .forEach((line) => line.setAttribute("data-smoke-old", "1"));
    });
    const appendedMessage = `appended without reload ${Date.now()}`;
    appendRunningLog("info", appendedMessage);
    await waitForMessage(appendedMessage);
    if ((await lineCount()) <= initialCount) {
      throw new Error("the appended line did not reach the open panel");
    }
    const marker = await page.evaluate(
      () =>
        (window as unknown as Record<string, string | undefined>).__logMarker,
    );
    if (marker !== "kept") {
      throw new Error("the page reloaded when a log line arrived");
    }
    const oldNodes = await page
      .locator(".logpanel .log .line[data-smoke-old]")
      .count();
    if (oldNodes !== initialCount) {
      throw new Error(
        `the panel replaced its list: ${oldNodes} of ${initialCount} old lines survived`,
      );
    }

    const selectedText = await page.evaluate(() => {
      const message = document.querySelector(".logpanel .log .line .msg");
      if (!message || !message.firstChild) return "";
      const range = document.createRange();
      range.selectNodeContents(message.firstChild);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? "";
    });
    if (!selectedText) {
      throw new Error("could not select text in an existing log line");
    }
    const selectionMessage = `selection stays ${Date.now()}`;
    appendRunningLog("info", selectionMessage);
    await waitForMessage(selectionMessage);
    const keptSelection = await page.evaluate(
      () => window.getSelection()?.toString() ?? "",
    );
    if (keptSelection !== selectedText) {
      throw new Error("the log append cleared the text selection");
    }

    const atBottom = (): Promise<boolean> =>
      page.evaluate(() => {
        const box = document.querySelector(".logpanel .log");
        if (!box) return false;
        return box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      });
    await page.evaluate(() => {
      const box = document.querySelector(".logpanel .log");
      if (box) box.scrollTop = box.scrollHeight;
    });
    await sleep(100);
    const tailMessage = `tail follows ${Date.now()}`;
    appendRunningLog("info", tailMessage);
    await waitForMessage(tailMessage);
    if (!(await atBottom())) {
      throw new Error("the log did not follow the bottom while at the bottom");
    }

    await page.evaluate(() => {
      const box = document.querySelector(".logpanel .log");
      if (!box) return;
      box.scrollTop = 0;
      box.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await sleep(150);
    const scrollBefore = await page.evaluate(
      () => document.querySelector(".logpanel .log")?.scrollTop ?? 0,
    );
    const scrolledUpMessage = `stays put ${Date.now()}`;
    appendRunningLog("info", scrolledUpMessage);
    await waitForMessage(scrolledUpMessage);
    await sleep(300);
    const scrollAfter = await page.evaluate(
      () => document.querySelector(".logpanel .log")?.scrollTop ?? 0,
    );
    if (Math.abs(scrollAfter - scrollBefore) > 4) {
      throw new Error(
        `the scroll position moved while scrolled up: ${scrollBefore} -> ${scrollAfter}`,
      );
    }
    const jump = page.locator("[data-log-jump]");
    if (!(await jump.isVisible())) {
      throw new Error("Jump to latest did not appear while scrolled up");
    }
    const jumpText = (await jump.textContent()) ?? "";
    if (!/Jump to latest \(\d+\)/.test(jumpText)) {
      throw new Error(`Jump to latest has no pending count: ${jumpText}`);
    }
    await jump.click();
    await sleep(200);
    if (!(await atBottom())) {
      throw new Error("Jump to latest did not go to the bottom");
    }
    if (await jump.isVisible()) {
      throw new Error("Jump to latest stayed visible after jumping");
    }
    if (/\(\d+\)/.test((await jump.textContent()) ?? "")) {
      throw new Error("Jump to latest kept its count after jumping");
    }

    const pause = page.locator("[data-log-pause]");
    await pause.click();
    await sleep(150);
    const pausedCount = await lineCount();
    const pausedMessage = `paused line ${Date.now()}`;
    appendRunningLog("info", pausedMessage);
    await sleep(2000);
    if ((await lineCount()) !== pausedCount) {
      throw new Error("Pause did not stop appending lines");
    }
    await pause.click();
    await waitForMessage(pausedMessage);

    const clear = page.locator("[data-log-clear]");
    await clear.click();
    await sleep(150);
    if ((await lineCount()) !== 0) {
      throw new Error("Clear did not empty the log view");
    }
    if (!/Running/.test(await page.locator("body").innerText())) {
      throw new Error("Clear stopped the job instead of only the view");
    }
    const afterClearMessage = `after clear ${Date.now()}`;
    appendRunningLog("info", afterClearMessage);
    await waitForMessage(afterClearMessage);

    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${base}/activity/${RUN_JOB}`, { waitUntil: "load" });
    await sleep(400);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow > 1) {
      throw new Error(
        `the job page overflows horizontally at 375px by ${overflow}px`,
      );
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/activity/${RUN_JOB}`, { waitUntil: "load" });
    await sleep(400);
    const contrast = (): Promise<Record<string, number>> =>
      page.evaluate(() => {
        const luminance = (rgb: string): number => {
          const parts = (rgb.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
          const channel = (value: number): number => {
            const v = value / 255;
            return v <= 0.03928
              ? v / 12.92
              : Math.pow((v + 0.055) / 1.055, 2.4);
          };
          return (
            0.2126 * channel(parts[0] ?? 0) +
            0.7152 * channel(parts[1] ?? 0) +
            0.0722 * channel(parts[2] ?? 0)
          );
        };
        const ratio = (a: string, b: string): number => {
          const first = luminance(a);
          const second = luminance(b);
          const light = Math.max(first, second);
          const dark = Math.min(first, second);
          return (light + 0.05) / (dark + 0.05);
        };
        const panel = document.querySelector(".logpanel .log");
        if (!panel) return {};
        const background = getComputedStyle(panel).backgroundColor;
        const out: Record<string, number> = {};
        for (const level of ["info", "dim", "ok", "warn", "error"]) {
          const line = document.querySelector(
            `.logpanel .log .line.lv-${level}`,
          );
          if (!line) continue;
          const message = line.querySelector(".msg") ?? line;
          out[level] = ratio(getComputedStyle(message).color, background);
        }
        return out;
      });
    const lightContrast = await contrast();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await sleep(150);
    const darkContrast = await contrast();
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    for (const [theme, values] of [
      ["light", lightContrast],
      ["dark", darkContrast],
    ] as const) {
      for (const level of ["info", "dim", "ok", "warn", "error"]) {
        const value = values[level];
        if (value === undefined) {
          throw new Error(`the ${theme} theme has no ${level} line`);
        }
        if (value < 3) {
          throw new Error(
            `the ${theme} theme ${level} line contrast ${value.toFixed(2)} is below 3`,
          );
        }
      }
    }
    console.log("job page live log panel works");
    await visionShot("job-running");

    // --- Running job refresh, connection loss and log-panel accessibility.
    // These checks are red until the job page refreshes its stage/spent state
    // in place, reports a failed refresh, and the log panel distinguishes an
    // empty log and a broken stream.
    const jobPath = `/activity/${RUN_JOB}`;
    const jobUrl = `${base}${jobPath}`;

    await page.goto(jobUrl, { waitUntil: "load" });
    await sleep(300);
    await page.evaluate(() => {
      (window as unknown as Record<string, string>).__jobRefreshMarker = "kept";
    });
    updateRunningJobArgs({
      stages: [
        { name: "Read code", state: "done", detail: "112 files" },
        { name: "Read pull requests", state: "done", detail: "50 of 50" },
        {
          name: "Extract facts",
          state: "current",
          detail: "20 of 51",
          percent: 39,
        },
        { name: "Write the guides", state: "pending" },
      ],
      spent: 0.02,
      estimate: 0.05,
    });
    let refreshedInTime = true;
    try {
      await page.waitForFunction(
        () => {
          const items = Array.from(document.querySelectorAll(".timeline li"));
          const extract = items.find((item) =>
            (item.textContent ?? "").includes("Extract facts"),
          );
          return Boolean(
            extract &&
            extract.getAttribute("data-stage-state") === "current" &&
            document.body.innerText.includes("$0.02"),
          );
        },
        null,
        { timeout: 3000 },
      );
    } catch {
      refreshedInTime = false;
    }
    if (!refreshedInTime) {
      issues.push({
        path: jobPath,
        kind: "text",
        text: "the running job page did not refresh its stage and spent state within 3 s",
      });
    }
    const refreshMarker = await page.evaluate(
      () =>
        (window as unknown as Record<string, string | undefined>)
          .__jobRefreshMarker,
    );
    if (refreshMarker !== "kept") {
      issues.push({
        path: jobPath,
        kind: "text",
        text: "the running job page reloaded instead of updating in place",
      });
    }

    const connectionIssuesBefore = issues.length;
    const abortJobRequests = async (route: import("playwright").Route) => {
      await route.abort("failed");
    };
    await page.route("**/api/jobs/**", abortJobRequests);
    await page.route(`**${jobPath}`, abortJobRequests);
    let sawConnectionLoss = true;
    try {
      await page.waitForFunction(
        () =>
          /connection (lost|problem)|could not refresh|reconnecting|not refreshing/i.test(
            document.body.innerText,
          ),
        null,
        { timeout: 3000 },
      );
    } catch {
      sawConnectionLoss = false;
    }
    if (!sawConnectionLoss) {
      issues.push({
        path: jobPath,
        kind: "text",
        text: "the running job page did not show a connection-loss state when the refresh failed",
      });
    }

    await page.unroute("**/api/jobs/**", abortJobRequests);
    await page.unroute(`**${jobPath}`, abortJobRequests);
    await page.route("**/api/jobs/**", abortJobRequests);
    await page.goto(jobUrl, { waitUntil: "load" });
    await sleep(300);
    let sawLogConnectionError = true;
    try {
      await page.waitForFunction(
        () => {
          const panel = document.querySelector(".logpanel");
          return Boolean(
            panel &&
            /connection (lost|error|problem)|could not (connect|refresh)|reconnecting/i.test(
              panel.textContent ?? "",
            ),
          );
        },
        null,
        { timeout: 3000 },
      );
    } catch {
      sawLogConnectionError = false;
    }
    if (!sawLogConnectionError) {
      issues.push({
        path: jobPath,
        kind: "text",
        text: "the log panel did not show a connection error when the stream failed",
      });
    }
    await page.unroute("**/api/jobs/**", abortJobRequests);

    await page.goto(jobUrl, { waitUntil: "load" });
    await sleep(300);
    const keyboardScroll = await page.evaluate(() => {
      const log = document.querySelector(".logpanel .log");
      if (!log) return { focusable: false, scrolled: false };
      const focusable = (log as HTMLElement).tabIndex >= 0;
      (log as HTMLElement).focus();
      log.scrollTop = 0;
      return { focusable, scrolled: false };
    });
    if (!keyboardScroll.focusable) {
      issues.push({
        path: jobPath,
        kind: "text",
        text: "the log is not focusable for keyboard scrolling",
      });
    }
    const scrollBeforeKey = await page.evaluate(
      () => document.querySelector(".logpanel .log")?.scrollTop ?? 0,
    );
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await sleep(100);
    const scrollAfterKey = await page.evaluate(
      () => document.querySelector(".logpanel .log")?.scrollTop ?? 0,
    );
    if (scrollAfterKey <= scrollBeforeKey) {
      issues.push({
        path: jobPath,
        kind: "text",
        text: "the arrow keys did not scroll the focused log",
      });
    }

    // The aborted requests above are the asserted condition, not a product
    // error; the browser logs them as console or page errors.
    for (let i = issues.length - 1; i >= connectionIssuesBefore; i--) {
      const issue = issues[i]!;
      if (
        (issue.kind === "console" || issue.kind === "pageerror") &&
        /ERR_FAILED|Failed to load resource|NetworkError|Failed to fetch|api\/jobs|activity\/job-live-smoke/i.test(
          issue.text,
        )
      ) {
        issues.splice(i, 1);
      }
    }

    finishRunningJob();

    // The token secret panel only exists after a real create, so drive the
    // button the same way an operator would and assert the panel appears.
    await page.goto(`${base}/settings`, { waitUntil: "load" });
    const tokenName = `smoke-${Date.now()}`;
    await page.fill("#remote-token-name", tokenName);
    await page.click("#create-remote-token");
    await page.waitForSelector("#remote-token-secret:not([hidden])", {
      timeout: 10_000,
    });
    const secret =
      (await page.locator("#remote-token-secret").textContent()) ?? "";
    if (!secret.includes("cmr_")) {
      throw new Error("the secret panel did not show a token");
    }
    if (!secret.includes("is not shown again")) {
      throw new Error("the secret panel is missing its warning");
    }
    console.log("token secret panel shown");

    // Clear knowledge with the cached-evidence checkbox, the way an operator
    // would. The page asks for a confirmation first.
    await page.goto(`${base}/repos/${REPO}/knowledge`, { waitUntil: "load" });
    let sawConfirm = false;
    page.once("dialog", (dialog) => {
      sawConfirm = true;
      void dialog.accept();
    });
    await page.check("#clear-cache");
    await Promise.all([page.waitForEvent("load"), page.click("#clear")]);
    if (!sawConfirm) throw new Error("the clear did not ask for confirmation");
    await sleep(400);
    const notice = (await page.locator(".notice").first().textContent()) ?? "";
    if (!notice.includes("Knowledge has not been built yet")) {
      throw new Error(`the clear did not reset the notice: ${notice}`);
    }
    let guideSurvived = true;
    try {
      await stat(join(env.CM_REPOS_DIR ?? "", REPO, "PR_REVIEW_GUIDE.md"));
    } catch {
      guideSurvived = false;
    }
    if (guideSurvived) throw new Error("the guide file survived the clear");
    if ((await cacheGet("state", REPO)) !== undefined) {
      throw new Error("the skill state survived the clear");
    }
    if ((await cacheGet("cost", `${REPO}:smoke`)) !== undefined) {
      throw new Error("the cached evidence survived includeCache");
    }
    console.log("clear knowledge works");

    // --- A2 shell: shared left menu, active item, 404 in the shell ---
    for (const path of [...SHELL_PAGES, ...SETTINGS_PAGES, ...REPO_PAGES]) {
      const response = await page.goto(`${base}${path}`, { waitUntil: "load" });
      await sleep(150);
      if (path === "/settings/ai") await visionShot("settings-ai");
      if (path === "/settings/ai" || path === `/repos/${REPO}/settings`) {
        await contrastCheck(path);
      }
      const finalPath = pathOf();
      const shell = await page.evaluate(() => {
        const side = document.querySelector("aside.side");
        const text = side ? side.textContent || "" : "";
        const active = side
          ? Array.from(side.querySelectorAll("a"))
              .filter(
                (a) =>
                  a.classList.contains("item") && a.classList.contains("on"),
              )
              .map((a) => a.getAttribute("href"))
          : [];
        return {
          hasSide: Boolean(side),
          groups: ["Reviews", "Setup", "Settings"].filter((g) =>
            text.includes(g),
          ),
          active,
        };
      });
      const status = response ? response.status() : 0;
      if (!shell.hasSide || status !== 200) {
        issues.push({
          path,
          kind: "text",
          text: `shell left menu missing (status ${status})`,
        });
        continue;
      }
      for (const group of ["Reviews", "Setup", "Settings"]) {
        if (!shell.groups.includes(group)) {
          issues.push({
            path,
            kind: "text",
            text: `shell nav is missing the "${group}" group`,
          });
        }
      }
      const want = expectedActive(finalPath);
      if (want && !(shell.active.length === 1 && shell.active[0] === want)) {
        issues.push({
          path,
          kind: "text",
          text: `active nav item is ${JSON.stringify(
            shell.active,
          )}, want exactly ${want}`,
        });
      }
    }

    // --- A2 theme: toggle changes the theme, persists, and no white flash ---
    await page.goto(`${base}/`, { waitUntil: "load" });
    if ((await page.locator("#theme").count()) !== 1) {
      issues.push({ path: "/", kind: "text", text: "no #theme toggle" });
    } else {
      const before = await page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      await page.click("#theme");
      await sleep(150);
      const after = await page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      if (before === after) {
        issues.push({
          path: "/",
          kind: "text",
          text: "the theme toggle did not change the theme",
        });
      }
      await page.reload({ waitUntil: "load" });
      const persisted = await page.evaluate(() =>
        document.documentElement.classList.contains("dark"),
      );
      if (persisted !== after) {
        issues.push({
          path: "/",
          kind: "text",
          text: "the theme choice did not persist across reload",
        });
      }
      const bootstrap = await page.evaluate(() =>
        Array.from(document.head.querySelectorAll("script")).some(
          (script) =>
            !script.defer &&
            !(script.getAttribute("type") || "").includes("module") &&
            /localStorage/.test(script.textContent || "") &&
            /dark/.test(script.textContent || ""),
        ),
      );
      if (!bootstrap) {
        issues.push({
          path: "/",
          kind: "text",
          text: "no inline head theme bootstrap (white flash)",
        });
      }
      await page.evaluate(() => {
        document.documentElement.classList.remove("dark");
        try {
          localStorage.removeItem("theme");
        } catch {
          // storage may be unavailable; nothing to reset
        }
      });
    }

    // --- A2 404: rendered inside the shell ---
    const notFound = await page.goto(`${base}/this-page-does-not-exist`, {
      waitUntil: "load",
    });
    await sleep(150);
    if (!notFound || notFound.status() !== 404) {
      issues.push({
        path: "/404",
        kind: "text",
        text: `404 status ${notFound ? notFound.status() : "?"}, want 404`,
      });
    } else {
      const inside = await page.evaluate(() => {
        const side = document.querySelector("aside.side");
        const sideText = side ? side.textContent || "" : "";
        return {
          hasSide: Boolean(side),
          hasHeading: /not found/i.test(document.body.innerText),
          groups: ["Reviews", "Setup", "Settings"].every((g) =>
            sideText.includes(g),
          ),
        };
      });
      if (!inside.hasSide) {
        issues.push({
          path: "/404",
          kind: "text",
          text: "404 outside the shell",
        });
      }
      if (!inside.hasHeading) {
        issues.push({
          path: "/404",
          kind: "text",
          text: "404 has no not-found heading",
        });
      }
      if (!inside.groups) {
        issues.push({
          path: "/404",
          kind: "text",
          text: "404 shell is missing its nav groups",
        });
      }
    }

    // --- A2 responsive: no horizontal overflow at the three widths ---
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of [...SHELL_PAGES, ...SETTINGS_PAGES, ...REPO_PAGES]) {
        await page.goto(`${base}${path}`, { waitUntil: "load" });
        await sleep(120);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        if (overflow > 1) {
          issues.push({
            path,
            kind: "text",
            text: `horizontal overflow at ${width}px: ${overflow}px`,
          });
        }
      }
    }

    // --- A2 mobile drawer: opens, closes, and closes on a link ---
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${base}/`, { waitUntil: "load" });
    await sleep(120);
    if ((await page.locator("#menu").count()) !== 1) {
      issues.push({
        path: "/",
        kind: "text",
        text: "no #menu drawer button at 375px",
      });
    } else {
      const drawerOpen = (): Promise<boolean> =>
        page.evaluate(() => Boolean(document.querySelector("aside.side.open")));
      await page.click("#menu");
      await sleep(200);
      if (!(await drawerOpen())) {
        issues.push({
          path: "/",
          kind: "text",
          text: "the drawer did not open",
        });
      }
      if ((await page.locator("#overlay").count()) === 1) {
        await page.click("#overlay");
        await sleep(200);
        if (await drawerOpen()) {
          issues.push({
            path: "/",
            kind: "text",
            text: "the drawer did not close on the overlay",
          });
        }
      }
      await page.click("#menu");
      await sleep(200);
      const link = page.locator("aside.side a.item").first();
      if ((await link.count()) === 1) {
        await link.click();
        await sleep(250);
        if (await drawerOpen()) {
          issues.push({
            path: "/",
            kind: "text",
            text: "the drawer did not close when a link was chosen",
          });
        }
      }
    }

    // --- A2 heading alignment: same h1 left edge across pages at 1280 ---
    await page.setViewportSize({ width: 1280, height: 900 });
    const offsets: { path: string; x: number }[] = [];
    for (const path of [...SHELL_PAGES, ...SETTINGS_PAGES, ...REPO_PAGES]) {
      await page.goto(`${base}${path}`, { waitUntil: "load" });
      await sleep(120);
      const h1 = page.locator("h1").first();
      if ((await h1.count()) === 0) {
        issues.push({ path, kind: "text", text: "no h1 on the page" });
        continue;
      }
      const box = await h1.boundingBox();
      if (box) offsets.push({ path, x: Math.round(box.x) });
    }
    if (offsets.length > 1) {
      const first = offsets[0]!.x;
      if (offsets.some((entry) => Math.abs(entry.x - first) > 1)) {
        issues.push({
          path: "/",
          kind: "text",
          text: `h1 left edge differs across pages: ${JSON.stringify(offsets)}`,
        });
      }
    }

    // --- Save feedback: every settings Save button reports Saving then Saved
    // without reloading the page. These checks are red until `save()` stops
    // calling `location.reload()` and shows a "Saved" toast.
    type SaveTarget = {
      cardIndex: number;
      cardId: string;
      buttonIndex: number;
      buttonId: string;
      label: string;
    };
    const saveTargets = async (): Promise<SaveTarget[]> =>
      await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("[data-async]"));
        const found: SaveTarget[] = [];
        cards.forEach((card, cardIndex) => {
          const buttons = Array.from(card.querySelectorAll("button"));
          buttons.forEach((button, buttonIndex) => {
            const label = (button.textContent || "").trim();
            if (label.includes("Save")) {
              found.push({
                cardIndex,
                cardId: card.id,
                buttonIndex,
                buttonId: button.id,
                label,
              });
            }
          });
        });
        return found;
      });
    const setSaveMarker = (): Promise<void> =>
      page.evaluate(() => {
        (window as unknown as Record<string, string>).__saveMarker = "kept";
      });
    const saveMarker = (): Promise<string | undefined> =>
      page.evaluate(
        () =>
          (window as unknown as Record<string, string | undefined>)
            .__saveMarker,
      );

    const checkSaveFeedback = async (
      path: string,
      routePattern: string,
      method: string,
    ): Promise<void> => {
      await page.goto(`${base}${path}`, { waitUntil: "load" });
      await sleep(200);
      const targets = await saveTargets();
      if (targets.length === 0) {
        console.log(`save feedback: ${path} has no Save button, skipped`);
        return;
      }
      for (const target of targets) {
        const name = `${path}#${target.buttonId || target.label}`;
        const card = page.locator("[data-async]").nth(target.cardIndex);
        const button = card.locator("button").nth(target.buttonIndex);
        const isSaveRequest = (route: import("playwright").Route): boolean =>
          route.request().method() === method;

        // Success path: the request is delayed, so "Saved" cannot appear
        // before the server answers, and the page must stay in place.
        await page.goto(`${base}${path}`, { waitUntil: "load" });
        await sleep(200);
        if (await button.isDisabled().catch(() => false)) {
          issues.push({
            path,
            kind: "text",
            text: `${name}: Save was disabled before the click, so the save feedback could not be tested`,
          });
          continue;
        }
        await setSaveMarker();
        let requests = 0;
        const okHandler = async (route: import("playwright").Route) => {
          if (!isSaveRequest(route)) {
            await route.continue();
            return;
          }
          requests++;
          await sleep(700);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "{}",
          });
        };
        await page.route(routePattern, okHandler);
        await button.click();
        await sleep(200);
        const early = await page.evaluate(
          ({ cardIndex, buttonIndex }) => {
            const scope = document.querySelectorAll("[data-async]")[cardIndex];
            const control = scope?.querySelectorAll("button")[buttonIndex];
            return {
              disabled: Boolean(control && control.disabled),
              busy: Boolean(scope && scope.classList.contains("busy")),
              savedText: document.body.innerText.includes("Saved"),
            };
          },
          { cardIndex: target.cardIndex, buttonIndex: target.buttonIndex },
        );
        if (!early.disabled && !early.busy) {
          issues.push({
            path,
            kind: "text",
            text: `${name}: Save showed no busy state within 300 ms`,
          });
        }
        if (early.savedText) {
          issues.push({
            path,
            kind: "text",
            text: `${name}: "Saved" appeared before the save finished`,
          });
        }
        let sawSaved = true;
        try {
          await page.waitForFunction(
            () => document.body.innerText.includes("Saved"),
            null,
            { timeout: 2000 },
          );
        } catch {
          sawSaved = false;
        }
        await page
          .waitForLoadState("load", { timeout: 2000 })
          .catch(() => undefined);
        const markerAfter = await saveMarker().catch(() => undefined);
        if (!sawSaved) {
          issues.push({
            path,
            kind: "text",
            text: `${name}: no "Saved" toast within 2 s after the response`,
          });
        }
        if (markerAfter !== "kept") {
          issues.push({
            path,
            kind: "text",
            text: `${name}: the page reloaded instead of updating in place`,
          });
        }
        if (requests !== 1) {
          issues.push({
            path,
            kind: "text",
            text: `${name}: Save sent ${requests} requests, want 1`,
          });
        }
        await page.unroute(routePattern, okHandler);

        // Error path: the card keeps the typed value and does not reload.
        await page.goto(`${base}${path}`, { waitUntil: "load" });
        await sleep(200);
        const errorCard = page.locator("[data-async]").nth(target.cardIndex);
        const errorButton = errorCard.locator("button").nth(target.buttonIndex);
        let control = errorCard
          .locator('input:not([type="checkbox"]):not([type="radio"]), textarea')
          .first();
        let controlTag = await control
          .evaluate((el) => el.tagName.toLowerCase())
          .catch(() => "");
        if (!controlTag) {
          control = errorCard.locator("select").first();
          controlTag = await control
            .evaluate((el) => el.tagName.toLowerCase())
            .catch(() => "");
        }
        if (controlTag) {
          await control
            .evaluate((el) => {
              if (el instanceof HTMLSelectElement) {
                el.value = el.options[0]?.value ?? "";
              } else if (
                el instanceof HTMLInputElement ||
                el instanceof HTMLTextAreaElement
              ) {
                el.value = "1";
              }
            })
            .catch(() => undefined);
        }
        const valueBefore = controlTag
          ? await control.inputValue().catch(() => "")
          : "";
        await setSaveMarker();
        const errorIssuesBefore = issues.length;
        const failHandler = async (route: import("playwright").Route) => {
          if (!isSaveRequest(route)) {
            await route.continue();
            return;
          }
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "save failed" } }),
          });
        };
        await page.route(routePattern, failHandler);
        await errorButton.click();
        let sawFail = true;
        try {
          await page.waitForFunction(
            () => {
              const box = document.querySelector("[data-fail]");
              return Boolean(
                box && (box.textContent || "").includes("save failed"),
              );
            },
            null,
            { timeout: 2000 },
          );
        } catch {
          sawFail = false;
        }
        const valueAfter = controlTag
          ? await control.inputValue().catch(() => "")
          : "";
        await page
          .waitForLoadState("load", { timeout: 1000 })
          .catch(() => undefined);
        const errorMarker = await saveMarker().catch(() => undefined);
        if (!sawFail) {
          issues.push({
            path,
            kind: "text",
            text: `${name}: the fail box did not show "save failed"`,
          });
        }
        if (controlTag && valueAfter !== valueBefore) {
          issues.push({
            path,
            kind: "text",
            text: `${name}: the input value changed after a failed save`,
          });
        }
        if (errorMarker !== "kept") {
          issues.push({
            path,
            kind: "text",
            text: `${name}: the page reloaded after a failed save`,
          });
        }
        // The deliberate 500 is logged by the browser; it is the asserted
        // condition here, not a product error.
        await sleep(100);
        for (let i = issues.length - 1; i >= errorIssuesBefore; i--) {
          const issue = issues[i]!;
          if (issue.kind === "console" && /\b500\b/.test(issue.text)) {
            issues.splice(i, 1);
          }
        }
        await page.unroute(routePattern, failHandler);

        // Double-click path: only one request may leave the page.
        await page.goto(`${base}${path}`, { waitUntil: "load" });
        await sleep(200);
        let doubleRequests = 0;
        const doubleHandler = async (route: import("playwright").Route) => {
          if (!isSaveRequest(route)) {
            await route.continue();
            return;
          }
          doubleRequests++;
          await sleep(500);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "{}",
          });
        };
        await page.route(routePattern, doubleHandler);
        await page.evaluate(
          ({ cardIndex, buttonIndex }) => {
            const scope = document.querySelectorAll("[data-async]")[cardIndex];
            const control = scope?.querySelectorAll("button")[buttonIndex];
            if (!control) return;
            control.click();
            control.click();
          },
          { cardIndex: target.cardIndex, buttonIndex: target.buttonIndex },
        );
        await sleep(900);
        if (doubleRequests !== 1) {
          issues.push({
            path,
            kind: "text",
            text: `${name}: double-click sent ${doubleRequests} requests, want 1`,
          });
        }
        await page.unroute(routePattern, doubleHandler);
      }
    };

    for (const path of SETTINGS_PAGES) {
      await checkSaveFeedback(path, "**/api/settings", "PUT");
    }
    await checkSaveFeedback(
      `/repos/${REPO}/settings`,
      "**/api/repos/**",
      "PATCH",
    );

    await checkRepoSettingsVision(page, base, issues);
  } finally {
    await browser.close();
  }

  const dedupe = (list: Issue[]): Issue[] => {
    const seen = new Set<string>();
    return list.filter((issue) => {
      const key = `${issue.path}\u0000${issue.kind}\u0000${issue.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const unexpected = dedupe(issues).filter(
    // A navigation that answers 404 is the asserted condition for the missing
    // page; the browser logs it as a console error. The status checks above
    // already catch a wrong status, so this line is noise here.
    (issue) =>
      !(
        issue.kind === "console" &&
        issue.text.includes("the server responded with a status of 404")
      ),
  );

  if (unexpected.length > 0) {
    const list = unexpected.map(
      (issue) => `  ${issue.path} [${issue.kind}] ${issue.text}`,
    );
    throw new Error(`dashboard issues:\n${list.join("\n")}`);
  }

  console.log("dashboard smoke ok");
} catch (error) {
  await stopServe();
  if (serveOutput) {
    // `stopServe` already awaited the child and cached the buffers.
    const stdout = new TextDecoder().decode(serveOutput.stdout);
    const stderr = new TextDecoder().decode(serveOutput.stderr);
    console.error(`--- serve stdout ---\n${stdout}`);
    console.error(`--- serve stderr ---\n${stderr}`);
  }
  throw error;
} finally {
  await stopServe();
  await remove(sandbox, { recursive: true }).catch(() => {});
}
