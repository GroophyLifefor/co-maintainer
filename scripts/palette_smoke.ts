/** Browser smoke for the Ctrl K search palette.
 *
 * Starts `serve` in a sandbox (never the machine's real config or databases),
 * seeds a few real records and drives the palette with Playwright: Ctrl K and
 * Cmd K open it with focus in the input, Esc and an outside click close it and
 * give focus back, arrow keys move the selection and Enter opens exactly the
 * selected result, a slow stale answer never replaces a newer one, and a long
 * repository name does not overflow the list.
 */
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { closeAppDb, openAppDb } from "../src/store/app_db.ts";
import { writeUserConfig } from "../src/config.ts";
import { activateRepo, markKnowledgeBuilt } from "../src/store/repos.ts";
import { insertReview } from "../src/store/reviews.ts";
import {
  commandSpawn,
  makeTempDir,
  remove,
  setEnv,
} from "../src/util/runtime.ts";
import { runtimeExecPath, runtimeRunArgs } from "../src/testing/runtime.ts";

const PASSWORD = "palette-smoke-pass";
const LONG = `acme/${"very-long-repository-name-".repeat(4)}end`;

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

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { redirect: "manual" })).status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`serve did not come up at ${url}`);
}

const sandbox = await makeTempDir({ prefix: "cm-palette-smoke-" });
const env: Record<string, string | undefined> = {
  ...process.env,
  CM_CONFIG_PATH: join(sandbox, "config.json"),
  CM_REPOS_DIR: join(sandbox, "repos"),
  CM_APP_DB: join(sandbox, "app.db"),
  CM_CLONES_DIR: join(sandbox, "clones"),
  XDG_CONFIG_HOME: join(sandbox, "config"),
  XDG_CACHE_HOME: join(sandbox, "cache"),
  XDG_DATA_HOME: join(sandbox, "data"),
};
for (const [name, value] of Object.entries(env)) {
  if (value !== undefined) setEnv(name, value);
}

const problems: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) problems.push(message);
};

let serve: ReturnType<typeof commandSpawn> | undefined;
try {
  await writeUserConfig({ auth: "gh", ai: "none" });
  await openAppDb();
  try {
    for (const name of ["acme/widgets", "acme/gadgets", LONG]) {
      activateRepo(name, 9);
      markKnowledgeBuilt(name, "abc");
    }
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
    ]),
    cwd: join(import.meta.dirname, ".."),
    env,
    stdout: "piped",
    stderr: "piped",
  });
  await waitForServer(`${base}/login`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL(`${base}/`),
      page.click('button[type="submit"]'),
    ]);
    await page.goto(`${base}/usage`);

    const open = () => page.locator("#pal").isVisible();
    const focusedId = () =>
      page.evaluate(() => document.activeElement?.id ?? "");
    const selected = () =>
      page.evaluate(() => {
        const item = document.querySelector('#pal-list [aria-selected="true"]');
        return item ? item.getAttribute("data-href") : null;
      });
    const settle = async (page: Page) => {
      await page.waitForFunction(
        () => !document.querySelector("#pal")?.hasAttribute("data-loading"),
      );
    };

    // Ctrl K opens with focus in the input; Esc closes and restores focus.
    await page.locator("#theme").focus();
    await page.keyboard.press("Control+k");
    check(await open(), "Ctrl K did not open the palette");
    check(
      (await focusedId()) === "pal-q",
      "Ctrl K did not focus the palette input",
    );
    await page.keyboard.press("Escape");
    check(!(await open()), "Esc did not close the palette");
    check((await focusedId()) === "theme", "Esc did not give focus back");

    // Cmd K opens too; an outside click closes.
    await page.keyboard.press("Meta+k");
    check(await open(), "Cmd K did not open the palette");
    await page.mouse.click(5, 5);
    check(!(await open()), "an outside click did not close the palette");

    // The sidebar button opens it as well.
    await page.click("[data-palette]");
    check(await open(), "the Search button did not open the palette");

    // Empty query shows pages and repositories.
    await settle(page);
    // textContent, not innerText: the group labels are uppercased by CSS.
    const emptyText = (await page.locator("#pal-list").textContent()) ?? "";
    check(
      emptyText.includes("Pages") && emptyText.includes("acme/widgets"),
      "the empty query shows no pages or repositories",
    );

    // No match says so and offers nothing to open.
    await page.fill("#pal-q", "zzz-nothing");
    await settle(page);
    check(
      (await page.locator("#pal-list [data-href]").count()) === 0,
      "a query with no match still lists results",
    );
    check(
      (await page.locator("#pal-list").innerText()).includes("No results"),
      "a query with no match does not say so",
    );

    // A slow answer for an older query never replaces a newer one.
    await page.route("**/api/search?q=a", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    // Wait past the input debounce so the old query really goes out first.
    const slowSent = page.waitForRequest("**/api/search?q=a");
    await page.fill("#pal-q", "a");
    await slowSent;
    await page.fill("#pal-q", "gadg");
    await settle(page);
    await page.waitForTimeout(1200);
    const afterStale = await page.locator("#pal-list").innerText();
    check(
      afterStale.includes("acme/gadgets") &&
        !afterStale.includes("acme/widgets"),
      `a stale answer replaced the newer one: ${afterStale}`,
    );
    await page.unroute("**/api/search?q=a");

    // A long name stays inside the list.
    await page.fill("#pal-q", "very-long");
    await settle(page);
    const overflow = await page.evaluate(() => {
      const list = document.getElementById("pal-list");
      return list ? list.scrollWidth - list.clientWidth : 999;
    });
    check(
      overflow <= 0,
      `a long repository name overflows the palette by ${overflow}px`,
    );

    // Arrow keys move the selection; Enter opens the selected result.
    await page.fill("#pal-q", "widg");
    await settle(page);
    const first = await selected();
    await page.keyboard.press("ArrowDown");
    const second = await selected();
    check(
      first !== null && second !== null && first !== second,
      "ArrowDown did not move the selection",
    );
    await page.keyboard.press("ArrowUp");
    check((await selected()) === first, "ArrowUp did not move back");
    await page.keyboard.press("ArrowDown");
    const target = await selected();
    await Promise.all([
      page.waitForURL(`${base}${target}`),
      page.keyboard.press("Enter"),
    ]);
    check(
      new URL(page.url()).pathname === target,
      `Enter opened ${page.url()}, not ${target}`,
    );
  } finally {
    await browser.close();
  }
} finally {
  serve?.kill("SIGTERM");
  await serve?.output().catch(() => undefined);
  await remove(sandbox, { recursive: true }).catch(() => {});
}

if (problems.length > 0) {
  console.error(`palette smoke failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("palette smoke ok");
