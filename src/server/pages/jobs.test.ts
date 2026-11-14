import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { activateRepo, markKnowledgeBuilt } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { KNOWN_COST } from "../../testing/fixtures/cost.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import { appendLog } from "../../store/job_logs.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const PASSWORD = "job-page-pass";
const REPO = "acme/widgets";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const originalDb = getEnv("CM_APP_DB");
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const originalRepos = getEnv("CM_REPOS_DIR");
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
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
    if (originalRepos === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", originalRepos);
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

function seedRepo(): void {
  activateRepo(REPO, 9);
  markKnowledgeBuilt(REPO, "abc");
}

async function jobPage(
  app: ReturnType<typeof createApp>,
  cookie: string,
  id: string,
): Promise<string> {
  const response = await app.fetch(
    new Request(`http://localhost/activity/${id}`, {
      headers: { cookie },
    }),
  );
  if (response.status !== 200) {
    throw new Error(`/activity/${id} returned ${response.status}`);
  }
  return await response.text();
}

function assertLogPanel(html: string, live: boolean, status?: string): void {
  if (!html.includes('class="logpanel"')) {
    throw new Error("the job page has no log panel root");
  }
  if (!html.includes(`data-live="${live ? "1" : "0"}"`)) {
    throw new Error(`the log panel is missing data-live="${live ? "1" : "0"}"`);
  }
  if (status && !html.includes(`data-status="${status}"`)) {
    throw new Error(`the log panel is missing data-status="${status}"`);
  }
  if (!/<span class="t">\d{2}:\d{2}:\d{2}<\/span>/.test(html)) {
    throw new Error("the log panel has no clock timestamp on its lines");
  }
}

function assertLevels(html: string, levels: string[]): void {
  for (const level of levels) {
    if (!html.includes(`line lv-${level}`)) {
      throw new Error(`the log panel has no ${level} line class`);
    }
  }
}

function seedFailedReviewJob(options: {
  id: string;
  prNumber: number;
  error: string;
  noteCommentId?: string | null;
  cost?: number;
  durationMs?: number;
  logs?: Array<readonly [string, string]>;
}): void {
  const model = "deepseek/deepseek-chat-v3.1";
  insertJob({
    id: options.id,
    type: "review",
    repo: REPO,
    prNumber: options.prNumber,
    args: { provider: "OpenRouter", model },
  });
  insertReview({
    id: `rev-${options.id}`,
    repo: REPO,
    prNumber: options.prNumber,
    jobId: options.id,
    headSha: `head-${options.id}`,
    baseSha: "cafebabe",
    scope: "whole-pr",
    model,
    round: 1,
  });
  setReviewStatus(`rev-${options.id}`, "failed", {
    ...KNOWN_COST(options.cost ?? 0.004),
    note_comment_id:
      options.noteCommentId === undefined ? "note-1" : options.noteCommentId,
    duration_ms: options.durationMs ?? 130000,
  });
  setJobStatus(options.id, "failed", { error: options.error });
  for (const [level, message] of options.logs ?? [["error", options.error]]) {
    appendLog(options.id, level, message);
  }
}

const STAGES = [
  { name: "Read code", state: "done", detail: "112 files" },
  {
    name: "Read pull requests",
    state: "current",
    detail: "31 of 50",
    percent: 62,
  },
  { name: "Extract facts", state: "pending" },
  { name: "Write the guides", state: "pending" },
];

async function runningLogPage(
  id: string,
  lines: Array<readonly [string, string]>,
): Promise<{ html: string; visible: string }> {
  insertJob({ id, type: "init", repo: REPO, args: { stages: STAGES } });
  setJobStatus(id, "running");
  for (const [level, message] of lines) appendLog(id, level, message);
  const app = createApp({ password: PASSWORD });
  const cookie = await cookieSession(app);
  const html = await jobPage(app, cookie, id);
  return { html, visible: visibleText(html) };
}

async function failedJobPage(options: {
  id: string;
  prNumber: number;
  error: string;
  noteCommentId?: string | null;
  cost?: number;
  durationMs?: number;
  logs?: Array<readonly [string, string]>;
}): Promise<{ html: string; visible: string }> {
  seedFailedReviewJob(options);
  const app = createApp({ password: PASSWORD });
  const cookie = await cookieSession(app);
  const html = await jobPage(app, cookie, options.id);
  return { html, visible: visibleText(html) };
}

async function doneNoAppPage(
  id: string,
): Promise<{ html: string; visible: string }> {
  insertJob({
    id,
    type: "remake",
    repo: REPO,
    args: {
      produced: { label: "171 facts", detail: "from 50 PRs and 54 commits" },
      durationMs: 720000,
      cost: 0.05,
    },
  });
  setJobStatus(id, "done");
  appendLog(id, "ok", "done");
  const app = createApp({ password: PASSWORD });
  const cookie = await cookieSession(app);
  const html = await jobPage(app, cookie, id);
  return { html, visible: visibleText(html) };
}

test("running job page shows real stages, spent so far and a live log panel", async () => {
  await withEnv(async () => {
    seedRepo();
    insertJob({
      id: "job-running",
      type: "init",
      repo: REPO,
      args: {
        stages: STAGES,
        spent: 0.008,
        estimate: 0.05,
        estimateSeconds: [480, 840],
      },
    });
    setJobStatus("job-running", "running");
    for (const [level, message] of [
      ["info", "read code · 112 files"],
      ["dim", "fetch PR 1/36 · download diff"],
      ["ok", "fetch PR 20/36 done · 2 comments · 1 review"],
      ["warn", "fetch PR 35/50 skipped: diff too large"],
      ["error", "ai synth_guide failed · retrying once"],
    ] as const) {
      appendLog("job-running", level, message);
    }

    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await jobPage(app, cookie, "job-running");
    const visible = visibleText(html);

    for (const stage of STAGES) {
      if (!visible.includes(stage.name)) {
        throw new Error(`running page missed stage "${stage.name}"`);
      }
    }
    for (const state of ["done", "current", "pending"]) {
      if (!html.includes(`data-stage-state="${state}"`)) {
        throw new Error(`running page missed a ${state} stage state`);
      }
    }
    if (!visible.includes("Spent so far")) {
      throw new Error("running page missed Spent so far");
    }
    if (!visible.includes("$0.008") || !visible.includes("$0.05")) {
      throw new Error(
        `running page missed the spent and estimate amounts: ${visible.slice(0, 400)}`,
      );
    }
    if (!visible.includes("Stop after this step")) {
      throw new Error("running page missed Stop after this step");
    }
    if (/>Stop</.test(html)) {
      throw new Error("running page still shows a bare Stop button");
    }
    if (!visible.includes("5 lines")) {
      throw new Error("running page missed the log line count");
    }
    if (!visible.includes("Running")) {
      throw new Error("running page did not mark the log panel as running");
    }
    assertLogPanel(html, true);
    assertLevels(html, ["info", "dim", "ok", "warn", "error"]);
  });
});

test("done job page shows what was produced, real duration and cost, estimate and next action", async () => {
  await withEnv(async () => {
    seedRepo();
    insertJob({
      id: "job-done",
      type: "remake",
      repo: REPO,
      args: {
        stages: STAGES.map((stage) => ({ ...stage, state: "done" })),
        produced: {
          label: "171 facts",
          detail: "from 50 PRs and 54 commits",
        },
        durationMs: 720000,
        cost: 0.05,
        estimate: { seconds: [480, 840], usd: [0.03, 0.05] },
        nextAction:
          "Open a pull request on the repository. It will be reviewed automatically.",
      },
    });
    setJobStatus("job-done", "done");
    for (const [level, message] of [
      ["dim", "fetch codebase · 25 files"],
      ["info", "extract facts · 171 facts"],
      ["ok", "done · 171 facts · $0.050"],
    ] as const) {
      appendLog("job-done", level, message);
    }

    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await jobPage(app, cookie, "job-done");
    const visible = visibleText(html);

    if (!visible.includes("Learned")) {
      throw new Error("done page missed the produced summary");
    }
    if (!visible.includes("171 facts")) {
      throw new Error("done page missed what was produced");
    }
    if (!visible.includes("from 50 PRs and 54 commits")) {
      throw new Error("done page missed the source counts");
    }
    if (!visible.includes("Took") || !visible.includes("Cost")) {
      throw new Error("done page missed the duration and cost labels");
    }
    if (!visible.includes("12 min")) {
      throw new Error("done page missed the real duration");
    }
    if (!visible.includes("$0.05")) {
      throw new Error("done page missed the real cost");
    }
    if (
      !visible.includes("estimate was 8") ||
      !visible.includes("14 min") ||
      !visible.includes("$0.03")
    ) {
      throw new Error(
        `done page missed the estimate comparison: ${visible.slice(0, 500)}`,
      );
    }
    if (!visible.includes("Next") || !visible.includes("Open a pull request")) {
      throw new Error("done page missed the next action");
    }
    if (
      !visible.includes("See the guides") ||
      !visible.includes("Review an open PR")
    ) {
      throw new Error("done page missed the next action buttons");
    }
    if (!visible.includes("3 lines")) {
      throw new Error("done page missed the log line count");
    }
    assertLogPanel(html, false, "Done");
    assertLevels(html, ["dim", "info", "ok"]);
  });
});

test("failed job page shows the real reason, the PR note status and a retry that starts a new attempt", async () => {
  await withEnv(async () => {
    seedRepo();
    insertJob({
      id: "job-failed",
      type: "review",
      repo: REPO,
      prNumber: 7,
      args: {
        provider: "OpenRouter",
        model: "deepseek/deepseek-chat-v3.1",
      },
    });
    insertReview({
      id: "rev-failed",
      repo: REPO,
      prNumber: 7,
      jobId: "job-failed",
      headSha: "deadbeef",
      baseSha: "cafebabe",
      scope: "whole-pr",
      model: "deepseek/deepseek-chat-v3.1",
      round: 1,
    });
    setReviewStatus("rev-failed", "failed", {
      ...KNOWN_COST(0.004),
      note_comment_id: "note-1",
      duration_ms: 130000,
    });
    setJobStatus("job-failed", "failed", {
      error: "reasoning budget exhausted",
    });
    appendLog("job-failed", "info", "reviewing acme/widgets#7");
    appendLog("job-failed", "dim", "AI request · prompt=6524 chars");
    appendLog("job-failed", "error", "openrouter returned an empty review");

    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await jobPage(app, cookie, "job-failed");
    const visible = visibleText(html);

    if (!visible.includes("reasoning budget exhausted")) {
      throw new Error("failed page missed the real provider reason");
    }
    if (!visible.includes("OpenRouter")) {
      throw new Error("failed page missed the provider");
    }
    if (!visible.includes("deepseek/deepseek-chat-v3.1")) {
      throw new Error("failed page missed the model");
    }
    if (!visible.includes("a note was left on the pull request")) {
      throw new Error("failed page missed the posted PR note status");
    }
    if (!visible.includes("Retry with the same model")) {
      throw new Error("failed page missed the retry that starts a new attempt");
    }
    if (!html.includes('data-post="/api/repos/acme/widgets/pulls/7/review"')) {
      throw new Error("the retry does not post a new review attempt");
    }
    if (!visible.includes("3 lines")) {
      throw new Error("failed page missed the log line count");
    }
    assertLogPanel(html, false, "Failed");
    assertLevels(html, ["info", "dim", "error"]);
  });
});

test("failed job page does not claim a note was posted when none was", async () => {
  await withEnv(async () => {
    seedRepo();
    insertJob({
      id: "job-failed-no-note",
      type: "review",
      repo: REPO,
      prNumber: 8,
      args: {
        provider: "OpenRouter",
        model: "deepseek/deepseek-chat-v3.1",
      },
    });
    insertReview({
      id: "rev-failed-no-note",
      repo: REPO,
      prNumber: 8,
      jobId: "job-failed-no-note",
      headSha: "feedface",
      baseSha: "cafebabe",
      scope: "whole-pr",
      model: "deepseek/deepseek-chat-v3.1",
      round: 1,
    });
    setReviewStatus("rev-failed-no-note", "failed", {
      ...KNOWN_COST(0.004),
      note_comment_id: null,
    });
    setJobStatus("job-failed-no-note", "failed", {
      error: "reasoning budget exhausted",
    });
    appendLog(
      "job-failed-no-note",
      "error",
      "openrouter returned an empty review",
    );

    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await jobPage(app, cookie, "job-failed-no-note");
    const visible = visibleText(html);

    if (visible.includes("a note was left on the pull request")) {
      throw new Error("failed page claimed a PR note that was never posted");
    }
    if (!/could not (leave|post) a note/i.test(visible)) {
      throw new Error(
        `failed page did not explain the missing PR note: ${visible.slice(0, 400)}`,
      );
    }
    assertLogPanel(html, false, "Failed");
    assertLevels(html, ["error"]);
  });
});

test("running job page with no log lines says the log is empty", async () => {
  await withEnv(async () => {
    seedRepo();
    insertJob({
      id: "job-empty-log",
      type: "init",
      repo: REPO,
      args: { stages: STAGES, spent: 0 },
    });
    setJobStatus("job-empty-log", "running");

    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await jobPage(app, cookie, "job-empty-log");
    const visible = visibleText(html);

    if (!html.includes('class="logpanel"')) {
      throw new Error("the job page has no log panel root");
    }
    if (!html.includes('data-live="1"')) {
      throw new Error('the log panel is missing data-live="1"');
    }
    if (!visible.includes("0 lines")) {
      throw new Error("the empty log panel does not report 0 lines");
    }
    if (
      !/no log lines yet|waiting for log lines|nothing has been logged yet/i.test(
        visible,
      )
    ) {
      throw new Error("the empty log panel has no explanation");
    }
  });
});

test("log panel uses log semantics", async () => {
  await withEnv(async () => {
    seedRepo();
    const { html } = await runningLogPage("job-a11y-role", [
      ["info", "first line"],
      ["warn", "second line"],
    ]);
    if (!html.includes('role="log"')) {
      throw new Error('the log has no role="log"');
    }
  });
});

test("log panel does not announce every appended line", async () => {
  await withEnv(async () => {
    seedRepo();
    const { html } = await runningLogPage("job-a11y-live", [
      ["info", "first line"],
      ["warn", "second line"],
    ]);
    const logTag = html.match(/<div class="log"[^>]*>/)?.[0] ?? "";
    if (/aria-live="polite"/.test(logTag)) {
      throw new Error(
        "the log is a polite live region, so every appended line is announced",
      );
    }
  });
});

test("log panel reports its line count as a status", async () => {
  await withEnv(async () => {
    seedRepo();
    const { html, visible } = await runningLogPage("job-a11y-count", [
      ["info", "first line"],
      ["warn", "second line"],
    ]);
    const countTag = html.match(/<span class="cnt"[^>]*>/)?.[0] ?? "";
    if (!/role="status"/.test(countTag)) {
      throw new Error("the line count is not a status for screen readers");
    }
    if (!/aria-live="polite"/.test(countTag)) {
      throw new Error("the line count status is not announced politely");
    }
    if (!visible.includes("2 lines")) {
      throw new Error("the line count status does not carry the real count");
    }
  });
});

test("done job page explains in human language why no guide was produced", async () => {
  await withEnv(async () => {
    seedRepo();
    insertJob({
      id: "job-done-no-guide",
      type: "remake",
      repo: REPO,
      args: {},
    });
    setJobStatus("job-done-no-guide", "done");
    appendLog("job-done-no-guide", "dim", "fetch codebase · 25 files");
    appendLog("job-done-no-guide", "ok", "done");

    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await jobPage(app, cookie, "job-done-no-guide");
    const visible = visibleText(html);

    if (
      !/no review history|nothing to learn from yet|not enough review history/i.test(
        visible,
      )
    ) {
      throw new Error(
        `done page did not explain the missing guide in human language: ${visible.slice(0, 600)}`,
      );
    }
    if (/synth_guide|PR_REVIEW_GUIDE\.md|review signals/i.test(visible)) {
      throw new Error(
        "done page used internal guide jargon instead of a human explanation",
      );
    }
  });
});

test("done job page does not promise automatic review when no GitHub App is configured", async () => {
  await withEnv(async () => {
    seedRepo();
    const { visible } = await doneNoAppPage("job-done-no-app");
    if (
      /reviewed automatically|review automatically|will be reviewed/i.test(
        visible,
      )
    ) {
      throw new Error(
        "done page promised automatic review without a GitHub App",
      );
    }
  });
});

test("done job page points to the missing GitHub App connection", async () => {
  await withEnv(async () => {
    seedRepo();
    const { html, visible } = await doneNoAppPage("job-done-no-app-link");
    if (!/GitHub App/i.test(visible)) {
      throw new Error(
        "done page did not name the missing GitHub App connection",
      );
    }
    const connectionLink = html.match(
      /<a[^>]+href="(\/setup[^"]*|\/settings\/github[^"]*)"[^>]*>([^<]*(?:GitHub App|connect)[^<]*)<\/a>/i,
    );
    if (!connectionLink) {
      throw new Error("done page did not link to the missing connection");
    }
  });
});

test("failed job page gives an empty answer a safe message", async () => {
  await withEnv(async () => {
    seedRepo();
    const { visible } = await failedJobPage({
      id: "job-fail-empty",
      prNumber: 11,
      error: "openrouter returned an empty review",
    });
    if (!/empty (answer|review)/i.test(visible)) {
      throw new Error(
        `failed page for an empty answer missed its safe message: ${visible.slice(0, 400)}`,
      );
    }
  });
});

test("failed job page gives a GitHub 403 a safe message", async () => {
  await withEnv(async () => {
    seedRepo();
    const { visible } = await failedJobPage({
      id: "job-fail-403",
      prNumber: 12,
      error: "github post failed · 403 Resource not accessible by integration",
    });
    if (!/403|access denied|permission|not accessible/i.test(visible)) {
      throw new Error(
        `failed page for a 403 missed its safe message: ${visible.slice(0, 400)}`,
      );
    }
  });
});

test("failed job page gives a rate limit a safe message", async () => {
  await withEnv(async () => {
    seedRepo();
    const { visible } = await failedJobPage({
      id: "job-fail-rate",
      prNumber: 13,
      error: "429 Too Many Requests",
    });
    if (!/429|rate limit|too many requests/i.test(visible)) {
      throw new Error(
        `failed page for a rate limit missed its safe message: ${visible.slice(0, 400)}`,
      );
    }
  });
});

test("failed job page gives a timeout a safe message", async () => {
  await withEnv(async () => {
    seedRepo();
    const { visible } = await failedJobPage({
      id: "job-fail-timeout",
      prNumber: 14,
      error: "request timed out after 60s",
    });
    if (!/timed out|timeout/i.test(visible)) {
      throw new Error(
        `failed page for a timeout missed its safe message: ${visible.slice(0, 400)}`,
      );
    }
  });
});

test("failed job page shows the failed attempt cost and duration", async () => {
  await withEnv(async () => {
    seedRepo();
    const { visible } = await failedJobPage({
      id: "job-fail-cost",
      prNumber: 15,
      error: "openrouter returned an empty review",
      cost: 0.004,
      durationMs: 130000,
    });

    if (!visible.includes("Duration") || !visible.includes("2 min 10s")) {
      throw new Error(
        `failed page missed the failed attempt duration: ${visible.slice(0, 500)}`,
      );
    }
    if (!visible.includes("Cost") || !visible.includes("$0.004")) {
      throw new Error(
        `failed page missed the failed attempt cost: ${visible.slice(0, 500)}`,
      );
    }
  });
});

test("failed job retry offers the same model and does not recommend a specific model", async () => {
  await withEnv(async () => {
    seedRepo();
    const { visible } = await failedJobPage({
      id: "job-fail-retry",
      prNumber: 16,
      error: "openrouter returned an empty review",
    });

    if (!visible.includes("Retry with the same model")) {
      throw new Error("failed page missed the same-model retry");
    }
    if (
      /\brecommend(ed)?\b|\bsuggested model\b|\btry (?:a|another|this|using) .*model/i.test(
        visible,
      )
    ) {
      throw new Error("failed page recommends a specific model");
    }
    if (/\bgpt-|\bclaude\b/i.test(visible)) {
      throw new Error(
        "failed page names a model other than the one that failed",
      );
    }
  });
});

test("failed job retry offers a change-default-model path", async () => {
  await withEnv(async () => {
    seedRepo();
    const { html } = await failedJobPage({
      id: "job-fail-change-default",
      prNumber: 18,
      error: "openrouter returned an empty review",
    });

    const change = html.match(
      /<a[^>]+href="([^"]+)"[^>]*>([^<]*Change default model[^<]*)<\/a>/i,
    );
    if (!change) {
      throw new Error("failed page has no Change default model path");
    }
    if (!change[1]!.includes("/settings/ai")) {
      throw new Error(
        `Change default model points to ${change[1]}, not the AI settings`,
      );
    }
  });
});

test("failed job log shows the safe error line and stack", async () => {
  await withEnv(async () => {
    seedRepo();
    seedFailedReviewJob({
      id: "job-fail-stack",
      prNumber: 17,
      error: "openrouter returned an empty review",
      logs: [
        ["error", "openrouter returned an empty review"],
        [
          "error",
          "Error: empty review\n    at runReview (src/services/review.ts:42:7)\n    at async main (src/main.ts:9:3)",
        ],
      ],
    });

    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await jobPage(app, cookie, "job-fail-stack");
    const visible = visibleText(html);

    if (!visible.includes("openrouter returned an empty review")) {
      throw new Error("failed log missed the error line");
    }
    if (!visible.includes("at runReview (src/services/review.ts:42:7)")) {
      throw new Error("failed log missed the safe stack line");
    }
    if (/sk-[A-Za-z0-9]|Authorization: Bearer/i.test(visible)) {
      throw new Error("failed log leaked a secret");
    }
  });
});
