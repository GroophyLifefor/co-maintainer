/** Builds a `.ts` module that exports a static asset as a string.
 *
 * Deno's `with { type: "text" }` import has no Node equivalent for arbitrary
 * extensions, so the CSS/JS is embedded at authoring time instead. Run after
 * editing `src/server/pages/styles.css` or `client.js`:
 *   node scripts/embed_assets.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";

const TARGETS = [
  {
    source: "src/server/pages/styles.css",
    module: "src/server/pages/styles.ts",
    name: "styles",
  },
  {
    source: "src/server/pages/client.js",
    module: "src/server/pages/client.ts",
    name: "client",
  },
];

for (const target of TARGETS) {
  const content = readFileSync(join(ROOT, target.source), "utf8");
  const body = JSON.stringify(content);
  const out =
    `/** Generated from ${target.source} by scripts/embed_assets.mjs — do not edit. */\n` +
    `export const ${target.name} = ${body};\n`;
  writeFileSync(join(ROOT, target.module), out);
  console.log(`${target.module}: ${content.length} chars`);
}
