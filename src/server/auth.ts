/** Only a token's hash ever reaches `store/sessions.ts`; the raw token is
 * handed back once, at login, and never stored. */
import { deleteSession, getSession, insertSession } from "../store/sessions.ts";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_DURATION_MS = 10 * 60 * 1000;

export const USERNAME = "admin";
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "co-maintainer";
export const SESSION_COOKIE = "cm";
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Attempt = {
  failures: number;
  firstFailureAt: number;
  lockedUntil?: number;
};
// ponytail: an in-memory Map, one entry per distinct IP that has ever failed
// a login. Fine for a single self-hosted admin; add eviction if this ever
// needs to survive a hostile flood of spoofed source IPs.
const attempts = new Map<string, Attempt>();

export function isLockedOut(ip: string): boolean {
  const attempt = attempts.get(ip);
  if (!attempt?.lockedUntil) return false;
  if (Date.now() >= attempt.lockedUntil) {
    attempts.delete(ip);
    return false;
  }
  return true;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const attempt = attempts.get(ip);
  if (!attempt || now - attempt.firstFailureAt > LOCKOUT_WINDOW_MS) {
    attempts.set(ip, { failures: 1, firstFailureAt: now });
    return;
  }
  attempt.failures++;
  if (attempt.failures >= LOCKOUT_THRESHOLD) {
    attempt.lockedUntil = now + LOCKOUT_DURATION_MS;
  }
}

function recordSuccess(ip: string): void {
  attempts.delete(ip);
}

export function hasCsrfHeader(request: Request): boolean {
  return request.headers.get(CSRF_HEADER) === CSRF_VALUE;
}

export type LoginResult = {
  token: string;
  username: string;
  expiresAt: string;
};

/** A locked-out attempt is indistinguishable from a wrong password to the
 * caller — both return `undefined` — so a probe gains nothing either way. */
export async function login(
  password: string,
  expected: string,
  ip: string,
): Promise<LoginResult | undefined> {
  if (isLockedOut(ip) || password !== expected) {
    recordFailure(ip);
    return undefined;
  }
  recordSuccess(ip);
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  insertSession(await sha256Hex(token), USERNAME, expiresAt);
  return { token, username: USERNAME, expiresAt };
}

export async function verifySession(
  token: string,
): Promise<{ username: string } | undefined> {
  const session = getSession(await sha256Hex(token));
  return session ? { username: session.username } : undefined;
}

export async function logout(token: string): Promise<void> {
  deleteSession(await sha256Hex(token));
}

export function readSessionToken(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE) {
      return trimmed.slice(eq + 1);
    }
  }
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  const flags = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

export function clearSessionCookieHeader(secure: boolean): string {
  const flags = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}
