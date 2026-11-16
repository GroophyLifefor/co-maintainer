/** Rule ids that stay the same across builds.
 *
 * A build numbers its rules from 1 (`R1`, `I1`, ...). A review that cited
 * `R4` must still point at the same rule after the next `sync`, so the fresh
 * numbers are mapped onto the last build's ids before anything is written:
 * a rule that shares a source with an old rule keeps that rule's id (it is the
 * same rule, maybe reworded), a rule with no match gets the next number ever
 * given, and a dropped id is never given again. */
import { sourceLabel, type RuleEntry, type RuleSource } from "./rules.ts";

export type FreshRule = {
  id: string;
  text: string;
  sources: RuleSource[];
  /** Old ids this rule may not take, such as the rule it overturns. */
  avoid?: string[];
};

/** The highest id number of one kind in `rules`. */
function highest(rules: Record<string, RuleEntry>, kind: "R" | "I"): number {
  let max = 0;
  for (const id of Object.keys(rules)) {
    if (id.startsWith(kind)) max = Math.max(max, Number(id.slice(1)) || 0);
  }
  return max;
}

/** Maps each fresh id to its stable id, and returns the new highest number.
 * Fresh rules are taken in order. Each takes the free old rule it shares the
 * most sources with, or else one with the same text. */
export function stableIds(
  kind: "R" | "I",
  fresh: FreshRule[],
  previous: Record<string, RuleEntry> | undefined,
  lastId: number | undefined,
): { ids: Map<string, string>; lastId: number } {
  const old = Object.entries(previous ?? {})
    .filter(([id]) => id.startsWith(kind))
    .map(([id, entry]) => ({
      id,
      text: entry.text,
      sources: new Set(entry.sources.map(sourceLabel)),
    }));
  let next = Math.max(lastId ?? 0, highest(previous ?? {}, kind));
  const taken = new Set<string>();
  const ids = new Map<string, string>();
  for (const rule of fresh) {
    if (ids.has(rule.id)) continue;
    const labels = rule.sources.map(sourceLabel);
    let best: { id: string; shared: number } | undefined;
    for (const item of old) {
      if (taken.has(item.id) || rule.avoid?.includes(item.id)) continue;
      const shared = labels.filter((label) => item.sources.has(label)).length;
      // Same text with no shared source still counts, below any shared
      // source: an instruction line that moved down a file is the same rule.
      const score = shared > 0 ? shared : item.text === rule.text ? 0.5 : 0;
      if (score > 0 && (!best || score > best.shared)) {
        best = { id: item.id, shared: score };
      }
    }
    if (best) {
      taken.add(best.id);
      ids.set(rule.id, best.id);
    } else {
      next++;
      ids.set(rule.id, `${kind}${next}`);
    }
  }
  return { ids, lastId: next };
}

/** Rewrites the `[R1]` / `[I1]` id at the end of each line in one pass, so a
 * rename such as R1 to R2 and R2 to R5 never collides. */
export function renameIdsInMarkdown(
  markdown: string,
  ids: Map<string, string>,
): string {
  return markdown.replace(
    /\[([RI][1-9]\d*)\](?=[ \t]*$)/gm,
    (whole, id: string) => {
      const renamed = ids.get(id);
      return renamed ? `[${renamed}]` : whole;
    },
  );
}
