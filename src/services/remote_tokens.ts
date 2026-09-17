import {
  deleteRemoteToken,
  findRemoteTokenByHash,
  findRemoteTokenByName,
  insertRemoteToken,
  listRemoteTokens,
  setRemoteTokenActive,
  touchRemoteToken,
} from "../store/remote_tokens.ts";
import type { RemoteTokenRow } from "../store/rows.ts";

const NAME_RE = /^[\w][\w .-]{0,63}$/;

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function base64Url(bytes: Uint8Array): string {
  const bin = [...bytes].map((b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateRemoteBearerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `cmr_${base64Url(bytes)}`;
}

export async function hashRemoteBearerToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export function validateRemoteTokenName(name: string): string | null {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    return "name must be 1–64 characters (letters, numbers, spaces, . -)";
  }
  return null;
}

export async function createRemoteToken(
  name: string,
): Promise<{ id: string; name: string; token: string }> {
  const err = validateRemoteTokenName(name);
  if (err) throw new Error(err);
  const trimmed = name.trim();
  if (findRemoteTokenByName(trimmed)) {
    throw new Error("name_taken");
  }
  const id = crypto.randomUUID();
  const token = generateRemoteBearerToken();
  const tokenHash = await hashRemoteBearerToken(token);
  insertRemoteToken(id, trimmed, tokenHash);
  return { id, name: trimmed, token };
}

export async function resolveRemoteToken(
  bearer: string,
): Promise<RemoteTokenRow | undefined> {
  const status = await lookupRemoteBearer(bearer);
  return status === "invalid" || status === "inactive" ? undefined : status;
}

export async function lookupRemoteBearer(
  bearer: string,
): Promise<RemoteTokenRow | "invalid" | "inactive"> {
  const token = bearer.startsWith("cmr_") ? bearer : `cmr_${bearer}`;
  const hash = await hashRemoteBearerToken(token);
  const row = findRemoteTokenByHash(hash);
  if (!row) return "invalid";
  if (row.active !== 1) return "inactive";
  touchRemoteToken(row.id);
  return row;
}

export {
  deleteRemoteToken,
  listRemoteTokens,
  setRemoteTokenActive,
  touchRemoteToken,
};
