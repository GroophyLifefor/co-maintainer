export type Counts = { tp: number; fp: number; fn: number };

export function scores(counts: Counts): {
  precision: number;
  recall: number;
  f1: number;
} {
  const { tp, fp, fn } = counts;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
