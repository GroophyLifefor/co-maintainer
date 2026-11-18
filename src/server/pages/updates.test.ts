/** The newer version notice in the sidebar and Settings, and the Update
 * button, only when the host set CM_UPDATE_URL. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { appDbPath } from "../../store/app_db.ts";
import { listAudit } from "../../store/audit.ts";
import { parseStable } from "../../services/update_check.ts";
import { VERSION } from "../../version.ts";
import {
  deleteEnv,
  getEnv,
  setEnv,
  writeTextFileSync,
} from "../../testing/runtime.ts";

const [major, minor, patch] = parseStable(VERSION.split("-")[0]!)!;
const NEWER = `${major}.${minor}.${patch! + 1}`;

async function withUpdateUrl(
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const original = getEnv("CM_UPDATE_URL");
  if (value) setEnv("CM_UPDATE_URL", value);
  else deleteEnv("CM_UPDATE_URL");
  try {
    await fn();
  } finally {
    if (original === undefined) deleteEnv("CM_UPDATE_URL");
    else setEnv("CM_UPDATE_URL", original);
  }
}

test("without CM_UPDATE_URL Settings shows the docker lines and no notice", async () => {
  await withUpdateUrl(undefined, async () => {
    await withDashboard(async (get) => {
      const html = (await get("/settings/server")).html;
      assert.ok(html.includes(`id="updates"`));
      assert.ok(
        html.includes(
          "docker pull ghcr.io/groophylifefor/co-maintainer:latest",
        ),
      );
      assert.ok(!html.includes(`id="start-update"`));
      assert.ok(!html.includes(`class="update-note"`));
    });
  });
});

test("with CM_UPDATE_URL a newer release shows in the sidebar and Settings with an Update button", async () => {
  // A port nothing listens on, so a real POST fails fast and never leaves
  // the machine.
  await withUpdateUrl("http://127.0.0.1:9/update", async () => {
    await withDashboard(async (get, send) => {
      writeTextFileSync(
        `${dirname(appDbPath())}/update-check.json`,
        JSON.stringify({
          check: {
            checkedAt: new Date().toISOString(),
            latest: NEWER,
            notesUrl: "https://example.com/notes",
          },
        }),
      );
      const line = `co-maintainer ${NEWER} is out. This instance runs ${VERSION}.`;
      const home = (await get("/")).html;
      assert.ok(
        home.includes(
          `<div class="update-note" role="status"><a href="/settings/server#updates">${line}</a>`,
        ),
      );
      assert.ok(home.includes(`href="https://example.com/notes"`));
      const settings = (await get("/settings/server")).html;
      assert.ok(settings.includes(`id="start-update" data-version="${NEWER}"`));
      assert.ok(!settings.includes("docker pull"));

      const older = await send("POST", "/api/update", { version: "0.0.1" });
      assert.equal(older.status, 422);
      const started = await send("POST", "/api/update", { version: NEWER });
      assert.equal(started.status, 200);
      // The fake host does not answer, so the state says so.
      assert.equal(started.json.status, "failed");
      assert.ok(
        listAudit({ kind: "update" }, 10, 0).items.some(
          (row) => row.summary === `Started an update to ${NEWER}`,
        ),
      );
    });
  });
});
