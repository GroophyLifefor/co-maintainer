// The pieces of bench-core-v3 that decide where results go and how repeated
// runs are summarized. They live apart from run.ts because run.ts executes on
// import, so nothing in it can be unit tested.

/** A label becomes part of a file name and a directory name, so it stays to
 * plain characters. A path separator or a dot-only name would write outside
 * the results folder. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function checkLabel(label: string): string {
  if (!LABEL.test(label)) {
    throw new Error(
      `--label must start with a letter or digit and use only letters, digits, ".", "_" and "-", got ${JSON.stringify(label)}`,
    );
  }
  return label;
}

/** Where one run's results go, relative to the results folder and without an
 * extension. The unlabelled single run keeps the name it always had, so the
 * baseline files do not move. A label is appended to it, and a run number is
 * appended when the command repeats the run. */
export function resultSlug(
  base: string,
  label: string | undefined,
  run: number,
  runs: number,
): string {
  const labelled = label ? `${base}-${label}` : base;
  return runs > 1 ? `${labelled}-run${run}` : labelled;
}

/** The file that holds the mean and spread of a repeated run. */
export function summarySlug(base: string, label: string | undefined): string {
  return `${label ? `${base}-${label}` : base}-runs`;
}

export type Spread = {
  mean: number;
  /** Sample standard deviation (n - 1). 0 for a single run. */
  stddev: number;
  min: number;
  max: number;
};

export function spread(values: number[]): Spread {
  if (values.length === 0) return { mean: 0, stddev: 0, min: 0, max: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.length < 2
      ? 0
      : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (values.length - 1);
  return {
    mean,
    stddev: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** The numbers the experiment compares: precision and recall, the severe false
 * findings on clean pull requests with the P3 count kept apart, and the cost. */
export const REPEATED_METRICS = [
  "f1",
  "precision",
  "recall",
  "tp",
  "fp",
  "fn",
  "controlFalsePositiveTotal",
  "controlFalsePositiveRate",
  "controlNiceToHaveTotal",
  "failedControlPrs",
  "totalCost",
  "avgTimeMs",
] as const;

export type RepeatedMetric = (typeof REPEATED_METRICS)[number];

/** Mean and spread of each metric over the runs. A metric a run does not
 * carry counts as 0 for that run, so a missing field shows up as a wide
 * spread instead of being dropped. */
export function summarizeRuns(
  runs: Partial<Record<RepeatedMetric, number>>[],
): Record<RepeatedMetric, Spread> {
  const summary = {} as Record<RepeatedMetric, Spread>;
  for (const metric of REPEATED_METRICS) {
    summary[metric] = spread(runs.map((run) => run[metric] ?? 0));
  }
  return summary;
}

/** One line per metric for the console. */
export function formatSummary(
  summary: Record<RepeatedMetric, Spread>,
  runs: number,
): string {
  const lines = [`MEAN AND SPREAD over ${runs} runs (stddev is n - 1)`];
  for (const metric of REPEATED_METRICS) {
    const { mean, stddev, min, max } = summary[metric];
    lines.push(
      `  ${metric.padEnd(26)} mean=${mean.toFixed(3)}  stddev=${stddev.toFixed(3)}  min=${min.toFixed(3)}  max=${max.toFixed(3)}`,
    );
  }
  return lines.join("\n");
}
