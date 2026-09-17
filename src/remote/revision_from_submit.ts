import type { Revision, RevisionFile } from "../review/revision.ts";

export function revisionFromSubmitJson(raw: unknown): Revision {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("revision must be an object");
  }
  const record = raw as Record<string, unknown>;
  const filesRaw = record.files;
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
    throw new Error("revision.files required");
  }
  const files: RevisionFile[] = filesRaw.map((file, index) => {
    if (typeof file !== "object" || file === null) {
      throw new Error(`revision.files[${index}] invalid`);
    }
    const f = file as Record<string, unknown>;
    return {
      path: String(f.path),
      previousPath: f.previousPath == null ? null : String(f.previousPath),
      status: f.status as RevisionFile["status"],
      binary: Boolean(f.binary),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
      patch: String(f.patch ?? ""),
    };
  });
  return {
    files,
    title: String(record.title ?? ""),
    description: String(record.description ?? ""),
    baseLabel: String(record.baseLabel ?? ""),
    producer: "remote",
  };
}
