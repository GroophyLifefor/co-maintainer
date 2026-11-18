/** The job page warns about a problem a finished job logged, links the pull
 * request and the posted review, and offers Clear only while the job runs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertJob, setJobStatus } from "../../store/jobs.ts";
import { appendLog } from "../../store/job_logs.ts";
import { jobWarnings } from "../../services/job_warnings.ts";
import type { JobLogRow } from "../../store/rows.ts";

const REPO = "acme/widgets";

function line(level: string, message: string, seq = 1): JobLogRow {
  return { job_id: "j", seq, at: "2026-01-01T00:00:00.000Z", level, message };
}

function doneReview(posted?: string): void {
  insertJob({ id: "job-ok", type: "review", repo: REPO, prNumber: 136 });
  insertReview({
    id: "r-ok",
    repo: REPO,
    prNumber: 136,
    jobId: "job-ok",
    headSha: "h",
    baseSha: "b",
    scope: "whole-pr",
    model: "m",
    round: 3,
  });
  setReviewStatus("r-ok", "posted", posted ? { posted_review_id: posted } : {});
  setJobStatus("job-ok", "done");
}

test("a check run 404 says the App lacks the Checks permission and how to fix it", () => {
  const [warning] = jobWarnings([
    line(
      "info",
      "GitHub Check Run update failed: Error: GitHub 404 Not Found for PATCH repos/a/b/check-runs/1",
    ),
  ]);
  assert.ok(warning, "no warning");
  assert.match(warning.problem, /Checks permission/);
  assert.match(warning.fix, /Checks to Read and write/);
  assert.equal(warning.fixHref, "/settings/github");
});

test("a plain warning shows once, a rate limit wait and info lines do not", () => {
  const warnings = jobWarnings([
    line("warn", "companion_unreachable: could not read acme/other", 1),
    line("warn", "companion_unreachable: could not read acme/other", 2),
    line("warn", JSON.stringify({ type: "rate_limit_wait", seconds: 3 }), 3),
    line("info", "posted review 77", 4),
  ]);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0]!.problem, /logged a warning: companion_unreachable/);
});

test("a finished job with a check run failure shows the banner and its Activity row a mark", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    doneReview("4242");
    appendLog(
      "job-ok",
      "warn",
      "GitHub Check Run update failed: Error: GitHub 404 Not Found",
    );
    const page = (await get("/activity/job-ok")).html;
    assert.ok(page.includes(`class="notice warn job-warning" role="alert"`));
    assert.ok(page.includes("Checks permission"));
    assert.ok(page.includes(`href="/settings/github"`));
    const activity = (await get("/activity")).html;
    assert.ok(
      /data-key="job:job-ok"[\s\S]*?class="warn-mark"/.test(activity),
      "the Activity row has no warning mark",
    );
  });
});

test("the job page links the pull request page and the review posted on GitHub", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    doneReview();
    appendLog("job-ok", "info", "posted review 9001");
    const page = (await get("/activity/job-ok")).html;
    assert.ok(
      page.includes(
        `href="/repos/${REPO}/pulls/136#round-3">Pull request page</a>`,
      ),
    );
    assert.ok(
      page.includes(
        `href="https://github.com/${REPO}/pull/136#pullrequestreview-9001" target="_blank" rel="noopener">`,
      ),
      "no link to the posted review",
    );
    assert.ok(!page.includes("job-warning"), "a clean job shows a banner");
  });
});

test("Clear shows only while the job runs", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    doneReview();
    insertJob({ id: "job-live", type: "remake", repo: REPO });
    setJobStatus("job-live", "running");
    assert.ok(
      !(await get("/activity/job-ok")).html.includes("data-log-clear>Clear<"),
    );
    assert.ok(
      (await get("/activity/job-live")).html.includes("data-log-clear>Clear<"),
    );
  });
});
