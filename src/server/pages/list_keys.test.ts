/** Activity, Findings and Pull requests carry the keyboard shortcuts: a
 * list the keys move through, a search box `/` focuses, and the bar and
 * panel that name the keys. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertFinding } from "../../store/findings.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import { client } from "./client.ts";

const REPO = "acme/widgets";

function seed(): void {
  activateRepo(REPO, 1);
  insertJob({ id: "job-1", type: "review", repo: REPO, prNumber: 3 });
  setJobStatus("job-1", "done");
  insertReview({
    id: "r-1",
    repo: REPO,
    prNumber: 3,
    jobId: "job-1",
    headSha: "h",
    baseSha: "b",
    scope: "whole-pr",
    model: "m",
  });
  setReviewStatus("r-1", "posted", { findings_count: 1 });
  insertFinding({
    id: "f-1",
    reviewId: "r-1",
    severity: "P2",
    title: "A finding",
    bodyMd: "x",
  });
}

test("each list page has a key list, a search target, the bar and the panel", async () => {
  await withDashboard(async (get) => {
    seed();
    for (const [path, select] of [
      ["/activity", true],
      ["/findings", false],
      [`/repos/${REPO}/findings`, false],
      [`/repos/${REPO}/pulls`, false],
    ] as const) {
      const { html } = await get(path);
      assert.match(html, /<table[^>]*data-kb-list/, `${path} has no key list`);
      assert.match(html, /<input[^>]*data-kb-search/, `${path} has no search`);
      assert.ok(html.includes(`class="kbbar"`), `${path} has no bar`);
      assert.ok(
        html.includes(`id="kb-help" role="dialog"`),
        `${path} no panel`,
      );
      assert.equal(
        html.includes("<kbd>x</kbd> select"),
        select,
        `${path} names x only where rows can be selected`,
      );
      assert.match(html, /<tr[^>]*data-href="[^"]+"/, `${path} has no rows`);
    }
  });
});

test("the shortcut handler never fires inside a field or with a modifier", () => {
  const body = client.slice(client.indexOf("function startListKeys()"));
  const handler = body.slice(0, body.indexOf("function startLogPanels()"));
  assert.match(
    handler,
    /if \(ev\.ctrlKey \|\| ev\.metaKey \|\| ev\.altKey\) return;/,
  );
  assert.match(handler, /if \(typing\(ev\.target\)\) return;/);
  assert.match(handler, /INPUT\|TEXTAREA\|SELECT/);
});
