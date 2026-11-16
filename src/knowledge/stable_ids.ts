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
 * A fresh rule may keep an old id when it shares a source with that rule, or
 * else has the same text. The ids are matched as a whole, not first come
 * first served: a rule that could keep two ids gives way to a later rule that
 * can keep only one of them, so as many ids as possible stay the same. Among
 * its options a rule tries the one with the most shared sources first. */
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
  const rules = fresh.filter(
    (rule, index) => fresh.findIndex((item) => item.id === rule.id) === index,
  );
  // Each rule's old ids it may keep, best first.
  const options = rules.map((rule) => {
    const labels = rule.sources.map(sourceLabel);
    return old
      .flatMap((item, order) => {
        if (rule.avoid?.includes(item.id)) return [];
        const shared = labels.filter((label) => item.sources.has(label)).length;
        // Same text with no shared source still counts, below any shared
        // source: an instruction line that moved down a file is the same rule.
        const score = shared > 0 ? shared : item.text === rule.text ? 0.5 : 0;
        return score > 0 ? [{ id: item.id, score, order }] : [];
      })
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((option) => option.id);
  });
  // Augmenting paths: a rule takes a free id, or moves the rule holding one
  // of its options to another id that rule may keep.
  const holder = new Map<string, number>();
  const kept = new Map<number, string>();
  const place = (index: number, seen: Set<string>): boolean => {
    for (const id of options[index]!) {
      if (seen.has(id)) continue;
      seen.add(id);
      const current = holder.get(id);
      if (current === undefined || place(current, seen)) {
        holder.set(id, index);
        kept.set(index, id);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < rules.length; index++) place(index, new Set());
  let next = Math.max(lastId ?? 0, highest(previous ?? {}, kind));
  const ids = new Map<string, string>();
  for (const [index, rule] of rules.entries()) {
    const id = kept.get(index);
    if (id) ids.set(rule.id, id);
    else {
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
