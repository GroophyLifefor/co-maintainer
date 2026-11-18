/** Every count of findings, failures or reviews opens the list it counts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertFinding } from "../../store/findings.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";

const REPO = "acme/widgets";

function seed(): void {
  activateRepo(REPO, 1);
  activateRepo("acme/gadgets", 1);
  insertJob({ id: "job-ok", type: "review", repo: REPO, prNumber: 136 });
  setJobStatus("job-ok", "done");
  insertReview({
    id: "r-ok",
    repo: REPO,
    prNumber: 136,
    jobId: "job-ok",
    headSha: "h1",
    baseSha: "b",
    scope: "whole-pr",
    model: "m",
    round: 4,
  });
  setReviewStatus("r-ok", "posted", { findings_count: 1 });
  insertFinding({
    id: "f-ok",
    reviewId: "r-ok",
    severity: "P2",
    title: "A medium one",
    bodyMd: "x",
  });
  insertJob({ id: "job-bad", type: "review", repo: REPO, prNumber: 137 });
  setJobStatus("job-bad", "failed", { error: "boom" });
  insertReview({
    id: "r-bad",
    repo: REPO,
    prNumber: 137,
    jobId: "job-bad",
    headSha: "h2",
    baseSha: "b",
    scope: "whole-pr",
    model: "m",
  });
  setReviewStatus("r-bad", "failed");
  insertJob({
    id: "job-other",
    type: "review",
    repo: "acme/gadgets",
    prNumber: 1,
  });
  setJobStatus("job-other", "done");
}

test("the Activity result opens the PR page at that round", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get("/activity");
    assert.ok(
      html.includes(
        `<a class="st ok" href="/repos/${REPO}/pulls/136#round-4">1 finding</a>`,
      ),
      "the result is not a link to the round",
    );
  });
});

test("Activity accepts repo and status=failed from the overview links", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(
      `/activity?repo=${encodeURIComponent(REPO)}&status=failed`,
    );
    const recent = html.slice(html.indexOf("<h2>Recent</h2>"));
    assert.ok(
      recent.includes("/activity/job-bad"),
      "the failed job is missing",
    );
    assert.ok(!recent.includes("/activity/job-ok"), "a done job was kept");
    assert.ok(!recent.includes("acme/gadgets"), "another repository was kept");
    assert.ok(html.includes(">Show all</a>"), "no way back to the whole list");
    const repoOnly = await get(`/activity?repo=${encodeURIComponent(REPO)}`);
    assert.ok(repoOnly.html.includes("/activity/job-ok"));
    assert.ok(
      !repoOnly.html
        .slice(repoOnly.html.indexOf("<h2>Recent</h2>"))
        .includes("job-other"),
    );
  });
});

test("the job page says Found and links the findings of that round", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get("/activity/job-ok");
    assert.ok(html.includes(`<div class="top">Found</div>`));
    assert.ok(!html.includes(`<div class="top">Learned</div>`));
    assert.ok(
      html.includes(`<a href="/repos/${REPO}/pulls/136#round-4">1 finding</a>`),
    );
  });
});

test("the overview's failed attempts and severity badges open their lists", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(`/repos/${REPO}`);
    assert.ok(
      html.includes(
        `<a href="/activity?repo=acme%2Fwidgets&amp;status=failed">1 failed attempt</a>`,
      ),
      "the failed part does not open the failed list",
    );
    assert.match(
      html,
      new RegExp(
        `<a href="/repos/${REPO}/pulls/136#round-4" class="badge-link"><span class="badge b-am">1 medium</span></a>`,
      ),
    );
  });
});

test("the Usage Findings card and severity rows open the findings list", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get("/usage");
    assert.ok(
      html.includes(`<a href="/findings?state=all&amp;days=30">1</a>`),
      "the Findings card does not open the list",
    );
    assert.ok(
      html.includes(`href="/findings?severity=P2&amp;state=all&amp;days=30"`),
      "a severity row does not open its list",
    );
    assert.ok(
      html.includes(`<a href="/activity?status=failed">1 failed attempt</a>`),
    );
  });
});
