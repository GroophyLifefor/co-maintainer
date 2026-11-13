/** The one call each review mode makes: run the AI review with its
 * extensions around it.
 *
 * The review starts at once and never waits for an extension. The extensions
 * that may run alongside it start too. When the review returns, its results
 * are written for the extensions that wait on it, and the call returns only
 * after every extension has finished, so a review is posted with all of them.
 * A review that throws cancels the extensions, and the run folder is removed
 * however the review ends.
 *
 * With `CM_EXTENSIONS_DISABLED=1`, or no registration for this repository and
 * review type, the review runs alone and nothing is written to disk. */
import { readConfig } from "../config.ts";
import {
  applicableRegistrations,
  extensionsDisabled,
  readRegistrations,
  rerunsOnRestart,
  type ReviewType,
} from "./registry.ts";
import {
  openRunFolder,
  removeDeadCliRunFolders,
  isRunId,
  removeRunFolder,
  writeReviewResult,
  type ExtensionDetails,
  type RunOwner,
} from "./run_folder.ts";
import { runExtensions } from "./runner.ts";
import {
  buildReport,
  EMPTY_REPORT,
  nextPrevious,
  type ExtensionReport,
  type PreviousExtensionFinding,
} from "./report.ts";

/** Where a review type keeps the keyed findings of its last round. */
export type ExtensionTracking = {
  /** The round number this review is, and the findings to compare with. */
  load(): Promise<{ round?: number; previous: PreviousExtensionFinding[] }>;
  /** `previous` is what the next round compares with. */
  save(
    report: ExtensionReport,
    previous: PreviousExtensionFinding[],
  ): Promise<void>;
};

export type ReviewContext = {
  /** A serve job passes its job id, so a rerun after a restart finds the
   * folder the first run left. The CLI leaves it out. */
  runId?: string;
  owner: RunOwner;
  reviewType: ReviewType;
  repo: string;
  prNumber: number | null;
  branch: string | null;
  workdir: string;
  headSha: string | null;
  baseSha: string | null;
  scope: string;
  sinceCommit: string | null;
  trigger: string;
  round: number;
  /** Built only when an extension runs. */
  diff: () => string | Promise<string>;
  /** Absent: every finding is new, as in a CLI pull request review, which
   * keeps nothing between runs. */
  tracking?: ExtensionTracking;
  signal?: AbortSignal;
  log?: (message: string) => void;
};

export type WithExtensions<T> = {
  review: T;
  /** Empty when no extension ran. */
  extensions: ExtensionReport;
};

/** One file of a review's diff, from GitHub or from git. */
export type DiffFile = {
  path: string;
  previousPath?: string | null;
  status?: string;
  patch: string;
};

const C_ESCAPES: Record<number, string> = {
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r",
  34: '\\"',
  92: "\\\\",
};

/** A path in a diff header, quoted the way git quotes it. A file name may
 * hold a newline, and unquoted it could forge a `+++` header in the patch an
 * extension reads. */
export function quotePath(path: string): string {
  const bytes = Buffer.from(path, "utf8");
  if (
    !bytes.some(
      (byte) => byte < 32 || byte >= 127 || byte === 34 || byte === 92,
    )
  ) {
    return path;
  }
  let out = "";
  for (const byte of bytes) {
    if (C_ESCAPES[byte]) out += C_ESCAPES[byte];
    else if (byte < 32 || byte >= 127)
      out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `"${out}"`;
}

/** A unified diff from the per-file patches every review type already has. */
export function unifiedDiff(files: DiffFile[]): string {
  return files
    .map((file) => {
      const before = file.previousPath ?? file.path;
      const oldName =
        file.status === "added" ? "/dev/null" : quotePath(`a/${before}`);
      const newName =
        file.status === "removed" ? "/dev/null" : quotePath(`b/${file.path}`);
      const body = file.patch.endsWith("\n") ? file.patch : `${file.patch}\n`;
      return `diff --git ${quotePath(`a/${before}`)} ${quotePath(`b/${file.path}`)}\n--- ${oldName}\n+++ ${newName}\n${file.patch ? body : ""}`;
    })
    .join("");
}

export async function withExtensions<T>(
  context: ReviewContext,
  review: () => Promise<T>,
  reviewResult: (result: T) => unknown,
): Promise<WithExtensions<T>> {
  if (extensionsDisabled()) {
    return { review: await review(), extensions: EMPTY_REPORT };
  }
  const config = readConfig();
  const registrations = applicableRegistrations(
    readRegistrations(config),
    context.repo,
    context.reviewType,
  );
  if (registrations.length === 0) {
    return { review: await review(), extensions: EMPTY_REPORT };
  }
  if (context.owner === "cli") await removeDeadCliRunFolders().catch(() => 0);
  const tracked = (await context.tracking?.load().catch(() => undefined)) ?? {
    previous: [],
  };
  // The diff first: building it may fill in the context's shas.
  const diff = await context.diff();
  const details: Omit<ExtensionDetails, "reviewResultPath" | "diffPath"> = {
    schemaVersion: 1,
    reviewType: context.reviewType,
    repo: context.repo,
    prNumber: context.prNumber,
    branch: context.branch,
    workdir: context.workdir,
    headSha: context.headSha,
    baseSha: context.baseSha,
    scope: context.scope,
    sinceCommit: context.sinceCommit,
    trigger: context.trigger,
    round: tracked.round ?? context.round,
  };
  const folder = await openRunFolder({
    // A job id that is not a UUID cannot name a run folder. Such a run only
    // loses its restart record.
    runId: isRunId(context.runId) ? context.runId : crypto.randomUUID(),
    owner: context.owner,
    details,
    diff,
  });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (context.signal?.aborted) controller.abort();
  context.signal?.addEventListener("abort", onAbort, { once: true });
  let reviewSettled!: (done: boolean) => void;
  const reviewDone = new Promise<boolean>((resolve) => {
    reviewSettled = resolve;
  });
  context.log?.(
    `extensions: ${registrations.map((entry) => entry.name).join(", ")}`,
  );
  const running = runExtensions({
    registrations,
    folder,
    cwd: context.workdir || undefined,
    reviewDone,
    signal: controller.signal,
    rerunOnRestart: (entry) => rerunsOnRestart(entry, config),
    log: context.log,
  });
  try {
    let result: T;
    try {
      result = await review();
      await writeReviewResult(folder, await reviewResult(result));
    } catch (error) {
      controller.abort();
      reviewSettled(false);
      await running;
      throw error;
    }
    reviewSettled(true);
    const results = await running;
    for (const entry of results) {
      context.log?.(
        `extension ${entry.name}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ""}`,
      );
    }
    const extensions = buildReport(results, tracked.previous);
    try {
      await context.tracking?.save(
        extensions,
        nextPrevious(extensions, tracked.previous),
      );
    } catch (error) {
      // Losing the tracking state costs the next round its open and closed
      // states. It does not cost this review.
      context.log?.(
        `could not save the extension findings for the next round: ${String(error)}`,
      );
    }
    return { review: result, extensions };
  } finally {
    context.signal?.removeEventListener("abort", onAbort);
    await removeRunFolder(folder);
  }
}
