/**
 * Build static HTML docs under docs/ from docs/md/*.md
 * Run: npm run docs:build
 */
import { marked } from "marked";
import { logo } from "../src/server/logo.ts";
import { mkdir, readTextFile, stat, writeFile } from "../src/util/runtime.ts";

const ROOT = new URL("../docs/", import.meta.url);
const MD_DIR = new URL("md/", ROOT);

type NavItem = { slug: string; label: string };
type NavSection = { title: string; items: NavItem[] };

/** Sidebar groups. Add pages here. Top bar stays minimal. */
const NAV: NavSection[] = [
  {
    title: "Getting started",
    items: [
      { slug: "getting-started", label: "Quickstart" },
      { slug: "probe", label: "Probe" },
      { slug: "init", label: "Init" },
      { slug: "remake", label: "Remake" },
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
    ],
  },
  {
    title: "Reference",
    items: [
      { slug: "configuration", label: "Configuration" },
      { slug: "authentication", label: "Authentication" },
      { slug: "caching", label: "Caching" },
    ],
  },
];

const ALL_PAGES: NavItem[] = NAV.flatMap((s) => s.items);

const GITHUB_REPO = "https://github.com/GroophyLifefor/co-maintainer";
const DOCS_EDIT_BRANCH = "main";

marked.setOptions({ gfm: true });

function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}

/** Markdown ```mermaid fences become placeholders, then figures after marked (blank lines break raw HTML). */
function extractMermaidFences(md: string): { md: string; slots: string[] } {
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

/** One-time vendor file so docs work without a CDN at view time. */
async function ensureMermaidBundle(assetsDir: URL): Promise<void> {
  const out = new URL("mermaid.min.js", assetsDir);
  try {
    await stat(out);
    return;
  } catch {
    /* download below */
  }
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
function lintDocMd(md: string, name: string): void {
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

function buildToc(bodyHtml: string): { html: string; toc: string } {
  const headings: { id: string; text: string }[] = [];
  const withIds = bodyHtml.replace(
    /<h([23])>([\s\S]*?)<\/h\1>/g,
    (_m, level: string, raw: string) => {
      const text = raw.replace(/<[^>]+>/g, "").trim();
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-");
      if (level === "2" && id) headings.push({ id, text });
      return `<h${level} id="${esc(id)}">${raw}</h${level}>`;
    },
  );
  if (headings.length < 2) {
    return { html: withIds, toc: "" };
  }
  const toc =
    `<nav class="toc" aria-label="On this page">
      <p class="toc-title">On this page</p>
      <ul>` +
    headings
      .map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
      .join("") +
    `</ul></nav>`;
  return { html: withIds, toc };
}

function siteBrandLink(): string {
  return `<a class="brand site-brand" href="index.html"><img src="assets/logo.png" alt="" width="32" height="32">co-maintainer</a>`;
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
        ${blocks}
      </div>
    </aside>`;
}

function docPageShell(
  title: string,
  bodyHtml: string,
  toc: string,
  activeSlug: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · co-maintainer docs</title>
  <link rel="stylesheet" href="assets/site.css">
  <link rel="icon" href="assets/logo.png">
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
  <script src="assets/docs.js"></script>
  <script src="assets/mermaid.min.js"></script>
  <script src="assets/mermaid-init.js"></script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const assetsDir = new URL("assets/", ROOT);
  await mkdir(assetsDir, { recursive: true });
  await ensureMermaidBundle(assetsDir);
  await writeFile(new URL("logo.png", assetsDir), logo);
  await writeFile(new URL(".nojekyll", ROOT), new Uint8Array());

  for (const { slug } of ALL_PAGES) {
    const mdPath = new URL(`${slug}.md`, MD_DIR);
    let md = await readTextFile(mdPath);
    lintDocMd(md, `${slug}.md`);
    md = fixMdSourceLinks(md);
    const { md: mdNoMermaid, slots } = extractMermaidFences(md);
    const raw = await marked.parse(mdNoMermaid);
    const withMermaid = injectMermaidSlots(
      mermaidBlocks(rewriteMdLinks(String(raw))),
      slots,
    );
    const { html: body, toc } = buildToc(highlightShellBlocks(withMermaid));
    const titleMatch = md.match(/^#\s+`?([^`\n]+)`?/);
    const title = titleMatch?.[1]?.trim() ?? slug;
    const html = docPageShell(title, body, toc, slug);
    await writeFile(
      new URL(`${slug}.html`, ROOT),
      new TextEncoder().encode(html),
    );
    console.log(`wrote ${slug}.html`);
  }
}

await main();
