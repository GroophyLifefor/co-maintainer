/** Pins a review to a historical diff/discussion state instead of the PR's
 * current (latest) state — used by the benchmarks to show the model exactly
 * what a human reviewer saw, without leaking later comments as hints.
 * `base` defaults to the PR's merge-base with its base branch (the whole PR
 * so far); pass an earlier review round's commit as `base` to show only the
 * incremental diff a re-reviewer would see since that round (P11). */
export type Snapshot = { base?: string; commit: string; before: string };
