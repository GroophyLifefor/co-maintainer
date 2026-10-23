import type { Fact } from "./types.ts";
import { codebaseSectionKeys, sectionKeys, sectionTitles } from "./sections.ts";

function sectionFacts(facts: Fact[], key: string): Fact[] {
  return facts
    .filter((item) => item.sectionKey === key)
    .sort((a, b) => b.weight - a.weight);
}

/** The link that stands in for a codebase section's text. */
function isCodebaseLink(section: string): boolean {
  return section.includes("[CODEBASE.md](CODEBASE.md)");
}

/** A codebase section in the skill is a link to `CODEBASE.md`, never text.
 * Every other section's body is authored by the synthesis job: there is no
 * deterministic fact renderer, so a section with no AI output is omitted. */
function render(key: string): string {
  if (codebaseSectionKeys.has(key)) {
    return `## ${sectionTitles[key] ?? key}\n\nSee [CODEBASE.md](CODEBASE.md).`;
  }
  return "";
}

function codebaseSectionText(
  key: string,
  overrides: Record<string, string>,
): string {
  const override = overrides[key]?.trim();
  if (override && hasBullets(override) && !isCodebaseLink(override)) {
    return cleanSection(override);
  }
  return "";
}

/** The full text of the sections that live in `CODEBASE.md`, each authored by
 * the synthesis job. The skill itself only links to that file, so this is the
 * single place the codebase guidance is written out. */
export function codebaseBody(overrides: Record<string, string> = {}): string {
  return [...codebaseSectionKeys]
    .map((key) => codebaseSectionText(key, overrides))
    .filter(Boolean)
    .join("\n\n");
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
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The fields that decide a section's text. `origin` is included so a fact
 * moving from PR narrative to repository policy (or the reverse) counts as a
 * change rather than reusing a section built under the old rule. */
function hashInput(item: Fact): unknown[] {
  return [
    item.id,
    item.claim,
    item.weight,
    item.scope,
    item.confidence,
    item.status,
    item.origin ?? "repository",
  ];
}

export async function factSectionHashes(
  facts: Fact[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const key of new Set(facts.map((item) => item.sectionKey))) {
    const relevant = sectionFacts(facts, key);
    hashes[key] = await hash(JSON.stringify(relevant.map(hashInput)));
  }
  return hashes;
}

export async function assembleSkill(
  repo: string,
  facts: Fact[],
  previousMarkdown: string | undefined,
  previousHashes: Record<string, string>,
  overrides: Record<string, string> = {},
): Promise<{
  markdown: string;
  hashes: Record<string, string>;
  changed: string[];
}> {
  const previous = previousMarkdown ? extractSections(previousMarkdown) : {};
  const sections: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  const changed: string[] = [];
  const keys = sectionKeys.filter((key) =>
    facts.some((item) => item.sectionKey === key),
  );

  for (const key of keys) {
    const content = render(key);
    const relevant = sectionFacts(facts, key);
    const sectionHash = await hash(JSON.stringify(relevant.map(hashInput)));
    hashes[key] = sectionHash;
    const canonicalHeading = `## ${sectionTitles[key] ?? key}`;
    const override = overrides[key]?.trim();
    // The codebase sections hold a link, not text, so the skill never takes a
    // synthesized override for them; the override goes to CODEBASE.md instead.
    const hasOverride = Boolean(override) && !codebaseSectionKeys.has(key);
    if (
      !hasOverride &&
      previousMarkdown &&
      previousHashes[key] === sectionHash &&
      previous[key]?.startsWith(canonicalHeading) &&
      // A section whose shape changed (the codebase sections now carry a link
      // instead of the text) is rewritten rather than kept because its facts
      // happen to be unchanged.
      isCodebaseLink(content) === isCodebaseLink(previous[key])
    ) {
      sections[key] = cleanSection(previous[key]);
      continue;
    }
    const section = hasOverride ? overrides[key] : content;
    // Every text section body is authored by the synthesis job, so a section
    // with no AI output is omitted. A codebase section is a link, not a bullet
    // list, and is kept even though it has no bullets.
    if (!section || (!isCodebaseLink(section) && !hasBullets(section))) {
      continue;
    }
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
