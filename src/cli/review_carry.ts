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
import type { Revision, RevisionFile } from "../review/revision.ts";
import { visiblePathsToSave } from "../review/visible_paths.ts";
import { parseFindings } from "../pr/findings.ts";
import { resolvedFromFirstReview } from "./review_result.ts";
import {
  withResolvedReferences,
  type ReferenceContext,
} from "../review/references.ts";

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
      ...(row.references ? { references: row.references } : {}),
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
  /** A companion changed since the last round, so every carried finding is
   * checked again. */
  recheck?: boolean;
};

/** With `recheck`, a finding in an unchanged file is checked again: a
 * companion changed, and that can make it right or wrong. */
function rechecked(items: CarryItem[], recheck: boolean): CarryItem[] {
  if (!recheck) return items;
  return items.map((item) =>
    item.class === "unchanged"
      ? { ...item, class: "verify_companion_changed" }
      : item,
  );
}

/** `previous` is null on a first or fresh run, and then nothing is carried.
 * `recheck` is true when a companion changed since the last round: every
 * file is sent again and every carried finding is checked again. */
export function startCarryRun(
  previous: PreviousRun | null,
  revision: Revision,
  currentGuideBuiltAt: string | null,
  recheck = false,
): CarryRun {
  if (!previous) return { previous: null, items: [], extras: {} };
  const carryPrevious: CarryPrevious = {
    files: previous.files,
    visiblePaths: new Set(previous.visiblePaths),
    findings: previous.findings,
    guideBuiltAt: previous.guideBuiltAt,
  };
  const { unchanged } = incrementalDiffPaths(
    revision,
    previous.files,
    carryPrevious.visiblePaths,
  );
  const items = rechecked(
    classifyCarryItems(
      carryPrevious,
      revision,
      carryPrevious.visiblePaths,
      currentGuideBuiltAt,
    ),
    recheck,
  );
  return {
    previous: carryPrevious,
    items,
    extras: {
      unchangedPaths: recheck ? [] : unchanged,
      carryPrompt: buildCarryPromptSection(items, revision),
    },
    ...(recheck ? { recheck } : {}),
  };
}

/** Turns the engine's answer into `new`, `open` and `closed` rows. Without a
 * previous run every parsed finding is `new`. `visiblePaths` is what to save
 * for the next run, decided by `visiblePathsToSave`. */
export function finishCarryRun(
  run: CarryRun,
  revision: Revision,
  response: {
    text: string;
    visiblePaths: string[];
    guideBuiltAt: string | null;
    referenceContext?: ReferenceContext;
  },
  repo = "",
): { resolved: ResolvedFinding[]; visiblePaths: Set<string> } {
  const visiblePaths = new Set(response.visiblePaths);
  const parsed = parseFindings(response.text);
  if (!run.previous) {
    const filesByPath = new Map(revision.files.map((f) => [f.path, f]));
    return {
      resolved: withResolvedReferences(
        resolvedFromFirstReview(parsed, filesByPath),
        repo,
        response.referenceContext,
      ),
      visiblePaths: visiblePathsToSave(
        null,
        run.extras.unchangedPaths,
        visiblePaths,
      ),
    };
  }
  const items = rechecked(
    classifyCarryItems(
      run.previous,
      revision,
      visiblePaths,
      response.guideBuiltAt,
    ),
    run.recheck ?? false,
  );
  return {
    resolved: withResolvedReferences(
      resolveCarryOutcomes(
        items,
        revision,
        visiblePaths,
        parsePreviousVerdicts(response.text),
        parsed,
      ),
      repo,
      response.referenceContext,
    ),
    visiblePaths: visiblePathsToSave(
      run.previous.visiblePaths,
      run.extras.unchangedPaths,
      visiblePaths,
    ),
  };
}
