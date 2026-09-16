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
  const raw = await cacheGet(NS, key(repo, root, branch));
  if (!raw) return null;
  return JSON.parse(raw) as LocalCarrySnapshot;
}

export async function saveLocalCarry(snapshot: LocalCarrySnapshot): Promise<void> {
  const { subjectId, ...rest } = snapshot;
  const parts = subjectId.split("\0");
  if (parts.length !== 3) throw new Error("invalid local subject id");
  await cacheSet(NS, key(parts[0], parts[1], parts[2]), JSON.stringify({
    subjectId,
    ...rest,
  }));
}

export async function clearLocalCarry(
  repo: string,
  root: string,
  branch: string,
): Promise<void> {
  await cacheDelete(NS, key(repo, root, branch));
}
