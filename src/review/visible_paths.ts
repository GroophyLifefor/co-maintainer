import { normalizePath } from "./revision.ts";

/** The states in which a file's diff reached the model this round, in full,
 * cut, or summarized. A `dropped` file was only named and a `withheld` one had
 * no diff at all, so neither ever counts as seen. */
const SEEN_STATES = new Set(["full", "partial", "summarized"]);

/** The files the model received this round, from the diff plan's states.
 * This is what every reviewer function returns as `visiblePaths`. */
export function pathsSeenInRound(
  files: Iterable<{ path: string; state: string }>,
): string[] {
  const seen: string[] = [];
  for (const file of files) {
    if (SEEN_STATES.has(file.state)) seen.push(file.path);
  }
  return seen;
}

/** The paths the next round may treat as judged: what the model saw this run,
 * plus what an earlier run judged and this run left out because the file had
 * not changed. Without the second part a file drops out of the set the first
 * time it is unchanged, and a later fix to it is never put to the model: its
 * finding is marked unverifiable and stays open for good.
 *
 * A path leaves the set when its file leaves the diff. A removed file and the
 * old name of a renamed file are not among this run's unchanged files, so they
 * are not carried. A file that changed this run is not carried from before
 * either: it is in the set only when the model saw it this time, so a file
 * the diff plan dropped or withheld is never in it. `incrementalDiffPaths`
 * reads this set, which is how a dropped file is sent again next round.
 *
 * Every review that saves a round's seen paths decides them here: local
 * review, CLI pull request review, App review and remote review. */
export function visiblePathsToSave(
  previousVisible: Iterable<string> | null | undefined,
  unchangedPaths: string[] | undefined,
  seenThisRun: Iterable<string>,
): Set<string> {
  const saved = new Set(seenThisRun);
  if (!previousVisible || !unchangedPaths) return saved;
  const unchanged = new Set(unchangedPaths.map((path) => normalizePath(path)));
  for (const path of previousVisible) {
    if (unchanged.has(normalizePath(path))) saved.add(path);
  }
  return saved;
}
