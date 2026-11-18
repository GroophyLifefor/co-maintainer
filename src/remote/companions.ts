/** Companions in remote review (issue 81). The client builds each companion's
 * diff from `--with` and sends it behind the handshake feature `companions`,
 * as `companions: [{ repo, branch, files, private }]`. The server reads them
 * as context, caps their patches, and asks the client to search a companion
 * through the tool bridge. A client that sends none changes nothing. */
import type { RevisionFile, RevisionFileStatus } from "../review/revision.ts";
import {
  type Companion,
  COMPANION_PATCH_MAX_CHARS,
  MAX_COMPANIONS,
} from "../review/companions.ts";
import type { CoverageWarning } from "../review/coverage.ts";
import { validateBranch, validateRevisionFile } from "./validate.ts";

/** The handshake feature a server lists when it reads companions. */
export const COMPANIONS_FEATURE = "companions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a submit's `companions` is refused, or `null` when it is fine or not
 * there. */
export function validateCompanionsPayload(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "companions: must be an array";
  if (value.length > MAX_COMPANIONS) {
    return `companions: at most ${MAX_COMPANIONS}`;
  }
  const repos = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const field = `companions[${i}]`;
    if (!isRecord(item)) return `${field}: must be an object`;
    if (
      typeof item.repo !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repo)
    ) {
      return `${field}.repo: must be owner/repo`;
    }
    if (repos.has(item.repo.toLowerCase())) {
      return `${field}.repo: given more than once`;
    }
    repos.add(item.repo.toLowerCase());
    if (typeof item.branch !== "string") {
      return `${field}.branch: must be a string`;
    }
    const branchErr = validateBranch(`${field}.branch`, item.branch);
    if (branchErr) return branchErr;
    if (item.private !== undefined && typeof item.private !== "boolean") {
      return `${field}.private: must be a boolean`;
    }
    if (!Array.isArray(item.files)) return `${field}.files: must be an array`;
    const paths = new Set<string>();
    for (let j = 0; j < item.files.length; j++) {
      const err = validateRevisionFile(item.files[j], j, paths);
      if (err) return `${field}.${err.replace(/^revision\./, "")}`;
    }
  }
  return null;
}

/** The companions a stored submit holds. A companion that says nothing about
 * its visibility is private. */
export function companionsFromSubmit(value: unknown): Companion[] {
  if (validateCompanionsPayload(value) || !Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      repo: item.repo as string,
      branch: item.branch as string,
      private: item.private !== false,
      files: (item.files as Record<string, unknown>[]).map(
        (file) =>
          ({
            path: file.path as string,
            previousPath:
              file.previousPath == null ? null : (file.previousPath as string),
            status: file.status as RevisionFileStatus,
            binary: file.binary as boolean,
            additions: file.additions as number,
            deletions: file.deletions as number,
            patch: file.patch as string,
          }) satisfies RevisionFile,
      ),
    };
  });
}

/** The companions within the server's patch limit. Above it every file list
 * is kept and every patch is dropped, with one `companion_list_cut`
 * warning. */
export function capCompanionPatches(
  companions: Companion[],
  maxChars = COMPANION_PATCH_MAX_CHARS,
): { companions: Companion[]; warnings: CoverageWarning[] } {
  const total = companions.reduce(
    (sum, companion) =>
      sum + companion.files.reduce((n, file) => n + file.patch.length, 0),
    0,
  );
  if (total <= maxChars) return { companions, warnings: [] };
  return {
    companions: companions.map((companion) => ({
      ...companion,
      files: companion.files.map((file) => ({ ...file, patch: "" })),
    })),
    warnings: [
      {
        code: "companion_list_cut",
        message: `The companions' patches came to ${total} characters, over this server's limit of ${maxChars}, so the review read their file lists only.`,
      },
    ],
  };
}
