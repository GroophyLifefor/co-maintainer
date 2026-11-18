import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertFinding, setFindingPosted } from "../../store/findings.ts";
import { rememberPullTitle } from "../../store/pull_titles.ts";
import { KNOWN_COST } from "../../testing/fixtures/cost.ts";

const REPO = "acme/widgets";

/** Two rounds of #136. Round 1 raised two findings. Round 2 carried one as
 * still open and closed the other, and the bot withdrew a third. */
function seed(): void {
  activateRepo(REPO, 9);
  insertReview({
    id: "r1",
    repo: REPO,
    prNumber: 136,
    jobId: "job-r1",
    headSha: "aaaaaaa1111",
    baseSha: "base",
    scope: "whole-pr",
    model: "m",
    round: 1,
  });
  setReviewStatus("r1", "posted", { findings_count: 2, ...KNOWN_COST(0.01) });
  insertFinding({
    id: "f1",
    reviewId: "r1",
    severity: "P1",
    path: "src/time.ts",
    lineFrom: 4,
    lineTo: 6,
    title: "Wrong unit",
    bodyMd: "Seconds, not milliseconds.",
    referencesJson: JSON.stringify([
      {
        kind: "rule",
        id: "R3",
        sources: [1, 2, 3, 4].map((pr) => ({
          pr,
          url: `https://github.com/${REPO}/pull/${pr}`,
        })),
      },
    ]),
  });
  setFindingPosted("f1", "555001");
  insertFinding({
    id: "f2",
    reviewId: "r1",
    severity: "P2",
    path: "src/format.ts",
    lineFrom: 9,
    title: "Unused import",
    bodyMd: "Drop it.",
  });
  insertReview({
    id: "r2",
    repo: REPO,
    prNumber: 136,
    jobId: "job-r2",
    headSha: "bbbbbbb2222",
    baseSha: "aaaaaaa1111",
    scope: "incremental",
    model: "m",
    round: 2,
  });
  setReviewStatus("r2", "posted", { findings_count: 3, ...KNOWN_COST(0.01) });
  insertFinding({
    id: "f1b",
    reviewId: "r2",
    severity: "P1",
    path: "src/time.ts",
    lineFrom: 4,
    title: "Wrong unit",
    bodyMd: "Seconds, not milliseconds.",
    state: "open",
    carriedFromFindingId: "f1",
    firstSeenReviewId: "r1",
    threadCommentId: "555001",
  });
  insertFinding({
    id: "f2b",
    reviewId: "r2",
    severity: "P2",
    path: "src/format.ts",
    lineFrom: 9,
    title: "Unused import",
    bodyMd: "Drop it.",
    state: "closed",
    carriedFromFindingId: "f2",
    closeReason: "fixed",
  });
  insertFinding({
    id: "f3",
    reviewId: "r2",
    severity: "P3",
    path: "src/name.ts",
    lineFrom: 1,
    title: "Name it formatDuration",
    bodyMd: "Clearer.",
    state: "closed",
    closeReason: "withdrawn",
  });
}

test("the PR page shows the stored title without asking GitHub", async () => {
  await withDashboard(async (get) => {
    seed();
    rememberPullTitle(REPO, 136, "Rename format to formatDuration");
    const { html } = await get(`/repos/${REPO}/pulls/136`);
    assert.match(html, /<h1>#136 Rename format to formatDuration<\/h1>/);
    assert.match(html, /<title>#136 Rename format to formatDuration/);
  });
});

test("every finding has its own state badge, a closed one says why", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(`/repos/${REPO}/pulls/136`);
    const round2 = html.slice(
      html.indexOf('id="round-2"'),
      html.indexOf('id="round-1"'),
    );
    const items = round2.split('class="finding"').slice(1);
    assert.equal(items.length, 3);
    for (const item of items) {
      assert.match(item, /class="badge b-(am|ne)">(Open|Closed)</);
    }
    assert.match(round2, /Withdrawn, the bot agreed it was wrong/);
    assert.match(round2, />Fixed</);
  });
});

test("the header counts each finding once, by its newest copy", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(`/repos/${REPO}/pulls/136`);
    assert.ok(html.includes("1 open, 2 closed"), "open and closed counts");
  });
});

test("References counts the references it lists", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(`/repos/${REPO}/pulls/136`);
    assert.ok(html.includes("References (4)"));
    assert.ok(!html.includes("References (1)"));
  });
});

test("rounds and findings have anchors, and the Reviews rows open the job log", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(`/repos/${REPO}/pulls/136`);
    assert.match(html, /<details id="round-2" open/);
    assert.match(html, /<details id="round-1"/);
    assert.match(html, /id="finding-f1b"/);
    assert.match(html, /<tr data-href="\/activity\/job-r2"/);
    assert.match(html, /<a href="\/activity\/job-r1"[^>]*>Round 1<\/a>/);
  });
});

test("file and line open GitHub at the round's commit, and a posted finding links its thread", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(`/repos/${REPO}/pulls/136`);
    assert.ok(
      html.includes(
        `href="https://github.com/${REPO}/blob/aaaaaaa1111/src/time.ts#L4-L6"`,
      ),
      "round 1 line link",
    );
    assert.ok(
      html.includes(
        `href="https://github.com/${REPO}/blob/bbbbbbb2222/src/time.ts#L4"`,
      ),
      "round 2 line link",
    );
    assert.ok(
      html.includes(
        `href="https://github.com/${REPO}/pull/136#discussion_r555001"`,
      ),
      "thread link",
    );
  });
});

test("a title missing from the store is fetched once, then read from the store", async () => {
  const { clearOpenPullsCache } =
    await import("../../github/open_pulls_cache.ts");
  const { TEST_PKCS1_PEM } = await import("../../testing/fixtures/rsa_key.ts");
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.startsWith("https://api.github.com/")) {
      return original(input as Parameters<typeof fetch>[0]);
    }
    calls.push(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/app/installations") && !url.includes("access_tokens"))
      return json([{ id: 9, account: { login: "acme", type: "User" } }]);
    if (url.includes("/access_tokens"))
      return json({
        token: "ghs_title",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    if (url.includes("/installation/repositories"))
      return json({ repositories: [{ full_name: REPO }] });
    if (url.endsWith(`/repos/${REPO}/pulls/136`))
      return json({ number: 136, title: "Fetched title" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  clearOpenPullsCache();
  try {
    await withDashboard(
      async (get) => {
        seed();
        const first = await get(`/repos/${REPO}/pulls/136`);
        assert.match(first.html, /<h1>#136 Fetched title<\/h1>/);
        const before = calls.length;
        assert.ok(before > 0, "the first view asked GitHub");
        const second = await get(`/repos/${REPO}/pulls/136`);
        assert.match(second.html, /<h1>#136 Fetched title<\/h1>/);
        assert.equal(calls.length, before, "the second view asked GitHub");
      },
      { githubAppId: "4900449", githubAppPrivateKey: TEST_PKCS1_PEM },
    );
  } finally {
    globalThis.fetch = original;
    clearOpenPullsCache();
  }
});
