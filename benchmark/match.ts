export type Span = {
  path: string;
  from: number;
  to: number;
};

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function overlaps(a: Span, b: Span): boolean {
  if (normalizePath(a.path) !== normalizePath(b.path)) return false;
  const aFrom = Number.isFinite(a.from) ? a.from : 0;
  const aTo = Number.isFinite(a.to) ? a.to : aFrom;
  const bFrom = Number.isFinite(b.from) ? b.from : 0;
  const bTo = Number.isFinite(b.to) ? b.to : bFrom;
  return aFrom <= bTo && bFrom <= aTo;
}

/** Greedy 1-1 match: each finding pairs with the first unused gold span. */
export function matchPairs(
  predicted: Span[],
  gold: Span[],
): { predicted: number; gold: number }[] {
  const used = new Set<number>();
  const pairs: { predicted: number; gold: number }[] = [];
  for (let i = 0; i < predicted.length; i++) {
    const index = gold.findIndex((item, g) =>
      !used.has(g) && overlaps(predicted[i], item)
    );
    if (index === -1) continue;
    used.add(index);
    pairs.push({ predicted: i, gold: index });
  }
  return pairs;
}

export function matchSpans(
  predicted: Span[],
  gold: Span[],
  pairs: { predicted: number; gold: number }[] = matchPairs(predicted, gold),
): { tp: number; fp: number; fn: number } {
  const tp = pairs.length;
  return { tp, fp: predicted.length - tp, fn: gold.length - tp };
}
