import { safeCopy } from "../../util/redact.ts";
import { relativeTime } from "../../util/time.ts";
import { client } from "./client.ts";
import { sprite } from "./icons.ts";
import { VERSION } from "../../version.ts";
import type { NavCounts } from "../../services/nav_counts.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] ?? char,
  );
}

export function text(value: unknown): string {
  return escapeHtml(safeCopy(String(value ?? "")));
}

function markdownInline(value: string): string {
  const slots: string[] = [];
  const slot = (html: string): string => {
    const index = slots.push(html) - 1;
    return `\uE000${index}\uE001`;
  };
  let result = escapeHtml(value);
  result = result.replace(/`([^`\n]+)`/g, (_, code: string) =>
    slot(`<code>${code}</code>`),
  );
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label: string, href: string) =>
      slot(`<a href="${href}" rel="noreferrer">${label}</a>`),
  );
  result = result.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  result = result.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  result = result.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  result = result.replace(
    /\uE000(\d+)\uE001/g,
    (_, index: string) => slots[Number(index)],
  );
  return result;
}

export function markdown(value: unknown): string {
  const lines = safeCopy(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let listKind: "ul" | "ol" | undefined;
  let code: string[] | undefined;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p>${markdownInline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (!list.length || !listKind) return;
    blocks.push(`<${listKind}>${list.join("")}</${listKind}>`);
    list = [];
    listKind = undefined;
  };
  const flushText = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const fence = line.match(/^```(?:[A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      flushText();
      if (code) {
        blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = undefined;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushText();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushText();
      const level = heading[1].length;
      blocks.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      if (listKind && listKind !== kind) flushList();
      flushParagraph();
      listKind = kind;
      list.push(`<li>${markdownInline((bullet ?? ordered)![1])}</li>`);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (code) {
    blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  flushText();
  return `<div class="markdown">${blocks.join("")}</div>`;
}

export function money(value: number): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(7).replace(/0+$/, "").replace(/\.$/, "")}`;
}

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function count(value: number): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return n < 1000 ? String(Math.round(n)) : compactNumber.format(n);
}

export function duration(ms: number | null | undefined): string {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  if (n < 1000) return `${Math.round(n)}ms`;
  const sec = Math.round(n / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/** Rendered only when the earlier window had something to compare against,
 * so an empty first month stays quiet rather than claiming a jump. */
export function delta(
  change: number | undefined,
  days: number,
  lowerIsBetter = false,
): string {
  if (change === undefined || change === 0) return "";
  const better = lowerIsBetter ? change < 0 : change > 0;
  const sign = change > 0 ? "+" : "";
  return `<div class="trend ${
    better ? "up" : "down"
  }">${sign}${change}% vs previous ${days} days</div>`;
}

/** A flex row of divs beats pulling in a chart library for one series, and
 * it stays readable when a range has a single day in it. Each column is full
 * height with the bar painted as a gradient stop, because a bar sized by its
 * own height leaves nothing to hover over on a quiet day. */
export function bars(items: { label: string; value: number }[]): string {
  if (items.length === 0) return "";
  const max = Math.max(...items.map((item) => item.value));
  return `<div class="bars">${items
    .map(
      (item) =>
        `<i title="${escapeHtml(item.label)}" style="--h:${
          max > 0 ? Math.max(2, (item.value / max) * 100).toFixed(1) : "2"
        }%"></i>`,
    )
    .join("")}</div>`;
}

/** GitHub truncates long responses, so a count that reached its ceiling is
 * a floor rather than a total and has to read as one. */
export function capped(value: number, cap: number): string {
  return value >= cap ? `${cap}+` : String(value);
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const abs = new Date(iso);
  const title = Number.isNaN(abs.getTime())
    ? iso
    : abs
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC");
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(title)}">${text(
    relativeTime(iso),
  )}</time>`;
}

export function skSlot(kind: "table" | "block" = "block"): string {
  if (kind === "table") {
    return `<div class="sk-slot" hidden><div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div></div>`;
  }
  return `<div class="sk-slot" hidden><div class="sk"></div><div class="sk"></div></div>`;
}

/** Runs in `<head>` before first paint: a remembered dark theme is applied to
 * `<html>` before the stylesheet can flash the light background. Kept inline
 * and synchronous on purpose. */
const THEME_BOOTSTRAP = `try{if(localStorage.getItem("theme")==="dark"){document.documentElement.classList.add("dark")}}catch(e){}`;

function ico(name: string): string {
  return `<svg class="ic" aria-hidden="true"><use href="#i-${escapeHtml(
    name,
  )}"></use></svg>`;
}

const NAV_GROUPS: {
  label: string;
  items: { href: string; label: string; icon: string }[];
}[] = [
  {
    label: "Reviews",
    items: [
      { href: "/", label: "Repositories", icon: "layout-grid" },
      { href: "/activity", label: "Activity", icon: "activity" },
      { href: "/usage", label: "Usage", icon: "chart-no-axes-column" },
    ],
  },
  {
    label: "Setup",
    items: [{ href: "/setup", label: "Setup", icon: "list-checks" }],
  },
  {
    label: "Settings",
    items: [
      { href: "/settings/ai", label: "AI models", icon: "sparkles" },
      { href: "/settings/github", label: "GitHub", icon: "github" },
      {
        href: "/settings/defaults",
        label: "Review defaults",
        icon: "sliders-horizontal",
      },
      { href: "/settings/remote", label: "Remote access", icon: "key-round" },
      { href: "/settings/server", label: "Server", icon: "server" },
      { href: "/settings/sign-in", label: "Sign-in", icon: "shield-check" },
      {
        href: "/settings/danger",
        label: "Danger zone",
        icon: "triangle-alert",
      },
    ],
  },
];

/** Where the menu badges come from. `createApp` registers the real counts;
 * a page rendered without an app (a unit test of one renderer) has none and
 * shows no badges. */
let navSource: (() => NavCounts) | undefined;

export function setNavSource(source: (() => NavCounts) | undefined): void {
  navSource = source;
}

function readNavCounts(): NavCounts | undefined {
  try {
    return navSource?.();
  } catch {
    // The badges are decoration: a closed database (a test that rendered a
    // page after tearing its app down) must not break the page itself.
    return undefined;
  }
}

function navBadge(href: string, counts: NavCounts | undefined): string {
  if (!counts) return "";
  if (href === "/" && counts.repos > 0) {
    return `<span class="r tnum">${counts.repos}</span>`;
  }
  if (href === "/activity" && counts.failed > 0) {
    return `<span class="r fail-count">${counts.failed} failed</span>`;
  }
  if (href === "/setup")
    return `<span class="r tnum">${text(counts.setup)}</span>`;
  return "";
}

function navHtml(active: string | undefined): string {
  const counts = readNavCounts();
  return `<nav class="nav">${NAV_GROUPS.map(
    (group) =>
      `<div class="grp"><p>${group.label}</p>${group.items
        .map(
          (item) =>
            `<a class="item${item.href === active ? " on" : ""}" href="${
              item.href
            }">${ico(item.icon)}${item.label}${navBadge(item.href, counts)}</a>`,
        )
        .join("")}</div>`,
  ).join("")}</nav>`;
}

/** The Ctrl K palette, hidden until `client.js` opens it. Results are filled
 * from `/api/search`. */
const PALETTE = `<div class="pal-ov" id="pal-ov" hidden></div>
<div class="pal" id="pal" role="dialog" aria-modal="true" aria-label="Search" hidden>
  <div class="in">${ico("search")}<input id="pal-q" type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" autocomplete="off" placeholder="Search pages, repositories, pull requests" aria-label="Search pages, repositories, pull requests"><kbd>Esc</kbd></div>
  <div class="list" id="pal-list" role="listbox" aria-label="Results"></div>
</div>`;

/** The shared shell: left menu, sidefoot user/theme/sign out, mobile topbar and
 * overlay. `active` is the href of the nav item to mark; pages under Reviews
 * pass `/`. */
export function layout(opts: {
  title: string;
  username: string;
  active?: string;
  body: string;
}): string {
  const username = opts.username;
  const initials = (username || "?").slice(0, 2).toUpperCase();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text(
    opts.title,
  )}</title><link rel="stylesheet" href="/styles.css"><link rel="icon" href="/logo.png" type="image/png"><script>${THEME_BOOTSTRAP}</script><script>${client}</script></head><body>
${sprite}
<div class="app">
  <aside class="side" id="side">
    <a class="logo" href="/"><img class="mark" src="/logo.png" alt=""><span class="name"><span class="n">co-maintainer</span><span class="s">Dashboard</span></span></a>
    <button type="button" class="search" data-palette aria-keyshortcuts="Control+K Meta+K">${ico(
      "search",
    )}<span>Search…</span><kbd>Ctrl K</kbd></button>
    ${navHtml(opts.active)}
    <div class="sidefoot">
      <div class="me"><span class="av">${text(
        initials,
      )}</span><span class="who"><span class="u">${text(
        username,
      )}</span><span class="s">v${text(VERSION)}</span></span></div>
      <button type="button" class="ghost" id="theme">${ico(
        "moon",
      )}<span>Dark mode</span></button>
      <form method="post" action="/logout"><button type="submit" class="ghost">${ico(
        "log-out",
      )}Sign out</button></form>
    </div>
  </aside>
  <div class="overlay" id="overlay"></div>
  <main>
    <div class="topbar"><button type="button" class="btn out sm" id="menu" aria-label="Menu">${ico(
      "menu",
    )}</button>co-maintainer</div>
    ${opts.body}
  </main>
</div>
${PALETTE}
<div id="toasts"></div>
</body></html>`;
}

/** The sign-in page: a centered focus card with the same theme behavior but no
 * application shell. */
export function layoutFocus(opts: { title: string; body: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text(
    opts.title,
  )}</title><link rel="stylesheet" href="/styles.css"><link rel="icon" href="/logo.png" type="image/png"><script>${THEME_BOOTSTRAP}</script><script>${client}</script></head><body>
${sprite}
<div class="focus"><main><div class="wrap">${opts.body}</div></main></div>
<div id="toasts"></div>
</body></html>`;
}

/** A 404 that still shows the shell, so a signed-in user keeps the menu and a
 * way back. */
export function notFound(
  username: string,
  message: string,
  active?: string,
): Response {
  return html(
    layout({
      title: "Page not found · co-maintainer",
      username,
      active,
      body: `<div class="wrap">
  <div class="pagehead"><div><h1>Page not found</h1>
    <p class="lead">${text(message)}</p></div></div>
  <div class="card"><div class="bd">
    <a class="btn primary" href="/">Back to repositories</a>
  </div></div>
</div>`,
    }),
    404,
  );
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** The repository tabs shared by every repo page. They replace the old second
 * sidebar; the shell owns the only left menu. */
export function repoTabs(fullName: string, on: string): string {
  const href = `/repos/${fullName}`;
  const items = [
    { id: "overview", label: "Overview", path: href },
    { id: "pulls", label: "Pull requests", path: `${href}/pulls` },
    { id: "knowledge", label: "Knowledge", path: `${href}/knowledge` },
    { id: "remote", label: "Remote reviews", path: `${href}/remote` },
    { id: "pushes", label: "Pushes", path: `${href}/pushes` },
    {
      id: "settings",
      label: "Repository settings",
      path: `${href}/settings`,
    },
  ];
  return `<nav class="tabs">${items
    .map(
      (item) =>
        `<a href="${item.path}"${on === item.id ? ` class="on"` : ""}>${text(
          item.label,
        )}</a>`,
    )
    .join("")}</nav>`;
}

export function empty(title: string, lead: string): string {
  return `<div class="empty"><h2>${text(title)}</h2><p>${text(lead)}</p></div>`;
}

export function statusClass(
  kind: "ok" | "warn" | "err" | "run",
  label: string,
): string {
  return `<span class="st ${kind}">${text(label)}</span>`;
}
