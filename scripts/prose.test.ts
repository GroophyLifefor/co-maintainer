/** Prose guard for the repository Markdown that ships to users (CORE-83).
 *
 * The docs site has its own guard inside `build_docs.ts`. The README, the
 * changelog, and each benchmark README ship to npm or GitHub and never pass
 * through that build, so they need the same check. The rule is one sentence
 * long: no em dash as punctuation, and no semicolon in prose. Fenced code
 * blocks keep whatever they need. */
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextFile } from "../src/util/runtime.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The Markdown a reader sees on npm or GitHub, not internal research notes. */
const SHIPPED = [
  "README.md",
  "CHANGELOG.md",
  "benchmark/README.md",
  "benchmark/core_v2/README.md",
  "benchmark/core_v3/README.md",
  "benchmark/swe-prbench/README.md",
];

/** Prose only: fenced blocks and inline code keep their characters, because a
 * code sample is not a sentence. */
function proseLines(text: string): Array<[number, string]> {
  const kept: Array<[number, string]> = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    kept.push([index + 1, line.replace(/`[^`]*`/g, "")]);
  });
  return kept;
}

test("shipped Markdown has no em dash as punctuation", async () => {
  const offenders: string[] = [];
  for (const rel of SHIPPED) {
    const text = await readTextFile(join(projectRoot, rel));
    for (const [lineNo, line] of proseLines(text)) {
      if (line.includes("\u2014")) {
        offenders.push(`${rel}:${lineNo}: ${line.trim()}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `em dash in shipped Markdown (CORE-83):\n${offenders.join("\n")}`,
    );
  }
});

test("shipped Markdown has no semicolon in prose", async () => {
  const offenders: string[] = [];
  for (const rel of SHIPPED) {
    const text = await readTextFile(join(projectRoot, rel));
    for (const [lineNo, line] of proseLines(text)) {
      if (line.includes(";")) {
        offenders.push(`${rel}:${lineNo}: ${line.trim()}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `semicolon in shipped Markdown prose (CORE-83):\n${offenders.join("\n")}`,
    );
  }
});
