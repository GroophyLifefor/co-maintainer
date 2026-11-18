import {
  empty,
  html,
  layout,
  markdown,
  plural,
  skSlot,
  text,
  when,
} from "./layout.ts";
import { formatCost, formatCostTotal, totalOfRows } from "./cost.ts";
import type { prDetail } from "../../services/dashboard.ts";
import { extensionCostNote, renderExtensionResults } from "./extensions.ts";
import { referencesHtml } from "./references.ts";
import { repoHeader } from "./ui.ts";
import {
  findingAnchor,
  isOpenFinding,
  locationLink,
  severityBadge,
  stateBadge,
  threadLink,
} from "./finding_bits.ts";

type Review = ReturnType<typeof prDetail>["reviews"][number];
type Finding = Review["findings"][number];

/** A finding carried into a later round has a newer copy there. Only the
 * newest copy of each finding counts, so a finding open for three rounds is
 * one open finding, not three. */
export function latestFindings(reviews: Review[]): Finding[] {
  const all = reviews.flatMap((review) => review.findings);
  const carried = new Set(
    all.flatMap((finding) =>
      finding.carried_from_finding_id ? [finding.carried_from_finding_id] : [],
    ),
  );
  return all.filter((finding) => !carried.has(finding.id));
}

/** The anchor of each round, `round-4`. When a round was attempted twice the
 * newest attempt, listed first, keeps the plain anchor. */
function roundAnchors(reviews: Review[]): Map<string, string> {
  const anchors = new Map<string, string>();
  const used = new Set<string>();
  for (const review of reviews) {
    let anchor = `round-${review.round}`;
    for (let n = 2; used.has(anchor); n++)
      anchor = `round-${review.round}-${n}`;
    used.add(anchor);
    anchors.set(review.id, anchor);
  }
  return anchors;
}

export function renderPr(
  username: string,
  fullName: string,
  data: ReturnType<typeof prDetail>,
  /** The pull request's title, when it is known. */
  title?: string,
): Response {
  const n = data.prNumber;
  const totalCost = totalOfRows(data.reviews);
  const anchors = roundAnchors(data.reviews);
  const latest = latestFindings(data.reviews);
  const openCount = latest.filter((f) => isOpenFinding(f.state)).length;
  const closedCount = latest.length - openCount;
  const findingItem = (review: Review, finding: Finding, last: boolean) => {
    const location = locationLink(fullName, review.head_sha, finding);
    const thread = threadLink(fullName, n, finding);
    const links = [location, thread].filter(Boolean).join(" · ");
    // punctuation: code, a CSS declaration list inside an inline style
    return `<div class="finding" id="${text(findingAnchor(finding.id))}"${
      last
        ? ""
        : ` style="padding-bottom:18px;border-bottom:1px solid var(--border2);margin-bottom:18px"`
    }>
          <div style="margin-bottom:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${stateBadge(
            finding.state,
            finding.close_reason,
          )}${severityBadge(finding.severity)}<b>${text(finding.title)}</b>${
            finding.first_seen_review_id
              ? ` <span class="muted" style="font-size:13px">Seen in an earlier round</span>`
              : ""
          }</div>
          ${links ? `<div class="muted" style="font-size:13px;margin-bottom:8px">${links}</div>` : ""}
          ${markdown(finding.body_md)}
          ${referencesHtml(finding.references_json)}
        </div>`;
  };
  const findingList = (review: Review) => {
    if (review.findings.length === 0) {
      return empty(
        "No findings",
        "This review did not report anything to fix.",
      );
    }
    // Open first, then closed, each with its own badge.
    const sorted = [
      ...review.findings.filter((f) => isOpenFinding(f.state)),
      ...review.findings.filter((f) => !isOpenFinding(f.state)),
    ];
    return sorted
      .map((finding, index) =>
        findingItem(review, finding, index === sorted.length - 1),
      )
      .join("");
  };
  // punctuation: code, a CSS declaration list inside an inline style
  const findingsBlock =
    data.reviews.length === 0
      ? empty(
          "No findings",
          "Run a review to post findings on this pull request.",
        )
      : data.reviews
          .map(
            (review, index) =>
              `<details id="${text(anchors.get(review.id))}"${index === 0 ? " open" : ""} style="padding:14px 0${
                index < data.reviews.length - 1
                  ? ";border-bottom:1px solid var(--border2)"
                  : ""
              }">
        <summary style="cursor:pointer">
          <b>Round ${text(review.round)}</b>
          <span class="muted"> · ${text(
            (review.head_sha ?? "").slice(0, 7),
          )} · ${plural(review.findings.length, "finding")}</span>
        </summary>
        <div style="padding:16px 4px 4px">${findingList(review)}${renderExtensionResults(review.extensions)}</div>
      </details>`,
          )
          .join("");
  const reviewsTable =
    data.reviews.length === 0
      ? empty(
          "Not reviewed yet",
          "Run a review to post findings on this pull request.",
        )
      : `<table>
          <thead><tr><th>Round</th><th>When</th><th>Commit</th><th>Looked at</th>
            <th class="num">Findings</th><th class="num">Cost</th></tr></thead>
          <tbody>
            ${data.reviews
              .map(
                (review) =>
                  `<tr data-href="/activity/${text(review.job_id)}" style="cursor:pointer"><td><a href="/activity/${text(
                    review.job_id,
                  )}" title="Open the log of this round">Round ${text(review.round)}</a></td>
              <td>${when(review.created_at)}</td>
              <td class="mono">${text((review.head_sha ?? "").slice(0, 7))}</td>
              <td class="muted">${text(
                review.scope === "incremental"
                  ? "Changes since the last review"
                  : "Whole pull request",
              )}</td>
              <td class="num"><a href="#${text(anchors.get(review.id))}">${review.findings_count}</a></td>
              <td class="num">${formatCost(review)}${extensionCostNote(review.extensions)}</td></tr>`,
              )
              .join("")}
          </tbody>
        </table>`;
  const heading = title ? `#${n} ${title}` : `#${n}`;
  return html(
    layout({
      title: `${heading} · co-maintainer`,
      username,
      active: "/",
      body: `<div class="wrap">
  ${repoHeader({
    fullName,
    tab: "pulls",
    title: heading,
    tabLabel: "Pull requests",
    deeper: [{ label: `#${n}` }],
    lead: `${plural(data.reviews.length, "review")} on record`,
    actions: `<button type="button" class="btn out" id="again">Review again</button>
        <a class="btn out" href="https://github.com/${text(fullName)}/pull/${n}">Open on GitHub</a>`,
  })}
  <div data-async>
    ${skSlot()}
    <div class="card" id="findings">
      <div class="hd"><h2>Findings</h2>
        <span class="muted" style="margin-left:auto;font-size:13px">${text(
          `${openCount} open, ${closedCount} closed`,
        )}</span></div>
      <div class="bd">${findingsBlock}</div>
    </div>
    <div class="card">
      <div class="hd"><h2>Reviews</h2>
        <span class="muted" style="margin-left:auto;font-size:13px">${formatCostTotal(
          totalCost,
        )} total</span></div>
      <div class="bd flush">${reviewsTable}</div>
    </div>
  </div>
</div>
<script>
document.getElementById("again").addEventListener("click", function() {
  postAndGo("/api/repos/" + ${JSON.stringify(
    fullName,
  )} + "/pulls/${n}/review", {}, "/activity", this);
});
document.querySelectorAll("tr[data-href]").forEach(function(row) {
  row.addEventListener("click", function(event) {
    if (event.target.closest("a")) return;
    location.href = row.getAttribute("data-href");
  });
});
// A link to a round or a finding opens the round it sits in.
function openTarget() {
  var id = decodeURIComponent(location.hash.slice(1));
  var target = id ? document.getElementById(id) : null;
  if (!target) return;
  var round = target.tagName === "DETAILS" ? target : target.closest("details");
  if (round) round.open = true;
  target.scrollIntoView({ block: "start" });
}
openTarget();
window.addEventListener("hashchange", openTarget);
</script>`,
    }),
  );
}
