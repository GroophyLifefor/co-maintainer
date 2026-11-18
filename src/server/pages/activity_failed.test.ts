/** Failed rows on Activity: the reason, Retry, Dismiss, Dismiss all, and
 * failures that a later review resolved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { getJob, insertJob, listJobs, setJobStatus } from "../../store/jobs.ts";

const REPO = "acme/widgets";

function failedReview(jobId: string, pr: number, repo = REPO): void {
  insertJob({ id: jobId, type: "review", repo, prNumber: pr });
  insertReview({
    id: `r-${jobId}`,
    repo,
    prNumber: pr,
    jobId,
    headSha: jobId,
    baseSha: "b",
    scope: "whole-pr",
    model: "vendor/model-a",
  });
  setReviewStatus(`r-${jobId}`, "failed");
  setJobStatus(jobId, "failed", { error: "Error: the request timed out" });
}

function recent(html: string): string {
  const start = html.indexOf("<h2>Recent</h2>");
  return html.slice(start, html.indexOf("</table>", start));
}

test("a failed row shows its reason, a Retry with the same model and a Dismiss", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    failedReview("job-bad", 7);
    const list = recent((await get("/activity?status=failed")).html);
    assert.ok(/timed out/.test(list), "no reason");
    assert.ok(
      list.includes(
        `data-post="/api/repos/${REPO}/pulls/7/review" data-body="{&quot;model&quot;:&quot;vendor/model-a&quot;}" data-next="here">Retry</button>`,
      ),
      "no Retry with the same model",
    );
    assert.ok(
      list.includes(
        `data-post="/api/activity/dismiss" data-body="{&quot;keys&quot;:[&quot;job:job-bad&quot;]}" data-next="here">Dismiss</button>`,
      ),
      "no Dismiss",
    );
  });
});

test("Dismiss keeps the failure in the history and takes it off the failed list", async () => {
  await withDashboard(async (get, send) => {
    activateRepo(REPO, 1);
    failedReview("job-bad", 7);
    failedReview("job-worse", 8);
    const dismissed = await send("POST", "/api/activity/dismiss", {
      keys: ["job:job-bad"],
    });
    assert.equal(dismissed.status, 200);
    assert.equal(getJob("job-bad")?.status, "failed");
    const failed = (await get("/activity?status=failed")).html;
    assert.ok(!recent(failed).includes("job-bad"), "a dismissed one is listed");
    assert.ok(recent(failed).includes("job-worse"));
    assert.ok(failed.includes("Show dismissed and resolved (1)"));
    const settled = recent(
      (await get("/activity?status=failed&settled=1")).html,
    );
    assert.ok(settled.includes("job-bad") && settled.includes("Dismissed"));
    const all = recent((await get("/activity")).html);
    assert.ok(all.includes("job-bad"), "a dismissed failure left the history");
  });
});

test("Dismiss all clears the failed list of one repository", async () => {
  await withDashboard(async (get, send) => {
    activateRepo(REPO, 1);
    activateRepo("acme/gadgets", 1);
    failedReview("job-bad", 7);
    failedReview("job-other", 1, "acme/gadgets");
    const page = (
      await get(`/activity?status=failed&repo=${encodeURIComponent(REPO)}`)
    ).html;
    assert.ok(page.includes(">Dismiss all</button>"));
    await send("POST", "/api/activity/dismiss", { all: true, repo: REPO });
    const left = recent((await get("/activity?status=failed")).html);
    assert.ok(!left.includes("job-bad"));
    assert.ok(left.includes("job-other"), "another repository was dismissed");
  });
});

test("a later posted review of the same pull request resolves its failure by itself", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    failedReview("job-bad", 7);
    insertJob({ id: "job-good", type: "review", repo: REPO, prNumber: 7 });
    insertReview({
      id: "r-good",
      repo: REPO,
      prNumber: 7,
      jobId: "job-good",
      headSha: "h",
      baseSha: "b",
      scope: "whole-pr",
      model: "m",
    });
    setReviewStatus("r-good", "posted");
    setJobStatus("job-good", "done");
    assert.ok(
      !recent((await get("/activity?status=failed")).html).includes("job-bad"),
    );
    const history = recent(
      (await get("/activity?status=failed&settled=1")).html,
    );
    assert.ok(history.includes("Resolved by a later review"));
    assert.ok(!/job-bad[\s\S]*?>Retry</.test(history.split("</tr>")[0]!));
  });
});

test("the retry API starts one review per pull request and skips rows with nothing to retry", async () => {
  await withDashboard(async (_get, send) => {
    activateRepo(REPO, 1);
    failedReview("job-a", 7);
    failedReview("job-b", 7);
    insertJob({ id: "job-ok", type: "review", repo: REPO, prNumber: 9 });
    setJobStatus("job-ok", "done");
    const before = listJobs().length;
    const result = await send("POST", "/api/activity/retry", {
      keys: ["job:job-a", "job:job-b", "job:job-ok"],
    });
    assert.equal(result.status, 200);
    assert.equal((result.json.jobIds as string[]).length, 1);
    assert.equal(result.json.skipped, 2);
    assert.equal(listJobs().length, before + 1);
    const queued = listJobs({ status: "queued" })[0]!;
    assert.equal(JSON.parse(queued.args).model, "vendor/model-a");
  });
});

test("the action APIs check their keys", async () => {
  await withDashboard(async (_get, send) => {
    for (const body of [{}, { keys: [] }, { keys: ["nope"] }, { keys: [1] }]) {
      const result = await send("POST", "/api/activity/retry", body);
      assert.equal(result.status, 422, JSON.stringify(body));
    }
    const dismiss = await send("POST", "/api/activity/dismiss", { keys: "x" });
    assert.equal(dismiss.status, 422);
  });
});

test("every row has a checkbox, and only a failed row allows the bulk Dismiss and Retry", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    failedReview("job-bad", 7);
    insertJob({ id: "job-ok", type: "remake", repo: REPO });
    setJobStatus("job-ok", "done");
    const html = (await get("/activity")).html;
    assert.ok(html.includes("data-select-all"), "no select all");
    assert.ok(html.includes(`data-bulk-action="dismiss" disabled`));
    assert.ok(html.includes(`data-bulk-action="retry" disabled`));
    const bad = /<tr [^>]*data-key="job:job-bad"[^>]*>/.exec(html)?.[0] ?? "";
    const ok = /<tr [^>]*data-key="job:job-ok"[^>]*>/.exec(html)?.[0] ?? "";
    assert.ok(bad.includes("data-dismiss") && bad.includes("data-retry"), bad);
    assert.ok(!ok.includes("data-dismiss") && !ok.includes("data-retry"), ok);
    assert.equal(
      (recent(html).match(/data-select aria-label/g) ?? []).length,
      2,
    );
  });
});
