/** The internal component gallery served at `/__ui` when the server runs in
 * debug mode (`serve --debug` or `CM_DEBUG=1`). It renders every design-system
 * component in `ui.ts` twice, once light and once dark, so the library can be
 * reviewed and captured as a visual baseline without any real data. It is not
 * part of the product and is absent from a normal server.
 */
import { escapeHtml, html } from "./layout.ts";
import { client } from "./client.ts";
import { iconNames } from "./icons.ts";
import {
  alert,
  badge,
  card,
  codeBlock,
  crumb,
  dl,
  emptyState,
  field,
  foot,
  icon,
  iconSprite,
  pageHeader,
  section,
  segmented,
  statCard,
  steps,
  switchControl,
  table,
  tabs,
  timeline,
  type Tone,
} from "./ui.ts";

/** `p` prefixes every id so the light and dark copies stay unique. */
function panel(p: string): string {
  const tones: Tone[] = ["emerald", "amber", "red", "sky", "neutral"];
  return `
${pageHeader({
  crumb: crumb([
    { label: "Repositories", href: "#" },
    { label: "acme/widgets" },
  ]),
  title: "Component gallery",
  lead: "Every design-system component, light and dark.",
  actions: `<button class="btn pri" type="button">${icon("sparkles")}Primary</button>
    <button class="btn out" type="button">${icon("download")}Outline</button>
    <button class="btn gh" type="button">Ghost</button>
    <button class="btn danger" type="button">Danger</button>`,
})}

${tabs([
  { label: "Overview", href: "#", on: true },
  { label: "Pull requests", href: "#", count: 3 },
  { label: "Knowledge", href: "#" },
])}

${card(
  section(
    table({
      head: ["Pull request", "Author", "Status", "Cost"],
      rows: [
        [
          `<span class="strong">Tidy the helper</span><span class="sub">#12 · fix/helper</span>`,
          "octocat",
          badge("emerald", "Reviewed"),
          `<span class="r tnum">$0.14</span>`,
        ],
        [
          `<span class="strong">Drop the cache</span><span class="sub">#11 · chore/cache</span>`,
          "hubot",
          badge("amber", "Running", { icon: "loader" }),
          `<span class="r tnum">$0.02</span>`,
        ],
        [
          `<span class="strong">Rework auth</span><span class="sub">#9 · feat/auth</span>`,
          "mona",
          badge("red", "Failed"),
          `<span class="r tnum">$0.00</span>`,
        ],
      ],
    }),
    { title: "Recent reviews", count: 3 },
  ),
  { flush: true },
)}

<div class="stats">
  ${statCard({ label: "Reviews", value: "128", hint: "+12 vs previous 30 days", icon: "git-pull-request" })}
  ${statCard({ label: "Cost", value: "$4.20", hint: "last 30 days", icon: "coins" })}
  ${statCard({ label: "Median time", value: "1m 30s", hint: "per review", icon: "timer" })}
  ${statCard({ label: "Findings", value: "42", hint: "P0 to P3", icon: "list-checks" })}
</div>

${card(
  section(
    `
    <div class="filters">
      ${segmented([
        { label: "7d", attrs: 'data-range="7d"' },
        { label: "30d", on: true, attrs: 'data-range="30d"' },
        { label: "90d", attrs: 'data-range="90d"' },
        { label: "Recommended", tag: "rec", tagRec: true },
      ])}
      <div class="sbox">${icon("search")}<input class="inp" type="search" placeholder="Search"></div>
    </div>
    <div class="row"><div class="b"><p class="strong">Concurrency</p><p class="muted">Reviews run at the same time.</p></div>
      ${switchControl({ id: `${p}-sw-1`, label: "Auto review", on: true })}
    </div>
    <div class="row"><div class="b"><p class="strong">Auto review</p><p class="muted">Review pushes automatically.</p></div>
      ${switchControl({ id: `${p}-sw-2`, label: "Auto review" })}
    </div>`,
    { title: "Controls" },
  ),
)}

${card(
  section(
    `<div class="grid2">
      ${field({ label: "Repository", id: `${p}-f1`, value: "acme/widgets", hint: "Owner/name" })}
      ${field({ label: "Branch", id: `${p}-f2`, placeholder: "main" })}
    </div>
    ${field({ label: "Review guide", id: `${p}-f3`, type: "textarea", rows: 3, value: "Focus on correctness." })}
    ${dl([
      { k: "Provider", v: "OpenRouter" },
      {
        k: "High model",
        v: `<span class="mono">anthropic/claude-sonnet-4</span>`,
      },
      { k: "Low model", v: `<span class="mono">deepseek/deepseek-chat</span>` },
    ])}`,
    { title: "Form fields" },
  ),
)}

${card(
  section(
    `${alert("emerald", { title: "Up to date", body: "Built 12 min ago from 171 facts." })}
   ${alert("amber", { title: "Setup is not finished", body: "Reviews cannot be posted until the GitHub App is connected.", action: `<button class="btn out sm" type="button">Continue${icon("arrow-right", "arr")}</button>` })}
   ${alert("red", { title: "The model returned an empty answer", body: "Nothing was posted as a review. A note was left on the pull request." })}
   ${alert("sky", { title: "Token created", body: "Shown once. Run this on the developer machine." })}
   ${codeBlock({ code: "co-maintainer init acme/widgets --include-codebase --gh-concurrent=1 --ai-concurrent=3" })}`,
    { title: "Alerts" },
  ),
)}

${card(
  section(
    `<div class="actions-row">${tones
      .map((tone) => badge(tone, tone[0]!.toUpperCase() + tone.slice(1)))
      .join("")}</div>`,
    { title: "Badges" },
  ),
)}

${card(
  section(
    steps([
      { n: 1, title: "Models and API key", detail: "Done", state: "done" },
      { n: 2, title: "GitHub App", detail: "In progress", state: "now" },
      { n: 3, title: "First repository" },
    ]),
    { title: "Setup steps" },
  ),
  { flush: true },
)}

${card(
  section(
    timeline([
      { title: "Review posted", when: "2 minutes ago", icon: "circle-check" },
      { title: "Sync finished", when: "1 hour ago", icon: "refresh-cw" },
      { title: "Repository added", when: "yesterday", icon: "plus" },
    ]),
    { title: "Timeline" },
  ),
)}

${card(
  emptyState({
    title: "No reviews yet",
    text: "Open a pull request or start one by number.",
    icon: "inbox",
    action: `<button class="btn pri" type="button">Start review</button>`,
  }),
  { flush: true },
)}

${card(
  section(
    `<div class="actions-row">${iconNames
      .map(
        (name) =>
          `<span class="badge b-ne">${icon(name)}${escapeHtml(name)}</span>`,
      )
      .join("")}</div>`,
    { title: `Icons (${iconNames.length})` },
  ),
)}

${card(section("Footer content here.", { title: "Card with footer" }), {})}
${foot(`Updated just now<span class="sp"></span><a href="#">Refresh</a>`)}`;
}

export function renderCatalog(): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Component gallery · co-maintainer</title>
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/logo.png" type="image/png">
<script>${client}</script></head><body>
${iconSprite}
<div class="app"><main><div class="wrap"><p class="muted">Light theme</p>${panel("l")}</div></main></div>
<div class="dark"><div class="app"><main><div class="wrap"><p class="muted">Dark theme</p>${panel("d")}</div></main></div></div>
<div id="toasts"></div>
</body></html>`;
  return html(body);
}
