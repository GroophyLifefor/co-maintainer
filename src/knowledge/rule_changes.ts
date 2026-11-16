/** What a `sync` changed in the rules, compared by their sources.
 *
 * A rebuilt guide can reword every line, so text alone cannot say which line
 * became which. Sources survive a rewrite: a guide line keeps resting on the
 * same pull requests, an instruction rule on the same file lines. A new rule
 * that shares a source with an old one is that rule, rewritten. */
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
  /** Pull requests that are no longer in the window this sync read. */
  leftWindow: string[];
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

/** Compares one kind of rule, `R` or `I`. A rule with no source cannot be
 * matched and is left out of the report. `inWindow` names the pull requests
 * the sync read, so a dropped rule can say its pull request left the window. */
export function compareRules(
  previous: Record<string, RuleEntry> | undefined,
  next: Record<string, RuleEntry>,
  kind: "R" | "I",
  inWindow?: Set<number>,
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
      leftWindow: inWindow
        ? rule.sources.filter((source) => {
            const match = /^#(\d+)$/.exec(source);
            return match !== null && !inWindow.has(Number(match[1]));
          })
        : [],
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

/** `2 rules added (#402, #407) · 1 rewritten (R12, #340 joined) · 1 dropped
 * (#101 left the window)`, or `no rule changed`. */
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
    const items = changes.dropped.flatMap((rule) =>
      rule.sources.map((source) =>
        rule.leftWindow.includes(source) ? `${source} left the window` : source,
      ),
    );
    parts.push(`${changes.dropped.length} dropped (${listed(items)})`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no rule changed";
}

export type Contradiction = {
  /** The old rule. */
  id: string;
  /** The new rule that goes against it. */
  by: string;
  /** The new rule's pull requests, `#340`. */
  sources: string[];
  /** The newest merge date of the new rule, `YYYY-MM-DD`. */
  newest: string;
  /** False when the old id is still in this build. */
  dropped: boolean;
};

function newestDate(entry: RuleEntry): string | undefined {
  const dates = entry.sources.flatMap((source) =>
    "pr" in source && source.mergedAt ? [source.mergedAt] : [],
  );
  return dates.length ? dates.sort().at(-1) : undefined;
}

/** The old rules the guide AI said a new rule goes against, kept only when
 * the old rule existed and the new rule's newest pull request was merged
 * after the old rule's newest one. Without both dates nothing is claimed. */
export function contradictions(
  previous: Record<string, RuleEntry> | undefined,
  next: Record<string, RuleEntry>,
  overturns: Map<string, string[]>,
): Contradiction[] {
  const found: Contradiction[] = [];
  for (const [by, ids] of overturns) {
    const entry = next[by];
    if (!entry) continue;
    const newest = newestDate(entry);
    if (!newest) continue;
    for (const id of ids) {
      const old = previous?.[id];
      if (!old || id === by) continue;
      const oldNewest = newestDate(old);
      if (!oldNewest || newest <= oldNewest) continue;
      found.push({
        id,
        by,
        sources: labels(entry),
        newest,
        dropped: !(id in next),
      });
    }
  }
  return found;
}

/** `R4 dropped, R9 goes against it (#340, 2026-03)`. */
export function contradictionLine(item: Contradiction): string {
  const evidence = `${listed(item.sources, 3)}, ${item.newest.slice(0, 7)}`;
  return item.dropped
    ? `${item.id} dropped, ${item.by} goes against it (${evidence})`
    : `${item.by} goes against ${item.id} (${evidence})`;
}
