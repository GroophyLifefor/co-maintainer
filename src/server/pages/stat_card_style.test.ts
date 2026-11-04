/** The stat card title is `<div class="top">`. A leftover global `.top`
 * rule from the old top bar painted it white with a bottom border, which
 * showed as a white strip in dark mode. No rule outside `.stat` may target a
 * bare `.top`. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The Ctrl K palette lives outside `.app`, so it only gets the theme's
 * colors if the token blocks name it too. Without that it stayed white in
 * dark mode. */
test("the palette takes the same light and dark tokens as the app", () => {
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*--card:[^}]*)\}/g)].map((m) =>
    m[1]!.split(",").map((s) => s.trim()),
  );
  const light = blocks.find((sel) => sel.includes(".app"));
  const dark = blocks.find((sel) => sel.includes(".dark .app"));
  if (!light?.includes(".pal")) throw new Error(`light tokens miss .pal: ${light}`);
  if (!dark?.includes(".dark .pal")) throw new Error(`dark tokens miss .dark .pal: ${dark}`);
});

test("no global .top rule can restyle the stat card title", () => {
  const offenders: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = match[1]!.split(",").map((s) => s.trim());
    for (const selector of selectors) {
      if (/(^|\s)\.top\b/.test(selector) && !/\.stat\s+\.top\b/.test(selector)) {
        offenders.push(selector);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`global .top rules: ${offenders.join(" | ")}`);
  }
});
