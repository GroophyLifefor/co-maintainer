/**
 * Build static HTML docs under docs/ from docs/md/*.md
 * Run: npm run docs:build
 *
 * Layout for co-maintainer.com (CORE-80 / D04, D05):
 *   docs/index.html          the landing page (hand written, not built here)
 *   docs/docs/<slug>.html    one page per docs/md/<slug>.md
 *   docs/docs/<slug>.md      the Markdown copy of that page (CORE-84)
 *   docs/docs/search-index.json  the client-side search rows
 *   docs/<slug>.html         a redirect stub for the old flat address
 *   docs/CNAME               the custom domain
 *   docs/sitemap.xml         every page under the apex domain
 *   docs/llms.txt            the llmstxt.org index (CORE-84)
 *   docs/llms-full.txt       every page combined for a model (CORE-84)
 *
 * Assets stay at docs/assets/, so a doc page reaches them through `../`.
 */
import { marked } from "marked";
import { pathToFileURL } from "node:url";
import { registryToMarkdown } from "../src/cli/commands/registry.ts";
import { logo } from "../src/server/logo.ts";
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
      { slug: "local-pr-review", label: "PR review" },
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
      { slug: "authentication", label: "Authentication" },
      { slug: "caching", label: "Caching" },
      { slug: "cost", label: "Cost" },
      { slug: "privacy", label: "Data and privacy" },
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

/** The one-sentence summary at the top of `llms.txt` (CORE-84). */
export const LLMS_SUMMARY =
  "co-maintainer learns a GitHub repository from its code, pull requests, and history, then reviews pull requests and local changes against that knowledge.";

/** `llms.txt` (llmstxt.org): the title, one summary line, and a link to the
 * Markdown copy of every page, grouped the way the sidebar is. */
export function llmsTxt(): string {
  const lines = [`# co-maintainer`, "", `> ${LLMS_SUMMARY}`, ""];
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
): string {
  const lines = [`# co-maintainer`, "", `> ${LLMS_SUMMARY}`, ""];
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

/** The `commands.md` page, generated from the command registry (CORE-81). */
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

/** The old flat addresses, and where each one points now. `remake` was the
 * name this page had before CORE-21, and its address must keep resolving. */
export const LEGACY_REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
  ...ALL_PAGES.map(({ slug }) => ({ from: slug, to: slug })),
  { from: "remake", to: "sync" },
];

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
  if (/—/.test(prose)) {
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
  const withIds = bodyHtml.replace(
    /<h([23])>([\s\S]*?)<\/h\1>/g,
    (_m, level: string, raw: string) => {
      const text = headingText(raw);
      const id = headingId(text);
      if (id) headings.push({ id, text, level: Number(level) });
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
        <a class="toplink" href="https://github.com/GroophyLifefor/co-maintainer">GitHub</a>
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
</head>
<body class="layout-doc">
  ${topBar("docs")}
  <div class="layout-body">
    ${sidebarHtml(activeSlug)}
    <div class="content-column">
      <main class="doc-main">
        <article class="markdown prose">${bodyHtml}</article>
        <footer class="doc-footer">
          <a href="${GITHUB_REPO}/edit/${DOCS_EDIT_BRANCH}/docs/md/${activeSlug}.md">Edit this page</a> on GitHub
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

/** Every indexable address, for sitemap.xml. */
export function sitemapXml(slugs: readonly string[]): string {
  const urls = [`${SITE_ORIGIN}/`];
  for (const slug of slugs) urls.push(`${SITE_ORIGIN}/docs/${slug}.html`);
  const entries = urls.map((url) => `  <url><loc>${esc(url)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}

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
    let md = await readTextFile(mdPath);
    lintDocMd(md, `${slug}.md`);
    md = fixMdSourceLinks(md);
    // The `.md` copy sits beside the `.html`, so `/docs/<slug>.md` resolves on
    // the deployed site and `llms.txt` can link straight to it (CORE-84).
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
    const title = titleMatch?.[1]?.trim() ?? slug;
    const html = docPageShell(title, body, toc, slug, description);
    await writeTextFile(new URL(`${slug}.html`, pagesDir), html);
    log(`wrote docs/${slug}.html`);
  }

  await writeTextFile(
    new URL("search-index.json", pagesDir),
    searchJson(searchEntries),
  );
  log("wrote docs/search-index.json");

  // The model-readable copies (CORE-84): a short index and one combined file.
  await writeTextFile(new URL("llms.txt", out), llmsTxt());
  log("wrote llms.txt");
  await writeTextFile(new URL("llms-full.txt", out), llmsFullTxt(builtPages));
  log("wrote llms-full.txt");

  for (const { from, to } of LEGACY_REDIRECTS) {
    await writeTextFile(new URL(`${from}.html`, out), redirectStub(from, to));
    log(`wrote ${from}.html (redirect to docs/${to}.html)`);
  }

  await writeTextFile(
    new URL("sitemap.xml", out),
    sitemapXml(ALL_PAGES.map(({ slug }) => slug)),
  );
  log("wrote sitemap.xml");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await buildDocs();
}
