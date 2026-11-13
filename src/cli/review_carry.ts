import {
  buildCarryPromptSection,
  classifyCarryItems,
  incrementalDiffPaths,
  parsePreviousVerdicts,
  resolveCarryOutcomes,
  type CarryItem,
  type CarryPrevious,
  type ResolvedFinding,
  type StoredFinding,
} from "../review/carry_over.ts";
import {
  normalizePath,
  type Revision,
  type RevisionFile,
} from "../review/revision.ts";
import { parseFindings } from "../pr/findings.ts";
import { resolvedFromFirstReview } from "./review_result.ts";

/** What a CLI run keeps for the next one: the findings that are still live. */
export function storedFindings(resolved: ResolvedFinding[]): StoredFinding[] {
  return resolved
    .filter((row) => row.state === "new" || row.state === "open")
    .map((row) => ({
      id: row.id,
      path: row.path,
      lineFrom: row.lineFrom,
      lineTo: row.lineTo,
      title: row.title,
      bodyMd: row.bodyMd,
      anchorText: row.anchorText,
      severity: row.severity,
      firstSeenReviewId: row.firstSeenReviewId,
    }));
}

export type PreviousRun = {
  files: RevisionFile[];
  visiblePaths: string[];
  findings: StoredFinding[];
  guideBuiltAt: string | null;
};

/** The carry-over a CLI review (local or pull request) hands the engine. */
export type CarryRun = {
  previous: CarryPrevious | null;
  items: CarryItem[];
  extras: { carryPrompt?: string; unchangedPaths?: string[] };
};

/** `previous` is null on a first or fresh run, and then nothing is carried. */
export function startCarryRun(
  previous: PreviousRun | null,
  revision: Revision,
  currentGuideBuiltAt: string | null,
): CarryRun {
  if (!previous) return { previous: null, items: [], extras: {} };
  const carryPrevious: CarryPrevious = {
    files: previous.files,
    visiblePaths: new Set(previous.visiblePaths),
    findings: previous.findings,
    guideBuiltAt: previous.guideBuiltAt,
  };
  const { unchanged } = incrementalDiffPaths(revision, previous.files);
  const items = classifyCarryItems(
    carryPrevious,
    revision,
    carryPrevious.visiblePaths,
    currentGuideBuiltAt,
  );
  return {
    previous: carryPrevious,
    items,
    extras: {
      unchangedPaths: unchanged,
      carryPrompt: buildCarryPromptSection(items, revision),
    },
  };
}

/** The paths the next run may treat as judged: what the model saw this run,
 * plus what an earlier run judged and this run left out because the file had
 * not changed. Without the second part a file drops out of the set the first
 * time it is unchanged, and a later fix to it is never put to the model: its
 * finding is marked unverifiable and stays open for good.
 *
 * A path leaves the set when its file leaves the diff. A removed file and the
 * old name of a renamed file are not among this run's unchanged files, so they
 * are not carried. A file that changed this run is not carried from before
 * either: it is in the set only when the model saw it this time. */
function visiblePathsToSave(
  run: CarryRun,
  seenThisRun: Set<string>,
): Set<string> {
  const saved = new Set(seenThisRun);
  if (!run.previous) return saved;
  const unchanged = new Set(
    (run.extras.unchangedPaths ?? []).map((path) => normalizePath(path)),
  );
  for (const path of run.previous.visiblePaths) {
    if (unchanged.has(normalizePath(path))) saved.add(path);
  }
  return saved;
}

/** Turns the engine's answer into `new`, `open` and `closed` rows. Without a
 * previous run every parsed finding is `new`. `visiblePaths` is what to save
 * for the next run, see `visiblePathsToSave`. */
export function finishCarryRun(
  run: CarryRun,
  revision: Revision,
  response: {
    text: string;
    visiblePaths: string[];
    guideBuiltAt: string | null;
  },
): { resolved: ResolvedFinding[]; visiblePaths: Set<string> } {
  const visiblePaths = new Set(response.visiblePaths);
  const parsed = parseFindings(response.text);
  if (!run.previous) {
    const filesByPath = new Map(revision.files.map((f) => [f.path, f]));
    return {
      resolved: resolvedFromFirstReview(parsed, filesByPath),
      visiblePaths: visiblePathsToSave(run, visiblePaths),
    };
  }
  const items = classifyCarryItems(
    run.previous,
    revision,
    visiblePaths,
    response.guideBuiltAt,
  );
  return {
    resolved: resolveCarryOutcomes(
      items,
      revision,
      visiblePaths,
      parsePreviousVerdicts(response.text),
      parsed,
    ),
    visiblePaths: visiblePathsToSave(run, visiblePaths),
  };
}
