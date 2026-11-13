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

/** Turns the engine's answer into `new`, `open` and `closed` rows. Without a
 * previous run every parsed finding is `new`. */
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
      visiblePaths,
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
    visiblePaths,
  };
}
