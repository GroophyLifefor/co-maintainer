/** The Activity list: one row per review, plain words, filters in the URL. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import { rememberPullTitle } from "../../store/pull_titles.ts";
import { KNOWN_COST } from "../../testing/fixtures/cost.ts";
import { skipGroups } from "./activity_list.ts";
import { recordDelivery } from "../../store/deliveries.ts";
import { getAppDb } from "../../store/app_db.ts";
import type { DeliveryRow } from "../../store/rows.ts";

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

function delivery(
  id: string,
  at: string,
  patch: Partial<DeliveryRow> = {},
): DeliveryRow {
  return {
    delivery_id: id,
    event: "pull_request",
    action: "opened",
    repo: REPO,
    pr_number: 8,
    received_at: at,
    outcome: "skipped",
    reason: "draft",
    ...patch,
  };
}

test("the same skip within one minute is one row with a count", () => {
  const { groups } = skipGroups([
    delivery("a", "2026-01-01T10:00:50.000Z"),
    delivery("b", "2026-01-01T10:00:10.000Z"),
    delivery("c", "2026-01-01T09:59:59.000Z"),
    delivery("d", "2026-01-01T09:59:58.000Z", { pr_number: 9 }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.row.delivery_id, group.count]),
    [
      ["a", 2],
      ["c", 1],
      ["d", 1],
    ],
  );
});

test("own comments are hidden until asked for, and ignored events without a reason are left out", () => {
  const rows = [
    delivery("own", "2026-01-01T10:00:00.000Z", { reason: "own-comment" }),
    delivery("noise", "2026-01-01T09:00:00.000Z", {
      outcome: "ignored",
      reason: null,
    }),
    delivery("draft", "2026-01-01T08:00:00.000Z"),
  ];
  const hidden = skipGroups(rows);
  assert.equal(hidden.ownHidden, 1);
  assert.deepEqual(
    hidden.groups.map((group) => group.row.delivery_id),
    ["draft"],
  );
  const shown = skipGroups(rows, { own: true });
  assert.deepEqual(
    shown.groups.map((group) => group.row.delivery_id),
    ["own", "draft"],
  );
});

test("the skipped list has headings, says why a row has no repository and toggles own comments", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    recordDelivery({
      deliveryId: "d-own",
      event: "issue_comment",
      repo: REPO,
      prNumber: 8,
      outcome: "skipped",
      reason: "own-comment",
    });
    recordDelivery({
      deliveryId: "d-install",
      event: "installation",
      action: "created",
      outcome: "ignored",
      reason: "installation-created",
    });
    for (const id of ["d-1", "d-2", "d-3"]) {
      recordDelivery({
        deliveryId: id,
        event: "pull_request",
        repo: REPO,
        prNumber: 9,
        outcome: "skipped",
        reason: "nothing-new-since-last-round",
      });
    }
    // The three repeats share one minute however fast the test runs.
    getAppDb()
      .prepare(
        `UPDATE deliveries SET received_at = '2026-01-01T10:00:00.000Z' WHERE delivery_id LIKE 'd-_'`,
      )
      .run();
    const { html } = await get("/activity");
    const card = html.slice(html.indexOf("Pull requests we skipped"));
    assert.ok(card.includes("<th>Reason</th>"), "no column headings");
    assert.ok(card.includes("No repository: about the whole installation"));
    assert.ok(card.includes("The GitHub App was installed"));
    assert.ok(card.includes("Skipped: nothing new since the last review"));
    assert.ok(card.includes("3 times"), "the repeats were not merged");
    assert.ok(!card.includes("own comment</td>"));
    assert.ok(!card.includes("Skipped: the bot's own comment"));
    assert.ok(card.includes("Show own comments (1)"));
    const own = await get("/activity?own=1");
    const ownCard = own.html.slice(
      own.html.indexOf("Pull requests we skipped"),
    );
    assert.ok(
      ownCard.includes("Skipped: the bot&#39;s own comment") ||
        ownCard.includes("Skipped: the bot's own comment"),
    );
    assert.ok(ownCard.includes("Hide own comments"));
  });
});
