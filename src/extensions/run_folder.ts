/** The folder one review shares with its extensions.
 *
 *   <config dir>/co-maintainer/extensions/<run-id>/details.json     context
 *   <config dir>/co-maintainer/extensions/<run-id>/cm-review.json   AI results
 *   <config dir>/co-maintainer/extensions/<run-id>/diff.patch       the diff
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
  getEnv,
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

/** `<config dir>/co-maintainer/extensions`. A `config.json` moved elsewhere
 * with `CM_CONFIG_PATH` may sit in a folder that holds anything, such as the
 * home folder, so the run folders go under a name of their own there:
 * `co-maintainer-extensions` next to that file. */
export function extensionsRoot(): string {
  if (getEnv("CM_CONFIG_PATH") === undefined) {
    return `${dirname(configPath())}/extensions`;
  }
  return `${dirname(configPath())}/co-maintainer-extensions`;
}

/** Every run id is a UUID, or `debug-` and a UUID. Nothing else is ever made
 * or removed under the extensions folder. */
const RUN_ID =
  /^(?:debug-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRunId(value: string | undefined): value is string {
  return value !== undefined && RUN_ID.test(value);
}

function safeRunId(runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error(`invalid extension run id: ${runId}`);
  }
  return runId;
}

/** Marks `owner.json` as co-maintainer's own. */
const OWNER_TOOL = "co-maintainer-extension-run";

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readTextFile(path)) as T;
  } catch {
    return undefined;
  }
}

type State = { started: string[] };
type Owner = { tool: typeof OWNER_TOOL; pid: number; kind: RunOwner };

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
  const owner: Owner = {
    tool: OWNER_TOOL,
    pid: process.pid,
    kind: input.owner,
  };
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

/** Removes the run folders `keep` does not claim. Only a folder named like a
 * run id that holds co-maintainer's own `owner.json` is ever a candidate:
 * anything else under the folder is someone else's and stays. */
export async function removeStaleRunFolders(
  keep: (runId: string, owner: Owner) => boolean,
): Promise<number> {
  const root = extensionsRoot();
  let removed = 0;
  try {
    for await (const entry of readDir(root)) {
      if (!entry.isDirectory || entry.isSymlink) continue;
      if (!RUN_ID.test(entry.name)) continue;
      const owner = await readJson<Owner>(`${root}/${entry.name}/owner.json`);
      if (owner?.tool !== OWNER_TOOL) continue;
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

/** `serve`'s cleanup at startup: every folder of a job no longer running, and
 * every CLI run whose process is gone. */
export function removeServeRunFolders(running: Set<string>): Promise<number> {
  return removeStaleRunFolders((runId, owner) =>
    owner.kind === "cli"
      ? owner.pid === process.pid || isProcessAlive(owner.pid)
      : running.has(runId),
  );
}

/** The CLI's cleanup on its next review: a CLI run whose process is gone.
 * Folders `serve` owns are left to `serve`, which may still rerun them. */
export function removeDeadCliRunFolders(): Promise<number> {
  return removeStaleRunFolders(
    (_, owner) =>
      owner.kind !== "cli" ||
      owner.pid === process.pid ||
      isProcessAlive(owner.pid),
  );
}
