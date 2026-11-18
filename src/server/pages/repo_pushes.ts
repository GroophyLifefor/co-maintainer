/** Commit watch on the dashboard: the setup card on the Pushes tab that says
 * whether pushes are watched and how to turn it on, the short status line the
 * overview keeps, and the list of each push review. */
import { empty, html, layout, plural, text, when } from "./layout.ts";
import { badge, codeBlock, icon, repoHeader, section } from "./ui.ts";
import { formatCost } from "./cost.ts";
import type { repoPushes } from "../../services/dashboard.ts";
import type { WatchStatus } from "../../services/watch_status.ts";
import type { PushSource } from "../../store/watch.ts";

function short(sha: string | null): string {
  return (sha ?? "").slice(0, 7);
}

function viaLabel(via: PushSource[]): string {
  if (via.includes("app") && via.includes("ci")) return "App and CI";
  if (via.includes("app")) return "App";
  if (via.includes("ci")) return "CI";
  return "unknown";
}

/** The workflow a CI user copies, with this server's address filled in. */
export function commitWatchWorkflow(serverUrl: string, branch: string): string {
  return `name: co-maintainer commit watch
on:
  push:
    branches: [${branch}]

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: GroophyLifefor/co-maintainer@v0
        with:
          remote-host: ${serverUrl || "https://your-server"}
          remote-token: \${{ secrets.CO_MAINTAINER_TOKEN }}`;
}

function statusBadge(status: WatchStatus): string {
  const app = status.app === "on";
  if (app && status.ci)
    return badge("emerald", "Watching via App and CI", {
      icon: "circle-check",
    });
  if (app)
    return badge("emerald", "Watching via GitHub App", {
      icon: "circle-check",
    });
  if (status.ci)
    return badge("emerald", "Watching via CI", { icon: "circle-check" });
  return badge("neutral", "Off");
}

function statusLine(status: WatchStatus): string {
  const last = status.lastPush;
  const watching = status.app === "on" || status.ci;
  if (!watching) {
    return `<p class="muted" style="font-size:13px">Turn it on one of the two ways below. Nothing is reviewed until then.</p>`;
  }
  if (!last) {
    return `<p class="muted" style="font-size:13px">Waiting for the first push…</p>`;
  }
  return `<p class="muted" style="font-size:13px">${icon("circle-check")} Last push <code>${text(
    short(last.head_sha),
  )}</code> via ${text(viaLabel(last.via))}, ${when(last.created_at)}</p>`;
}

function appRow(status: WatchStatus): string {
  const state =
    status.app === "on"
      ? "The Push event is on."
      : status.app === "off"
        ? "The App is installed here, the Push event is off."
        : status.app === "not-installed"
          ? "The App is not installed on this repository."
          : "The events of the App could not be read.";
  return `<div class="row"><div class="b">
    <p class="strong">GitHub App</p>
    <p class="muted" style="font-size:13px">${text(state)} In the App's settings open the
    permissions and events page and tick <b>Push</b> under Subscribe to events. It applies to
    every repository the App is installed on.</p>
  </div><a class="btn out sm" href="https://github.com/settings/apps" target="_blank" rel="noopener">${icon(
    "external-link",
  )}App settings</a></div>`;
}

function ciRow(serverUrl: string, branch: string): string {
  return `<div class="row" style="display:block"><div class="b">
    <p class="strong">CI</p>
    <p class="muted" style="font-size:13px">Add this workflow and a <code>CO_MAINTAINER_TOKEN</code>
    secret with a remote review token from Settings.</p>
  </div>
  ${codeBlock({
    code: commitWatchWorkflow(serverUrl, branch),
    attrs: "data-commit-watch-yaml",
  })}</div>`;
}

/** The setup card at the top of the Pushes tab. */
export function commitWatchCard(
  status: WatchStatus,
  serverUrl: string,
  branch: string,
): string {
  return `<div class="card" id="commit-watch">${section(
    `${statusLine(status)}${appRow(status)}${ciRow(serverUrl, branch)}`,
    {
      title: "Commit watch",
      lead: `Review pushes to ${branch}.`,
      action: statusBadge(status),
    },
  )}</div>`;
}

/** The overview's one line: whether pushes are watched, the last push, and
 * a link to the setup on the Pushes tab. */
export function commitWatchStatus(
  fullName: string,
  status: WatchStatus,
): string {
  const watching = status.app === "on" || status.ci;
  const last = status.lastPush;
  const detail = !watching
    ? "Pushes to the default branch are not reviewed."
    : last
      ? `Last push <code>${text(short(last.head_sha))}</code> via ${text(
          viaLabel(last.via),
        )}, ${when(last.created_at)}.`
      : "Waiting for the first push.";
  return `<div class="card" id="commit-watch-status">${section(
    `<div class="row"><div class="b"><p class="muted" style="font-size:13px">${detail}</p></div>${statusBadge(
      status,
    )}<a class="btn out sm" href="/repos/${text(fullName)}/pushes">${
      watching ? "Pushes" : "Set up on Pushes"
    }</a></div>`,
    { title: "Commit watch" },
  )}</div>`;
}

export function renderRepoPushes(
  username: string,
  fullName: string,
  data: ReturnType<typeof repoPushes>,
  status: WatchStatus,
  /** The commit watch setup card, from `commitWatchCard`. */
  setup = "",
): Response {
  const watched =
    status.app === "on" && status.ci
      ? "via the GitHub App and CI"
      : status.app === "on"
        ? "via the GitHub App"
        : status.ci
          ? "via CI"
          : "not watched";
  const rows =
    data.items.length === 0
      ? empty(
          "No pushes reviewed yet",
          "Turn on commit watch one of the two ways above. Only pushes after that are reviewed.",
        )
      : `<table>
        <thead><tr><th>Push</th><th>Via</th><th>Status</th><th class="num">P0</th>
          <th class="num">P1</th><th class="num">P2</th><th class="num">P3</th>
          <th class="num">Issues opened</th><th class="num">Cost</th><th>When</th></tr></thead>
        <tbody>
          ${data.items
            .map(
              (review) => `<tr>
            <td><code>${text(short(review.base_sha))}..${text(short(review.head_sha))}</code></td>
            <td>${text(viaLabel(review.via))}</td>
            <td>${text(review.status)}</td>
            <td class="num">${review.p0}</td>
            <td class="num">${review.p1}</td>
            <td class="num">${review.p2}</td>
            <td class="num">${review.p3}</td>
            <td class="num">${review.issuesOpened}</td>
            <td class="num">${formatCost(review)}</td>
            <td class="muted">${when(review.created_at)}</td>
          </tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  return html(
    layout({
      title: `${fullName} · Pushes · co-maintainer`,
      username,
      active: "/",
      body: `<div class="wrap">
  ${repoHeader({
    fullName,
    tab: "pushes",
    title: "Pushes",
    tabLabel: "Pushes",
    lead: `Commit watch reviews of pushes to the default branch. This repository is ${watched}. ${plural(data.openIssues, "open issue")}.`,
  })}
  <div>
    ${setup}
    <div class="card"><div class="bd flush">${rows}</div></div>
  </div>
</div>`,
    }),
  );
}
