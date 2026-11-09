/** Commit watch on the dashboard: the card on a repository's overview that
 * says whether pushes are watched and how to turn it on, and the Pushes tab
 * that lists each push review. */
import {
  escapeHtml,
  empty,
  html,
  layout,
  repoTabs,
  text,
  when,
} from "./layout.ts";
import { badge, icon, section } from "./ui.ts";
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
  <div class="code" data-commit-watch-yaml><span style="white-space:pre;overflow-x:auto;display:block">${escapeHtml(
    commitWatchWorkflow(serverUrl, branch),
  )}</span><button type="button" data-copy title="Copy">${icon("copy")}</button></div></div>`;
}

/** The overview card. */
export function commitWatchCard(
  fullName: string,
  status: WatchStatus,
  serverUrl: string,
  branch: string,
): string {
  return `<div class="card" id="commit-watch">${section(
    `${statusLine(status)}${appRow(status)}${ciRow(serverUrl, branch)}`,
    {
      title: "Commit watch",
      lead: `Review pushes to ${branch}.`,
      action: `${statusBadge(status)} <a class="btn gh sm" href="/repos/${text(
        fullName,
      )}/pushes">Pushes</a>`,
    },
  )}</div>`;
}

export function renderRepoPushes(
  username: string,
  fullName: string,
  data: ReturnType<typeof repoPushes>,
  status: WatchStatus,
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
          "Turn on commit watch on the overview of this repository. Only pushes after that are reviewed.",
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
  ${repoTabs(fullName, "pushes")}
  <div>
    <div class="crumbs"><a href="/">Repositories</a> / ${text(fullName)}</div>
    <div class="pagehead">
      <div>
        <h1>Pushes</h1>
        <p class="lead">Commit watch reviews of pushes to the default branch. This repository is ${text(
          watched,
        )}. ${data.openIssues} open ${data.openIssues === 1 ? "issue" : "issues"}.</p>
      </div>
    </div>
    <div class="card"><div class="bd flush">${rows}</div></div>
  </div>
</div>`,
    }),
  );
}
