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
/** Only a patch longer than this is summarized. A shorter one saves too little
 * room to be worth a model call and the loss of its code, so it is shown in
 * full or dropped. */
export const SUMMARY_MIN_PATCH_CHARS = 4_000;
/** At most this many summaries per review, largest files first. Each is one
 * low-model call, and a review made of summaries has no code to judge. */
export const MAX_SUMMARIES = 40;

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

export type PlannedFile = DiffFile & {
  state: FileState;
  /** A file with no patch text shown only as one line of the NO DIFF TEXT
   * list instead of its own block, which happens when the diff is over
   * budget. Its state does not change. */
  listed?: boolean;
};

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

/** The same facts as `emptyLabel`, as one line of the NO DIFF TEXT list. */
function noDiffLine(file: DiffFile): string {
  switch (file.empty) {
    case "binary":
      return `- ${file.path}: binary file`;
    case "renamed":
      return `- ${file.path}: renamed without changes${file.previousPath ? ` from ${file.previousPath}` : ""}`;
    case "no_changes":
      return `- ${file.path}: no changed lines`;
    default:
      return `- ${file.path}: diff withheld by GitHub (+${file.additions} -${file.deletions})`;
  }
}

const NO_DIFF_HEAD = [
  "NO DIFF TEXT: these files changed, but there is no diff text to show for",
  "them. Do not treat a withheld file as unchanged and do not report its contents.",
].join("\n");

/** The NO DIFF TEXT list, or `""` when no file is listed. */
export function noDiffBlock(files: PlannedFile[]): string {
  const listed = files.filter((file) => file.listed);
  if (listed.length === 0) return "";
  return [NO_DIFF_HEAD, ...capped(listed.map(noDiffLine))].join("\n");
}

/** One file's block in the DIFF section, or `""` for a dropped file, which
 * is listed under NOT SHOWN instead, and for a listed file, which is one line
 * of NO DIFF TEXT. */
export function renderSection(
  file: PlannedFile,
  options: RenderOptions,
): string {
  const head = `FILE: ${file.path}\n`;
  if (file.listed) return "";
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

/** A list of file names in the prompt names at most this many, then says how
 * many more there are. A local review of a moved or vendored tree has no
 * file limit, and an unbounded list could outgrow the model's context. */
export const MAX_LISTED_FILES = 200;

const NOT_SHOWN_HEAD = [
  "NOT SHOWN (diff budget): these files changed, but their diff did not fit in",
  "this prompt and they were not reviewed.",
];
const NOT_SHOWN_HOW = {
  tools: "Call read-full-diff to open one before reporting on it.",
  none: "This model cannot call tools, so they cannot be read here. Do not report on them.",
};

function droppedLine(file: DiffFile): string {
  return `- ${file.path} (+${file.additions} -${file.deletions})`;
}

/** At most `MAX_LISTED_FILES` lines, then one line for the rest. */
function capped(lines: string[]): string[] {
  if (lines.length <= MAX_LISTED_FILES) return lines;
  return [
    ...lines.slice(0, MAX_LISTED_FILES),
    `- and ${lines.length - MAX_LISTED_FILES} more`,
  ];
}

/** The NOT SHOWN list for dropped files, or `""` when none was dropped. */
export function notShownBlock(
  files: PlannedFile[],
  options: Pick<RenderOptions, "tools">,
): string {
  const dropped = files.filter((file) => file.state === "dropped");
  if (dropped.length === 0) return "";
  const [first, second] = NOT_SHOWN_HEAD;
  const how = options.tools ? NOT_SHOWN_HOW.tools : NOT_SHOWN_HOW.none;
  return [first, `${second} ${how}`, ...capped(dropped.map(droppedLine))].join(
    "\n",
  );
}

const SEPARATOR = "\n\n".length;
/** Room for the "- and N more" line and its line break, for any N. */
const MORE_LINE_CHARS = "\n- and 9999999999 more".length;

/** The most a capped list can add: its heading, the longest
 * `MAX_LISTED_FILES` lines it could show, and the "and N more" line. Kept as
 * running totals, so a plan over thousands of files stays linear. */
class ListBound {
  private count = 0;
  private sum = 0;
  private longest = 0;
  private readonly head: number;
  constructor(head: number) {
    this.head = head;
  }

  add(line: number): void {
    this.count++;
    this.sum += line + 1;
    this.longest = Math.max(this.longest, line + 1);
  }

  /** The longest line stays as it was, which keeps this an upper bound. */
  remove(line: number): void {
    this.count--;
    this.sum -= line + 1;
  }

  size(): number {
    if (this.count === 0) return 0;
    const more = this.count > MAX_LISTED_FILES ? MORE_LINE_CHARS : 0;
    return (
      this.head + Math.min(this.sum, MAX_LISTED_FILES * this.longest) + more
    );
  }
}

/** What the DIFF section will weigh: the file sections joined by blank lines,
 * then the NO DIFF TEXT and NOT SHOWN lists. All of it counts against
 * `MAX_REVIEW_DIFF_CHARS`. */
class Budget {
  private sections = 0;
  private shown = 0;
  private readonly dropped = new ListBound(
    NOT_SHOWN_HEAD.join("\n").length +
      Math.max(NOT_SHOWN_HOW.tools.length, NOT_SHOWN_HOW.none.length) +
      2,
  );
  private readonly noDiff = new ListBound(NO_DIFF_HEAD.length);

  private readonly size: (file: PlannedFile) => number;

  constructor(files: PlannedFile[], size: (file: PlannedFile) => number) {
    this.size = size;
    for (const file of files) {
      if (file.state === "dropped") this.dropped.add(droppedLine(file).length);
      else if (file.listed) this.noDiff.add(noDiffLine(file).length);
      else this.show(file);
    }
  }

  /** Moves a file with no patch text from its own block into the list. */
  list(file: PlannedFile): void {
    this.hide(file);
    file.listed = true;
    this.noDiff.add(noDiffLine(file).length);
  }

  show(file: PlannedFile): void {
    this.sections += this.size(file);
    this.shown++;
  }

  hide(file: PlannedFile): void {
    this.sections -= this.size(file);
    this.shown--;
  }

  drop(file: PlannedFile): void {
    this.hide(file);
    file.state = "dropped";
    this.dropped.add(droppedLine(file).length);
  }

  restore(file: PlannedFile, state: FileState): void {
    this.dropped.remove(droppedLine(file).length);
    file.state = state;
    this.show(file);
  }

  total(): number {
    const parts = [
      this.shown > 0 ? this.sections + SEPARATOR * (this.shown - 1) : 0,
      this.noDiff.size(),
      this.dropped.size(),
    ].filter((part) => part > 0);
    return (
      parts.reduce((sum, part) => sum + part, 0) +
      SEPARATOR * Math.max(0, parts.length - 1)
    );
  }
}

const DROPPABLE = new Set<FileState>(["full", "partial", "summarized"]);

/** Plain code-point order. `localeCompare` follows the process locale, so a
 * server and a laptop could drop different files from the same diff. */
export function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Over budget, every file with no patch text becomes one line of the capped
 * NO DIFF TEXT list. Its marker carries no code, so it goes before any file
 * that has a patch loses room. */
function listPatchless(
  files: PlannedFile[],
  budget: Budget,
  max: number,
): void {
  if (budget.total() <= max) return;
  for (const file of files) {
    if (file.patch === "" && !file.listed && file.state !== "dropped") {
      budget.list(file);
    }
  }
}

/** Drops files from the end of path order until the DIFF section fits. Both
 * the plan and the pass after the real summaries use it. Only a file with a
 * patch is dropped: files without one are listed first. Mutates `files`. */
export function dropUntilFits(
  files: PlannedFile[],
  size: (file: PlannedFile) => number,
  max = MAX_REVIEW_DIFF_CHARS,
): void {
  const budget = new Budget(files, size);
  listPatchless(files, budget, max);
  if (budget.total() <= max) return;
  const fromEnd = [...files].sort((a, b) => byPath(b.path, a.path));
  for (const file of fromEnd) {
    if (budget.total() <= max) return;
    if (!DROPPABLE.has(file.state) || file.patch === "") continue;
    budget.drop(file);
  }
}

/** The state a file has without a summary: its whole patch, or the first
 * `MAX_FILE_PATCH_CHARS` of it. */
function shownState(file: DiffFile): FileState {
  if (file.patch === "") {
    return file.empty === "withheld" || file.empty === undefined
      ? "withheld"
      : "full";
  }
  return file.patch.length > MAX_FILE_PATCH_CHARS ? "partial" : "full";
}

function summaryCandidate(file: DiffFile): boolean {
  return file.patch.length > SUMMARY_MIN_PATCH_CHARS;
}

/** After the drop pass the budget can have room left, because a large file
 * went where several small ones would have fit. Dropped files that fit come
 * back, smallest first, without a summary. Mutates `files`. */
export function restoreIntoRoom(
  files: PlannedFile[],
  size: (file: PlannedFile) => number,
  max = MAX_REVIEW_DIFF_CHARS,
): void {
  const budget = new Budget(files, size);
  if (budget.total() >= max) return;
  const dropped = files
    .filter((file) => file.state === "dropped")
    .map((file) => ({ file, state: shownState(file) }))
    .map((item) => ({
      ...item,
      chars: size({ ...item.file, state: item.state }),
    }))
    .sort((a, b) => a.chars - b.chars || byPath(a.file.path, b.file.path));
  for (const { file, state } of dropped) {
    budget.restore(file, state);
    if (budget.total() > max) budget.drop(file);
  }
}

/** The plan. Files keep their input order, and only dropping looks at path
 * order. Preference is always full, then partial or summarized, then
 * dropped.
 *
 * 1. A file over `DIFF_SUMMARY_THRESHOLD` changed lines is summarized.
 * 2. A patch over `MAX_FILE_PATCH_CHARS` is partial.
 * 3. While the total is over `MAX_REVIEW_DIFF_CHARS`, the largest full or
 *    partial file is summarized.
 * 4. If that is not enough, files are dropped from the end of path order.
 * 5. Dropped files that fit in the room left come back, smallest first.
 *
 * Only a patch over `SUMMARY_MIN_PATCH_CHARS` is ever summarized, by rule 1
 * or 3, and at most `MAX_SUMMARIES` per review, largest first. */
export function planDiff(
  files: DiffFile[],
  max = MAX_REVIEW_DIFF_CHARS,
): PlannedFile[] {
  const planned: PlannedFile[] = files.map((file) => ({
    ...file,
    state: shownState(file),
  }));
  const overThreshold = planned
    .filter(
      (file) => file.changes > DIFF_SUMMARY_THRESHOLD && summaryCandidate(file),
    )
    .sort((a, b) => b.patch.length - a.patch.length)
    .slice(0, MAX_SUMMARIES);
  for (const file of overThreshold) file.state = "summarized";
  let summaries = overThreshold.length;
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
  const budget = new Budget(planned, size);
  listPatchless(planned, budget, max);
  while (budget.total() > max && summaries < MAX_SUMMARIES) {
    let largest: PlannedFile | undefined;
    for (const file of planned) {
      if (file.state !== "full" && file.state !== "partial") continue;
      if (!summaryCandidate(file)) continue;
      if (!largest || size(file) > size(largest)) largest = file;
    }
    if (!largest || size(largest) <= asSummary(largest)) break;
    budget.hide(largest);
    largest.state = "summarized";
    budget.show(largest);
    summaries++;
  }
  dropUntilFits(planned, size, max);
  restoreIntoRoom(planned, size, max);
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
