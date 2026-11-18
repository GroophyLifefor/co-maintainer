/** The menu badge, the home list, the repository overview and the failed
 * Activity list they open all say the same number of open failures. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import { dismissFailures } from "../../store/failures.ts";
import { getAppDb } from "../../store/app_db.ts";
import { openFailuresHref } from "../../services/open_failures.ts";

const REPO = "acme/widgets";
const OTHER = "acme/gadgets";

function failedJob(id: string, repo: string, pr: number, type = "review") {
  insertJob({ id, type, repo, prNumber: pr });
  setJobStatus(id, "failed", { error: "boom" });
}

function seed(): void {
  activateRepo(REPO, 1);
  activateRepo(OTHER, 1);
  // A failed review with its review row counts once.
  failedJob("job-a", REPO, 1);
  insertReview({
    id: "r-a",
    repo: REPO,
    prNumber: 1,
    jobId: "job-a",
    headSha: "h",
    baseSha: "b",
    scope: "whole-pr",
    model: "m",
  });
  setReviewStatus("r-a", "failed");
  // A failed review job that wrote no review row, and a failed sync.
  failedJob("job-b", REPO, 2);
  failedJob("job-c", REPO, 0, "remake");
  // Dismissed, so not open.
  failedJob("job-d", REPO, 3);
  dismissFailures({ jobs: ["job-d"] });
  // Older than the window, so not counted.
  failedJob("job-e", REPO, 4);
  getAppDb()
    .prepare(`UPDATE jobs SET created_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), "job-e");
  // Another repository.
  failedJob("job-f", OTHER, 5);
}

/** The total the Activity list prints for a filter: "1-3 of 3". */
function listTotal(html: string): number {
  const match = html.match(/(?:\d+-\d+|0) of (\d+)/);
  assert.ok(match, "the list prints no total");
  return Number(match[1]);
}

test("the badge, the home list, the overview and the failed list agree", async () => {
  await withDashboard(async (get) => {
    seed();
    const home = (await get("/")).html;
    const badge = home.match(
      /<a class="r fail-count" href="([^"]+)"[^>]*>(\d+) open failures?<\/a>/,
    );
    assert.ok(badge, "no open failures badge");
    assert.equal(Number(badge[2]), 4, "the badge count");
    const all = await get(badge[1]!.replaceAll("&amp;", "&"));
    assert.equal(listTotal(all.html), 4, "the list the badge opens");

    const href = openFailuresHref(REPO).replaceAll("&", "&amp;");
    const row = home.match(
      new RegExp(
        `<a class="sub fail-link" href="${href.replace(/[?]/g, "\\?")}">(\\d+) open failures?</a>`,
      ),
    );
    assert.ok(row, "the home list does not link its open failures");
    assert.equal(Number(row[1]), 3, "the home list count");

    const overview = (await get(`/repos/${REPO}`)).html;
    assert.ok(
      overview.includes(`<a href="${href}">3 open failures</a>`),
      "the overview count or link differs",
    );
    const repoList = await get(openFailuresHref(REPO));
    assert.equal(listTotal(repoList.html), 3, "the list the home row opens");
  });
});
