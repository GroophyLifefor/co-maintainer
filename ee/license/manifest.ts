/** A list of what the enterprise files should be, and the check against it.
 *
 * Each release carries a manifest: the hash of every file under `ee/`. It is
 * signed with its own key, made in the build and not the license key, so a
 * leaked build key never signs a license. The check compares the files on disk
 * with it. A difference is a note in the admin page and the audit log, never a
 * stop: the license forbids changing these files, and the note is the record.
 *
 * It runs only when a license is loaded. A person who runs the code from
 * source has no license, and a warning there would be a false one. */
import { createHash, createPublicKey, verify } from "node:crypto";

export const MANIFEST_PREFIX = "co-maintainer-ee-manifest-v1\n";
export const MANIFEST_VERSION = 1;

/** The keys that sign manifests, by key id, as SPKI PEM text. Empty until the
 * build's public key is added. */
export type ManifestKeys = Readonly<Record<string, string>>;

export type Manifest = {
  v: number;
  kid: string;
  /** Path under `ee/`, with `/`, to the file's SHA-256 in hex. */
  files: Record<string, string>;
};

export type ManifestResult =
  | { ok: true; manifest: Manifest }
  | {
      ok: false;
      reason: "malformed" | "unknown_key" | "bad_signature" | "unknown_version";
    };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function hashFile(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Verifies a manifest's text. Never throws. */
export function verifyManifest(
  text: string,
  keys: ManifestKeys,
): ManifestResult {
  const parts = text.trim().split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, signature] = parts as [string, string];
  if (!BASE64URL.test(body) || !BASE64URL.test(signature)) {
    return { ok: false, reason: "malformed" };
  }
  const bytes = Buffer.from(body, "base64url");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "malformed" };
  }
  const record = raw as Record<string, unknown>;
  const kid = typeof record.kid === "string" ? record.kid : "";
  const pem = Object.hasOwn(keys, kid) ? keys[kid] : undefined;
  if (pem === undefined) return { ok: false, reason: "unknown_key" };
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.concat([Buffer.from(MANIFEST_PREFIX, "utf8"), bytes]),
      createPublicKey(pem),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (record.v !== MANIFEST_VERSION)
    return { ok: false, reason: "unknown_version" };
  const files = record.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return { ok: false, reason: "malformed" };
  }
  const clean: Record<string, string> = {};
  for (const [path, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !HEX64.test(hash)) {
      return { ok: false, reason: "malformed" };
    }
    clean[path] = hash;
  }
  return { ok: true, manifest: { v: MANIFEST_VERSION, kid, files: clean } };
}

export type EeCheck = {
  /** Files whose content is not what the manifest says. */
  changed: string[];
  /** Files the manifest lists that are not there. */
  missing: string[];
  /** Files under `ee/` the manifest does not list. */
  added: string[];
  /** True when every file is as listed. */
  clean: boolean;
};

/** Compares the files with the manifest. `current` is every file under `ee/`
 * as path to content. Test files and the manifest itself are not part of
 * what is compared: the caller leaves them out of `current`. */
export function checkEeFiles(
  manifest: Manifest,
  current: Record<string, string | Buffer>,
): EeCheck {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [path, hash] of Object.entries(manifest.files)) {
    const content = current[path];
    if (content === undefined) missing.push(path);
    else if (hashFile(content) !== hash) changed.push(path);
  }
  const added = Object.keys(current).filter(
    (path) => !Object.hasOwn(manifest.files, path),
  );
  changed.sort();
  missing.sort();
  added.sort();
  return {
    changed,
    missing,
    added,
    clean: changed.length + missing.length + added.length === 0,
  };
}

export type EeNote = {
  kind: "ee_modified";
  changed: string[];
  missing: string[];
  added: string[];
};

/** The note to show and to write to the audit log. Nothing without a license,
 * and nothing when the files are as listed. */
export function eeNote(check: EeCheck, licensed: boolean): EeNote | undefined {
  if (!licensed || check.clean) return undefined;
  return {
    kind: "ee_modified",
    changed: check.changed,
    missing: check.missing,
    added: check.added,
  };
}
