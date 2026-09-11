import type { Fact } from "./types.ts";
import { sectionKeys, sectionTitles } from "./sections.ts";

function sectionFacts(facts: Fact[], key: string): Fact[] {
  return facts.filter((item) => item.sectionKey === key).sort((a, b) =>
    b.weight - a.weight
  );
}

function render(key: string, facts: Fact[]): string {
  const items = sectionFacts(facts, key).slice(0, 6);
  if (!items.length) return "";
  return `## ${sectionTitles[key] ?? key}\n\n${
    items.map((item) => `- ${item.claim}`).join("\n")
  }`;
}

function cleanSection(value: string): string {
  return value.replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, "").trim();
}

function hasBullets(value: string): boolean {
  return /^-\s+/m.test(value);
}

/** Slices an assembled skill's `## Heading` sections back out by section key,
 * from `<!-- section:key -->` markers or (fallback) canonical heading text. */
export function extractSections(markdown: string): Record<string, string> {
  const result: Record<string, string> = {};
  const markerPattern =
    /<!-- section:([a-z-]+) -->\n([\s\S]*?)\n<!-- \/section:\1 -->/g;
  for (const match of markdown.matchAll(markerPattern)) {
    result[match[1]] = match[2];
  }
  const keysByTitle = Object.fromEntries(
    Object.entries(sectionTitles).map(([key, title]) => [title, key]),
  );
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  for (let index = 0; index < headings.length; index++) {
    const key = keysByTitle[headings[index][1].trim()];
    if (!key || result[key]) continue;
    const start = headings[index].index ?? 0;
    const end = headings[index + 1]?.index ?? markdown.length;
    result[key] = markdown.slice(start, end).trim();
  }
  return result;
}

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function factSectionHashes(
  facts: Fact[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const key of new Set(facts.map((item) => item.sectionKey))) {
    const relevant = sectionFacts(facts, key);
    hashes[key] = await hash(
      JSON.stringify(
        relevant.map((item) => [
          item.id,
          item.claim,
          item.weight,
          item.scope,
          item.confidence,
          item.status,
        ]),
      ),
    );
  }
  return hashes;
}

export async function assembleSkill(
  repo: string,
  facts: Fact[],
  previousMarkdown: string | undefined,
  previousHashes: Record<string, string>,
  overrides: Record<string, string> = {},
): Promise<
  { markdown: string; hashes: Record<string, string>; changed: string[] }
> {
  const previous = previousMarkdown ? extractSections(previousMarkdown) : {};
  const sections: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  const changed: string[] = [];
  const keys = sectionKeys.filter((key) =>
    facts.some((item) => item.sectionKey === key)
  );

  for (const key of keys) {
    const content = render(key, facts);
    if (!content) continue;
    const relevant = sectionFacts(facts, key);
    const sectionHash = await hash(
      JSON.stringify(
        relevant.map((item) => [
          item.id,
          item.claim,
          item.weight,
          item.scope,
          item.confidence,
          item.status,
        ]),
      ),
    );
    hashes[key] = sectionHash;
    const canonicalHeading = `## ${sectionTitles[key] ?? key}`;
    const hasOverride = Object.hasOwn(overrides, key);
    if (
      !hasOverride &&
      previousMarkdown &&
      previousHashes[key] === sectionHash &&
      previous[key]?.startsWith(canonicalHeading)
    ) {
      sections[key] = cleanSection(previous[key]);
      continue;
    }
    const section = hasOverride ? overrides[key] : content;
    if (!hasBullets(section)) continue;
    sections[key] = section;
    changed.push(key);
  }

  const header = `---
name: ${repo.replace("/", "-")}-maintainer
description: Repository-specific guidance for contributing to ${repo}. Use when writing code, opening or reviewing pull requests, debugging, or releasing this repository.
---

# ${repo}

Generated from repository metadata and selected project history. Prefer current repository files and workflows when this guidance conflicts with a stale example.
`;
  const body = Object.values(sections).join("\n\n");
  return { markdown: header + body + "\n", hashes, changed };
}
