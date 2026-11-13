/** What a `sync` changed in the rules, compared by their sources.
 *
 * A rebuilt `INSTRUCTIONS.md` can reword every rule, so text alone cannot say
 * which rule became which. Sources survive a rewrite: an instruction rule
 * keeps resting on the same file lines. A new rule that shares a source with
 * an old one is that rule, rewritten. */
import { rulesOfKind, sourceLabel, type RuleEntry } from "./rules.ts";

export type AddedRule = { id: string; text: string; sources: string[] };
export type RewrittenRule = {
  id: string;
  text: string;
  /** The old ids it shares a source with. */
  previous: string[];
  /** Sources the old rules did not have. */
  joined: string[];
  /** Sources of the old rules it no longer has. */
  left: string[];
};
export type DroppedRule = {
  id: string;
  text: string;
  sources: string[];
};

export type RuleChanges = {
  added: AddedRule[];
  rewritten: RewrittenRule[];
  dropped: DroppedRule[];
  unchanged: number;
};

function labels(entry: RuleEntry): string[] {
  return [...new Set(entry.sources.map(sourceLabel))];
}

/** Compares one kind of rule. A rule with no source cannot be matched and is
 * left out of the report. */
export function compareRules(
  previous: Record<string, RuleEntry> | undefined,
  next: Record<string, RuleEntry>,
  kind: "I",
): RuleChanges {
  const old = Object.entries(rulesOfKind(previous, kind))
    .map(([id, entry]) => ({ id, entry, sources: labels(entry) }))
    .filter((rule) => rule.sources.length > 0);
  const fresh = Object.entries(rulesOfKind(next, kind))
    .map(([id, entry]) => ({ id, entry, sources: labels(entry) }))
    .filter((rule) => rule.sources.length > 0);
  const freshSources = new Set(fresh.flatMap((rule) => rule.sources));
  const changes: RuleChanges = {
    added: [],
    rewritten: [],
    dropped: [],
    unchanged: 0,
  };
  for (const rule of fresh) {
    const own = new Set(rule.sources);
    const matches = old.filter((item) =>
      item.sources.some((source) => own.has(source)),
    );
    if (matches.length === 0) {
      changes.added.push({
        id: rule.id,
        text: rule.entry.text,
        sources: rule.sources,
      });
      continue;
    }
    const same = matches.some(
      (item) =>
        item.entry.text === rule.entry.text &&
        item.sources.length === rule.sources.length &&
        item.sources.every((source) => own.has(source)),
    );
    if (same) {
      changes.unchanged++;
      continue;
    }
    const before = new Set(matches.flatMap((item) => item.sources));
    changes.rewritten.push({
      id: rule.id,
      text: rule.entry.text,
      previous: matches.map((item) => item.id),
      joined: rule.sources.filter((source) => !before.has(source)),
      left: [...before].filter((source) => !own.has(source)),
    });
  }
  for (const rule of old) {
    if (rule.sources.some((source) => freshSources.has(source))) continue;
    changes.dropped.push({
      id: rule.id,
      text: rule.entry.text,
      sources: rule.sources,
    });
  }
  return changes;
}

/** At most `max` items, then how many more. */
function listed(items: string[], max = 5): string {
  const unique = [...new Set(items)];
  if (unique.length <= max) return unique.join(", ");
  return `${unique.slice(0, max).join(", ")}, and ${unique.length - max} more`;
}

/** `1 rule added (AGENTS.md:40) · 1 rewritten (I3, AGENTS.md:12 joined) · 1
 * dropped (AGENTS.md:9)`, or `no rule changed`. */
export function ruleChangeLine(changes: RuleChanges): string {
  const parts: string[] = [];
  if (changes.added.length > 0) {
    const count = changes.added.length;
    parts.push(
      `${count} ${count === 1 ? "rule" : "rules"} added (${listed(
        changes.added.flatMap((rule) => rule.sources),
      )})`,
    );
  }
  if (changes.rewritten.length > 0) {
    const items = changes.rewritten.map((rule) =>
      rule.joined.length > 0
        ? `${rule.id}, ${rule.joined.join(", ")} joined`
        : rule.id,
    );
    parts.push(`${changes.rewritten.length} rewritten (${listed(items, 3)})`);
  }
  if (changes.dropped.length > 0) {
    parts.push(
      `${changes.dropped.length} dropped (${listed(
        changes.dropped.flatMap((rule) => rule.sources),
      )})`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "no rule changed";
}
