/**
 * Build static HTML docs under docs/ from docs/md/*.md
 * Run: npm run docs:build
 *
 * Layout for co-maintainer.com:
 *   docs/index.html          the landing page (hand written, not built here)
 *   docs/privacy.html        the privacy page (hand written, not built here)
 *   docs/docs/<slug>.html    one page per docs/md/<slug>.md
 *   docs/docs/<slug>.md      the Markdown copy of that page
 *   docs/docs/search-index.json  the client-side search rows
 *   docs/<slug>.html         a redirect stub for the old flat address
 *   docs/CNAME               the custom domain
 *   docs/sitemap.xml         every page under the apex domain
 *   docs/llms.txt            the llmstxt.org index
 *   docs/llms-full.txt       every page combined for a model
 *   docs/robots.txt          every crawler allowed, the sitemap announced
 *   docs/index.html          only its `<!-- seo:start -->` block is filled
 *
 * Assets stay at docs/assets/, so a doc page reaches them through `../`.
 */
import { marked } from "marked";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  registryToMarkdown,
  visibleCommandNames,
} from "../src/cli/commands/registry.ts";
import { applySchemaBlock } from "../src/extensions/schema.ts";
import { logo } from "../src/server/logo.ts";
import { permissionTable, type TableKind } from "../src/github/permissions.ts";
import {
  mkdir,
  readTextFile,
  stat,
  writeFile,
  writeTextFile,
} from "../src/util/runtime.ts";

const DEFAULT_OUT = new URL("../docs/", import.meta.url);
const MD_DIR = new URL("md/", DEFAULT_OUT);

/** The public origin. Canonical links and the sitemap use it. */
export const SITE_ORIGIN = "https://co-maintainer.com";

/** The custom domain GitHub Pages serves the site from. */
export const CNAME = "co-maintainer.com";

type NavItem = { slug: string; label: string };
type NavSection = { title: string; items: NavItem[] };
/** A heading the search index and the on-page table of contents both use. */
export type Heading = { id: string; text: string; level: number };
/** One searchable row: a page, or a section of a page. */
export type SearchEntry = {
  slug: string;
  label: string;
  section: string;
  heading: string;
  hash: string;
};

/** Sidebar groups. Add pages here. Top bar stays minimal. */
const NAV: NavSection[] = [
  {
    title: "Getting started",
    items: [
      { slug: "getting-started", label: "Quickstart" },
      { slug: "probe", label: "Probe" },
      { slug: "init", label: "Init" },
      { slug: "sync", label: "Sync" },
      { slug: "view", label: "View guides" },
    ],
  },
  {
    title: "Review",
    items: [
      { slug: "review", label: "Review" },
      { slug: "local-review", label: "Local review" },
      { slug: "remote-review", label: "Remote review" },
      { slug: "ci", label: "CI" },
      { slug: "review-policy", label: "Review policy" },
      { slug: "local-pr-review", label: "PR review" },
      { slug: "commit-watch-review", label: "Commit watch review" },
      { slug: "extensions", label: "Extensions" },
      { slug: "companions", label: "Companions" },
    ],
  },
  {
    title: "Self-hosted",
    items: [
      { slug: "serve", label: "Serve" },
      { slug: "dashboard", label: "Dashboard" },
      { slug: "github-app", label: "GitHub App" },
    ],
  },
  {
    title: "Cloud",
    items: [{ slug: "cloud", label: "Cloud" }],
  },
  {
    title: "Reference",
    items: [
      { slug: "commands", label: "Commands" },
      { slug: "configuration", label: "Configuration" },
      { slug: "providers", label: "AI providers" },
      { slug: "authentication", label: "Authentication" },
      { slug: "caching", label: "Caching" },
      { slug: "codegraph", label: "Codegraph" },
      { slug: "cost", label: "Cost" },
      { slug: "troubleshooting", label: "Troubleshooting" },
    ],
  },
];

const ALL_PAGES: NavItem[] = NAV.flatMap((s) => s.items);

/** Which sidebar group and label a slug belongs to, for the search index. */
const SECTION_OF = new Map<string, string>();
const LABEL_OF = new Map<string, string>();
for (const section of NAV) {
  for (const item of section.items) {
    SECTION_OF.set(item.slug, section.title);
    LABEL_OF.set(item.slug, item.label);
  }
}

/** The client-side search index: one row per page, plus one per section, so a
 * query can land on a heading instead of only a whole page. */
export function searchEntriesFor(
  slug: string,
  headings: readonly Heading[],
): SearchEntry[] {
  const label = LABEL_OF.get(slug) ?? slug;
  const section = SECTION_OF.get(slug) ?? "";
  const entries: SearchEntry[] = [
    { slug, label, section, heading: "", hash: "" },
  ];
  for (const heading of headings) {
    entries.push({
      slug,
      label,
      section,
      heading: heading.text,
      hash: heading.id,
    });
  }
  return entries;
}

export function searchJson(entries: readonly SearchEntry[]): string {
  return `${JSON.stringify(entries)}\n`;
}

/** The one-sentence summary at the top of `llms.txt`. */
export const LLMS_SUMMARY =
  "co-maintainer learns a GitHub repository from its code, pull requests, and history, then reviews pull requests and local changes against that knowledge.";

/** The newest released version and its date, read from the first
 * `## [x.y.z] - date` heading of CHANGELOG.md. A beta changes only
 * package.json, so the site keeps stating the last stable release. */
export type SiteFacts = { version: string; date: string | undefined };

export function siteFacts(changelog: string): SiteFacts {
  for (const line of changelog.split("\n")) {
    const match = /^## \[(\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?/.exec(
      line,
    );
    if (match) return { version: match[1]!, date: match[2] };
  }
  throw new Error("CHANGELOG.md has no released version");
}

/** The "Facts" block at the top of `llms.txt` and `llms-full.txt`: short,
 * dated statements a model can quote instead of guessing from an old
 * snapshot. The command list comes from the command registry. */
export function llmsFacts(
  facts: SiteFacts,
  commands: readonly string[],
): string[] {
  const released = facts.date ? `, released ${facts.date}` : "";
  return [
    "## Facts",
    "",
    `- Latest version: ${facts.version}${released}. Changelog: https://github.com/GroophyLifefor/co-maintainer/blob/main/CHANGELOG.md`,
    "- License: MIT. Source: https://github.com/GroophyLifefor/co-maintainer",
    "- Install: `npm install -g co-maintainer`. Needs Node 24 or newer.",
    `- Commands: ${commands.map((name) => `\`${name}\``).join(", ")}. \`sync\` keeps the review guides up to date (its old name was \`remake\`).`,
    "- AI providers: OpenRouter, OpenAI, Anthropic and OpenCode, on your own model key.",
    "- Git platform: GitHub only.",
    "- Runs as a CLI on your machine, in CI, or as a self-hosted GitHub App with `serve`. A hosted service runs `serve` at cloud.co-maintainer.com.",
    `- Compared with CodeRabbit: ${SITE_ORIGIN}/vs/coderabbit.html`,
    "",
  ];
}

/** `llms.txt` (llmstxt.org): the title, one summary line, the facts, and a
 * link to the Markdown copy of every page, grouped the way the sidebar is. */
export function llmsTxt(facts?: string[]): string {
  const lines = [
    `# co-maintainer`,
    "",
    `> ${LLMS_SUMMARY}`,
    "",
    ...(facts ?? []),
  ];
  for (const section of NAV) {
    lines.push(`## ${section.title}`, "");
    for (const { slug, label } of section.items) {
      lines.push(`- [${label}](${SITE_ORIGIN}/docs/${slug}.md)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** `llms-full.txt`: the same content as `llms.txt`, with every page's Markdown
 * inlined below its link so a model can read the whole site in one request. */
export function llmsFullTxt(
  pages: ReadonlyArray<{ slug: string; md: string }>,
  facts?: string[],
): string {
  const lines = [
    `# co-maintainer`,
    "",
    `> ${LLMS_SUMMARY}`,
    "",
    ...(facts ?? []),
  ];
  for (const { slug, md } of pages) {
    lines.push(
      `---`,
      "",
      `Source: ${SITE_ORIGIN}/docs/${slug}.md`,
      "",
      md.trim(),
      "",
    );
  }
  return lines.join("\n");
}

/** The `commands.md` page, generated from the command registry. */
export function commandsMarkdown(): string {
  return `# Commands

Reference for every visible command. This page is generated from the command
registry in the source, so it always matches \`co-maintainer help\` and
\`co-maintainer help <command>\`.

${registryToMarkdown()}
See [Configuration](configuration.md) for the \`config.json\` keys, and
[Troubleshooting](troubleshooting.md) for a failing command.
`;
}

/** Rewrites every `<!-- permissions:KIND:start -->` block from
 * `permissionTable`, so a permission table cannot drift from the code. */
export function applyPermissionBlocks(md: string): string {
  return md.replace(
    /<!-- permissions:([a-z-]+):start -->[\s\S]*?<!-- permissions:\1:end -->/g,
    (_, kind: string) =>
      `<!-- permissions:${kind}:start -->\n${permissionTable(kind as TableKind)}\n<!-- permissions:${kind}:end -->`,
  );
}

/** The old flat addresses, and where each one points now. `remake` was the
 * name this page had before it was renamed, and its address must keep resolving. */
export const LEGACY_REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
  ...ALL_PAGES.map(({ slug }) => ({ from: slug, to: slug })),
  { from: "remake", to: "sync" },
];

/** Pages that left the docs for a hand written page at the site root, like
 * the landing page. Their old `docs/<slug>.html` address stays as a stub that
 * points there, and the sitemap lists the root page instead. */
export const MOVED_TO_ROOT: readonly string[] = ["privacy"];

const GITHUB_REPO = "https://github.com/GroophyLifefor/co-maintainer";
const DOCS_EDIT_BRANCH = "main";

/** A doc page reaches the shared assets through this prefix. */
const ASSET_PREFIX = "../assets/";
/** A doc page reaches the landing page through this prefix. */
const HOME_HREF = "../index.html";

marked.setOptions({ gfm: true });

export function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}

/** The first real paragraph of a page, as a plain sentence for `<meta
 * description>`. Markdown is stripped so the tag reads as prose, and the text
 * is cut at a word boundary near 155 characters, the length search engines
 * show. */
export function pageDescription(md: string): string {
  const withoutFences = md.replace(/```[\s\S]*?```/g, "");
  for (const block of withoutFences.split(/\r?\n\s*\r?\n/)) {
    const paragraph = block.trim();
    if (paragraph === "" || /^#{1,6}\s/.test(paragraph)) continue;
    if (/^[|>-]/.test(paragraph)) continue;
    const plain = paragraph
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (plain === "") continue;
    if (plain.length <= 155) return plain;
    const cut = plain.slice(0, 155);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
  }
  return "co-maintainer documentation.";
}

/** Markdown ```mermaid fences become placeholders, then figures after marked (blank lines break raw HTML). */
export function extractMermaidFences(md: string): {
  md: string;
  slots: string[];
} {
  const slots: string[] = [];
  const stripped = md.replace(
    /```mermaid(?:[ \t]+zoom)?[ \t]*\r?\n([\s\S]*?)```/g,
    (_match, body: string) => {
      const id = slots.length;
      slots.push(body.trim());
      return `\n\n<!--cm-mermaid-${id}-->\n\n`;
    },
  );
  return { md: stripped, slots };
}

function mermaidInHtml(source: string): string {
  return source.replace(/<\/div>/gi, "&lt;/div&gt;");
}

function renderMermaidFigure(source: string): string {
  return `<figure class="mermaid-figure">
<div class="mermaid-viewport"><div class="mermaid">${mermaidInHtml(source)}</div></div>
</figure>`;
}

function injectMermaidSlots(html: string, slots: string[]): string {
  let out = html;
  for (let i = 0; i < slots.length; i++) {
    const figure = renderMermaidFigure(slots[i]);
    const marker = `<!--cm-mermaid-${i}-->`;
    out = out.replace(`<p>${marker}</p>`, figure);
    out = out.replace(marker, figure);
  }
  return out;
}

function decodeMermaidEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function mermaidBlocks(html: string): string {
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_match, raw: string) => {
      const text = decodeMermaidEntities(raw).trim();
      return renderMermaidFigure(text);
    },
  );
}

const MERMAID_CDN =
  "https://cdn.jsdelivr.net/npm/mermaid@11.4.0/dist/mermaid.min.js";

/** One-time vendor file so docs work without a CDN at view time. `fetch` is
 * off in a test build, which must not reach the network. */
async function ensureMermaidBundle(
  assetsDir: URL,
  download: boolean,
): Promise<void> {
  const out = new URL("mermaid.min.js", assetsDir);
  try {
    await stat(out);
    return;
  } catch {
    /* download below */
  }
  if (!download) return;
  const resp = await fetch(MERMAID_CDN);
  if (!resp.ok) {
    throw new Error(`Failed to download mermaid: HTTP ${resp.status}`);
  }
  await writeFile(out, new Uint8Array(await resp.arrayBuffer()));
  console.log("wrote assets/mermaid.min.js");
}

function highlightShellTail(tail: string): string {
  return tail.replace(
    /(\s+)|(#.*)|(--[\w-]+(?:=[^\s\\]*)?)|([^\s#]+)/g,
    (part, ws, comment, flag, word) => {
      if (ws !== undefined) return ws;
      if (comment !== undefined) {
        return `<span class="sh-comment">${esc(comment)}</span>`;
      }
      if (flag !== undefined) {
        return `<span class="sh-flag">${esc(flag)}</span>`;
      }
      if (word !== undefined) {
        return `<span class="sh-arg">${esc(word)}</span>`;
      }
      return esc(part);
    },
  );
}

function highlightShellLine(line: string): string {
  const cm = line.match(/^(\s*)co-maintainer(\s+)(\S+)(.*)$/);
  if (cm) {
    return `${esc(cm[1])}<span class="sh-cli">co-maintainer</span>${esc(cm[2])}<span class="sh-cmd">${esc(cm[3])}</span>${highlightShellTail(cm[4])}`;
  }
  if (/^\s*#/.test(line)) {
    return `<span class="sh-comment">${esc(line)}</span>`;
  }
  if (/--/.test(line)) {
    const lead = line.match(/^(\s*)/)?.[1] ?? "";
    const rest = line.slice(lead.length);
    return esc(lead) + highlightShellTail(rest);
  }
  return esc(line);
}

function highlightShellCode(source: string): string {
  return source.split("\n").map(highlightShellLine).join("\n");
}

function highlightShellBlocks(html: string): string {
  return html.replace(
    /<pre><code class="language-(?:sh|bash|shell)">([\s\S]*?)<\/code><\/pre>/g,
    (_match, raw: string) => {
      const code = decodeMermaidEntities(raw);
      return `<pre class="shell-block"><code>${highlightShellCode(code)}</code></pre>`;
    },
  );
}

function rewriteMdLinks(html: string): string {
  return html.replace(
    /href="([^"]+\.md)(#[^"]*)?"/g,
    (_match, path: string, hash = "") => {
      if (path.startsWith("http") || path.startsWith("/")) return _match;
      return `href="${path.replace(/\.md$/, ".html")}${hash}"`;
    },
  );
}

/** Docs prose must not use em dashes or semicolons (code fences excluded). */
export function lintDocMd(md: string, name: string): void {
  const prose = md.replace(/```[\s\S]*?```/g, "");
  if (/\u2014/.test(prose)) {
    throw new Error(`${name}: em dash is not allowed in docs`);
  }
  if (/;/.test(prose)) {
    throw new Error(`${name}: semicolon is not allowed in docs prose`);
  }
}

function fixMdSourceLinks(md: string): string {
  return md.replace(
    /\]\(([^)]+\.md)(#[^)]*)?\)/g,
    (match, path: string, hash = "") => {
      if (path.startsWith("http")) return match;
      const base = path.replace(/^\.\//, "").replace(/^md\//, "");
      return `](${base}${hash})`;
    },
  );
}

/** A heading's plain text: tags dropped and the entities marked emits decoded,
 * so `&#39;` and `&amp;` do not leak into an id or the table of contents. */
function headingText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildToc(bodyHtml: string): {
  html: string;
  toc: string;
  headings: Heading[];
} {
  const headings: Heading[] = [];
  // The commands page repeats headings such as `### AI` under every command, so
  // the same id would appear several times and collapse deep links and search
  // results onto the first one. A later duplicate gets a `-2`, `-3`, suffix.
  const used = new Map<string, number>();
  const withIds = bodyHtml.replace(
    /<h([23])>([\s\S]*?)<\/h\1>/g,
    (_m, level: string, raw: string) => {
      const text = headingText(raw);
      const base = headingId(text);
      if (!base) return `<h${level}>${raw}</h${level}>`;
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen + 1}`;
      headings.push({ id, text, level: Number(level) });
      return `<h${level} id="${esc(id)}">${raw}</h${level}>`;
    },
  );
  const tocHeadings = headings.filter((h) => h.level === 2);
  if (tocHeadings.length < 2) {
    return { html: withIds, toc: "", headings };
  }
  const toc =
    `<nav class="toc" aria-label="On this page">
      <p class="toc-title">On this page</p>
      <ul>` +
    tocHeadings
      .map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
      .join("") +
    `</ul></nav>`;
  return { html: withIds, toc, headings };
}

function siteBrandLink(): string {
  return `<a class="brand site-brand" href="${HOME_HREF}"><img src="${ASSET_PREFIX}logo.png" alt="" width="32" height="32">co-maintainer</a>`;
}

function topBar(active: "home" | "docs"): string {
  const docsClass = active === "docs" ? "toplink on" : "toplink";
  return `<header class="site-header">
    <div class="site-header-inner">
      ${siteBrandLink()}
      <nav class="topnav" aria-label="Site">
        <a class="${docsClass}" href="getting-started.html">Documentation</a>
        <a class="toplink" href="https://www.npmjs.com/package/co-maintainer">npm</a>
        <a class="toplink" href="https://github.com/GroophyLifefor/co-maintainer" data-umami-event="click-github">GitHub</a>
      </nav>
      <button type="button" class="sidebar-toggle" aria-label="Open menu" hidden></button>
    </div>
  </header>`;
}

function sidebarHtml(activeSlug: string): string {
  const blocks = NAV.map((section) => {
    const items = section.items
      .map(({ slug, label }) => {
        const cls = slug === activeSlug ? ' class="active"' : "";
        return `<li><a href="${slug}.html"${cls}>${esc(label)}</a></li>`;
      })
      .join("\n          ");
    return `<div class="nav-section">
          <p class="nav-section-title">${esc(section.title)}</p>
          <ul class="nav-list">
          ${items}
          </ul>
        </div>`;
  }).join("\n        ");
  return `<aside class="sidebar" id="sidebar">
      <div class="sidebar-scroll">
        <div class="search">
          <label class="search-label" for="doc-search">Search docs</label>
          <input id="doc-search" type="search" class="search-input"
            placeholder="Search docs" autocomplete="off" spellcheck="false"
            aria-controls="search-results" aria-expanded="false">
          <ul id="search-results" class="search-results" hidden></ul>
        </div>
        ${blocks}
      </div>
    </aside>`;
}

export function docPageShell(
  title: string,
  bodyHtml: string,
  toc: string,
  activeSlug: string,
  description: string,
): string {
  const canonical = `${SITE_ORIGIN}/docs/${activeSlug}.html`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · co-maintainer docs</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="${ASSET_PREFIX}site.css">
  <link rel="icon" href="${ASSET_PREFIX}logo.png">
  <script defer src="https://umami.ordu.dev/script.js" data-website-id="5c8e6df5-063d-4031-9eb6-f43138e09e2d"></script>
  <script defer src="https://umami.ordu.dev/recorder.js" data-website-id="5c8e6df5-063d-4031-9eb6-f43138e09e2d"></script>
</head>
<body class="layout-doc">
  ${topBar("docs")}
  <div class="layout-body">
    ${sidebarHtml(activeSlug)}
    <div class="content-column">
      <main class="doc-main">
        <article class="markdown prose">${bodyHtml}</article>
        <footer class="doc-footer">
          <a href="${GITHUB_REPO}/edit/${DOCS_EDIT_BRANCH}/docs/md/${activeSlug}.md" data-umami-event="click-github">Edit this page</a> on GitHub
          · <a href="https://buttondown.com/murat" data-umami-event="newsletter-click">Get the newsletter</a>
        </footer>
      </main>
      ${toc}
    </div>
  </div>
  <script src="${ASSET_PREFIX}docs.js"></script>
  <script src="${ASSET_PREFIX}mermaid.min.js"></script>
  <script src="${ASSET_PREFIX}mermaid-init.js"></script>
</body>
</html>`;
}

/** The redirect stub that now lives at an old flat address. It carries a meta
 * refresh for people, a canonical link for crawlers, and a visible link so a
 * reader without either still finds the page. */
export function redirectStub(from: string, to: string): string {
  const target = `docs/${to}.html`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Moved · co-maintainer docs</title>
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0; url=${target}">
  <link rel="canonical" href="${SITE_ORIGIN}/${target}">
</head>
<body>
  <p>This page moved to <a href="${target}">${target}</a>.</p>
</body>
</html>`;
}

/** The stub left at `docs/<slug>.html` for a page in MOVED_TO_ROOT. It sits in
 * the docs folder, so it reaches the root page through `../`. */
export function movedToRootStub(slug: string): string {
  const target = `../${slug}.html`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Moved · co-maintainer</title>
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0; url=${target}">
  <link rel="canonical" href="${SITE_ORIGIN}/${slug}.html">
</head>
<body>
  <p>This page moved to <a href="${target}">${slug}.html</a>.</p>
</body>
</html>`;
}

/** Hand written pages outside the docs, besides the ones in `MOVED_TO_ROOT`,
 * listed in the sitemap by their path under the site root. */
export const HAND_PAGES: readonly string[] = ["vs/coderabbit", "trust"];

/** Every indexable address, for sitemap.xml: the landing page, the hand
 * written root pages, then every doc page. `lastmod` names the date a page's
 * source last changed, by its path under `docs/` (`index.html`,
 * `privacy.html`, `md/init.md`), and an entry without one has no date. */
export function sitemapXml(
  slugs: readonly string[],
  rootPages: readonly string[] = [],
  lastmod: (source: string) => string | undefined = () => undefined,
): string {
  const urls: Array<{ url: string; source: string }> = [
    { url: `${SITE_ORIGIN}/`, source: "index.html" },
  ];
  for (const page of rootPages) {
    urls.push({ url: `${SITE_ORIGIN}/${page}.html`, source: `${page}.html` });
  }
  for (const slug of slugs) {
    urls.push({
      url: `${SITE_ORIGIN}/docs/${slug}.html`,
      source: `md/${slug}.md`,
    });
  }
  const entries = urls.map(({ url, source }) => {
    const date = lastmod(source);
    return `  <url><loc>${esc(url)}</loc>${date ? `<lastmod>${date}</lastmod>` : ""}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}

/** The date a file under `docs/` last changed: today when it has changes
 * that are not committed, otherwise the date of the last commit that touched
 * it. Without git, or for a file git does not know, there is no date. */
export function gitLastModified(
  docsDir: string,
  source: string,
  today = new Date().toISOString().slice(0, 10),
): string | undefined {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: docsDir, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  const changed = git(["status", "--porcelain", "--", source]);
  if (changed === undefined) return undefined;
  if (changed !== "") return today;
  const date = git(["log", "-1", "--format=%cs", "--", source]);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

/** robots.txt: every crawler may read the whole site, AI crawlers named
 * too, and the sitemap is announced. */
export function robotsTxt(): string {
  const groups = [
    "*",
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-SearchBot",
    "PerplexityBot",
    "Google-Extended",
  ].map((agent) => `User-agent: ${agent}\nAllow: /\n`);
  return `${groups.join("\n")}\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;
}

/** The marked block in the landing page that the build fills: canonical,
 * Open Graph and Twitter tags, and the JSON-LD facts. */
const LANDING_SEO = /<!-- seo:start -->[\s\S]*?<!-- seo:end -->/;

export function landingSeoBlock(facts: SiteFacts, faq = ""): string {
  const title =
    "co-maintainer · open source AI code review that learns your repo";
  const description =
    "An open source PR reviewer that learns how your repository is reviewed from its code and past PR reviews, then reviews like that, on your own model key.";
  const image = `${SITE_ORIGIN}/assets/og.png`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "co-maintainer",
    description,
    url: `${SITE_ORIGIN}/`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Linux, macOS, Windows",
    softwareVersion: facts.version,
    ...(facts.date ? { dateModified: facts.date } : {}),
    license: "https://opensource.org/licenses/MIT",
    codeRepository: "https://github.com/GroophyLifefor/co-maintainer",
    downloadUrl: "https://www.npmjs.com/package/co-maintainer",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
  return [
    "<!-- seo:start -->",
    `<link rel="canonical" href="${SITE_ORIGIN}/">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="co-maintainer">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${SITE_ORIGIN}/">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="co-maintainer logo with npm install -g co-maintainer">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${image}">`,
    `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    ...(faq ? [faq] : []),
    "<!-- seo:end -->",
  ].join("\n");
}

/** The landing page with its marked block filled. A page without the
 * markers is returned as it is. */
export function applyLandingSeo(html: string, facts: SiteFacts): string {
  return html.replace(LANDING_SEO, () =>
    landingSeoBlock(facts, faqJsonLd(html)),
  );
}

/** The questions of the landing page's FAQ section: each `<summary>` with
 * the `<p class="faq-a">` after it, as plain text. The "More:" links sit in
 * their own element and are left out. */
export function faqEntries(
  html: string,
): Array<{ question: string; answer: string }> {
  const section = /<section class="faq"[\s\S]*?<\/section>/.exec(html)?.[0];
  if (!section) return [];
  const plain = (text: string) =>
    text
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  const entries: Array<{ question: string; answer: string }> = [];
  for (const item of section.matchAll(
    /<summary>([\s\S]*?)<\/summary>[\s\S]*?<p class="faq-a">([\s\S]*?)<\/p>/g,
  )) {
    entries.push({ question: plain(item[1]!), answer: plain(item[2]!) });
  }
  return entries;
}

/** The FAQPage JSON-LD of the landing page, from its own FAQ section, so the
 * structured copy can never say something the page does not. Empty when the
 * page has no questions. */
export function faqJsonLd(html: string): string {
  const entries = faqEntries(html);
  if (entries.length === 0) return "";
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map(({ question, answer }) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: { "@type": "Answer", text: answer },
    })),
  };
  // `<` is escaped, so no answer can close the script tag.
  return `<script type="application/ld+json">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>`;
}

/** A few words after a page's name in its `<title>`, for pages whose name
 * alone matches no search. */
export const TITLE_TAGLINES: Readonly<Record<string, string>> = {
  init: "build review guides from your PR history",
  sync: "keep review guides up to date",
  probe: "estimate cost before you run",
};

export type BuildOptions = {
  /** Where the site is written. Defaults to the repository `docs/` folder. */
  outDir?: URL;
  /** Download the vendored Mermaid bundle when it is missing. A test build
   * passes false so it never reaches the network. */
  fetchAssets?: boolean;
  /** Suppress the per-page progress line. */
  quiet?: boolean;
};

/** Builds every page, stub, and the sitemap into `outDir`. */
export async function buildDocs(options: BuildOptions = {}): Promise<void> {
  const out = options.outDir ?? DEFAULT_OUT;
  const downloadAssets = options.fetchAssets ?? true;
  const log = options.quiet ? () => {} : (line: string) => console.log(line);

  const assetsDir = new URL("assets/", out);
  const pagesDir = new URL("docs/", out);
  await mkdir(assetsDir, { recursive: true });
  await mkdir(pagesDir, { recursive: true });
  await ensureMermaidBundle(assetsDir, downloadAssets);
  await writeFile(new URL("logo.png", assetsDir), logo);
  await writeFile(new URL(".nojekyll", out), new Uint8Array());
  await writeTextFile(new URL("CNAME", out), `${CNAME}\n`);

  // The command reference is generated from the registry, so a flag that
  // changes in the code cannot drift out of the docs.
  await writeTextFile(new URL("commands.md", MD_DIR), commandsMarkdown());
  log("wrote md/commands.md");

  const searchEntries: SearchEntry[] = [];
  const builtPages: Array<{ slug: string; md: string }> = [];
  for (const { slug } of ALL_PAGES) {
    const mdPath = new URL(`${slug}.md`, MD_DIR);
    const source = await readTextFile(mdPath);
    let md = applySchemaBlock(applyPermissionBlocks(source));
    if (md !== source) await writeTextFile(mdPath, md);
    lintDocMd(md, `${slug}.md`);
    md = fixMdSourceLinks(md);
    // The `.md` copy sits beside the `.html`, so `/docs/<slug>.md` resolves on
    // the deployed site and `llms.txt` can link straight to it.
    await writeTextFile(new URL(`${slug}.md`, pagesDir), md);
    builtPages.push({ slug, md });
    const description = pageDescription(md);
    const { md: mdNoMermaid, slots } = extractMermaidFences(md);
    const raw = await marked.parse(mdNoMermaid);
    const withMermaid = injectMermaidSlots(
      mermaidBlocks(rewriteMdLinks(String(raw))),
      slots,
    );
    const {
      html: body,
      toc,
      headings,
    } = buildToc(highlightShellBlocks(withMermaid));
    searchEntries.push(...searchEntriesFor(slug, headings));
    const titleMatch = md.match(/^#\s+`?([^`\n]+)`?/);
    const name = titleMatch?.[1]?.trim() ?? slug;
    const tagline = TITLE_TAGLINES[slug];
    const title = tagline ? `${name}: ${tagline}` : name;
    const html = docPageShell(title, body, toc, slug, description);
    await writeTextFile(new URL(`${slug}.html`, pagesDir), html);
    log(`wrote docs/${slug}.html`);
  }

  await writeTextFile(
    new URL("search-index.json", pagesDir),
    searchJson(searchEntries),
  );
  log("wrote docs/search-index.json");

  // The release facts come from CHANGELOG.md, so the site states the
  // version that was released, with its date.
  const facts = siteFacts(
    await readTextFile(new URL("../CHANGELOG.md", import.meta.url)),
  );
  const factLines = llmsFacts(facts, visibleCommandNames());

  // The model-readable copies: a short index and one combined file.
  await writeTextFile(new URL("llms.txt", out), llmsTxt(factLines));
  log("wrote llms.txt");
  await writeTextFile(
    new URL("llms-full.txt", out),
    llmsFullTxt(builtPages, factLines),
  );
  log("wrote llms-full.txt");

  await writeTextFile(new URL("robots.txt", out), robotsTxt());
  log("wrote robots.txt");

  // The landing page is hand written. Only its marked block is filled here,
  // and an output folder without it (a test build) is left alone.
  const landing = new URL("index.html", out);
  if (await exists(landing)) {
    const html = await readTextFile(landing);
    const filled = applyLandingSeo(html, facts);
    if (filled !== html) {
      await writeTextFile(landing, filled);
      log("wrote index.html (seo block)");
    }
  }

  for (const { from, to } of LEGACY_REDIRECTS) {
    await writeTextFile(new URL(`${from}.html`, out), redirectStub(from, to));
    log(`wrote ${from}.html (redirect to docs/${to}.html)`);
  }

  for (const slug of MOVED_TO_ROOT) {
    await writeTextFile(
      new URL(`${slug}.html`, pagesDir),
      movedToRootStub(slug),
    );
    log(`wrote docs/${slug}.html (redirect to ${slug}.html)`);
  }

  await writeTextFile(
    new URL("sitemap.xml", out),
    sitemapXml(
      ALL_PAGES.map(({ slug }) => slug),
      [...MOVED_TO_ROOT, ...HAND_PAGES],
      // Dates come from the sources in the repository's docs/ folder, also
      // for a test build, which writes elsewhere.
      (source) => gitLastModified(fileURLToPath(DEFAULT_OUT), source),
    ),
  );
  log("wrote sitemap.xml");
}

async function exists(url: URL): Promise<boolean> {
  try {
    await stat(url);
    return true;
  } catch {
    return false;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await buildDocs();
}
