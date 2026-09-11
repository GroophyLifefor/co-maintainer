/** GitHub's `x-hub-signature-256` is `sha256=` plus hex HMAC-SHA256 of the
 * raw body. Compared in constant time so a mismatch does not leak which
 * byte differed. */

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(n)) return undefined;
    out[i] = n;
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hmacSha256Hex(
  secret: string,
  body: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body as BufferSource),
  );
  return Array.from(sig, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `false` when the header is missing, malformed, or the digest does not
 * match. Callers skip this entirely when no webhook secret is configured. */
export async function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const expected = hexToBytes(header.slice("sha256=".length));
  if (!expected) return false;
  const actual = hexToBytes(await hmacSha256Hex(secret, body));
  if (!actual) return false;
  return timingSafeEqual(actual, expected);
}
