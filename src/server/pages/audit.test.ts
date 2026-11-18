/** The audit log records who did what from the places that change things,
 * never shows a secret, and filters by kind and person. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { listAudit } from "../../store/audit.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import { settingChanges } from "../../services/audit.ts";

test("settings, tokens, repositories, dismissals and sign-ins are written to the log", async () => {
  await withDashboard(async (get, send) => {
    activateRepo("acme/widgets", 1);
    let result = await send("PUT", "/api/settings", {
      ai: "openrouter",
      highModel: "model-b",
      token: "sk-secret-value-1234",
    });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    result = await send("POST", "/api/remote-tokens", { name: "laptop" });
    assert.equal(result.status, 201);
    result = await send("PATCH", "/api/repos/acme/widgets", {
      remakeCron: "0 3 * * 1",
    });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    insertJob({
      id: "job-bad",
      type: "review",
      repo: "acme/widgets",
      prNumber: 7,
    });
    setJobStatus("job-bad", "failed", { error: "boom" });
    result = await send("POST", "/api/activity/dismiss", {
      keys: ["job:job-bad"],
    });
    assert.equal(result.status, 200);
    result = await send("DELETE", "/api/repos/acme/widgets");
    assert.equal(result.status, 200);

    const { items } = listAudit({}, 50, 0);
    const kinds = items.map((row) => `${row.kind}:${row.summary}`);
    for (const expected of [
      "sign-in:Signed in with the password",
      "settings:Changed settings",
      "token:Created a remote review token",
      "repo-settings:Changed repository settings",
      "dismiss:Dismissed a failure",
      "repo:Removed a repository",
    ]) {
      assert.ok(
        kinds.includes(expected),
        `missing ${expected} in ${kinds.join(", ")}`,
      );
    }
    assert.ok(items.every((row) => row.actor === "admin"));
    const settings = items.find((row) => row.kind === "settings")!;
    assert.deepEqual(
      settings.changes.find((change) => change.setting === "highModel"),
      { setting: "highModel", from: "not set", to: "model-b" },
    );
    assert.deepEqual(
      settings.changes.find((change) => change.setting === "token"),
      { setting: "token", from: "not set", to: "changed, hidden" },
    );

    const page = (await get("/settings/audit")).html;
    assert.ok(
      !page.includes("sk-secret-value-1234"),
      "a secret reached the page",
    );
    assert.ok(page.includes("Created a remote review token"));
    assert.ok(page.includes("laptop"));
    const filtered = (await get("/settings/audit?kind=token")).html;
    const rows = filtered.slice(filtered.indexOf("<tbody>"));
    assert.ok(rows.includes("Created a remote review token"));
    assert.ok(
      !rows.includes("Changed settings"),
      "the kind filter kept another kind",
    );
    const nobody = (await get("/settings/audit?actor=someone-else")).html;
    assert.ok(nobody.includes("Nothing fits this filter"));
  });
});

test("a secret never shows its value, old or new", () => {
  const changes = settingChanges(
    { token: "sk-old", githubWebhookSecret: "a", maxConcurrentJobs: 2 },
    { token: "sk-new", maxConcurrentJobs: 4 },
  );
  assert.deepEqual(changes, [
    { setting: "githubWebhookSecret", from: "hidden", to: "removed" },
    { setting: "maxConcurrentJobs", from: "2", to: "4" },
    { setting: "token", from: "hidden", to: "changed, hidden" },
  ]);
});
