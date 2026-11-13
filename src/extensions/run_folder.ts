/** The folder one review shares with its extensions.
 *
 *   <config dir>/extensions/<run-id>/details.json     context
 *   <config dir>/extensions/<run-id>/cm-review.json   AI review results
 *   <config dir>/extensions/<run-id>/diff.patch       the diff
 *
 * The folder is removed however the review ends. A process that dies cannot
 * remove its own, so `serve` removes the folders of jobs no longer running at
 * startup and the CLI removes the folders of CLI runs whose process is gone.
 *
 * `state.json` records which extensions started. A `serve` job that runs again
 * after a restart finds its folder still there and learns from it which
 * extensions were cut off mid-run. */
import { dirname } from "node:path";
import { configPath } from "../config.ts";
import {
  isNotFound,
  isProcessAlive,
  mkdir,
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from "../util/runtime.ts";
import type { ReviewType } from "./registry.ts";

export type RunOwner = "cli" | "serve";

/** What every extension of one review reads from `details.json`. */
export type ExtensionDetails = {
  schemaVersion: 1;
  reviewType: ReviewType;
  repo: string;
  prNumber: number | null;
  branch: string | null;
  /** The checkout a local review runs in. Empty for PR and remote reviews,
   * where an extension makes its own checkout if it needs one. */
  workdir: string;
  headSha: string | null;
  baseSha: string | null;
  scope: string;
  sinceCommit: string | null;
  trigger: string;
  round: number;
  /** Empty until the AI review has finished. */
  reviewResultPath: string;
  diffPath: string;
};

export type RunFolder = {
  runId: string;
  dir: string;
  detailsPath: string;
  reviewResultPath: string;
  diffPath: string;
  /** The folder was already there: this run is a rerun after a restart. */
  restarted: boolean;
  /** Extensions that had started before the restart. */
  startedBefore: Set<string>;
  details: ExtensionDetails;
};

export function extensionsRoot(): string {
  return `${dirname(configPath())}/extensions`;
}

/** A run id becomes a directory name, so only plain characters pass. */
function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
    throw new Error(`invalid extension run id: ${runId}`);
  }
  return runId;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readTextFile(path)) as T;
  } catch {
    return undefined;
  }
}

type State = { started: string[] };
type Owner = { pid: number; kind: RunOwner };

export async function openRunFolder(input: {
  runId: string;
  owner: RunOwner;
  details: Omit<ExtensionDetails, "reviewResultPath" | "diffPath">;
  diff: string;
}): Promise<RunFolder> {
  const dir = `${extensionsRoot()}/${safeRunId(input.runId)}`;
  const state = await readJson<State>(`${dir}/state.json`);
  await mkdir(dir, { recursive: true });
  const folder: RunFolder = {
    runId: input.runId,
    dir,
    detailsPath: `${dir}/details.json`,
    reviewResultPath: `${dir}/cm-review.json`,
    diffPath: `${dir}/diff.patch`,
    restarted: state !== undefined,
    startedBefore: new Set(state?.started ?? []),
    details: { ...input.details, reviewResultPath: "", diffPath: "" },
  };
  folder.details.diffPath = folder.diffPath;
  const owner: Owner = { pid: process.pid, kind: input.owner };
  await writeTextFile(`${dir}/owner.json`, JSON.stringify(owner));
  await writeTextFile(folder.diffPath, input.diff);
  await writeDetails(folder);
  // A rerun keeps the old record until each extension starts again, so a
  // second restart still knows what the first one cut off.
  if (!state) await writeState(folder, []);
  return folder;
}

async function writeDetails(folder: RunFolder): Promise<void> {
  await writeTextFile(
    folder.detailsPath,
    `${JSON.stringify(folder.details, null, 2)}\n`,
  );
}

async function writeState(folder: RunFolder, started: string[]): Promise<void> {
  await writeTextFile(
    `${folder.dir}/state.json`,
    JSON.stringify({ started } satisfies State),
  );
}

/** Records that an extension started. Calls for one folder are serialised,
 * so two extensions starting together cannot drop each other's entry. */
const startedLocks = new Map<string, Promise<void>>();
export function markStarted(folder: RunFolder, name: string): Promise<void> {
  const previous = startedLocks.get(folder.dir) ?? Promise.resolve();
  const next = previous.then(async () => {
    const state = (await readJson<State>(`${folder.dir}/state.json`)) ?? {
      started: [],
    };
    if (!state.started.includes(name)) state.started.push(name);
    await writeState(folder, state.started);
  });
  const settled = next.catch(() => {});
  startedLocks.set(folder.dir, settled);
  return next;
}

/** Writes the AI review results and points `details.json` at them. */
export async function writeReviewResult(
  folder: RunFolder,
  result: unknown,
): Promise<void> {
  await writeTextFile(
    folder.reviewResultPath,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  folder.details.reviewResultPath = folder.reviewResultPath;
  await writeDetails(folder);
}

export async function removeRunFolder(folder: RunFolder): Promise<void> {
  startedLocks.delete(folder.dir);
  await remove(folder.dir, { recursive: true }).catch(() => {});
}

/** Removes the folders `keep` does not claim. `serve` keeps its running jobs,
 * the CLI keeps every folder whose process is alive. */
export async function removeStaleRunFolders(
  keep: (runId: string, owner: Owner | undefined) => boolean,
): Promise<number> {
  const root = extensionsRoot();
  let removed = 0;
  try {
    for await (const entry of readDir(root)) {
      if (!entry.isDirectory) continue;
      const owner = await readJson<Owner>(`${root}/${entry.name}/owner.json`);
      if (keep(entry.name, owner)) continue;
      await remove(`${root}/${entry.name}`, { recursive: true }).catch(
        () => {},
      );
      removed++;
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return removed;
}

/** The CLI's cleanup on its next review: a CLI run whose process is gone.
 * Folders `serve` owns are left to `serve`, which may still rerun them. */
export function removeDeadCliRunFolders(): Promise<number> {
  return removeStaleRunFolders(
    (_, owner) =>
      owner === undefined ||
      owner.kind !== "cli" ||
      owner.pid === process.pid ||
      isProcessAlive(owner.pid),
  );
}
