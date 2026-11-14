import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { VERSION } from "../../version.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
} from "../../testing/runtime.ts";
import { test } from "node:test";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const PASSWORD = "sidebar-pass";

type Get = (path: string) => Promise<Response>;

async function withApp(fn: (get: Get) => Promise<void>): Promise<void> {
  const keys = ["CM_APP_DB", "CM_CONFIG_PATH", "CM_REPOS_DIR"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    activateRepo("acme/widgets", 9);
    activateRepo("acme/gadgets", 9);
    insertReview({
      id: "r1",
      repo: "acme/widgets",
      prNumber: 7,
      jobId: "job-r1",
      headSha: "h",
      baseSha: "b",
      scope: "full",
      model: "m",
    });
    setReviewStatus("r1", "failed", {});
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
    await fn((path) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          headers: {
            cookie: `cm=${token}`,
            "x-requested-with": "co-maintainer",
          },
        }),
      ),
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

function side(html: string): string {
  return (
    html.match(/<aside\b[^>]*class="side"[^>]*>([\s\S]*?)<\/aside>/)?.[1] ?? ""
  );
}

function navItem(nav: string, href: string): string {
  return (
    nav.match(
      new RegExp(`<a class="item[^"]*" href="${href}">([\\s\\S]*?)</a>`),
    )?.[1] ?? ""
  );
}

test("the sidebar has a Search button with its Ctrl K hint", async () => {
  await withApp(async (get) => {
    const nav = side(await (await get("/usage")).text());
    if (
      !/<button type="button" class="search"[^>]*data-palette[^>]*>[\s\S]*?Search[\s\S]*?<kbd>Ctrl K<\/kbd><\/button>/.test(
        nav,
      )
    ) {
      throw new Error("no search button with a Ctrl K hint");
    }
    if (!nav.includes('aria-keyshortcuts="Control+K Meta+K"')) {
      throw new Error("the search button does not announce its shortcut");
    }
  });
});

test("the sidebar shows the version", async () => {
  await withApp(async (get) => {
    const nav = side(await (await get("/")).text());
    if (!nav.includes(`v${VERSION}`))
      throw new Error(`no v${VERSION} in the sidebar`);
  });
});

test("the sidebar badges show repo count, failed reviews and setup progress", async () => {
  await withApp(async (get) => {
    const nav = side(await (await get("/usage")).text());
    if (!/<span class="r tnum">2<\/span>/.test(navItem(nav, "/"))) {
      throw new Error("Repositories badge is not 2");
    }
    if (
      !/<span class="r fail-count">1 failed<\/span>/.test(
        navItem(nav, "/activity"),
      )
    ) {
      throw new Error("Activity badge is not 1 failed");
    }
    if (!/<span class="r tnum">1\/4<\/span>/.test(navItem(nav, "/setup"))) {
      throw new Error("Setup badge is not 1/4");
    }
  });
});

test("every page carries the palette dialog, hidden until opened", async () => {
  await withApp(async (get) => {
    for (const path of ["/", "/usage", "/setup"]) {
      const html = await (await get(path)).text();
      if (
        !/<div class="pal" id="pal" role="dialog" aria-modal="true" aria-label="Search" hidden>/.test(
          html,
        )
      ) {
        throw new Error(`${path} has no hidden palette dialog`);
      }
      if (
        !/<input id="pal-q"[^>]*role="combobox"[^>]*aria-controls="pal-list"/.test(
          html,
        )
      ) {
        throw new Error(`${path} palette input is not a combobox`);
      }
    }
  });
});

test("GET /api/search returns grouped real results and needs a session", async () => {
  await withApp(async (get) => {
    const response = await get("/api/search?q=widg");
    const body = (await response.json()) as {
      groups: { label: string; items: { label: string; href: string }[] }[];
    };
    const repos =
      body.groups.find((g) => g.label === "Repositories")?.items ?? [];
    if (repos.map((r) => r.href).join(",") !== "/repos/acme/widgets") {
      throw new Error(JSON.stringify(body));
    }
  });
  const app = createApp({ password: PASSWORD });
  const anonymous = await app.fetch(
    new Request("http://localhost/api/search?q=a"),
  );
  if (anonymous.status !== 401)
    throw new Error(`anonymous got ${anonymous.status}`);
});
