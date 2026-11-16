/** What a review finding rests on.
 *
 * The review answer names ids only: `R12` and `I3` from the guide and
 * instruction lines, `codebase:<section>` for a CODEBASE CONVENTIONS section,
 * and `system` for the review instructions themselves. No pull request number
 * or date ever enters the prompt. Code turns each id into a reference from
 * `RULES.json` at review time, and the result is stored with the finding, so
 * a later `sync` never changes what an old review cited. */
import { RULE_ID, type RulesFile } from "../knowledge/rules.ts";

/** What references resolve against, from the guides a review was given. */
export type ReferenceContext = { rules: RulesFile | null; codebase: string };

export type ReferenceSource =
  | { pr: number; url?: string; mergedAt?: string }
  | { path: string; line: number; url?: string };

export type ResolvedReference =
  | { kind: "rule"; id: string; sources: ReferenceSource[] }
  | { kind: "instruction"; id: string; sources: ReferenceSource[] }
  | { kind: "codebase"; section?: string }
  | { kind: "system" };

/** The ids as the model wrote them, one per entry, trimmed. */
export function referenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

/** The `## ` section titles of CODEBASE.md, so a made-up section is not
 * shown as if it existed. */
function codebaseSections(codebase: string): Set<string> {
  return new Set(
    [...codebase.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) =>
      match[1].toLowerCase(),
    ),
  );
}

function instructionUrl(
  repo: string,
  commit: string | undefined,
  path: string,
  line: number,
): string | undefined {
  if (!commit || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
  return `https://github.com/${repo}/blob/${commit}/${path}#L${line}`;
}

/** Turns the ids of one finding into references. An id that is not in
 * `RULES.json` is dropped, so a made-up id never shows. A finding that names
 * nothing usable rests on the review instructions: `system`. */
export function resolveReferences(
  ids: string[],
  input: { repo: string; rules: RulesFile | null; codebase: string },
): ResolvedReference[] {
  const sections = codebaseSections(input.codebase);
  const resolved: ResolvedReference[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.replace(/^\[|\]$/g, "").trim();
    const lower = id.toLowerCase();
    if (lower === "system") {
      if (!seen.has("system")) resolved.push({ kind: "system" });
      seen.add("system");
      continue;
    }
    if (lower === "codebase" || lower.startsWith("codebase:")) {
      const name = id.slice("codebase".length).replace(/^:/, "").trim();
      const section =
        name && sections.has(name.toLowerCase()) ? name : undefined;
      const key = `codebase:${section ?? ""}`;
      if (!seen.has(key)) resolved.push({ kind: "codebase", section });
      seen.add(key);
      continue;
    }
    const upper = id.toUpperCase();
    if (!RULE_ID.test(upper) || seen.has(upper)) continue;
    const entry = input.rules?.rules[upper];
    if (!entry) continue;
    seen.add(upper);
    const sources: ReferenceSource[] = entry.sources.map((source) =>
      "pr" in source
        ? {
            pr: source.pr,
            ...(source.mergedAt ? { mergedAt: source.mergedAt } : {}),
            ...(source.url ? { url: source.url } : {}),
          }
        : {
            path: source.path,
            line: source.line,
            ...(() => {
              const url = instructionUrl(
                input.repo,
                entry.commit,
                source.path,
                source.line,
              );
              return url ? { url } : {};
            })(),
          },
    );
    resolved.push({
      kind: upper.startsWith("R") ? "rule" : "instruction",
      id: upper,
      sources,
    });
  }
  return resolved.length ? resolved : [{ kind: "system" }];
}

function linkWith(links: boolean) {
  return (text: string, url: string | undefined): string =>
    links && url ? `[${text}](${url})` : text;
}

/** One reference as a reader sees it:
 * `Rules-12 · #212, #340 · 2026-03`, `Instructions-3 · AGENTS.md:14`,
 * `System Prompt`, `Codebase · Tests`. */
export function referenceLine(
  reference: ResolvedReference,
  links = true,
): string {
  const link = linkWith(links);
  switch (reference.kind) {
    case "system":
      return "System Prompt";
    case "codebase":
      return reference.section ? `Codebase · ${reference.section}` : "Codebase";
    case "rule": {
      const prs = reference.sources.flatMap((source) =>
        "pr" in source ? [link(`#${source.pr}`, source.url)] : [],
      );
      const dates = reference.sources
        .flatMap((source) =>
          "pr" in source && source.mergedAt ? [source.mergedAt] : [],
        )
        .sort();
      const newest = dates.at(-1)?.slice(0, 7);
      return [`Rules-${reference.id.slice(1)}`, prs.join(", "), newest]
        .filter(Boolean)
        .join(" · ");
    }
    case "instruction": {
      const lines = reference.sources.flatMap((source) =>
        "path" in source
          ? [link(`${source.path}:${source.line}`, source.url)]
          : [],
      );
      return [`Instructions-${reference.id.slice(1)}`, lines.join(", ")]
        .filter(Boolean)
        .join(" · ");
    }
  }
}

/** The collapsed block under a finding, or `""` when there is nothing. */
export function referencesBlock(references: ResolvedReference[]): string {
  if (references.length === 0) return "";
  return [
    `<details><summary>References (${references.length})</summary>`,
    "",
    ...references.map((reference) => `- ${referenceLine(reference)}`),
    "",
    "</details>",
  ].join("\n");
}

/** Reads a stored `references_json` value. Anything that does not fit is
 * skipped, so a bad row shows no references rather than failing a page. */
export function parseStoredReferences(text: string | null | undefined) {
  if (!text) return [] as ResolvedReference[];
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is ResolvedReference =>
        !!item &&
        typeof item === "object" &&
        ["rule", "instruction", "codebase", "system"].includes(
          (item as { kind?: unknown }).kind as string,
        ),
    );
  } catch {
    return [];
  }
}

/** The `references_json` to store for a finding: a carried one keeps what it
 * rested on, a new one resolves the ids its answer named. */
export function referencesJson(
  finding: { references?: ResolvedReference[]; referenceIds?: string[] },
  repo: string,
  context: ReferenceContext | undefined,
): string {
  if (finding.references) return JSON.stringify(finding.references);
  return JSON.stringify(
    resolveReferences(finding.referenceIds ?? [], {
      repo,
      rules: context?.rules ?? null,
      codebase: context?.codebase ?? "",
    }),
  );
}

/** Gives every row that has no references yet the ones its ids resolve to,
 * so every output (stored row, JSON, carry file) carries the same list. */
export function withResolvedReferences<
  T extends { references?: ResolvedReference[]; referenceIds?: string[] },
>(rows: T[], repo: string, context: ReferenceContext | undefined): T[] {
  for (const row of rows) {
    if (row.references) continue;
    row.references = resolveReferences(row.referenceIds ?? [], {
      repo,
      rules: context?.rules ?? null,
      codebase: context?.codebase ?? "",
    });
  }
  return rows;
}
