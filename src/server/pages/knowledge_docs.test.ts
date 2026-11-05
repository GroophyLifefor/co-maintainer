/** The knowledge document has three views of one file: the rendered page, the
 * Copy source and the Download response. They must all come from the same
 * bytes, and a document that is not on the server must not become a 200. */
import { test } from "node:test";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { activateRepo, markKnowledgeBuilt } from "../../store/repos.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../../testing/runtime.ts";

const PASSWORD = "knowledge-docs-pass";
const REPO = "acme/widgets";
const LONG_LINE = `const veryLong = "${"x".repeat(300)}";`;
const RAW_GUIDE = [
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
  LONG_LINE,
  "```",
  "",
].join("\n");

type Page = { status: number; html: string };

async function withEnv(fn: (dir: string) => Promise<void>): Promise<void> {
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
    await fn(dir);
  } finally {
    await closeAppDb();
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    }
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
  if (response.status !== 303)
    throw new Error(`login status ${response.status}`);
  const token = response.headers.get("set-cookie")?.match(/^cm=([^;]+)/)?.[1];
  if (!token) throw new Error("the login response set no session cookie");
  return `cm=${token}`;
}

async function getPage(
  app: ReturnType<typeof createApp>,
  cookie: string,
  path: string,
): Promise<Page> {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { cookie },
      redirect: "manual",
    }),
  );
  return { status: response.status, html: await response.text() };
}

async function seedGuides(dir: string): Promise<void> {
  const repoDir = join(dir, "repos", REPO);
  await mkdirPath(repoDir, { recursive: true });
  await writeTextFile(join(repoDir, "PR_REVIEW_GUIDE.md"), RAW_GUIDE);
  activateRepo(REPO, 9);
  markKnowledgeBuilt(REPO, "abc");
}

function decode(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]!) : undefined;
}

/** The hidden element the Copy button reads. It must hold the raw markdown,
 * not the rendered HTML and not a JSON wrapper. */
function copySource(html: string, id: string): string | undefined {
  const pattern = new RegExp(
    `<([a-z0-9-]+)[^>]*data-doc-source="${id}"[^>]*>([\\s\\S]*?)</\\1>`,
    "i",
  );
  const match = pattern.exec(html);
  return match ? decode(match[2]!) : undefined;
}

function copyControl(html: string, id: string): string | undefined {
  return new RegExp(
    `<(button|a)[^>]*data-copy-doc="${id}"[^>]*>([\\s\\S]*?)</\\1>`,
    "i",
  ).exec(html)?.[0];
}

function downloadLink(html: string, id: string): string | undefined {
  const tag = new RegExp(`<a[^>]*data-doc-download="${id}"[^>]*>`, "i").exec(
    html,
  )?.[0];
  return tag ? attributeValue(tag, "href") : undefined;
}

test("the document view renders markdown and exposes the same raw text for Copy", async () => {
  await withEnv(async (dir) => {
    await seedGuides(dir);
    const app = createApp({
      password: PASSWORD,
      auth: { password: true, github: false },
    });
    const cookie = await cookieSession(app);
    const page = await getPage(
      app,
      cookie,
      `/repos/${REPO}/knowledge?view=guide`,
    );
    if (page.status !== 200) {
      throw new Error(`the document page returned ${page.status}`);
    }
    if (!/<h2[^>]*>Rules<\/h2>/.test(page.html)) {
      throw new Error("the document heading was not rendered as markdown");
    }
    if (!/<strong>helpers<\/strong>/.test(page.html)) {
      throw new Error("markdown bold was not rendered");
    }
    if (!/<code>id<\/code>/.test(page.html)) {
      throw new Error("markdown inline code was not rendered");
    }
    if (
      !/<pre><code>[\s\S]*const veryLong[\s\S]*<\/code><\/pre>/.test(page.html)
    ) {
      throw new Error("the fenced code block was not rendered as markdown");
    }
    const control = copyControl(page.html, "guide");
    if (!control) {
      throw new Error("the document has no Copy control");
    }
    if (!/aria-label="Copy"|>\s*Copy\s*</i.test(control)) {
      throw new Error("the Copy control has no accessible name");
    }
    const source = copySource(page.html, "guide");
    if (source !== RAW_GUIDE) {
      throw new Error(
        `the Copy source diverged from the raw document: ${JSON.stringify(source)}`,
      );
    }
  });
});

test("Download serves the same raw document with its filename and content type", async () => {
  await withEnv(async (dir) => {
    await seedGuides(dir);
    const app = createApp({
      password: PASSWORD,
      auth: { password: true, github: false },
    });
    const cookie = await cookieSession(app);
    const page = await getPage(
      app,
      cookie,
      `/repos/${REPO}/knowledge?view=guide`,
    );
    const href = downloadLink(page.html, "guide");
    if (!href) {
      throw new Error("the document has no Download link");
    }
    const response = await app.fetch(
      new Request(new URL(href, "http://localhost").toString(), {
        headers: { cookie },
        redirect: "manual",
      }),
    );
    if (response.status !== 200) {
      throw new Error(`the download returned ${response.status}`);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/^text\/markdown\b/i.test(type)) {
      throw new Error(`the download content type is ${JSON.stringify(type)}`);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    if (!/filename="?PR_REVIEW_GUIDE\.md"?/i.test(disposition)) {
      throw new Error(
        `the download filename is ${JSON.stringify(disposition)}`,
      );
    }
    const body = await response.text();
    if (body !== RAW_GUIDE) {
      throw new Error("the download body diverged from the document");
    }
  });
});

test("a missing document returns 404 and a path outside the repository is never read", async () => {
  await withEnv(async (dir) => {
    await seedGuides(dir);
    const secret = "OUTSIDE-REPO-SECRET";
    await writeTextFile(join(dir, "secret.txt"), secret);
    const app = createApp({
      password: PASSWORD,
      auth: { password: true, github: false },
    });
    const cookie = await cookieSession(app);

    const missing = await getPage(
      app,
      cookie,
      `/repos/${REPO}/knowledge?view=missing`,
    );
    if (missing.status !== 404) {
      throw new Error(`a missing document returned ${missing.status}`);
    }

    for (const id of ["../secret", "../../secret", "../../../../etc/passwd"]) {
      const page = await getPage(
        app,
        cookie,
        `/repos/${REPO}/knowledge?view=${encodeURIComponent(id)}`,
      );
      if (page.status !== 404) {
        throw new Error(`view=${id} returned ${page.status}`);
      }
      if (page.html.includes(secret)) {
        throw new Error(`view=${id} read a file outside the repository`);
      }
    }
  });
});
