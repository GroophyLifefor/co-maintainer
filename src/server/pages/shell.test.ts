import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { activateRepo, markKnowledgeBuilt } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { KNOWN_COST } from "../../testing/fixtures/cost.ts";
import { insertFinding } from "../../store/findings.ts";
import { insertJob } from "../../store/jobs.ts";
import { upsertDrift } from "../../store/drift.ts";
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
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const PASSWORD = "shell-pass";
const REPO = "acme/widgets";

const APP_PAGES: { path: string; active: string }[] = [
  { path: "/", active: "/" },
  { path: "/setup", active: "/setup" },
  { path: "/activity", active: "/activity" },
  { path: "/usage", active: "/usage" },
  { path: "/settings/ai", active: "/settings/ai" },
  { path: "/settings/github", active: "/settings/github" },
  { path: "/settings/defaults", active: "/settings/defaults" },
  { path: "/settings/remote", active: "/settings/remote" },
  { path: "/settings/server", active: "/settings/server" },
  { path: "/settings/sign-in", active: "/settings/sign-in" },
  { path: "/settings/danger", active: "/settings/danger" },
];

const SETTINGS_HEADINGS: { path: string; heading: string }[] = [
  { path: "/settings/ai", heading: "AI models" },
  { path: "/settings/github", heading: "GitHub" },
  { path: "/settings/defaults", heading: "Review defaults" },
  { path: "/settings/remote", heading: "Remote access" },
  { path: "/settings/server", heading: "Server" },
  { path: "/settings/sign-in", heading: "Sign-in" },
  { path: "/settings/danger", heading: "Danger zone" },
];

const REPO_PAGES: { path: string; tab: string; href: string }[] = [
  { path: `/repos/${REPO}`, tab: "Overview", href: `/repos/${REPO}` },
  {
    path: `/repos/${REPO}/pulls`,
    tab: "Pull requests",
    href: `/repos/${REPO}/pulls`,
  },
  {
    path: `/repos/${REPO}/knowledge`,
    tab: "Knowledge",
    href: `/repos/${REPO}/knowledge`,
  },
  {
    path: `/repos/${REPO}/remote`,
    tab: "Remote reviews",
    href: `/repos/${REPO}/remote`,
  },
  {
    path: `/repos/${REPO}/settings`,
    tab: "Repository settings",
    href: `/repos/${REPO}/settings`,
  },
];

const REPO_TAB_LABELS = [
  "Overview",
  "Pull requests",
  "Knowledge",
  "Remote reviews",
  "Repository settings",
];

const NAV_GROUPS = ["Reviews", "Setup", "Settings"];

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

type Fetched = { status: number; html: string; location: string };

async function get(
  app: ReturnType<typeof createApp>,
  cookie: string,
  path: string,
): Promise<Fetched> {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { cookie },
      redirect: "manual",
    }),
  );
  return {
    status: response.status,
    html: await response.text(),
    location: response.headers.get("location") ?? "",
  };
}

function leftNav(html: string): string | undefined {
  return /<aside\b[^>]*class="[^"]*\bside\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/i.exec(
    html,
  )?.[1];
}

function anchors(html: string): { href: string; classes: string[] }[] {
  const found: { href: string; classes: string[] }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = match[1]!;
    const href = /\bhref="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const classes = (/\bclass="([^"]*)"/.exec(attrs)?.[1] ?? "")
      .split(/\s+/)
      .filter(Boolean);
    found.push({ href, classes });
  }
  return found;
}

function activeNavHref(html: string): string[] {
  return anchors(html)
    .filter(
      (anchor) =>
        anchor.classes.includes("item") && anchor.classes.includes("on"),
    )
    .map((anchor) => anchor.href);
}

function sideTokenCount(html: string): number {
  return (html.match(/class="[^"]*\bside\b[^"]*"/gi) ?? []).length;
}

function pageInlineMaxWidths(html: string): string[] {
  const offenders: string[] = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const attrs = match[2]!;
    const classes = /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (!/\b(wrap|narrow|focus|page)\b/.test(classes)) continue;
    const style = /\bstyle="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (/max-width\s*:/.test(style)) offenders.push(match[0]);
  }
  return offenders;
}

function seed(): void {
  activateRepo(REPO, 9);
  markKnowledgeBuilt(REPO, "abc");
  upsertDrift({
    repo: REPO,
    as_of: new Date().toISOString(),
    prs_since: 2,
    prs_updated: 1,
    commits_since: 4,
    files_changed: 3,
  });
  insertJob({ id: "job-rev", type: "review", repo: REPO, prNumber: 7 });
  insertReview({
    id: "rev-1",
    repo: REPO,
    prNumber: 7,
    jobId: "job-rev",
    headSha: "deadbeef",
    baseSha: "cafebabe",
    scope: "whole-pr",
    model: "fake",
    round: 1,
  });
  setReviewStatus("rev-1", "posted", {
    findings_count: 1,
    ...KNOWN_COST(0.02),
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
}

test("each settings page renders 200 with its own heading", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    for (const { path, heading } of SETTINGS_HEADINGS) {
      const { status, html } = await get(app, cookie, path);
      if (status !== 200) throw new Error(`${path} status ${status}, want 200`);
      if (!new RegExp(`<h1[^>]*>${heading}</h1>`).test(html)) {
        throw new Error(`${path} did not render the "${heading}" heading`);
      }
    }
  });
});

test("GET /settings lands on the AI models page", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const { status, html, location } = await get(app, cookie, "/settings");
    if (status >= 300 && status < 400) {
      if (!location.endsWith("/settings/ai")) {
        throw new Error(
          `/settings redirected to ${location}, want /settings/ai`,
        );
      }
      return;
    }
    if (status !== 200) throw new Error(`/settings status ${status}`);
    if (!/<h1[^>]*>AI models<\/h1>/.test(html)) {
      throw new Error("/settings did not render the AI models page");
    }
  });
});

test("GET /analytics reaches the /usage page", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const { status, location } = await get(app, cookie, "/analytics");
    if (status < 300 || status >= 400) {
      throw new Error(`/analytics status ${status}, want a redirect to /usage`);
    }
    if (!location.endsWith("/usage")) {
      throw new Error(`/analytics redirected to ${location}, want /usage`);
    }
    const usage = await get(app, cookie, "/usage");
    if (usage.status !== 200) {
      throw new Error(`/usage status ${usage.status}, want 200`);
    }
    if (!/<h1[^>]*>Usage<\/h1>/.test(usage.html)) {
      throw new Error("/usage did not render the Usage heading");
    }
  });
});

test("an unknown page returns a 404 rendered inside the shell", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const { status, html } = await get(
      app,
      cookie,
      "/this-page-does-not-exist",
    );
    if (status !== 404) throw new Error(`status ${status}, want 404`);
    if (!/page not found|not found/i.test(html)) {
      throw new Error("the 404 body has no not-found heading");
    }
    const nav = leftNav(html);
    if (!nav) throw new Error("the 404 body is not inside the shell");
    for (const group of NAV_GROUPS) {
      if (!nav.includes(`>${group}<`)) {
        throw new Error(`the 404 shell is missing the "${group}" group`);
      }
    }
    if (!anchors(html).some((anchor) => anchor.href === "/")) {
      throw new Error("the 404 body has no link back to the repositories");
    }
  });
});

test("every app page carries the nav groups and marks the active item", async () => {
  await withEnv(async () => {
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    for (const { path, active } of APP_PAGES) {
      const { status, html } = await get(app, cookie, path);
      if (status !== 200) throw new Error(`${path} status ${status}, want 200`);
      const nav = leftNav(html);
      if (!nav) throw new Error(`${path} has no left nav`);
      for (const group of NAV_GROUPS) {
        if (!nav.includes(`>${group}<`)) {
          throw new Error(`${path} is missing the "${group}" nav group`);
        }
      }
      const marked = activeNavHref(html);
      if (marked.length !== 1 || marked[0] !== active) {
        throw new Error(
          `${path} marks ${JSON.stringify(marked)}, want exactly ${active}`,
        );
      }
    }
  });
});

test("repo pages use tabs and do not add a second sidebar", async () => {
  await withEnv(async () => {
    seed();
    await mkdirPath(`${getEnv("CM_REPOS_DIR")}/${REPO}`, { recursive: true });
    await writeTextFile(
      `${getEnv("CM_REPOS_DIR")}/${REPO}/PR_REVIEW_GUIDE.md`,
      "# guide\nKeep helpers honest.\n",
    );
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    for (const { path, tab, href } of REPO_PAGES) {
      const { status, html } = await get(app, cookie, path);
      if (status !== 200) throw new Error(`${path} status ${status}, want 200`);
      if (!/<nav\b[^>]*class="[^"]*\btabs\b[^"]*"[^>]*>/.test(html)) {
        throw new Error(`${path} has no repo tabs`);
      }
      for (const label of REPO_TAB_LABELS) {
        if (!html.includes(`>${label}`)) {
          throw new Error(`${path} tabs are missing "${label}"`);
        }
      }
      const sideCount = sideTokenCount(html);
      if (sideCount !== 1) {
        throw new Error(
          `${path} renders ${sideCount} sidebars, want only the shell`,
        );
      }
      const activeTabs = anchors(html).filter(
        (anchor) => anchor.href === href && anchor.classes.includes("on"),
      );
      if (activeTabs.length !== 1) {
        throw new Error(`${path} does not mark the "${tab}" tab active`);
      }
    }
  });
});

test("no page body sets its width with an inline max-width", async () => {
  await withEnv(async () => {
    seed();
    await mkdirPath(`${getEnv("CM_REPOS_DIR")}/${REPO}`, { recursive: true });
    await writeTextFile(
      `${getEnv("CM_REPOS_DIR")}/${REPO}/PR_REVIEW_GUIDE.md`,
      "# guide\nKeep helpers honest.\n",
    );
    const app = createApp({ password: PASSWORD });
    const cookie = await cookieSession(app);
    const paths = [
      ...APP_PAGES.map((page) => page.path),
      ...REPO_PAGES.map((p) => p.path),
      "/settings",
    ];
    for (const path of paths) {
      const { html } = await get(app, cookie, path);
      const offenders = pageInlineMaxWidths(html);
      if (offenders.length > 0) {
        throw new Error(`${path} sets page width inline: ${offenders[0]}`);
      }
    }
  });
});
