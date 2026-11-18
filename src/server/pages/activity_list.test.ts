/** The Activity list: one row per review, plain words, filters in the URL. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import { rememberPullTitle } from "../../store/pull_titles.ts";
import { KNOWN_COST } from "../../testing/fixtures/cost.ts";

const REPO = "acme/widgets";

function recent(html: string): string {
  const start = html.indexOf("<h2>Recent</h2>");
  const end = html.indexOf("</table>", start);
  return html.slice(start, end < 0 ? undefined : end);
}

function rows(html: string): string[] {
  return recent(html).match(/<tr data-href="[^"]*"/g) ?? [];
}

function review(jobId: string, pr: number, status: string, findings = 0): void {
  insertJob({ id: jobId, type: "review", repo: REPO, prNumber: pr });
  insertReview({
    id: `r-${jobId}`,
    repo: REPO,
    prNumber: pr,
    jobId,
    headSha: jobId,
    baseSha: "b",
    scope: "whole-pr",
    model: "m",
    round: 2,
  });
  setReviewStatus(`r-${jobId}`, status, {
    findings_count: findings,
    ...KNOWN_COST(0.0096),
  });
  setJobStatus(jobId, status === "failed" ? "failed" : "done", {
    error: status === "failed" ? "Error: the provider timed out" : undefined,
  });
}

test("a review is one row with its PR, result, cost, time and status", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    rememberPullTitle(REPO, 136, "Rename format to formatDuration");
    review("job-136", 136, "posted", 2);
    insertJob({ id: "job-sync", type: "remake", repo: REPO });
    setJobStatus("job-sync", "done");
    const { html } = await get("/activity");
    const found = rows(html);
    assert.equal(found.length, 2, `expected 2 rows, got ${found.join(", ")}`);
    const list = recent(html);
    assert.ok(
      list.includes(`href="/activity/job-136"`),
      "the row opens its log",
    );
    assert.ok(
      list.includes(
        `<a class="st ok" href="/repos/${REPO}/pulls/136#round-2">2 findings</a>`,
      ),
    );
    assert.ok(list.includes("Rename format to formatDuration"));
    assert.ok(list.includes("$0.0096"), "the cost is on the review row");
    assert.ok(!list.includes("Review #136"), "the job is not a second row");
    assert.ok(list.includes("Synced knowledge"));
  });
});

test("a review row whose job row is gone still shows once", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    insertReview({
      id: "orphan",
      repo: REPO,
      prNumber: 9,
      jobId: "job-gone",
      headSha: "h",
      baseSha: "b",
      scope: "whole-pr",
      model: "m",
    });
    setReviewStatus("orphan", "posted", { findings_count: 1 });
    const { html } = await get("/activity");
    assert.equal(rows(html).length, 1);
    assert.ok(recent(html).includes(`/repos/${REPO}/pulls/9#round-1`));
  });
});

test("a failed review row shows its reason in words", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    review("job-bad", 7, "failed");
    const { html } = await get("/activity");
    const list = recent(html);
    assert.ok(/timed out/.test(list), "the reason is missing");
    assert.ok(
      list.includes(`<a class="st err" href="/activity/job-bad">Failed</a>`),
    );
  });
});

test("a skip job says what it skipped", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    insertJob({
      id: "job-skip",
      type: "skip",
      repo: REPO,
      prNumber: 4,
      args: { command: "pr-off", by: null },
    });
    setJobStatus("job-skip", "done");
    const { html } = await get("/activity");
    const list = recent(html);
    assert.ok(list.includes("Skipped a review"));
    assert.ok(list.includes("Skipped: reviews are off for this pull request"));
    assert.ok(!/>skip</.test(list), "the raw job type shows");
  });
});

test("filters in the URL narrow the list by status, kind, repository, PR, day and words", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    activateRepo("acme/gadgets", 1);
    rememberPullTitle(REPO, 136, "Rename format to formatDuration");
    review("job-136", 136, "posted", 1);
    review("job-bad", 137, "failed");
    insertJob({ id: "job-sync", type: "remake", repo: "acme/gadgets" });
    setJobStatus("job-sync", "canceled", { cancel_reason: "superseded" });
    const keys = async (path: string) =>
      rows((await get(path)).html).map((row) => row.slice(15, -1));
    assert.deepEqual(await keys("/activity?status=failed"), [
      "/activity/job-bad",
    ]);
    assert.deepEqual(await keys("/activity?status=canceled"), [
      "/activity/job-sync",
    ]);
    assert.deepEqual(await keys("/activity?kind=setup"), [
      "/activity/job-sync",
    ]);
    assert.equal((await keys("/activity?kind=review")).length, 2);
    assert.deepEqual(await keys("/activity?pr=136"), ["/activity/job-136"]);
    assert.deepEqual(await keys("/activity?q=formatDuration"), [
      "/activity/job-136",
    ]);
    assert.deepEqual(await keys("/activity?q=timed%20out"), [
      "/activity/job-bad",
    ]);
    assert.deepEqual(await keys("/activity?q=%23137"), ["/activity/job-bad"]);
    assert.deepEqual(await keys("/activity?repo=acme%2Fgadgets"), [
      "/activity/job-sync",
    ]);
    assert.equal(
      (await keys("/activity?from=2000-01-01&to=2999-01-01")).length,
      3,
    );
    assert.equal((await keys("/activity?to=2000-01-01")).length, 0);
    // A value that does not fit is dropped, not an error.
    const odd = await get("/activity?status=nope&kind=nope&from=yesterday");
    assert.equal(odd.status, 200);
    assert.equal(rows(odd.html).length, 3);
  });
});

test("the chips keep the other filters and each active value can be taken off", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    review("job-136", 136, "posted", 1);
    const { html } = await get(
      `/activity?repo=${encodeURIComponent(REPO)}&q=x&status=done`,
    );
    assert.ok(
      html.includes(
        `href="/activity?status=failed&amp;repo=acme%2Fwidgets&amp;q=x"`,
      ),
      "the Failed chip dropped the other filters",
    );
    assert.ok(
      html.includes(
        `href="/activity?status=done&amp;repo=acme%2Fwidgets" aria-label="Remove Search: x"`,
      ),
      "the search chip cannot be taken off",
    );
    assert.ok(html.includes(">Show all</a>"));
    assert.ok(html.includes(`name="q" value="x"`));
  });
});
