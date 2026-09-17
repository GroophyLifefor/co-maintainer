import { rejectEscapingPath } from "../pr/codegraph_tool_args.ts";
import type { RevisionFileStatus } from "../review/revision.ts";
import {
  MIN_CLIENT_SCHEMA,
  REMOTE_KNOWN_TOOL_NAMES,
  REMOTE_SCHEMA_VERSION,
  REMOTE_SYNC_STATUSES,
} from "./schema.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REVISION_STATUSES = new Set<RevisionFileStatus>([
  "added",
  "modified",
  "removed",
  "renamed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(field: string, reason: string): string {
  return `${field}: ${reason}`;
}

export function parseSchemaVersion(
  body: Record<string, unknown>,
): number | string {
  const v = body.schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return bad("schemaVersion", "must be a positive integer");
  }
  return v;
}

export function assertClientSchema(version: number): string | null {
  if (version < MIN_CLIENT_SCHEMA) {
    return bad(
      "schemaVersion",
      `must be at least ${MIN_CLIENT_SCHEMA}`,
    );
  }
  if (version > REMOTE_SCHEMA_VERSION) {
    return bad(
      "schemaVersion",
      `must be at most ${REMOTE_SCHEMA_VERSION}`,
    );
  }
  return null;
}

function validateBranch(name: string, value: string): string | null {
  if (!value) return bad(name, "must not be empty");
  if (value.length > 255) return bad(name, "too long");
  if (/[\0\r\n]/.test(value)) return bad(name, "invalid characters");
  return null;
}

export function validateRemotePath(field: string, path: string): string | null {
  if (!path) return bad(field, "must not be empty");
  if (path.includes("\\")) return bad(field, "must use forward slashes");
  if (/[\0]/.test(path)) return bad(field, "invalid characters");
  const escape = rejectEscapingPath(path);
  if (escape) return bad(field, escape.replace(/^Tool error: /, ""));
  return null;
}

function validateRevisionFile(
  file: unknown,
  index: number,
  paths: Set<string>,
): string | null {
  if (!isRecord(file)) {
    return bad(`revision.files[${index}]`, "must be an object");
  }
  const path = file.path;
  if (typeof path !== "string") {
    return bad(`revision.files[${index}].path`, "must be a string");
  }
  const pathErr = validateRemotePath(`revision.files[${index}].path`, path);
  if (pathErr) return pathErr;
  if (paths.has(path)) {
    return bad(`revision.files[${index}].path`, "duplicate path");
  }
  paths.add(path);

  const status = file.status;
  if (typeof status !== "string" || !REVISION_STATUSES.has(status as RevisionFileStatus)) {
    return bad(`revision.files[${index}].status`, "invalid status");
  }

  const previousPath = file.previousPath;
  if (previousPath !== null && previousPath !== undefined) {
    if (typeof previousPath !== "string") {
      return bad(`revision.files[${index}].previousPath`, "must be a string or null");
    }
    const prevErr = validateRemotePath(
      `revision.files[${index}].previousPath`,
      previousPath,
    );
    if (prevErr) return prevErr;
  }
  if (status === "renamed") {
    if (typeof previousPath !== "string" || !previousPath) {
      return bad(`revision.files[${index}].previousPath`, "required for renamed");
    }
  }

  const binary = file.binary;
  if (typeof binary !== "boolean") {
    return bad(`revision.files[${index}].binary`, "must be a boolean");
  }
  const patch = file.patch;
  if (typeof patch !== "string") {
    return bad(`revision.files[${index}].patch`, "must be a string");
  }
  if (binary && patch.length > 0) {
    return bad(`revision.files[${index}].patch`, "must be empty for binary files");
  }

  for (const key of ["additions", "deletions"] as const) {
    const n = file[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      return bad(`revision.files[${index}].${key}`, "must be a non-negative integer");
    }
  }
  return null;
}

export function validateHandshakeRequest(body: unknown): string | null {
  if (!isRecord(body)) return "body must be an object";
  const version = parseSchemaVersion(body);
  if (typeof version === "string") return version;
  const schemaErr = assertClientSchema(version);
  if (schemaErr) return schemaErr;
  if (typeof body.clientVersion !== "string" || !body.clientVersion) {
    return bad("clientVersion", "required");
  }
  if (typeof body.repo !== "string" || !body.repo.includes("/")) {
    return bad("repo", "must be owner/repo");
  }
  return null;
}

export function validateSubmitRequest(body: unknown): string | null {
  if (!isRecord(body)) return "body must be an object";
  const version = parseSchemaVersion(body);
  if (typeof version === "string") return version;
  const schemaErr = assertClientSchema(version);
  if (schemaErr) return schemaErr;

  const requestId = body.requestId;
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return bad("requestId", "must be a UUID");
  }
  if (typeof body.repo !== "string" || !body.repo) {
    return bad("repo", "required");
  }
  const branchErr = validateBranch("branch", String(body.branch ?? ""));
  if (branchErr) return branchErr;
  if (body.toBranch !== undefined && typeof body.toBranch !== "string") {
    return bad("toBranch", "must be a string");
  }
  if (body.fresh !== undefined && typeof body.fresh !== "boolean") {
    return bad("fresh", "must be a boolean");
  }

  const revision = body.revision;
  if (!isRecord(revision)) return bad("revision", "required");
  const files = revision.files;
  if (!Array.isArray(files) || files.length < 1) {
    return bad("revision.files", "must have at least one file");
  }
  const paths = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const err = validateRevisionFile(files[i], i, paths);
    if (err) return err;
  }

  if (body.capabilities !== undefined) {
    if (!isRecord(body.capabilities)) {
      return bad("capabilities", "must be an object");
    }
    const tools = body.capabilities.tools;
    if (tools !== undefined) {
      if (!Array.isArray(tools)) return bad("capabilities.tools", "must be an array");
      for (let i = 0; i < tools.length; i++) {
        const tool = tools[i];
        if (!isRecord(tool)) {
          return bad(`capabilities.tools[${i}]`, "must be an object");
        }
        if (typeof tool.name !== "string" || !tool.name) {
          return bad(`capabilities.tools[${i}].name`, "required");
        }
        // Unknown tools are ignored at runtime; no error here (plan §14.5).
        if (
          REMOTE_KNOWN_TOOL_NAMES.has(tool.name) &&
          tool.version !== undefined &&
          typeof tool.version !== "string"
        ) {
          return bad(`capabilities.tools[${i}].version`, "must be a string");
        }
      }
    }
  }
  return null;
}

export function validateSyncRequest(body: unknown): string | null {
  if (!isRecord(body)) return "body must be an object";
  const version = parseSchemaVersion(body);
  if (typeof version === "string") return version;
  const schemaErr = assertClientSchema(version);
  if (schemaErr) return schemaErr;

  const after = body.afterLogSeq;
  if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
    return bad("afterLogSeq", "must be a non-negative integer");
  }

  const results = body.toolResults;
  if (results !== undefined) {
    if (!Array.isArray(results)) return bad("toolResults", "must be an array");
    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      if (!isRecord(row)) {
        return bad(`toolResults[${i}]`, "must be an object");
      }
      if (typeof row.callId !== "string" || !row.callId) {
        return bad(`toolResults[${i}].callId`, "required");
      }
      const hasOut = row.output !== undefined;
      const hasErr = row.error !== undefined;
      if (hasOut && typeof row.output !== "string") {
        return bad(`toolResults[${i}].output`, "must be a string");
      }
      if (hasErr && typeof row.error !== "string") {
        return bad(`toolResults[${i}].error`, "must be a string");
      }
    }
  }
  return null;
}

export function validateSyncResponseStatus(status: unknown): string | null {
  if (typeof status !== "string") return bad("status", "required");
  if (!(REMOTE_SYNC_STATUSES as readonly string[]).includes(status)) {
    return bad("status", "unexpected value");
  }
  return null;
}
