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
];

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const originalDb = Deno.env.get("CM_APP_DB");
  const originalConfig = Deno.env.get("CM_CONFIG_PATH");
  const originalRepos = Deno.env.get("CM_REPOS_DIR");
  const dir = Deno.makeTempDirSync();
  Deno.env.set("CM_APP_DB", `${dir}/app.db`);
  Deno.env.set("CM_CONFIG_PATH", `${dir}/config.json`);
  Deno.env.set("CM_REPOS_DIR", `${dir}/repos`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    if (originalDb === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", originalDb);
    if (originalConfig === undefined) Deno.env.delete("CM_CONFIG_PATH");
    else Deno.env.set("CM_CONFIG_PATH", originalConfig);
    if (originalRepos === undefined) Deno.env.delete("CM_REPOS_DIR");
    else Deno.env.set("CM_REPOS_DIR", originalRepos);
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

Deno.test("GET / without a session redirects to login", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const response = await app.fetch(
      new Request("http://localhost/", { redirect: "manual" }),
    );
    if (response.status !== 303) throw new Error(`status ${response.status}`);
    if (!response.headers.get("location")?.includes("/login")) {
      throw new Error(String(response.headers.get("location")));
    }
    const login = await (await app.fetch(
      new Request("http://localhost/login"),
    )).text();
    if (!login.includes('class="brand" src="/logo.png"')) {
      throw new Error("login missed the logo");
    }
  });
});

Deno.test("each page renders 200 with empty data", async () => {
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
    const add = await (await app.fetch(
      new Request("http://localhost/repos/new", { headers: { cookie } }),
    )).text();
    if (!add.includes('<select id="repo"') || !add.includes("GitHub App")) {
      throw new Error("add-repo missed the installation picker");
    }
    const settings = await (await app.fetch(
      new Request("http://localhost/settings", { headers: { cookie } }),
    )).text();
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

Deno.test("each page renders 200 with seeded data", async () => {
  await withEnv(async () => {
    seed();
    await Deno.mkdir(`${Deno.env.get("CM_REPOS_DIR")}/acme/widgets`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${Deno.env.get("CM_REPOS_DIR")}/acme/widgets/PR_REVIEW_GUIDE.md`,
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
    const home = await (await app.fetch(
      new Request("http://localhost/", { headers: { cookie } }),
    )).text();
    if (!home.includes("acme/widgets")) {
      throw new Error("home did not list the seeded repo");
    }
    const pr = await (await app.fetch(
      new Request("http://localhost/repos/acme/widgets/pulls/7", {
        headers: { cookie },
      }),
    )).text();
    if (!pr.includes("unused value")) {
      throw new Error("pr page missed the finding");
    }
    if (!pr.includes("old finding") || !pr.includes("This finding belongs")) {
      throw new Error("pr page missed findings from an older review");
    }
    const pulls = await (await app.fetch(
      new Request("http://localhost/repos/acme/widgets/pulls", {
        headers: { cookie },
      }),
    )).text();
    if (
      !pulls.includes('id="manual-review"') ||
      !pulls.includes('id="pr-number"') ||
      !pulls.includes("Start review")
    ) {
      throw new Error("pull requests page missed manual review");
    }
    const manual = await app.fetch(
      new Request(
        "http://localhost/api/repos/acme/widgets/pulls/42/review",
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "x-requested-with": "co-maintainer",
          },
          body: "{}",
        },
      ),
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

Deno.test("cookie session can call /api/me", async () => {
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

Deno.test("GET /styles.css is public", async () => {
  const app = createApp({ password: PASSWORD });
  const response = await app.fetch(new Request("http://localhost/styles.css"));
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const css = await response.text();
  if (!css.includes("--bg")) throw new Error("did not serve mock styles");
  if (!css.includes("sk-slot") || !css.includes("prefers-reduced-motion")) {
    throw new Error("styles missed the UX pass rules");
  }
});

Deno.test("GET /logo.png is public", async () => {
  const app = createApp({ password: PASSWORD });
  const response = await app.fetch(new Request("http://localhost/logo.png"));
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("image/png")) throw new Error(type);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error("did not serve the png");
  }
});

Deno.test("the knowledge page counts new and changed pull requests apart", async () => {
  await withEnv(async () => {
    seed();
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const html = await (await app.fetch(
      new Request("http://localhost/repos/acme/widgets/knowledge", {
        headers: { cookie },
      }),
    )).text();
    for (
      const needle of [
        "2 new pull requests",
        "1 changed pull requests",
        "4 new commits",
        "3 changed files",
      ]
    ) {
      if (!html.includes(needle)) {
        throw new Error(`knowledge page missed "${needle}"`);
      }
    }
  });
});

Deno.test("GET /client.js is the fetch wrapper with toast and retry", async () => {
  const app = createApp({ password: PASSWORD });
  const response = await app.fetch(new Request("http://localhost/client.js"));
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const js = await response.text();
  for (
    const needle of [
      "function toast",
      "function fail",
      "Retry",
      'addEventListener("error"',
      "unhandledrejection",
      "bindToggle",
      "pollActivity",
      "5000",
    ]
  ) {
    if (!js.includes(needle)) throw new Error(`client.js missed ${needle}`);
  }
  if (js.includes("alert(")) throw new Error("client.js still alerts");
});

Deno.test("mutating pages ship a skeleton and a failure path", async () => {
  await withEnv(async () => {
    seed();
    setJobStatus("job-rev", "running");
    await Deno.mkdir(`${Deno.env.get("CM_REPOS_DIR")}/acme/widgets`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${Deno.env.get("CM_REPOS_DIR")}/acme/widgets/PR_REVIEW_GUIDE.md`,
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
      const html = await (await app.fetch(
        new Request(`http://localhost${path}`, { headers: { cookie } }),
      )).text();
      if (!html.includes('id="toasts"') || !html.includes("/client.js")) {
        throw new Error(`${path} missed the toast host`);
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
    const home = await (await app.fetch(
      new Request("http://localhost/", { headers: { cookie } }),
    )).text();
    if (!home.includes("<time datetime=")) {
      throw new Error("home missed absolute times on hover");
    }
  });
});

Deno.test("activity lists a job as a link and the job page shows the error", async () => {
  await withEnv(async () => {
    seed();
    insertJob({
      id: "job-fail",
      type: "remake",
      repo: "acme/widgets",
    });
    setJobStatus("job-fail", "failed", {
      error:
        "Error: remake requires a previous init or remake for this repository",
    });
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const activity = await (await app.fetch(
      new Request("http://localhost/activity", { headers: { cookie } }),
    )).text();
    if (!activity.includes('id="activity-root"')) {
      throw new Error("activity missed the poll root");
    }
    if (!activity.includes("/activity/job-fail")) {
      throw new Error("failed job was not a link");
    }
    const analytics = await (await app.fetch(
      new Request("http://localhost/analytics", { headers: { cookie } }),
    )).text();
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
    if (!html.includes("Updated knowledge")) {
      throw new Error("job page missed the label");
    }
    if (!html.includes("remake requires a previous init")) {
      throw new Error("job page missed the error");
    }
    if (!html.includes("Retry")) throw new Error("job page missed Retry");
    assertCleanCopy(html, "/activity/job-fail");
  });
});

Deno.test("money keeps sub-cent costs visible", () => {
  if (money(0) !== "$0.00") throw new Error(money(0));
  if (money(2.41) !== "$2.41") throw new Error(money(2.41));
  if (money(0.01) !== "$0.01") throw new Error(money(0.01));
  if (money(0.0002118) !== "$0.0002118") throw new Error(money(0.0002118));
  if (money(0.001) !== "$0.001") throw new Error(money(0.001));
});

Deno.test("finding markdown renders safely", () => {
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
