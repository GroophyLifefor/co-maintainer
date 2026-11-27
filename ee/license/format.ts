/** The license file: what it holds and how it is verified.
 *
 * Enterprise edition code. The license terms of this folder are not written
 * yet (open question with counsel), so nothing here ships in the npm package.
 *
 * A file is `payload.signature`, both base64url. The payload is JSON. The
 * signature is Ed25519 over the fixed prefix and the payload's own bytes, as
 * they are in the file: nothing is parsed and written out again before it is
 * checked. The product only verifies, it never signs: the private key is not
 * here and is never on a server.
 *
 * A file carries the right to use: who, what, until when. No price, discount,
 * credit or payment plan is in it, and no contact address. */
import { createPublicKey, verify } from "node:crypto";

/** The bytes in front of the payload that the signature covers. A signature
 * made for anything else cannot be replayed as a license. */
export const LICENSE_PREFIX = "co-maintainer-license-v1\n";
/** The one format version this build reads. A file of a newer version is
 * refused with a message to upgrade, never half read. */
export const LICENSE_VERSION = 1;

export type LicenseKind = "enterprise" | "trial" | "staging";
const KINDS: readonly string[] = ["enterprise", "trial", "staging"];

export type LicensePayload = {
  v: number;
  /** The license's own id. */
  id: string;
  /** Which public key signed it. */
  kid: string;
  kind: LicenseKind;
  customer: { id: string; name: string };
  /** The installation it is for. */
  install_id: string;
  seats: number;
  /** Module names. A name this build does not know is kept and ignored. */
  modules: string[];
  /** UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
  issued_at: string;
  not_before: string;
  expires_at: string;
};

/** The public keys a build trusts, by key id: SPKI PEM text. Two slots from
 * the first day, the active one and an offline spare, so a key can be
 * replaced without making every license in the field unreadable. */
export type PublicKeys = Readonly<Record<string, string>>;

export type VerifyFailure =
  | "malformed"
  | "unknown_version"
  | "unknown_key"
  | "bad_signature"
  | "bad_payload";

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: VerifyFailure; detail?: string };

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A UTC time as milliseconds, or undefined when it is not in the one
 * accepted form. */
export function parseUtc(value: unknown): number | undefined {
  if (typeof value !== "string" || !UTC_TIME.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function fail(reason: VerifyFailure, detail?: string): VerifyResult {
  return detail === undefined
    ? { ok: false, reason }
    : { ok: false, reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the fields this build knows. Fields it does not know are dropped. */
function readPayload(raw: Record<string, unknown>): LicensePayload | string {
  const text = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const id = text("id");
  const kid = text("kid");
  const installId = text("install_id");
  if (!id) return "id";
  if (!kid) return "kid";
  if (!installId) return "install_id";
  const kind = raw.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return "kind";
  const customer = raw.customer;
  if (
    !isRecord(customer) ||
    typeof customer.id !== "string" ||
    customer.id === "" ||
    typeof customer.name !== "string"
  ) {
    return "customer";
  }
  const seats = raw.seats;
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 0) {
    return "seats";
  }
  const modules = raw.modules;
  if (
    !Array.isArray(modules) ||
    !modules.every((item) => typeof item === "string")
  ) {
    return "modules";
  }
  const issued = parseUtc(raw.issued_at);
  const notBefore = parseUtc(raw.not_before);
  const expires = parseUtc(raw.expires_at);
  if (issued === undefined) return "issued_at";
  if (notBefore === undefined) return "not_before";
  if (expires === undefined) return "expires_at";
  if (expires < notBefore) return "expires_at";
  return {
    v: LICENSE_VERSION,
    id,
    kid,
    kind: kind as LicenseKind,
    customer: { id: customer.id, name: customer.name },
    install_id: installId,
    seats,
    modules: [...new Set(modules as string[])],
    issued_at: raw.issued_at as string,
    not_before: raw.not_before as string,
    expires_at: raw.expires_at as string,
  };
}

/** Verifies a license file's text against the keys this build trusts. Never
 * throws: a file that cannot be used says why, and the caller treats it as no
 * license. */
export function verifyLicenseFile(
  text: string,
  keys: PublicKeys,
): VerifyResult {
  const parts = text.trim().split(".");
  if (parts.length !== 2) return fail("malformed");
  const [payloadText, signatureText] = parts as [string, string];
  if (!BASE64URL.test(payloadText) || !BASE64URL.test(signatureText)) {
    return fail("malformed");
  }
  const payloadBytes = Buffer.from(payloadText, "base64url");
  const signature = Buffer.from(signatureText, "base64url");
  let raw: unknown;
  try {
    raw = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return fail("malformed");
  }
  if (!isRecord(raw)) return fail("malformed");
  // Only a key id is read from the unchecked payload, and only to pick one of
  // the keys this build already trusts.
  const kid = typeof raw.kid === "string" ? raw.kid : "";
  const pem = Object.hasOwn(keys, kid) ? keys[kid] : undefined;
  if (pem === undefined) return fail("unknown_key", kid);
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.concat([Buffer.from(LICENSE_PREFIX, "utf8"), payloadBytes]),
      createPublicKey(pem),
      signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) return fail("bad_signature");
  // A signed file of another version is a valid file this build cannot read.
  if (raw.v !== LICENSE_VERSION) {
    return fail("unknown_version", String(raw.v));
  }
  const payload = readPayload(raw);
  if (typeof payload === "string") return fail("bad_payload", payload);
  return { ok: true, payload };
}
