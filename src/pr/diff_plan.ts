/** The diff plan: which state each changed file reaches the model in, decided
 * before any model call so nothing is cut blindly. Every file ends in exactly
 * one state, and the joined DIFF section fits in `MAX_REVIEW_DIFF_CHARS`.
 *
 * - `full`: the whole patch.
 * - `partial`: the first `MAX_FILE_PATCH_CHARS` characters, cut at a line.
 * - `summarized`: a low-model summary.
 * - `dropped`: only its path and counts, under NOT SHOWN.
 * - `withheld`: GitHub sent no patch, so there is nothing to show.
 *
 * This file is pure. The model calls live in `review_diff.ts`. */
import type { Json } from "../types.ts";
import type { RevisionFile, Revision } from "../review/revision.ts";
import type { Coverage } from "../review/coverage.ts";
import { DIFF_SUMMARY_THRESHOLD } from "./diff_summary.ts";
import { numberPatch } from "./hunks.ts";

/** A longer patch is shown up to here and marked `partial`. */
export const MAX_FILE_PATCH_CHARS = 12_000;
/** The whole DIFF section never grows past this. */
export const MAX_REVIEW_DIFF_CHARS = 240_000;
/** What the plan counts for one summary before the summary exists. The real
 * length is checked again once the summaries come back. */
export const PLANNED_SUMMARY_CHARS = 700;

export type FileState =
  | "full"
  | "partial"
  | "summarized"
  | "dropped"
  | "withheld";

/** Why a file has no patch text. Only `withheld` hides a change from the
 * model. The others are complete as a one-line label. */
export type EmptyPatch = "withheld" | "binary" | "renamed" | "no_changes";

export type DiffFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  /** Set exactly when `patch` is empty. */
  empty?: EmptyPatch;
};

export type PlannedFile = DiffFile & { state: FileState };

function count(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

/** A pure rename: GitHub reports it as `renamed` with no changed lines and
 * sends no patch, because there is none. */
function pureRename(status: string, changes: number): boolean {
  return status === "renamed" && changes === 0;
}

/** A file from GitHub's pull request or compare API. GitHub leaves `patch`
 * out for a file it considers too large or binary and gives no reason, so an
 * empty patch is `withheld`. The one exception is a pure rename, which has
 * nothing to withhold. */
export function diffFileFromGithub(file: Json): DiffFile {
  const patch = String(file.patch ?? "");
  const status = String(file.status ?? "modified");
  const changes = count(file.changes);
  const empty: EmptyPatch | undefined =
    patch !== ""
      ? undefined
      : pureRename(status, changes)
        ? "renamed"
        : "withheld";
  return {
    path: String(file.filename ?? ""),
    previousPath: file.previous_filename
      ? String(file.previous_filename)
      : null,
    status,
    additions: count(file.additions),
    deletions: count(file.deletions),
    changes,
    patch,
    ...(empty ? { empty } : {}),
  };
}

/** A file from a `Revision`. A revision built from git knows why a patch is
 * empty, so a binary file or a pure rename is labeled as what it is instead
 * of being described as withheld. */
export function diffFileFromRevision(
  file: RevisionFile,
  producer: Revision["producer"],
): DiffFile {
  const changes = file.additions + file.deletions;
  const empty: EmptyPatch | undefined =
    file.patch !== ""
      ? undefined
      : file.binary
        ? "binary"
        : pureRename(file.status, changes)
          ? "renamed"
          : producer === "github"
            ? "withheld"
            : "no_changes";
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes,
    patch: file.patch,
    ...(empty ? { empty } : {}),
  };
}

/** The patch cut to at most `max` characters at a line end, so a partial file
 * never shows half a line and its next line has a clean offset. */
export function cutAtLine(patch: string, max = MAX_FILE_PATCH_CHARS): string {
  if (patch.length <= max) return patch;
  const end = patch.lastIndexOf("\n", max);
  return end > 0 ? patch.slice(0, end) : patch.slice(0, max);
}

export type RenderOptions = {
  /** Whether the model can call `read-full-diff`. Without tool support the
   * markers say the rest cannot be read, rather than pointing at a tool the
   * model does not have. */
  tools: boolean;
  /** The file's summary, for a `summarized` file. */
  summary?: string;
};

/** GitHub omits `patch` for files it considers too large, and the file still
 * appears with only its counts. Rendering that as an empty body reads as "this
 * file did not change", and a reviewer then reports the absence as a finding
 * (a lockfile that was in fact regenerated, say). Say plainly that the hunks
 * are missing. A file git reports without hunks gets its real reason. */
function emptyLabel(file: DiffFile): string {
  switch (file.empty) {
    case "binary":
      return `[${file.status}: binary file]`;
    case "renamed":
      return `[renamed without changes${file.previousPath ? ` from ${file.previousPath}` : ""}]`;
    case "no_changes":
      return `[${file.status}: no changed lines]`;
    default: {
      const counts =
        file.changes > 0
          ? `${file.changes} changed lines (+${file.additions} -${file.deletions})`
          : "an unreported number of changed lines";
      return (
        `[${file.status}: ${counts}, diff withheld by GitHub, not shown here. ` +
        `Do not treat this file as unchanged and do not report its contents.]`
      );
    }
  }
}

/** One file's block in the DIFF section, or `""` for a dropped file, which
 * is listed under NOT SHOWN instead. */
export function renderSection(
  file: PlannedFile,
  options: RenderOptions,
): string {
  const head = `FILE: ${file.path}\n`;
  switch (file.state) {
    case "dropped":
      return "";
    case "withheld":
      return `${head}${emptyLabel(file)}`;
    case "full":
      return `${head}${file.patch === "" ? emptyLabel(file) : numberPatch(file.patch)}`;
    case "partial": {
      const shown = cutAtLine(file.patch);
      // A short file lands here only when its summary failed. Nothing was
      // cut, so no marker claims otherwise.
      if (shown === file.patch) return `${head}${numberPatch(file.patch)}`;
      const next = shown.split("\n").length;
      const rest = options.tools
        ? `Call read-full-diff with path "${file.path}" and offset=${next} for the rest.`
        : "The rest cannot be read in this review.";
      return (
        `${head}${numberPatch(shown)}\n[${file.status}: ${file.changes} ` +
        `changed lines total. This file's diff is cut off here, later hunks are ` +
        `not shown. ${rest}]`
      );
    }
    case "summarized": {
      const read = options.tools
        ? ` call read-full-diff("${file.path}") for the complete diff if this is not enough`
        : "";
      return `${head}[${file.changes} changed lines, summarized below.${read}]\n${options.summary ?? ""}`;
    }
  }
}

/** The NOT SHOWN list for dropped files, or `""` when none was dropped. */
export function notShownBlock(
  files: PlannedFile[],
  options: Pick<RenderOptions, "tools">,
): string {
  const dropped = files.filter((file) => file.state === "dropped");
  if (dropped.length === 0) return "";
  const how = options.tools
    ? "Call read-full-diff to open one before reporting on it."
    : "This model cannot call tools, so they cannot be read here. Do not report on them.";
  return [
    "NOT SHOWN (diff budget): these files changed, but their diff did not fit in",
    `this prompt and they were not reviewed. ${how}`,
    ...dropped.map(
      (file) => `- ${file.path} (+${file.additions} -${file.deletions})`,
    ),
  ].join("\n");
}

const SEPARATOR = "\n\n".length;

function totalChars(
  files: PlannedFile[],
  size: (file: PlannedFile) => number,
): number {
  const shown = files.filter((file) => file.state !== "dropped");
  if (shown.length === 0) return 0;
  return (
    shown.reduce((sum, file) => sum + size(file), 0) +
    SEPARATOR * (shown.length - 1)
  );
}

const DROPPABLE = new Set<FileState>(["full", "partial", "summarized"]);

/** Plain code-point order. `localeCompare` follows the process locale, so a
 * server and a laptop could drop different files from the same diff. */
export function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Drops files from the end of path order until the DIFF section fits. Both
 * the plan and the pass after the real summaries use it. Mutates `files`. */
export function dropUntilFits(
  files: PlannedFile[],
  size: (file: PlannedFile) => number,
  max = MAX_REVIEW_DIFF_CHARS,
): void {
  let total = totalChars(files, size);
  if (total <= max) return;
  const fromEnd = [...files].sort((a, b) => byPath(b.path, a.path));
  for (const file of fromEnd) {
    if (total <= max) return;
    if (!DROPPABLE.has(file.state)) continue;
    const shownBefore = files.filter((item) => item.state !== "dropped").length;
    total -= size(file) + (shownBefore > 1 ? SEPARATOR : 0);
    file.state = "dropped";
  }
}

/** The plan. Files keep their input order, and only dropping looks at path
 * order.
 *
 * 1. A file over `DIFF_SUMMARY_THRESHOLD` changed lines is summarized.
 * 2. A patch over `MAX_FILE_PATCH_CHARS` is partial.
 * 3. While the total is over `MAX_REVIEW_DIFF_CHARS`, the largest full or
 *    partial file is summarized. A file already smaller than its summary
 *    would be is left alone, since summarizing it would only grow the total.
 * 4. If that is not enough, files are dropped from the end of path order. */
export function planDiff(
  files: DiffFile[],
  max = MAX_REVIEW_DIFF_CHARS,
): PlannedFile[] {
  const planned: PlannedFile[] = files.map((file) => ({
    ...file,
    state:
      file.patch === ""
        ? file.empty === "withheld" || file.empty === undefined
          ? "withheld"
          : "full"
        : file.changes > DIFF_SUMMARY_THRESHOLD
          ? "summarized"
          : file.patch.length > MAX_FILE_PATCH_CHARS
            ? "partial"
            : "full",
  }));
  const cache = new Map<string, number>();
  const size = (file: PlannedFile): number => {
    const key = `${file.state}\0${file.path}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const length = renderSection(file, {
      tools: true,
      summary: "x".repeat(PLANNED_SUMMARY_CHARS),
    }).length;
    cache.set(key, length);
    return length;
  };
  const asSummary = (file: PlannedFile) =>
    size({ ...file, state: "summarized" });
  let total = totalChars(planned, size);
  while (total > max) {
    let largest: PlannedFile | undefined;
    for (const file of planned) {
      if (file.state !== "full" && file.state !== "partial") continue;
      if (file.patch === "") continue;
      if (!largest || size(file) > size(largest)) largest = file;
    }
    if (!largest || size(largest) <= asSummary(largest)) break;
    total -= size(largest) - asSummary(largest);
    largest.state = "summarized";
  }
  dropUntilFits(planned, size, max);
  return planned;
}

/** The files the model received in some form this round, plus the files it
 * received in an earlier round whose patch has not changed since. Only these
 * count as reviewed when the next round decides what to send again. */
export function seenPaths(
  planned: PlannedFile[],
  unchangedPaths: string[] = [],
): string[] {
  const seen = planned
    .filter((file) => DROPPABLE.has(file.state))
    .map((file) => file.path);
  return [...new Set([...seen, ...unchangedPaths])];
}

/** The coverage block for a planned round. A file carried over unchanged from
 * an earlier round counts as full: it needs no new review. */
export function coverageFromPlan(
  planned: PlannedFile[],
  unchangedPaths: string[] = [],
): Coverage {
  const paths = (state: FileState) =>
    planned.filter((file) => file.state === state).map((file) => file.path);
  return {
    full: paths("full").length + unchangedPaths.length,
    partial: paths("partial"),
    summarized: paths("summarized"),
    dropped: paths("dropped"),
    withheld: paths("withheld"),
  };
}
