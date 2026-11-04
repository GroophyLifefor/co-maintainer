import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import {
  activateRepo,
  markKnowledgeBuilt,
  updateRepoSettings,
} from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertFinding } from "../../store/findings.ts";
import { recordDelivery } from "../../store/deliveries.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "repo-overview-pass";
const REPO = "acme/widgets";

async function overview(
  config: Record<string, unknown> = {},
  scope = "whole-pr",
): Promise<string> {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH", "CM_REPOS_DIR"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none", ...config });
    await mkdirPath(`${dir}/repos/${REPO}`, { recursive: true });
    await writeTextFile(`${dir}/repos/${REPO}/PR_REVIEW_GUIDE.md`, "# guide\n");
    activateRepo(REPO, 9);
    markKnowledgeBuilt(REPO, "abc");
    updateRepoSettings(REPO, { review_scope: scope });
    insertReview({
      id: "r1",
      repo: REPO,
      prNumber: 7,
      jobId: "job-r1",
      headSha: "h",
      baseSha: "b",
      scope: "full",
      model: "m",
    });
    setReviewStatus("r1", "posted", { findings_count: 2, duration_ms: 7000 });
    for (const [id, severity] of [
      ["f1", "P1"],
      ["f2", "P3"],
    ] as const) {
      insertFinding({ id, reviewId: "r1", severity, title: "t", bodyMd: "b" });
    }
    recordDelivery({
      deliveryId: "d1",
      event: "pull_request",
      action: "opened",
      repo: REPO,
      prNumber: 7,
      outcome: "queued",
    });
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "https://example.com/github/webhook",
    });
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
        new Request(`http://localhost/repos/${REPO}`, {
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

function statCard(html: string, label: string): string {
  const at = html.indexOf(`<div class="top">${label}`);
  if (at < 0) throw new Error(`no stat card "${label}"`);
  return html.slice(
    at,
    html.indexOf('<div class="stat">', at + 1) >>> 0 || undefined,
  );
}

test("the overview shows four stat cards from real 30 day figures", async () => {
  const html = await overview();
  if ((html.match(/<div class="stat">/g) ?? []).length !== 4) {
    throw new Error("want four stat cards");
  }
  const reviewed = statCard(html, "Reviewed (30d)");
  if (!/<div class="v">1<\/div>/.test(reviewed))
    throw new Error("reviewed is not 1");
  const findings = statCard(html, "Findings");
  if (
    !/<div class="v">2<\/div>/.test(findings) ||
    !findings.includes("1 high · 1 low")
  ) {
    throw new Error(`findings card wrong: ${findings.slice(0, 300)}`);
  }
  statCard(html, "Cost (30d)");
  if (!/<div class="v">7 s<\/div>/.test(statCard(html, "Avg. review"))) {
    throw new Error("average review time is not 7 s");
  }
});

test("the header has a chevron breadcrumb, Sync and GitHub buttons", async () => {
  const html = await overview();
  if (
    !/<div class="crumb"><a href="\/">Repositories<\/a><svg[^>]*><use href="#i-chevron-right">/.test(
      html,
    )
  ) {
    throw new Error("no chevron breadcrumb back to Repositories");
  }
  if (
    !/<button type="button" class="btn out" id="remake">[\s\S]*?Sync<\/button>/.test(
      html,
    )
  ) {
    throw new Error("no Sync button");
  }
  if (
    !/<a class="btn out" href="https:\/\/github.com\/acme\/widgets"[^>]*>[\s\S]*?GitHub<\/a>/.test(
      html,
    )
  ) {
    throw new Error("no GitHub button");
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  if (new Set(ids).size !== ids.length)
    throw new Error("duplicate ids on the overview");
});

test("the tabs come after the page header, as in the mock", async () => {
  const html = await overview();
  if (html.indexOf("<h1>") > html.indexOf('<nav class="tabs">')) {
    throw new Error("the tabs render above the title");
  }
});

test("recent pull requests show the highest severity", async () => {
  const html = await overview();
  if (!/href="\/repos\/acme\/widgets\/pulls\/7"[^>]*>#7</.test(html)) {
    throw new Error("no link to #7");
  }
  if (!/<span class="badge b-red">1 high<\/span>/.test(html)) {
    throw new Error("#7 lacks its high severity badge");
  }
});

test("How it reviews names who, scope, blocking and the webhook", async () => {
  const html = await overview({ reviewBlocking: "severity" }, "incremental");
  const panel = html.slice(html.indexOf("How it reviews"));
  for (const term of ["Who", "Scope", "Blocking", "Webhook"]) {
    if (!panel.includes(`<dt>${term}</dt>`))
      throw new Error(`panel lacks ${term}`);
  }
  if (!panel.includes("Only what changed since the last review")) {
    throw new Error("scope does not follow the repository setting");
  }
  if (!panel.includes("Severity is Critical or High")) {
    throw new Error("blocking does not follow the config");
  }
  if (
    !panel.includes("Receiving") ||
    !panel.includes("Last webhook delivery:")
  ) {
    throw new Error("webhook row does not show the last delivery");
  }
  if (!panel.includes(`href="/repos/${REPO}/settings"`)) {
    throw new Error("no Change link to repository settings");
  }
  const model = await overview();
  if (
    !model
      .slice(model.indexOf("How it reviews"))
      .includes("When the model says so")
  ) {
    throw new Error("default blocking wording missing");
  }
});

test("the auto review toggle moved to repository settings", async () => {
  const html = await overview();
  if (html.includes('id="auto"'))
    throw new Error("the overview still has the toggle");
});
