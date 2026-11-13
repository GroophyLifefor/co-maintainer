import { normalizePath } from "./revision.ts";

/** The paths the next round may treat as judged: what the model saw this run,
 * plus what an earlier run judged and this run left out because the file had
 * not changed. Without the second part a file drops out of the set the first
 * time it is unchanged, and a later fix to it is never put to the model: its
 * finding is marked unverifiable and stays open for good.
 *
 * A path leaves the set when its file leaves the diff. A removed file and the
 * old name of a renamed file are not among this run's unchanged files, so they
 * are not carried. A file that changed this run is not carried from before
 * either: it is in the set only when the model saw it this time.
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
