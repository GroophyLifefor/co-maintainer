import {
  capped,
  empty,
  html,
  layout,
  repoTabs,
  skSlot,
  text,
  when,
} from "./layout.ts";
import {
  badge,
  crumb,
  dl,
  icon,
  pageHeader,
  section,
  statCard,
  type Tone,
} from "./ui.ts";
import { formatCostTotal } from "./cost.ts";
import { COMPARE_FILE_CAP, MAX_COMMITS_COUNTED } from "../../services/drift.ts";
import type { repoOverview } from "../../services/dashboard.ts";
import { describePolicy } from "../../services/review_policy.ts";
import { policyForRepo } from "../../services/webhook.ts";
import { reviewBlockingFrom } from "../../review/blocking.ts";
import { SEVERITY_LEGEND } from "../../pr/review_copy.ts";
import { readConfig } from "../../config.ts";
import { webhookReachabilityProblem } from "../../util/webhook_reachability.ts";
import { lastDeliveryForRepo } from "../../store/deliveries.ts";

/** P0..P3 in legend order, with the words the PR comment uses. */
const SEVERITY_TONE: Record<string, Tone> = {
  P0: "red",
  P1: "red",
  P2: "amber",
  P3: "neutral",
};

function severityName(level: string): string {
  return (
    SEVERITY_LEGEND.find((entry) => entry.level === level)?.name ?? level
  ).toLowerCase();
}

/** "1 high · 1 low", most severe first. */
function severityHint(
  counts: { severity: string; findings: number }[],
): string {
  return SEVERITY_LEGEND.map((entry) => {
    const n = counts.find((c) => c.severity === entry.level)?.findings ?? 0;
    return n > 0 ? `${n} ${entry.name.toLowerCase()}` : "";
  })
    .filter(Boolean)
    .join(" · ");
}

/** The most severe level among a review's findings, as a badge. */
function topSeverity(levels: string[]): string {
  const top = SEVERITY_LEGEND.find((entry) => levels.includes(entry.level));
  if (!top) return "";
  const n = levels.filter((level) => level === top.level).length;
  return badge(
    SEVERITY_TONE[top.level] ?? "neutral",
    `${n} ${severityName(top.level)}`,
  );
}

function seconds(ms: number): string {
  if (!ms) return "None yet";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export function renderRepo(
  username: string,
  data: ReturnType<typeof repoOverview>,
  webhookUrl: string,
): Response {
  const name = data.repo.full_name;
  const stats = data.stats;
  const drift = data.drift;
  const notice =
    drift &&
    (drift.prs_since > 0 || drift.prs_updated > 0 || drift.commits_since > 0)
      ? `<div class="notice" data-async>
      ${skSlot()}
      <div class="txt"><b>Update recommended.</b> Since the guide was built:
        ${drift.prs_since} new pull requests, ${drift.prs_updated} changed pull requests, ${capped(
          drift.commits_since,
          MAX_COMMITS_COUNTED,
        )} commits, ${capped(drift.files_changed, COMPARE_FILE_CAP)} files changed. Use Sync to update it.</div>
    </div>`
      : "";
  const pulls =
    data.recentPulls.length === 0
      ? empty(
          "No reviews yet",
          "Reviews appear here after a pull request is opened.",
        )
      : data.recentPulls
          .map(
            (review) =>
              `<div class="row"><div class="b"><p class="strong"><a href="/repos/${text(
                name,
              )}/pulls/${review.pr_number}">#${review.pr_number}</a></p>
          <p class="muted" style="font-size:13px">Reviewed ${when(review.created_at)} · ${
            review.findings_count
          } ${review.findings_count === 1 ? "finding" : "findings"}</p></div>${topSeverity(
            review.severities,
          )}</div>`,
          )
          .join("");
  const reach = webhookReachabilityProblem(webhookUrl);
  const last = lastDeliveryForRepo(name);
  const delivery = last ? when(last.received_at) : "never";
  const webhookNotice = reach
    ? `<div class="notice bad">
      <div class="txt"><b>GitHub cannot reach this address, so automatic reviews will not arrive.</b>
        ${text(reach)} The webhook URL is <code>${text(
          webhookUrl,
        )}</code>. Change it in <a href="/settings">Settings</a>.
        Last webhook delivery: ${delivery}.</div>
    </div>`
    : !last
      ? `<div class="notice info">
      <div class="txt"><b>No webhook delivery yet.</b> GitHub has not reached this repository
        and the last webhook delivery is never. Open a pull request, or check the webhook URL
        <code>${text(webhookUrl)}</code> in <a href="/settings">Settings</a>.</div>
    </div>`
      : "";
  const config = readConfig();
  const blocking =
    reviewBlockingFrom(
      config.repos?.[name]?.reviewBlocking ?? config.reviewBlocking,
    ) === "severity"
      ? "Severity is Critical or High"
      : "When the model says so";
  const webhookRow =
    last && !reach
      ? `${badge("emerald", "Receiving", { icon: "circle-check" })} <span class="muted" style="font-size:13px">Last webhook delivery: ${delivery}</span>`
      : `${badge("amber", "Not receiving", { icon: "triangle-alert" })} <span class="muted" style="font-size:13px">Last webhook delivery: ${delivery}</span>`;
  const how = dl([
    {
      k: "Who",
      v: describePolicy(policyForRepo(data.repo)).map(text).join(" "),
    },
    {
      k: "Scope",
      v:
        data.repo.review_scope === "incremental"
          ? "Only what changed since the last review"
          : "The whole pull request every time",
    },
    { k: "Blocking", v: blocking },
    { k: "Webhook", v: webhookRow },
  ]);
  const auto = data.repo.auto_review === 1;
  const lead = `${
    auto ? "Reviewing pull requests automatically" : "Automatic review is off"
  } · knowledge ${
    data.repo.knowledge_built_at
      ? when(data.repo.knowledge_built_at)
      : "not built yet"
  }`;
  const failedHint =
    stats.failed > 0
      ? `${stats.failed} failed ${stats.failed === 1 ? "attempt" : "attempts"}`
      : undefined;
  return html(
    layout({
      title: `${name} · co-maintainer`,
      username,
      active: "/",
      body: `<div class="wrap">
  ${pageHeader({
    title: name,
    leadHtml: lead,
    crumb: crumb([{ label: "Repositories", href: "/" }, { label: name }]),
    actions: `<button type="button" class="btn out" id="remake">${icon("refresh-cw")}Sync</button><a class="btn out" href="https://github.com/${text(
      name,
    )}">${icon("external-link")}GitHub</a>`,
  })}
  ${repoTabs(name, "overview")}
  ${notice}
  ${webhookNotice}
  <div class="stats">
    ${statCard({ label: "Reviewed (30d)", value: String(stats.pullRequests), hint: failedHint, icon: "git-pull-request" })}
    ${statCard({ label: "Findings", value: String(stats.findings), hint: severityHint(data.bySeverity) || undefined, icon: "flag" })}
    ${statCard({ label: "Cost (30d)", value: formatCostTotal(stats), icon: "coins" })}
    ${statCard({ label: "Avg. review", value: seconds(stats.avgDurationMs), icon: "timer" })}
  </div>
  <div class="cols c11">
    <div class="card">${section(pulls, {
      title: "Recent pull requests",
      action: `<a class="btn gh sm" href="/repos/${text(name)}/pulls">View all</a>`,
    })}</div>
    <div class="card">${section(how, {
      title: "How it reviews",
      action: `<a class="btn gh sm" href="/repos/${text(name)}/settings">Change</a>`,
    })}</div>
  </div>
</div>
<script>
var repo = ${JSON.stringify(name)};
var remake = document.getElementById("remake");
if (remake) remake.addEventListener("click", function() {
  postAndGo("/api/repos/" + repo + "/remake", {}, "/activity", remake);
});
</script>`,
    }),
  );
}
