import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo, deactivateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { insertFinding } from "../../store/findings.ts";
import { rememberPullTitle } from "../../store/pull_titles.ts";
import { findingsHref, parseFindingQuery } from "./findings.ts";

const REPO = "acme/widgets";

function review(id: string, repo: string, pr: number, round: number): void {
  insertReview({
    id,
    repo,
    prNumber: pr,
    jobId: `job-${id}`,
    headSha: `sha-${id}`,
    baseSha: "base",
    scope: "whole-pr",
    model: "m",
    round,
  });
  setReviewStatus(id, "posted", { findings_count: 1 });
}

/** #136 has two rounds: a high finding carried as open, and a medium one
 * closed in round 2. #140 has a low finding in another file. A second
 * repository has one finding of its own. */
function seed(): void {
  activateRepo(REPO, 1);
  activateRepo("acme/gadgets", 1);
  rememberPullTitle(REPO, 136, "Rename format to formatDuration");
  review("a1", REPO, 136, 1);
  insertFinding({
    id: "high-1",
    reviewId: "a1",
    severity: "P1",
    path: "src/time.ts",
    lineFrom: 4,
    title: "Wrong unit",
    bodyMd: "Seconds, not milliseconds.",
  });
  insertFinding({
    id: "medium-1",
    reviewId: "a1",
    severity: "P2",
    path: "src/format.ts",
    lineFrom: 9,
    title: "Unused import",
    bodyMd: "Drop it.",
  });
  review("a2", REPO, 136, 2);
  insertFinding({
    id: "high-2",
    reviewId: "a2",
    severity: "P1",
    path: "src/time.ts",
    lineFrom: 4,
    title: "Wrong unit",
    bodyMd: "Seconds, not milliseconds.",
    state: "open",
    carriedFromFindingId: "high-1",
  });
  insertFinding({
    id: "medium-2",
    reviewId: "a2",
    severity: "P2",
    path: "src/format.ts",
    lineFrom: 9,
    title: "Unused import",
    bodyMd: "Drop it.",
    state: "closed",
    carriedFromFindingId: "medium-1",
    closeReason: "fixed",
  });
  review("b1", REPO, 140, 1);
  insertFinding({
    id: "low-1",
    reviewId: "b1",
    severity: "P3",
    path: "lib/100%_done.ts",
    lineFrom: 2,
    title: "Typo in a comment",
    bodyMd: "Spell it right.",
  });
  review("c1", "acme/gadgets", 3, 1);
  insertFinding({
    id: "gadget-1",
    reviewId: "c1",
    severity: "P0",
    path: "main.go",
    lineFrom: 1,
    title: "Nil map write",
    bodyMd: "Make the map first.",
  });
}

/** The finding ids a list shows, read from the row links. */
function ids(html: string): string[] {
  return [...html.matchAll(/<tr data-href="[^"]*#finding-([^"]+)"/g)].map(
    (m) => m[1]!,
  );
}

test("the repository list shows each finding once, by its newest copy, open by default", async () => {
  await withDashboard(async (get) => {
    seed();
    const { status, html } = await get(`/repos/${REPO}/findings`);
    assert.equal(status, 200);
    assert.deepEqual(ids(html).sort(), ["high-2", "low-1"]);
    assert.ok(
      html.includes(`href="/repos/${REPO}/pulls/136#finding-high-2"`),
      "a row opens the PR page at the finding",
    );
    assert.ok(html.includes("Rename format to formatDuration"), "PR title");
    assert.ok(html.includes(">Blocking<") || html.includes(">Not blocking<"));
    assert.match(
      html,
      /<nav class="tabs">[\s\S]*?<a href="[^"]*\/findings" class="on">Findings<\/a>/,
    );
  });
});

test("severity, state, pull request, file and search filter the list", async () => {
  await withDashboard(async (get) => {
    seed();
    const list = async (query: string) =>
      ids((await get(`/repos/${REPO}/findings?${query}`)).html).sort();
    assert.deepEqual(await list("severity=P1"), ["high-2"]);
    assert.deepEqual(await list("state=closed"), ["medium-2"]);
    assert.deepEqual(await list("state=all"), ["high-2", "low-1", "medium-2"]);
    assert.deepEqual(await list("state=all&pr=140"), ["low-1"]);
    assert.deepEqual(await list("file=format&state=all"), ["medium-2"]);
    assert.deepEqual(await list("q=milliseconds"), ["high-2"]);
    // % and _ are text, not wildcards.
    assert.deepEqual(await list("file=100%25_"), ["low-1"]);
    assert.deepEqual(await list("file=1000"), []);
  });
});

test("an active filter shows as a chip that takes it off", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(`/repos/${REPO}/findings?pr=136&q=unit`);
    assert.ok(
      html.includes(`<a class="chip" href="/repos/${REPO}/findings?q=unit"`),
      "the PR chip keeps the search",
    );
    assert.ok(html.includes(">PR #136<"));
  });
});

test("the list is paginated", async () => {
  await withDashboard(async (get) => {
    activateRepo(REPO, 1);
    review("many", REPO, 9, 1);
    for (let i = 0; i < 30; i++) {
      insertFinding({
        id: `f${String(i).padStart(2, "0")}`,
        reviewId: "many",
        severity: "P2",
        title: `Finding ${i}`,
        bodyMd: "x",
      });
    }
    const first = await get(`/repos/${REPO}/findings`);
    assert.equal(ids(first.html).length, 25);
    assert.ok(first.html.includes("1-25 of 30"));
    assert.ok(first.html.includes(`href="/repos/${REPO}/findings?page=2"`));
    const second = await get(`/repos/${REPO}/findings?page=2`);
    assert.equal(ids(second.html).length, 5);
  });
});

test("the list across repositories has a repository filter and a menu item", async () => {
  await withDashboard(async (get) => {
    seed();
    const all = await get("/findings");
    assert.equal(all.status, 200);
    assert.deepEqual(ids(all.html).sort(), ["gadget-1", "high-2", "low-1"]);
    assert.match(all.html, /<a class="item on" href="\/findings">/);
    assert.match(
      all.html,
      /<option value="acme\/gadgets">acme\/gadgets<\/option>/,
    );
    const one = await get("/findings?repo=acme%2Fgadgets");
    assert.deepEqual(ids(one.html), ["gadget-1"]);
    assert.match(one.html, /<option value="acme\/gadgets" selected>/);
    deactivateRepo("acme/gadgets");
    assert.deepEqual(ids((await get("/findings")).html).sort(), [
      "high-2",
      "low-1",
    ]);
  });
});

test("an empty list says so and offers to clear the filters", async () => {
  await withDashboard(async (get) => {
    seed();
    const { html } = await get(`/repos/${REPO}/findings?severity=P0`);
    assert.ok(html.includes("No findings match"));
    assert.ok(
      html.includes(
        `<a class="btn out sm" href="/repos/${REPO}/findings">Clear filters</a>`,
      ),
    );
  });
});

test("a hand-edited query keeps only the values that fit", () => {
  const query = parseFindingQuery(
    new URLSearchParams("severity=P9&state=maybe&pr=-1&days=12&page=x"),
  );
  assert.deepEqual(query, {
    severity: undefined,
    state: "open",
    pr: undefined,
    file: undefined,
    q: undefined,
    repo: undefined,
    days: undefined,
    author: undefined,
    page: 1,
  });
  assert.equal(
    findingsHref(REPO, { severity: "P1", state: "all", days: 30 }),
    `/repos/${REPO}/findings?severity=P1&state=all&days=30`,
  );
  assert.equal(findingsHref(undefined), "/findings");
});
