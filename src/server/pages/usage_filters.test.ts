/** Usage narrows to one repository or one pull request author, and Export
 * downloads the reviews the page counts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withDashboard } from "../../testing/dashboard_pages.ts";
import { activateRepo } from "../../store/repos.ts";
import { insertReview, setReviewStatus } from "../../store/reviews.ts";
import { rememberPullTitle } from "../../store/pull_titles.ts";
import { insertFinding } from "../../store/findings.ts";
import { parseUsageQuery, usageHref } from "./usage_query.ts";
import { usageCsv } from "./usage_csv.ts";

function review(
  id: string,
  repo: string,
  pr: number,
  status: string,
  cost: number | null,
): void {
  insertReview({
    id,
    repo,
    prNumber: pr,
    jobId: `job-${id}`,
    headSha: id,
    baseSha: "b",
    scope: "whole-pr",
    model: "m-1",
  });
  setReviewStatus(id, status, {
    cost,
    cost_status: cost === null ? "unknown" : "known",
    findings_count: 1,
    tokens_in: 100,
    tokens_out: 20,
  });
}

function seed(): void {
  activateRepo("acme/widgets", 1);
  activateRepo("acme/gadgets", 1);
  rememberPullTitle("acme/widgets", 1, "One", "ada");
  rememberPullTitle("acme/widgets", 2, "Two", "grace");
  rememberPullTitle("acme/gadgets", 3, "Three", "ada");
  review("r1", "acme/widgets", 1, "posted", 0.5);
  review("r2", "acme/widgets", 2, "posted", 0.25);
  review("r3", "acme/gadgets", 3, "posted", null);
  insertFinding({
    id: "f1",
    reviewId: "r1",
    severity: "P1",
    title: "A high one",
    bodyMd: "x",
  });
  insertFinding({
    id: "f2",
    reviewId: "r2",
    severity: "P2",
    title: "A medium one",
    bodyMd: "x",
  });
}

/** The big number of the stat card with this label. */
function card(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`, html.indexOf(`class="stats"`));
  assert.ok(at >= 0, `no ${label} card`);
  return html.slice(at, at + 600);
}

test("Usage filters by repository and by author, and the links keep them", async () => {
  await withDashboard(async (get) => {
    seed();
    const all = (await get("/usage")).html;
    assert.match(card(all, "Spent"), /\$0\.75/);
    assert.ok(all.includes(`<option value="grace">grace</option>`));
    assert.ok(
      all.includes(`<option value="acme/gadgets">acme/gadgets</option>`),
    );

    const repo = (await get("/usage?repo=acme%2Fwidgets")).html;
    assert.match(card(repo, "Reviews"), /2 pull requests/);
    assert.ok(!repo.includes(`href="/repos/acme/gadgets"`));
    assert.ok(
      repo.includes(`href="/usage?range=7d&amp;repo=acme%2Fwidgets"`),
      "the range links drop the repository",
    );

    const ada = (await get("/usage?author=ada")).html;
    assert.match(card(ada, "Reviews"), /2 pull requests/);
    assert.match(card(ada, "Spent"), /\$0\.50/);
    // The findings count opens the list with the same author.
    assert.ok(
      ada.includes(
        `<a href="/findings?state=all&amp;days=30&amp;author=ada">1</a>`,
      ),
    );
    const findings = (await get("/findings?state=all&days=30&author=ada")).html;
    assert.ok(findings.includes("A high one"));
    assert.ok(!findings.includes("A medium one"));
    assert.ok(findings.includes("Author: ada"));
    // Init and sync have no author, so their row leaves the table.
    assert.ok(!ada.includes("init / sync"));
    assert.ok(
      ada.includes(`href="/usage/export.csv?range=30d&amp;author=ada"`),
      "Export does not carry the filter",
    );
  });
});

test("Export downloads one row per review with the filters on screen", async () => {
  await withDashboard(async (get) => {
    seed();
    const response = await get("/usage/export.csv?range=30d&author=ada");
    assert.equal(response.status, 200);
    const lines = response.html.trim().split("\r\n");
    assert.equal(
      lines[0],
      "time,repository,pull_request,author,model,tokens_in,tokens_out,cost_usd,billed_to,findings,status",
    );
    assert.equal(lines.length, 3, response.html);
    const widgets = lines.find((line) => line.includes("acme/widgets"));
    assert.match(
      widgets ?? "",
      /,acme\/widgets,1,ada,m-1,100,20,0\.5,server,1,posted$/,
    );
    // An unknown cost is an empty cell, never a zero.
    const gadgets = lines.find((line) => line.includes("acme/gadgets"));
    assert.match(
      gadgets ?? "",
      /,acme\/gadgets,3,ada,m-1,100,20,,server,1,posted$/,
    );
  });
});

test("a CSV cell never starts a formula and quotes what needs quoting", () => {
  const csv = usageCsv([
    {
      created_at: "2026-01-01T00:00:00.000Z",
      repo: "acme/widgets",
      pr_number: 1,
      author: "=cmd",
      kind: "pr",
      model: 'a "quoted", model',
      tokens_in: 1,
      tokens_out: 2,
      cost: 0.1,
      cost_status: "known",
      billed_to: "byok",
      findings_count: 0,
      status: "posted",
    },
  ]);
  assert.ok(csv.includes(`,'=cmd,"a ""quoted"", model",1,2,0.1,byok,0,posted`));
});

test("a hand-edited Usage query falls back to 30 days", () => {
  const query = parseUsageQuery(new URLSearchParams("range=12d&repo=%20"));
  assert.deepEqual(query, { range: "30d", repo: undefined, author: undefined });
  assert.equal(
    usageHref({ range: "7d", author: "ada" }, { range: "90d" }),
    "/usage?range=90d&author=ada",
  );
});
