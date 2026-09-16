import type { Json } from "../types.ts";
import {
  normalizePath,
  type Revision,
  type RevisionFile,
  type RevisionFileStatus,
} from "../review/revision.ts";

function githubStatus(raw: string): RevisionFileStatus {
  if (raw === "added") return "added";
  if (raw === "removed") return "removed";
  if (raw.startsWith("renamed")) return "renamed";
  return "modified";
}

export function githubFileToRevisionFile(file: Json): RevisionFile {
  const path = normalizePath(String(file.filename ?? ""));
  const status = githubStatus(String(file.status ?? "modified"));
  const additions = Number(file.additions ?? 0);
  const deletions = Number(file.deletions ?? 0);
  const patch = String(file.patch ?? "");
  const binary = patch === "" && additions + deletions > 0;
  return {
    path,
    previousPath: file.previous_filename
      ? normalizePath(String(file.previous_filename))
      : null,
    status,
    binary,
    additions,
    deletions,
    patch,
  };
}

export function githubPullRequestToRevision(
  files: Json[],
  pr: Json,
  baseLabel: string,
): Revision {
  return {
    files: files.map((file) => githubFileToRevisionFile(file as Json)),
    title: String(pr.title ?? ""),
    description: String(pr.body ?? ""),
    baseLabel,
    producer: "github",
  };
}
