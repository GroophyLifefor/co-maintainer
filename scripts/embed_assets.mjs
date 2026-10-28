/** Builds `.ts` modules that export static assets as strings.
 *
 * Deno's `with { type: "text" }` import has no Node equivalent for arbitrary
 * extensions, so assets are embedded at authoring time instead. Run after
 * editing `src/server/pages/styles.css`, `client.js`, the SVGs under
 * `src/server/pages/icons/`, or the fonts under `src/server/pages/fonts/`:
 *   node scripts/embed_assets.mjs
 *
 * Fonts: `styles.css` refers to each `.woff2` by file name (for example
 * `url("outfit-latin.woff2")`); the build swaps that for a base64 data URI so
 * the served stylesheet carries the font inline and makes no extra request.
 *
 * Icons: every `.svg` in `icons/` becomes one `<symbol id="i-<name>">` inside
 * a single hidden `<svg>` sprite. `ui.ts` renders an icon as
 * `<svg class="ic"><use href="#i-<name>"></svg>`.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";

/** Replaces `url("<name>.woff2")` with a base64 data URI for every font file. */
function inlineFonts(css) {
  const fontsDir = join(ROOT, "src/server/pages/fonts");
  const files = readdirSync(fontsDir).filter((name) => name.endsWith(".woff2"));
  if (files.length === 0) throw new Error(`no .woff2 files in ${fontsDir}`);
  let out = css;
  for (const name of files) {
    const data = readFileSync(join(fontsDir, name)).toString("base64");
    const needle = `url("${name}")`;
    if (!out.includes(needle)) {
      throw new Error(`styles.css does not reference ${needle}`);
    }
    out = out.split(needle).join(`url("data:font/woff2;base64,${data}")`);
  }
  return out;
}

const TARGETS = [
  {
    source: "src/server/pages/styles.css",
    module: "src/server/pages/styles.ts",
    name: "styles",
    transform: inlineFonts,
  },
  {
    source: "src/server/pages/client.js",
    module: "src/server/pages/client.ts",
    name: "client",
  },
];

for (const target of TARGETS) {
  const raw = readFileSync(join(ROOT, target.source), "utf8");
  const content = target.transform ? target.transform(raw) : raw;
  const body = JSON.stringify(content);
  const out =
    `/** Generated from ${target.source} by scripts/embed_assets.mjs — do not edit. */\n` +
    `export const ${target.name} = ${body};\n`;
  writeFileSync(join(ROOT, target.module), out);
  console.log(`${target.module}: ${content.length} chars`);
}

const iconsDir = join(ROOT, "src/server/pages/icons");
const iconNames = readdirSync(iconsDir)
  .filter((name) => name.endsWith(".svg"))
  .map((name) => name.slice(0, -".svg".length))
  .sort();
if (iconNames.length === 0) throw new Error(`no .svg files in ${iconsDir}`);

function symbolFor(name) {
  const svg = readFileSync(join(iconsDir, `${name}.svg`), "utf8");
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 24 24";
  const inner = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .trim();
  return (
    `<symbol id="i-${name}" viewBox="${viewBox}" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round">${inner}</symbol>`
  );
}

const sprite =
  `<svg xmlns="http://www.w3.org/2000/svg" ` +
  `style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">` +
  iconNames.map(symbolFor).join("") +
  `</svg>`;

const iconsOut =
  `/** Generated from src/server/pages/icons/*.svg by scripts/embed_assets.mjs — do not edit. */\n` +
  `export const iconNames: readonly string[] = JSON.parse(${JSON.stringify(
    JSON.stringify(iconNames),
  )});\n` +
  `export const sprite = ${JSON.stringify(sprite)};\n`;
writeFileSync(join(ROOT, "src/server/pages/icons.ts"), iconsOut);
console.log(`src/server/pages/icons.ts: ${iconNames.length} icons`);
