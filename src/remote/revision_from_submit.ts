import type {
  Revision,
  RevisionFile,
  RevisionFileStatus,
} from "../review/revision.ts";
import { validateRevisionPayload } from "./validate.ts";

export function revisionFromSubmitJson(raw: unknown): Revision {
  const err = validateRevisionPayload(raw);
  if (err) throw new Error(err);
  const record = raw as Record<string, unknown>;
  const files = (record.files as unknown[]).map((file) => {
    const f = file as Record<string, unknown>;
    return {
      path: f.path as string,
      previousPath: f.previousPath == null ? null : (f.previousPath as string),
      status: f.status as RevisionFileStatus,
      binary: f.binary as boolean,
      additions: f.additions as number,
      deletions: f.deletions as number,
      patch: f.patch as string,
    } satisfies RevisionFile;
  });
  return {
    files,
    title: typeof record.title === "string" ? record.title : "",
    description:
      typeof record.description === "string" ? record.description : "",
    baseLabel: typeof record.baseLabel === "string" ? record.baseLabel : "",
    producer: "remote",
  };
}
