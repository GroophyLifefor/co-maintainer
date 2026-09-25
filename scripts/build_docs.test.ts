/** The doc site layout (CORE-80 / D04, D05).
 *
 * co-maintainer.com is one origin. The landing page stays at the root and the
 * pages move under `/docs/`, so the site has a single identity and the old flat
 * addresses keep working through a redirect stub. This builds the site into a
 * temp directory and checks what a broken build would break silently: every
 * page carries a description and a canonical link, every old address is a stub
 * that points at the new one, and no internal link in the built HTML is dead.
 */
import { test } from "node:test";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  makeTempDir,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  writeFile,
} from "../src/util/runtime.ts";
import {
  buildDocs,
  CNAME,
  commandsMarkdown,
  LEGACY_REDIRECTS,
  LLMS_SUMMARY,
  SITE_ORIGIN,
  sitemapXml,
} from "./build_docs.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docsRoot = join(projectRoot, "docs");

/** Copies the hand-maintained files the build does not regenerate, so a temp
 * build is the same shape as the deployed tree. */
async function copyStatic(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for await (const entry of readDir(from)) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory) await copyStatic(source, target);
    else if (entry.isFile) await writeFile(target, await readFile(source));
  }
}

async function buildInto(): Promise<string> {
  const outDir = await makeTempDir({ prefix: "cm-docs-" });
  await writeFile(
    join(outDir, "index.html"),
    await readFile(join(docsRoot, "index.html")),
  );
  await copyStatic(join(docsRoot, "assets"), join(outDir, "assets"));
  await buildDocs({
    outDir: new URL(`file://${outDir.replaceAll("\\", "/")}/`),
    fetchAssets: false,
    quiet: true,
  });
  return outDir;
}

/** Every `.html` under a directory. */
async function htmlFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) found.push(...(await htmlFiles(path)));
    else if (entry.isFile && entry.name.endsWith(".html")) found.push(path);
  }
  return found;
}

/** Internal links with no file behind them, for a set of pages read from
 * `root`. Assets are served from the same tree, so they must resolve too. A
 * `page.html#anchor` is checked against the anchor's `id` in that page, so a
 * renamed heading cannot leave a silent dead link behind. */
async function deadLinks(
  root: string,
  files: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    const html = await readTextFile(file);
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (
        href.startsWith("http") ||
        href.startsWith("#") ||
        href.startsWith("mailto:")
      ) {
        continue;
      }
      const [path, hash] = href.split("#");
      if (path === "") continue;
      const target = join(dirname(file), path);
      if (!existsSync(target)) {
        missing.push(`${relative(root, file)} -> ${href}`);
        continue;
      }
      if (hash && path.endsWith(".html")) {
        const targetHtml = await readTextFile(target);
        if (!targetHtml.includes(`id="${hash}"`)) {
          missing.push(`${relative(root, file)} -> ${href} (no such anchor)`);
        }
      }
    }
  }
  return missing;
}

test("every page is written under docs/ with a description and canonical", async () => {
  const outDir = await buildInto();
  try {
    const pages = await htmlFiles(join(outDir, "docs"));
    if (pages.length !== 20) {
      throw new Error(`expected 20 doc pages, found ${pages.length}`);
    }
    for (const page of pages) {
      const html = await readTextFile(page);
      if (!html.includes('name="description"')) {
        throw new Error(`${page} has no meta description`);
      }
      const slug = basename(page).replace(".html", "");
      const canonical = `${SITE_ORIGIN}/docs/${slug}.html`;
      if (!html.includes('rel="canonical"')) {
        throw new Error(`${page} has no canonical link`);
      }
      if (!html.includes(canonical)) {
        throw new Error(`${page} canonical is not ${canonical}`);
      }
      if (!html.includes('href="../assets/site.css"')) {
        throw new Error(`${page} does not reach the shared assets`);
      }
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("CNAME and sitemap are written", async () => {
  const outDir = await buildInto();
  try {
    const cname = await readTextFile(join(outDir, "CNAME"));
    if (cname.trim() !== CNAME) {
      throw new Error(`CNAME was "${cname.trim()}", wanted ${CNAME}`);
    }
    const sitemap = await readTextFile(join(outDir, "sitemap.xml"));
    if (!sitemap.includes(`${SITE_ORIGIN}/`)) {
      throw new Error("sitemap does not list the landing page");
    }
    if (!sitemap.includes(`${SITE_ORIGIN}/docs/getting-started.html`)) {
      throw new Error("sitemap does not list a doc page");
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("every old flat address redirects to its new page", async () => {
  const outDir = await buildInto();
  try {
    for (const { from, to } of LEGACY_REDIRECTS) {
      const stubPath = join(outDir, `${from}.html`);
      if (!existsSync(stubPath)) {
        throw new Error(`no redirect stub for ${from}.html`);
      }
      const html = await readTextFile(stubPath);
      if (!html.includes(`url=docs/${to}.html`)) {
        throw new Error(`${from}.html does not refresh to docs/${to}.html`);
      }
      if (!html.includes(`${SITE_ORIGIN}/docs/${to}.html`)) {
        throw new Error(`${from}.html has no canonical to docs/${to}.html`);
      }
      if (!html.includes(`href="docs/${to}.html"`)) {
        throw new Error(`${from}.html has no visible link to docs/${to}.html`);
      }
    }
    // The old name of the sync page keeps resolving.
    const remake = await readTextFile(join(outDir, "remake.html"));
    if (!remake.includes("url=docs/sync.html")) {
      throw new Error("remake.html does not point at the sync page");
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("no page repeats a heading id", async () => {
  // The commands page repeats `### AI` and `### GitHub access` under every
  // command, so the same id would appear several times and collapse deep links
  // and search results onto the first one.
  const outDir = await buildInto();
  try {
    for (const page of await htmlFiles(join(outDir, "docs"))) {
      const html = await readTextFile(page);
      const ids = [...html.matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]);
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          throw new Error(`${relative(outDir, page)} repeats id "${id}"`);
        }
        seen.add(id);
      }
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("no internal link in the built site is dead", async () => {
  const outDir = await buildInto();
  try {
    // The temp build holds the landing page, the assets, every doc page, and
    // every stub, so all internal links resolve inside it.
    const files = await htmlFiles(outDir);
    const missing = await deadLinks(outDir, files);
    if (missing.length > 0) {
      throw new Error(`dead internal links:\n${missing.join("\n")}`);
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("the repository docs/ tree is the built layout, not the flat one", async () => {
  // The build overwrites a flat page with a stub, so a stale build is visible:
  // the new directory must exist, and the old address must be a refresh stub.
  const page = join(docsRoot, "docs", "getting-started.html");
  if (!existsSync(page)) {
    throw new Error("docs/docs/getting-started.html is missing");
  }
  const stub = join(docsRoot, "getting-started.html");
  if (!existsSync(stub)) {
    throw new Error("the old flat getting-started.html is missing");
  }
  const html = await readTextFile(stub);
  if (!html.includes('http-equiv="refresh"')) {
    throw new Error("the flat getting-started.html is a full page");
  }
});

test("sitemapXml lists the landing page first, then every slug", () => {
  const xml = sitemapXml(["a", "b"]);
  const first = xml.indexOf(`${SITE_ORIGIN}/`);
  const second = xml.indexOf(`${SITE_ORIGIN}/docs/a.html`);
  if (first < 0 || second < 0 || first > second) {
    throw new Error(`sitemap order is wrong:\n${xml}`);
  }
});

test("the search index covers every page and is well formed", async () => {
  const outDir = await buildInto();
  try {
    const indexPath = join(outDir, "docs", "search-index.json");
    if (!existsSync(indexPath)) {
      throw new Error("docs/search-index.json is missing");
    }
    const raw = await readTextFile(indexPath);
    const entries = JSON.parse(raw) as Array<{
      slug: string;
      label: string;
      section: string;
      heading: string;
      hash: string;
    }>;
    if (!Array.isArray(entries) || entries.length < 20) {
      throw new Error(`search index has too few rows: ${entries.length}`);
    }
    const slugs = new Set(entries.map((e) => e.slug));
    for (const slug of slugs) {
      const page = join(outDir, "docs", `${slug}.html`);
      if (!existsSync(page)) {
        throw new Error(`search index names ${slug}, but the page is missing`);
      }
      const html = await readTextFile(page);
      if (!html.includes('id="doc-search"')) {
        throw new Error(`${slug}.html has no search box in the sidebar`);
      }
    }
    // A section row carries a heading and an anchor the page really has.
    const withHeading = entries.find((e) => e.heading !== "" && e.hash !== "");
    if (!withHeading) {
      throw new Error("search index has no section rows");
    }
    const html = await readTextFile(
      join(outDir, "docs", `${withHeading.slug}.html`),
    );
    if (!html.includes(`id="${withHeading.hash}"`)) {
      throw new Error(
        `search index anchor #${withHeading.hash} is not in ${withHeading.slug}.html`,
      );
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("the new reference pages are in the navigation and the index", async () => {
  const outDir = await buildInto();
  try {
    const required = [
      "troubleshooting",
      "cost",
      "privacy",
      "cloud",
      "github-app",
      "view",
    ];
    for (const slug of required) {
      const page = join(outDir, "docs", `${slug}.html`);
      if (!existsSync(page)) throw new Error(`docs/${slug}.html is missing`);
      const stub = join(outDir, `${slug}.html`);
      if (!existsSync(stub)) {
        throw new Error(`the old flat ${slug}.html is missing`);
      }
    }
    const commands = await readTextFile(join(outDir, "docs", "commands.html"));
    if (!commands.includes("co-maintainer probe")) {
      throw new Error("the commands page does not carry the registry output");
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("sidebar groups the pages into the planned sections", async () => {
  const outDir = await buildInto();
  try {
    const html = await readTextFile(join(outDir, "docs", "cost.html"));
    for (const title of [
      "Getting started",
      "Review",
      "Self-hosted",
      "Cloud",
      "Reference",
    ]) {
      if (!html.includes(`>${title}</p>`)) {
        throw new Error(`the sidebar has no "${title}" group`);
      }
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("the commands page is generated from the command registry", async () => {
  const outDir = await buildInto();
  try {
    const generated = await readTextFile(join(docsRoot, "md", "commands.md"));
    if (generated !== commandsMarkdown()) {
      throw new Error(
        "docs/md/commands.md does not match the registry. Run npm run docs:build.",
      );
    }
    const html = await readTextFile(join(outDir, "docs", "commands.html"));
    for (const command of ["probe", "init", "sync", "review", "serve"]) {
      if (!html.includes(`co-maintainer ${command}`)) {
        throw new Error(`the commands page omits ${command}`);
      }
    }
    // The hidden alias must not leak into the reference.
    if (/>co-maintainer remake</.test(html)) {
      throw new Error("the commands page documents the hidden remake alias");
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("llms.txt lists every page and llms-full.txt inlines them", async () => {
  const outDir = await buildInto();
  try {
    const llms = await readTextFile(join(outDir, "llms.txt"));
    if (!llms.startsWith("# co-maintainer")) {
      throw new Error("llms.txt does not start with the title");
    }
    if (!llms.includes(`> ${LLMS_SUMMARY}`)) {
      throw new Error("llms.txt has no summary line");
    }
    const slugs = [
      "getting-started",
      "probe",
      "init",
      "sync",
      "view",
      "review",
      "local-review",
      "remote-review",
      "local-pr-review",
      "serve",
      "dashboard",
      "github-app",
      "cloud",
      "commands",
      "configuration",
      "authentication",
      "caching",
      "cost",
      "privacy",
      "troubleshooting",
    ];
    for (const slug of slugs) {
      if (!llms.includes(`(${SITE_ORIGIN}/docs/${slug}.md)`)) {
        throw new Error(`llms.txt does not list ${slug}`);
      }
    }
    // Every `.md` a model is pointed at must exist in the built site.
    for (const match of llms.matchAll(/\((https:\/\/[^)]+\.md)\)/g)) {
      const rel = match[1].replace(`${SITE_ORIGIN}/`, "");
      if (!existsSync(join(outDir, ...rel.split("/")))) {
        throw new Error(`llms.txt links ${rel}, but the file is missing`);
      }
    }
    const full = await readTextFile(join(outDir, "llms-full.txt"));
    if (!full.includes(`> ${LLMS_SUMMARY}`)) {
      throw new Error("llms-full.txt has no summary line");
    }
    if ((full.match(/^Source: /gm) ?? []).length !== slugs.length) {
      throw new Error("llms-full.txt does not inline every page");
    }
    // The inlined body is the real page, not a placeholder.
    if (!full.includes("co-maintainer probe")) {
      throw new Error("llms-full.txt does not carry the commands page body");
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});

test("each page has a .md copy beside its .html", async () => {
  const outDir = await buildInto();
  try {
    const htmlPages = await htmlFiles(join(outDir, "docs"));
    for (const page of htmlPages) {
      const mdPath = page.replace(/\.html$/, ".md");
      if (!existsSync(mdPath)) {
        throw new Error(`${basename(page)} has no .md copy`);
      }
      const body = await readTextFile(mdPath);
      if (!body.startsWith("# ")) {
        throw new Error(`${basename(mdPath)} does not start with a heading`);
      }
      // A relative `.md` link in the copy resolves against the same folder,
      // where every other page's copy also lives, so it must exist too.
      for (const match of body.matchAll(/\]\(([^)#]+\.md)\)/g)) {
        const target = match[1].replace(/^\.\//, "");
        if (!existsSync(join(outDir, "docs", target))) {
          throw new Error(
            `${basename(mdPath)} links ${target}, which is missing`,
          );
        }
      }
    }
  } finally {
    await remove(outDir, { recursive: true });
  }
});
