/** The settings search finds every setting on its page, and settings pages
 * show their save state. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { SETTINGS_INDEX } from "./settings_index.ts";
import { activateRepo } from "../../store/repos.ts";

test("every entry of the settings search jumps to a field that exists", async () => {
  await withDashboard(async (get) => {
    const pages = new Map<string, string>();
    for (const entry of SETTINGS_INDEX) {
      const [path, id] = entry.href.split("#") as [string, string];
      if (!pages.has(path)) pages.set(path, (await get(path)).html);
      const main = pages.get(path)!.split("<main>")[1] ?? "";
      assert.ok(
        main.includes(`id="${id}"`),
        `${entry.name} jumps to #${id}, which ${path} does not have`,
      );
    }
  });
});

test("the search box sits above the Settings menu with its list", async () => {
  await withDashboard(async (get) => {
    const { html } = await get("/");
    const settings = html.indexOf("<p>Settings</p>");
    const search = html.indexOf(
      '<input class="inp" type="search" data-settings-search',
    );
    const first = html.indexOf(`class="item" href="/settings/ai"`);
    assert.ok(
      settings < search && search < first,
      "the box is not above the menu",
    );
    const json = html.match(
      /<script type="application\/json" id="settings-index">([^<]*)<\/script>/,
    );
    assert.ok(json, "no settings list on the page");
    assert.equal(JSON.parse(json[1]!).length, SETTINGS_INDEX.length);
  });
});

test("settings pages and repository settings show the save state", async () => {
  await withDashboard(async (get) => {
    activateRepo("acme/widgets", 1);
    for (const path of [
      "/settings/ai",
      "/settings/server",
      "/repos/acme/widgets/settings",
    ]) {
      const { html } = await get(path);
      assert.ok(
        html.includes(
          `data-save-state data-state="saved" role="status" aria-live="polite">All changes saved</span>`,
        ),
        `${path} has no save state`,
      );
    }
  });
});
