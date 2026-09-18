export type RevisionFileStatus = "added" | "modified" | "removed" | "renamed";

export type RevisionFile = {
  path: string;
  previousPath: string | null;
  status: RevisionFileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  patch: string;
};

export type Revision = {
  files: RevisionFile[];
  title: string;
  description: string;
  baseLabel: string;
  producer: "github" | "local" | "remote";
};

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Patch body for carry-over comparison (11.2). */
/** Whether two revision files represent the same change for carry-over scope. */
export function revisionFilesEquivalent(
  a: RevisionFile,
  b: RevisionFile,
): boolean {
  if (a.status !== b.status) return false;
  if (a.binary !== b.binary) return false;
  if (a.additions !== b.additions || a.deletions !== b.deletions) return false;
  if ((a.previousPath ?? "") !== (b.previousPath ?? "")) return false;
  return normalizeBody(a.patch) === normalizeBody(b.patch);
}

export function normalizeBody(patch: string): string {
  const lines = patch.split("\n").flatMap((line) => {
    if (line.startsWith("@@")) return ["@@"];
    if (line === "\\ No newline at end of file") return [];
    return [line.replace(/\r$/, "").trimEnd()];
  });
  return lines.join("\n");
}

export function normalizeAnchor(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

export async function revisionHash(revision: Revision): Promise<string> {
  const parts: string[] = [];
  const files = [...revision.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  for (const file of files) {
    parts.push(
      file.path,
      file.status,
      file.previousPath ?? "",
      String(file.binary),
      normalizeBody(file.patch),
    );
  }
  const data = new TextEncoder().encode(parts.join("\0"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function fileByPath(
  revision: Revision,
  path: string,
): RevisionFile | undefined {
  const normalized = normalizePath(path);
  return revision.files.find((file) => normalizePath(file.path) === normalized);
}

export function resolvePathAfterRename(
  revision: Revision,
  previousPath: string | null,
): string | null {
  if (!previousPath) return null;
  const renamed = revision.files.find(
    (file) =>
      file.status === "renamed" &&
      file.previousPath &&
      normalizePath(file.previousPath) === normalizePath(previousPath),
  );
  return renamed ? renamed.path : previousPath;
}
