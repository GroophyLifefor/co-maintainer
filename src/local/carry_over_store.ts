import { cacheDelete, cacheGet, cacheSet } from "../store/cache_db.ts";
import type { RevisionFile } from "../review/revision.ts";
import type { StoredFinding } from "../review/carry_over.ts";

const NS = "local-review";

export type LocalCarrySnapshot = {
  subjectId: string;
  files: RevisionFile[];
  visiblePaths: string[];
  findings: StoredFinding[];
  guideBuiltAt: string | null;
  /** The pull request head the findings were judged against. Only a pull
   * request snapshot has one: it is how a force-push is told from a push. */
  headSha?: string | null;
};

function key(repo: string, root: string, branch: string): string {
  return `${repo}\0${root}\0${branch}`;
}

export function localSubjectId(
  repo: string,
  root: string,
  branch: string,
): string {
  return key(repo, root, branch);
}

export async function loadLocalCarry(
  repo: string,
  root: string,
  branch: string,
): Promise<LocalCarrySnapshot | null> {
  const loaded = await tryLoadLocalCarry(repo, root, branch);
  if (loaded.unavailable) {
    throw new Error("local carry-over cache is unreadable");
  }
  return loaded.data;
}

/** Plan E163 — corrupt or locked cache must not abort review. */
export async function tryLoadLocalCarry(
  repo: string,
  root: string,
  branch: string,
): Promise<{ data: LocalCarrySnapshot | null; unavailable: boolean }> {
  try {
    const raw = await cacheGet(NS, key(repo, root, branch));
    if (!raw) return { data: null, unavailable: false };
    return { data: JSON.parse(raw) as LocalCarrySnapshot, unavailable: false };
  } catch {
    return { data: null, unavailable: true };
  }
}

export async function saveLocalCarry(
  snapshot: LocalCarrySnapshot,
): Promise<void> {
  const { subjectId, ...rest } = snapshot;
  const parts = subjectId.split("\0");
  if (parts.length !== 3) throw new Error("invalid local subject id");
  await cacheSet(
    NS,
    key(parts[0], parts[1], parts[2]),
    JSON.stringify({
      subjectId,
      ...rest,
    }),
  );
}

export async function clearLocalCarry(
  repo: string,
  root: string,
  branch: string,
): Promise<void> {
  await cacheDelete(NS, key(repo, root, branch));
}

// A pull request run lives in the same namespace under a second key shape,
// `${repo}\0pull-request\0${number}`. The middle part cannot be a git root,
// which is always an absolute path, so the two shapes never collide, and
// `clear` already removes every row that starts with `${repo}\0`.
const PR_PART = "pull-request";

export function prSubjectId(repo: string, prNumber: number): string {
  return key(repo, PR_PART, String(prNumber));
}

export async function tryLoadPrCarry(
  repo: string,
  prNumber: number,
): Promise<{ data: LocalCarrySnapshot | null; unavailable: boolean }> {
  return tryLoadLocalCarry(repo, PR_PART, String(prNumber));
}

export async function savePrCarry(snapshot: LocalCarrySnapshot): Promise<void> {
  await saveLocalCarry(snapshot);
}

export async function clearPrCarry(
  repo: string,
  prNumber: number,
): Promise<void> {
  await clearLocalCarry(repo, PR_PART, String(prNumber));
}
