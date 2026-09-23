import { createApp } from "./app.ts";
import { markdown, money } from "./pages/layout.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { writeUserConfig } from "../config.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { insertReview, setReviewStatus } from "../store/reviews.ts";
import { insertFinding } from "../store/findings.ts";
import { insertJob, setJobStatus } from "../store/jobs.ts";
import { upsertDrift } from "../store/drift.ts";
import { recordDelivery } from "../store/deliveries.ts";
import { TEST_PKCS1_PEM } from "../testing/fixtures/rsa_key.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "page-pass";

const PAGES = [
  "/",
  "/setup",
  "/repos/new",
  "/activity",
  "/analytics",
  "/settings",
];

const REPO_PAGES = [
  "/repos/acme/widgets",
  "/repos/acme/widgets/pulls",
  "/repos/acme/widgets/pulls/7",
  "/repos/acme/widgets/knowledge",
  "/repos/acme/widgets/settings",
  "/repos/acme/widgets/remote",
];

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

function assertCleanCopy(html: string, path: string): void {
  const visible = visibleText(html);
  if (visible.includes("\u2014") || visible.includes(";")) {
    throw new Error(`forbidden copy on ${path}: ${visible.slice(0, 200)}`);
  }
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

function seed(): void {
  activateRepo("acme/widgets", 9);
  markKnowledgeBuilt("acme/widgets", "abc");
  upsertDrift({
    repo: "acme/widgets",
    as_of: new Date().toISOString(),
    prs_since: 2,
    prs_updated: 1,
    commits_since: 4,
    files_changed: 3,
  });
  insertJob({
    id: "job-rev",
    type: "review",
    repo: "acme/widgets",
    prNumber: 7,
  });
  insertReview({
    id: "rev-old",
    repo: "acme/widgets",
    prNumber: 7,
    jobId: "job-old",
    headSha: "oldhead",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 1,
  });
  setReviewStatus("rev-old", "posted", { findings_count: 1, cost: 0.01 });
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
    repo: "acme/widgets",
    prNumber: 7,
    jobId: "job-rev",
    headSha: "deadbeef",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 2,
  });
  setReviewStatus("rev-1", "posted", { findings_count: 1, cost: 0.02 });
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
  recordDelivery({
    deliveryId: "d-1",
    event: "pull_request",
    action: "opened",
    repo: "acme/widgets",
    prNumber: 8,
    outcome: "skipped",
    reason: "draft",
  });
}

test("GET / without a session redirects to login", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      new Request("http://localhost/", { redirect: "manual" }),
    );
    if (response.status !== 303) throw new Error(`status ${response.status}`);
    if (!response.headers.get("location")?.includes("/login")) {
      throw new Error(String(response.headers.get("location")));
    }
    const login = await (
      await app.fetch(new Request("http://localhost/login"))
    ).text();
    if (!login.includes('class="brand" src="/logo.png"')) {
      throw new Error("login missed the logo");
    }
  });
});

test("each page renders 200 with empty data", async () => {
  await withEnv(async () => {
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "http://localhost:5000/github/webhook",
    });
    const cookie = await cookieSession(app);
    for (const path of PAGES) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, { headers: { cookie } }),
      );
      if (response.status !== 200) {
        throw new Error(`${path} status ${response.status}`);
      }
      const html = await response.text();
      if (!html.includes("<!doctype html>")) {
        throw new Error(`${path} was not html`);
      }
      assertCleanCopy(html, path);
    }
    const add = await (
      await app.fetch(
        new Request("http://localhost/repos/new", { headers: { cookie } }),
      )
    ).text();
    if (!add.includes('<select id="repo"') || !add.includes("GitHub App")) {
      throw new Error("add-repo missed the installation picker");
    }
    const settings = await (
      await app.fetch(
        new Request("http://localhost/settings", { headers: { cookie } }),
      )
    ).text();
    if (
      !settings.includes("Murat Kirazkaya") ||
      !settings.includes("github.com/GroophyLifefor/co-maintainer")
    ) {
      throw new Error("settings about block missing");
    }
    if (
      !settings.includes('<textarea id="app-key"') ||
      !settings.includes("BEGIN RSA PRIVATE KEY")
    ) {
      throw new Error("settings private key field missed PEM guidance");
    }
  });
});

test("the home page lists the remaining setup steps", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(new Request("http://localhost/", { headers: { cookie } }))
    ).text();
    if (!html.includes('id="finish-setup"')) {
      throw new Error("a fresh install has no Finish setup card");
    }
    for (const title of [
      "Models and API key",
      "GitHub App",
      "Webhook reachable",
      "First repository",
      "First review",
      "CLI connected",
    ]) {
      if (!html.includes(title)) throw new Error(`missing step: ${title}`);
    }
    // Every step links somewhere actionable.
    if (!html.includes("/settings#ai") || !html.includes("/settings#remote")) {
      throw new Error("a step does not link to its settings card");
    }
    if (!html.includes("0/6 done")) {
      throw new Error("the done counter is wrong for a fresh install");
    }
  });
});

test("the Finish setup card disappears once everything is done", async () => {
  await withEnv(async () => {
    seed();
    await writeUserConfig({
      auth: "gh",
      ai: "openrouter",
      token: "sk-or-x",
      lowModel: "low/model",
      highModel: "high/model",
      githubAppId: "4900449",
      githubAppPrivateKey: "PEM",
    });
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "https://example.com/github/webhook",
    });
    const cookie = await cookieSession(app);
    // A remote token satisfies the CLI step.
    await app.fetch(
      new Request("http://localhost/api/remote-tokens", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-requested-with": "co-maintainer",
        },
        body: JSON.stringify({ name: "laptop" }),
      }),
    );
    // `seed` already recorded a delivery and a review, and the repo is active.
    const html = await (
      await app.fetch(new Request("http://localhost/", { headers: { cookie } }))
    ).text();
    if (html.includes('id="finish-setup"')) {
      throw new Error("the card stayed after everything was done");
    }
  });
});

test("the Finish setup card names an unreachable webhook", async () => {
  await withEnv(async () => {
    seed();
    await writeUserConfig({
      auth: "gh",
      ai: "openrouter",
      token: "sk-or-x",
      lowModel: "low/model",
      highModel: "high/model",
      githubAppId: "4900449",
      githubAppPrivateKey: "PEM",
    });
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "http://localhost:5000/github/webhook",
    });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(new Request("http://localhost/", { headers: { cookie } }))
    ).text();
    if (!html.includes("GitHub cannot reach")) {
      throw new Error("the checklist did not flag the localhost webhook");
    }
  });
});

test("each page renders 200 with seeded data", async () => {
  await withEnv(async () => {
    seed();
    await mkdirPath(`${getEnv("CM_REPOS_DIR")}/acme/widgets`, {
      recursive: true,
    });
    await writeTextFile(
      `${getEnv("CM_REPOS_DIR")}/acme/widgets/PR_REVIEW_GUIDE.md`,
      "# guide\nKeep helpers honest.\n",
    );
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "http://localhost:5000/github/webhook",
    });
    const cookie = await cookieSession(app);
    for (const path of [...PAGES, ...REPO_PAGES]) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, { headers: { cookie } }),
      );
      if (response.status !== 200) {
        throw new Error(
          `${path} status ${response.status} ${await response.text()}`,
        );
      }
      const html = await response.text();
      assertCleanCopy(html, path);
    }
    const home = await (
      await app.fetch(new Request("http://localhost/", { headers: { cookie } }))
    ).text();
    if (!home.includes("acme/widgets")) {
      throw new Error("home did not list the seeded repo");
    }
    const pr = await (
      await app.fetch(
        new Request("http://localhost/repos/acme/widgets/pulls/7", {
          headers: { cookie },
        }),
      )
    ).text();
    if (!pr.includes("unused value")) {
      throw new Error("pr page missed the finding");
    }
    if (!pr.includes("old finding") || !pr.includes("This finding belongs")) {
      throw new Error("pr page missed findings from an older review");
    }
    const pulls = await (
      await app.fetch(
        new Request("http://localhost/repos/acme/widgets/pulls", {
          headers: { cookie },
        }),
      )
    ).text();
    if (
      !pulls.includes('id="manual-review"') ||
      !pulls.includes('id="pr-number"') ||
      !pulls.includes("Start review")
    ) {
      throw new Error("pull requests page missed manual review");
    }
    const manual = await app.fetch(
      new Request("http://localhost/api/repos/acme/widgets/pulls/42/review", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-requested-with": "co-maintainer",
        },
        body: "{}",
      }),
    );
    if (manual.status !== 200) {
      throw new Error(`manual review status ${manual.status}`);
    }
    const manualBody = await manual.json();
    if (typeof manualBody.jobId !== "string") {
      throw new Error(`manual review body ${JSON.stringify(manualBody)}`);
    }
  });
});

test("cookie session can call /api/me", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const response = await app.fetch(
      new Request("http://localhost/api/me", { headers: { cookie } }),
    );
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    const body = await response.json();
    if (body.username !== "admin") throw new Error(JSON.stringify(body));
  });
});

test("GET /styles.css is public", async () => {
  const app = createApp({ password: PASSWORD });
  const response = await app.fetch(new Request("http://localhost/styles.css"));
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const css = await response.text();
  if (!css.includes("--bg")) throw new Error("did not serve mock styles");
  if (!css.includes("sk-slot") || !css.includes("prefers-reduced-motion")) {
    throw new Error("styles missed the UX pass rules");
  }
});

test("GET /logo.png is public", async () => {
  const app = createApp({ password: PASSWORD });
  const response = await app.fetch(new Request("http://localhost/logo.png"));
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("image/png")) throw new Error(type);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error("did not serve the png");
  }
});

test("the knowledge page counts new and changed pull requests apart", async () => {
  await withEnv(async () => {
    seed();
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(
        new Request("http://localhost/repos/acme/widgets/knowledge", {
          headers: { cookie },
        }),
      )
    ).text();
    for (const needle of [
      "2 new pull requests",
      "1 changed pull requests",
      "4 new commits",
      "3 changed files",
    ]) {
      if (!html.includes(needle)) {
        throw new Error(`knowledge page missed "${needle}"`);
      }
    }
  });
});

test("a drift count that hit its ceiling reads as a floor on both pages", async () => {
  await withEnv(async () => {
    seed();
    upsertDrift({
      repo: "acme/widgets",
      as_of: new Date().toISOString(),
      prs_since: 2,
      prs_updated: 1,
      commits_since: 500,
      files_changed: 300,
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    for (const path of [
      "/repos/acme/widgets",
      "/repos/acme/widgets/knowledge",
    ]) {
      const html = await (
        await app.fetch(
          new Request(`http://localhost${path}`, { headers: { cookie } }),
        )
      ).text();
      if (!html.includes("500+") || !html.includes("300+")) {
        throw new Error(`${path} showed a capped count as exact`);
      }
    }
  });
});

test("GET /client.js is the fetch wrapper with toast and retry", async () => {
  const app = createApp({ password: PASSWORD });
  const response = await app.fetch(new Request("http://localhost/client.js"));
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const js = await response.text();
  for (const needle of [
    "function toast",
    "function fail",
    "Retry",
    'addEventListener("error"',
    "unhandledrejection",
    "bindToggle",
    'getElementById("activity-root")',
    "5000",
  ]) {
    if (!js.includes(needle)) throw new Error(`client.js missed ${needle}`);
  }
  if (js.includes("alert(")) throw new Error("client.js still alerts");
});

test("every page carries the helper before its own scripts", async () => {
  await withEnv(async () => {
    seed();
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const paths = ["/", "/repos/new", "/settings", "/repos/acme/widgets"];
    for (const path of paths) {
      const html = await (
        await app.fetch(
          new Request(`http://localhost${path}`, { headers: { cookie } }),
        )
      ).text();
      // `bindToggle` and `api` are called from page scripts; if the helper
      // lands after `<body>` those calls hit an undefined name.
      const head = html.slice(0, html.indexOf("</head>"));
      if (!head.includes("function bindToggle")) {
        throw new Error(`${path} did not inline the helper in <head>`);
      }
      if (head.includes("/client.js")) {
        throw new Error(`${path} still loads the helper as a body script`);
      }
    }
  });
});

test("the token secret panel replaces the browser prompt", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(
        new Request("http://localhost/settings", { headers: { cookie } }),
      )
    ).text();
    if (!html.includes('id="remote-token-secret"')) {
      throw new Error("settings missed the secret panel");
    }
    if (html.includes('prompt("Copy this token')) {
      throw new Error("settings still prompts for the token");
    }
  });
});

test("the repo overview warns when GitHub cannot reach the webhook", async () => {
  await withEnv(async () => {
    seed();
    await mkdirPath(`${getEnv("CM_REPOS_DIR")}/acme/widgets`, {
      recursive: true,
    });
    await writeTextFile(
      `${getEnv("CM_REPOS_DIR")}/acme/widgets/PR_REVIEW_GUIDE.md`,
      "# guide\nKeep helpers honest.\n",
    );
    const local = createApp({
      password: PASSWORD,
      webhookUrl: "http://localhost:5000/github/webhook",
    });
    const localCookie = await cookieSession(local);
    const localHtml = await (
      await local.fetch(
        new Request("http://localhost/repos/acme/widgets", {
          headers: { cookie: localCookie },
        }),
      )
    ).text();
    if (
      !localHtml.includes(
        "GitHub cannot reach this address, so automatic reviews will not arrive.",
      )
    ) {
      throw new Error("a localhost webhook did not warn");
    }
    if (!localHtml.includes("Last webhook delivery:")) {
      throw new Error("the warning omitted the last delivery line");
    }
    const publicApp = createApp({
      password: PASSWORD,
      webhookUrl: "https://example.com/github/webhook",
    });
    const publicCookie = await cookieSession(publicApp);
    const publicHtml = await (
      await publicApp.fetch(
        new Request("http://localhost/repos/acme/widgets", {
          headers: { cookie: publicCookie },
        }),
      )
    ).text();
    if (publicHtml.includes("cannot reach this address")) {
      throw new Error("a public webhook still warned");
    }
    // `seed` records one delivery for acme/widgets, so this is the "has
    // arrived" reading rather than the empty state.
    if (!publicHtml.includes("Last webhook delivery:")) {
      throw new Error("a reached repo hid the delivery line");
    }
  });
});

test("a repo with no deliveries says so instead of staying silent", async () => {
  await withEnv(async () => {
    activateRepo("acme/widgets", 9);
    await mkdirPath(`${getEnv("CM_REPOS_DIR")}/acme/widgets`, {
      recursive: true,
    });
    await writeTextFile(
      `${getEnv("CM_REPOS_DIR")}/acme/widgets/PR_REVIEW_GUIDE.md`,
      "# guide\nKeep helpers honest.\n",
    );
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "https://example.com/github/webhook",
    });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(
        new Request("http://localhost/repos/acme/widgets", {
          headers: { cookie },
        }),
      )
    ).text();
    if (!html.includes("No webhook delivery yet.")) {
      throw new Error("an empty delivery history stayed silent");
    }
    if (!html.includes("the last webhook delivery is never")) {
      throw new Error("the empty state omitted the never reading");
    }
  });
});

test("the pulls tab lists open pull requests and starts a review from one", async () => {
  await withEnv(async () => {
    activateRepo("acme/widgets", 9);
    await writeUserConfig({
      githubAppId: "4900449",
      githubAppPrivateKey: TEST_PKCS1_PEM,
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/app/installations")) {
        return Response.json([
          {
            id: 7,
            account: { login: "acme", type: "Organization" },
            suspended_at: null,
          },
        ]);
      }
      if (url.includes("/access_tokens")) {
        return Response.json({
          token: "ghs_x",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (url.includes("/installation/repositories")) {
        return Response.json({
          repositories: [{ full_name: "acme/widgets", private: false }],
        });
      }
      if (url.includes("/repos/acme/widgets/pulls")) {
        return Response.json([
          {
            number: 12,
            title: "Tidy the helper",
            draft: false,
            user: { login: "octocat" },
            head: { ref: "fix/helper" },
            updated_at: "2026-09-22T10:00:00Z",
          },
        ]);
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      const app = createApp({ password: PASSWORD });
      const cookie = await cookieSession(app);
      const html = await (
        await app.fetch(
          new Request("http://localhost/repos/acme/widgets/pulls", {
            headers: { cookie },
          }),
        )
      ).text();
      if (!html.includes('data-review-pr="12"')) {
        throw new Error(
          "the open pull request was not listed with a review button",
        );
      }
      if (!html.includes("Tidy the helper") || !html.includes("fix/helper")) {
        throw new Error("the open pull request row is missing its fields");
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

test("the pulls tab explains itself when the App is not configured", async () => {
  await withEnv(async () => {
    activateRepo("acme/widgets", 9);
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(
        new Request("http://localhost/repos/acme/widgets/pulls", {
          headers: { cookie },
        }),
      )
    ).text();
    if (!html.includes("Configure the GitHub App to list open pull requests")) {
      throw new Error("the unconfigured state stayed silent");
    }
    if (!html.includes('id="manual-review"')) {
      throw new Error("the by-number form disappeared");
    }
  });
});

test("the settings page uses the CLI's high/low model language", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(
        new Request("http://localhost/settings", { headers: { cookie } }),
      )
    ).text();
    if (!html.includes("High model") || !html.includes("Low model")) {
      throw new Error("settings does not use high/low model labels");
    }
    if (html.includes("Main model") || html.includes("Cheap model")) {
      throw new Error("settings still uses the old model labels");
    }
    // The high model also synthesizes the guides, not only proves reviews.
    if (!html.includes("synthesizes the guides")) {
      throw new Error("the high-model hint does not mention synthesis");
    }
    if (!html.includes("Extracts facts from history")) {
      throw new Error("the low-model hint does not describe extraction");
    }
  });
});

test("the add-repo page previews before it can start init", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(
        new Request("http://localhost/repos/new", { headers: { cookie } }),
      )
    ).text();
    if (!html.includes('id="preview"')) {
      throw new Error("the page has no preview button");
    }
    if (!html.includes('id="plan"')) {
      throw new Error("the page has no plan slot");
    }
    // The old one-click add is gone: no button posts straight to /api/repos.
    if (html.includes('id="add"')) {
      throw new Error("the page still adds without confirmation");
    }
    if (!html.includes("Add and start init")) {
      throw new Error("the confirm action is missing");
    }
    if (!html.includes("/api/repos/preview")) {
      throw new Error("the page does not call the preview endpoint");
    }
  });
});

test("the client catches only once the page is parsed", async () => {
  // The helper is inlined into `<head>`, so its wiring and the activity poll
  // must not run at parse time: `pollActivity` reads `activity-root`, which
  // the body has not printed yet.
  const app = createApp({ password: PASSWORD });
  const js = await (
    await app.fetch(new Request("http://localhost/client.js"))
  ).text();
  const firstListener = js.indexOf('addEventListener("DOMContentLoaded"');
  const errorListener = js.indexOf('addEventListener("error"');
  const activityLookup = js.indexOf('getElementById("activity-root")');
  if (firstListener < 0 || errorListener < 0 || activityLookup < 0) {
    throw new Error("client.js lost its wiring or the activity poll");
  }
  if (errorListener < firstListener || activityLookup < firstListener) {
    throw new Error("client.js runs at parse time instead of on load");
  }
  if (/\(function pollActivity\(\)/.test(js)) {
    throw new Error("client.js still uses the self-invoking poll wrapper");
  }
});

test("mutating pages ship a skeleton and a failure path", async () => {
  await withEnv(async () => {
    seed();
    setJobStatus("job-rev", "running");
    await mkdirPath(`${getEnv("CM_REPOS_DIR")}/acme/widgets`, {
      recursive: true,
    });
    await writeTextFile(
      `${getEnv("CM_REPOS_DIR")}/acme/widgets/PR_REVIEW_GUIDE.md`,
      "# guide\nKeep helpers honest.\n",
    );
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "http://localhost:5000/github/webhook",
    });
    const cookie = await cookieSession(app);
    const paths = [
      "/",
      "/repos/new",
      "/activity",
      "/settings",
      "/repos/acme/widgets",
      "/repos/acme/widgets/pulls/7",
      "/repos/acme/widgets/knowledge",
      "/repos/acme/widgets/settings",
    ];
    for (const path of paths) {
      const html = await (
        await app.fetch(
          new Request(`http://localhost${path}`, { headers: { cookie } }),
        )
      ).text();
      if (
        !html.includes('id="toasts"') ||
        !html.includes("function bindToggle")
      ) {
        throw new Error(`${path} missed the toast host or the inlined helper`);
      }
      if (
        !html.includes('src="/logo.png"') ||
        !html.includes('rel="icon" href="/logo.png"')
      ) {
        throw new Error(`${path} missed the logo`);
      }
      if (!html.includes("data-async") || !html.includes("sk-slot")) {
        throw new Error(`${path} missed an async skeleton`);
      }
      if (html.includes("alert(")) {
        throw new Error(`${path} still alerts`);
      }
      assertCleanCopy(html, path);
    }
    const home = await (
      await app.fetch(new Request("http://localhost/", { headers: { cookie } }))
    ).text();
    if (!home.includes("<time datetime=")) {
      throw new Error("home missed absolute times on hover");
    }
  });
});

test("usage breaks spend down by day, model and severity", async () => {
  await withEnv(async () => {
    seed();
    setReviewStatus("rev-1", "posted", {
      tokens_in: 12000,
      tokens_out: 3400,
      duration_ms: 90000,
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await (
      await app.fetch(
        new Request("http://localhost/analytics?range=7d", {
          headers: { cookie },
        }),
      )
    ).text();
    assertCleanCopy(html, "/analytics");
    const visible = visibleText(html);
    for (const label of ["Cost per day", "By model", "Findings by severity"]) {
      if (!visible.includes(label)) throw new Error(`usage missed ${label}`);
    }
    if ((html.match(/<div class="bars">/g) ?? []).length !== 1) {
      throw new Error("usage missed the daily bar chart");
    }
    if ((html.match(/<i title="/g) ?? []).length !== 7) {
      throw new Error("7d range did not fill every day with a bar");
    }
    if (
      !visible.includes("15.4K") ||
      !visible.includes("12K in and 3.4K out")
    ) {
      throw new Error(`usage missed the token split: ${visible.slice(0, 400)}`);
    }
    if (!visible.includes("1m 30s")) {
      throw new Error("usage missed the average review duration");
    }
    if (!visible.includes("P1") || !visible.includes("P2")) {
      throw new Error("usage missed the severity rows");
    }
    const api = await (
      await app.fetch(
        new Request("http://localhost/api/analytics?range=7d", {
          headers: { cookie },
        }),
      )
    ).json();
    if (api.bySeverity.length !== 2 || api.byDay.length !== 7) {
      throw new Error(`api shape ${JSON.stringify(api).slice(0, 200)}`);
    }
    const repeat = api.bySeverity.find(
      (row: { severity: string }) => row.severity === "P2",
    );
    if (repeat.repeats !== 1) {
      throw new Error("api lost the raised again count");
    }
    if (api.previous === undefined || api.change === undefined) {
      throw new Error("api lost the trend window");
    }
  });
});

test("activity lists a job as a link and the job page shows the error", async () => {
  await withEnv(async () => {
    seed();
    insertJob({
      id: "job-fail",
      type: "remake",
      repo: "acme/widgets",
    });
    setJobStatus("job-fail", "failed", {
      error: "Error: sync requires a previous init or sync for this repository",
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const activity = await (
      await app.fetch(
        new Request("http://localhost/activity", { headers: { cookie } }),
      )
    ).text();
    if (!activity.includes('id="activity-root"')) {
      throw new Error("activity missed the poll root");
    }
    if (!activity.includes("/activity/job-fail")) {
      throw new Error("failed job was not a link");
    }
    const analytics = await (
      await app.fetch(
        new Request("http://localhost/analytics", { headers: { cookie } }),
      )
    ).text();
    if (
      !analytics.includes('data-worth-id="job-fail"') ||
      !analytics.includes('data-dismiss-worth="job-fail"')
    ) {
      throw new Error("analytics missed dismissible failed job");
    }
    const job = await app.fetch(
      new Request("http://localhost/activity/job-fail", {
        headers: { cookie },
      }),
    );
    if (job.status !== 200) throw new Error(`job page ${job.status}`);
    const html = await job.text();
    if (!html.includes("Synced knowledge")) {
      throw new Error("job page missed the label");
    }
    if (!html.includes("sync requires a previous init")) {
      throw new Error("job page missed the error");
    }
    if (!html.includes("Retry")) throw new Error("job page missed Retry");
    assertCleanCopy(html, "/activity/job-fail");
  });
});

test("money keeps sub-cent costs visible", () => {
  if (money(0) !== "$0.00") throw new Error(money(0));
  if (money(2.41) !== "$2.41") throw new Error(money(2.41));
  if (money(0.01) !== "$0.01") throw new Error(money(0.01));
  if (money(0.0002118) !== "$0.0002118") throw new Error(money(0.0002118));
  if (money(0.001) !== "$0.001") throw new Error(money(0.001));
});

test("finding markdown renders safely", () => {
  const html = markdown(
    "**Bold** `code`\n\n- item\n\n```ts\n<script>alert(1)</script>\n```",
  );
  if (
    !html.includes("<strong>Bold</strong>") ||
    !html.includes("<code>code</code>") ||
    !html.includes("<ul>") ||
    !html.includes("&lt;script&gt;")
  ) {
    throw new Error(`markdown was not rendered: ${html}`);
  }
  if (html.includes("<script>")) throw new Error("markdown was not escaped");
});

test("a repository subpage with a stray PR number is not a rendered page", async () => {
  await withEnv(async () => {
    seed();
    const app = createApp({
      password: PASSWORD,
      webhookUrl: "http://localhost:5000/github/webhook",
    });
    const cookie = await cookieSession(app);
    // Only `pulls` takes a numeric suffix; `/remote/7` is malformed and must
    // not silently render the remote listing while dropping the number.
    for (const path of [
      "/repos/acme/widgets/remote/7",
      "/repos/acme/widgets/settings/7",
      "/repos/acme/widgets/knowledge/7",
    ]) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, { headers: { cookie } }),
      );
      if (response.status !== 404) {
        throw new Error(`${path} status ${response.status}, want 404`);
      }
    }
    // The legitimate PR route still works.
    const ok = await app.fetch(
      new Request("http://localhost/repos/acme/widgets/pulls/7", {
        headers: { cookie },
      }),
    );
    if (ok.status !== 200) {
      throw new Error(`/pulls/7 status ${ok.status}`);
    }
  });
});
