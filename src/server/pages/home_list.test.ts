import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import {
  activateRepo,
  markKnowledgeBuilt,
  registerCliRepo,
  updateRepoSettings,
} from "../../store/repos.ts";
import { insertJob } from "../../store/jobs.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";

const PASSWORD = "home-list-pass";

async function withSeed(
  fn: (get: (path: string) => Promise<string>) => Promise<void>,
) {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH", "CM_REPOS_DIR"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  try {
    await openAppDb();
    await writeUserConfig({
      auth: "gh",
      ai: "none",
      githubAppId: "4900449",
      githubAppPrivateKey: "PEM",
    });
    activateRepo("acme/widgets", 9);
    markKnowledgeBuilt("acme/widgets", "abc");
    activateRepo("acme/gadgets", 9);
    markKnowledgeBuilt("acme/gadgets", "abc");
    updateRepoSettings("acme/gadgets", { auto_review: 0 });
    activateRepo("other/tools", 9);
    insertJob({ id: "job-init", type: "init", repo: "other/tools" });
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
    await fn(async (path) =>
      (
        await app.fetch(
          new Request(`http://localhost${path}`, {
            headers: { cookie: `cm=${token}` },
          }),
        )
      ).text(),
    );
  } finally {
    await closeAppDb();
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
    await removePath(dir, { recursive: true }).catch(() => {});
  }
}

/** The table rows, one string per repository. */
function rows(html: string): string[] {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  return body.split("<tr").slice(1);
}

function rowFor(html: string, name: string): string {
  const row = rows(html).find((r) => r.includes(`>${name}<`));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

test("each repository row has a status badge and an Open button", async () => {
  await withSeed(async (get) => {
    const html = await get("/");
    const cases: [string, string][] = [
      ["acme/widgets", "Reviewing"],
      ["acme/gadgets", "Paused"],
      ["other/tools", "Setting up"],
    ];
    for (const [name, label] of cases) {
      const row = rowFor(html, name);
      if (
        !new RegExp(
          `class="badge[^"]*"[^>]*>(<svg[\\s\\S]*?</svg>)?${label}<`,
        ).test(row)
      ) {
        throw new Error(`${name} has no ${label} badge`);
      }
      if (!new RegExp(`href="/repos/${name}"[^>]*>Open`).test(row)) {
        throw new Error(`${name} has no Open button`);
      }
    }
  });
});

test("the auto review toggle column is gone from the list", async () => {
  await withSeed(async (get) => {
    const html = await get("/");
    if (html.includes("<th>Auto review</th>") || html.includes('class="tg')) {
      throw new Error("the home page still has the auto review toggle");
    }
    if (!html.includes("Reviews (30d)")) {
      throw new Error("the reviews column does not name its window");
    }
  });
});

test("the list has a search field and All / Reviewing / Paused tabs", async () => {
  await withSeed(async (get) => {
    const html = await get("/");
    if (
      !/<form[^>]*method="get"[^>]*>[\s\S]*?<input[^>]*name="q"/i.test(html)
    ) {
      throw new Error("no search form");
    }
    for (const [label, href] of [
      ["All", "/"],
      ["Reviewing", "/?status=reviewing"],
      ["Paused", "/?status=paused"],
    ]) {
      if (
        !new RegExp(
          `<a[^>]*href="${href.replace("?", "\\?")}"[^>]*>(<svg[\\s\\S]*?</svg>)?${label}<`,
        ).test(html)
      ) {
        throw new Error(`no ${label} tab linking to ${href}`);
      }
    }
    if (!/<a class="on"[^>]*aria-current="page"[^>]*href="\/"/.test(html)) {
      throw new Error("All is not the current tab by default");
    }
  });
});

test("the status tabs and the search really filter the rows", async () => {
  await withSeed(async (get) => {
    const names = (html: string) =>
      rows(html)
        .map((r) => r.match(/>([a-z]+\/[a-z]+)</)?.[1])
        .join(",");
    const cases: [string, string][] = [
      ["/", "acme/gadgets,acme/widgets,other/tools"],
      ["/?status=reviewing", "acme/widgets"],
      ["/?status=paused", "acme/gadgets,other/tools"],
      ["/?q=gad", "acme/gadgets"],
      ["/?q=acme&status=reviewing", "acme/widgets"],
    ];
    for (const [path, want] of cases) {
      const got = names(await get(path));
      if (got !== want) throw new Error(`${path}: ${got}`);
    }
    const searched = await get("/?q=acme&status=reviewing");
    if (!searched.includes('value="acme"')) {
      throw new Error("the search box lost the query");
    }
    if (!searched.includes('href="/?status=paused&amp;q=acme"')) {
      throw new Error("the tabs drop the search");
    }
  });
});

test("a repo built from the CLI says so in the list", async () => {
  await withSeed(async (get) => {
    registerCliRepo("acme/fromcli", "2026-11-01T00:00:00.000Z");
    const html = await get("/");
    if (
      !rowFor(html, "acme/fromcli").includes(
        '<span class="sub">Added from CLI</span>',
      )
    ) {
      throw new Error("the CLI repo is not labelled Added from CLI");
    }
    if (rowFor(html, "acme/widgets").includes("Added from CLI")) {
      throw new Error("a dashboard repo is labelled Added from CLI");
    }
  });
});

test("Add repository carries the plus mark", async () => {
  await withSeed(async (get) => {
    const html = await get("/");
    if (
      !/<a class="btn primary" href="\/repos\/new"><svg[^>]*><use href="#i-plus"><\/use><\/svg>Add repository<\/a>/.test(
        html,
      )
    ) {
      throw new Error("Add repository has no plus icon");
    }
  });
});

test("an empty filter result says so instead of showing No repositories", async () => {
  await withSeed(async (get) => {
    const html = await get("/?q=nothing-matches");
    if (rows(html).length !== 0) throw new Error("rows shown for no match");
    if (!html.includes("No repositories match")) {
      throw new Error("no empty-filter message");
    }
  });
});
