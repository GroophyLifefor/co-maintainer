/** GitHub hands out App private keys as PKCS#1 PEM ("BEGIN RSA PRIVATE
 * KEY"). Web Crypto's `importKey("pkcs8", ...)` only takes PKCS#8. The two
 * differ by a fixed 26-byte wrapper around the same PKCS#1 bytes: a version
 * INTEGER, the rsaEncryption AlgorithmIdentifier, and an OCTET STRING tag
 * around the PKCS#1 payload — this file builds that wrapper by hand rather
 * than pulling in an ASN.1 library for one fixed structure. */

const RSA_ALGORITHM_IDENTIFIER = Uint8Array.from([
  0x30,
  0x0d, // SEQUENCE, 13 bytes
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01, // OID 1.2.840.113549.1.1.1 rsaEncryption
  0x05,
  0x00, // NULL
]);

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function derTlv(tag: number, content: Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...derLength(content.length), ...content]);
}

export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const octetString = derTlv(0x04, pkcs1);
  const inner = new Uint8Array(
    version.length + RSA_ALGORITHM_IDENTIFIER.length + octetString.length,
  );
  inner.set(version, 0);
  inner.set(RSA_ALGORITHM_IDENTIFIER, version.length);
  inner.set(octetString, version.length + RSA_ALGORITHM_IDENTIFIER.length);
  return derTlv(0x30, inner);
}

function pemToDer(pem: string): { der: Uint8Array; label: string } {
  const match = pem.match(/-----BEGIN ([^-]+)-----([\s\S]+?)-----END \1-----/);
  if (!match) throw new Error("not a PEM-encoded key");
  const base64 = match[2].replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return { der, label: match[1].trim() };
}

export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const { der, label } = pemToDer(pem);
  let pkcs8: Uint8Array;
  if (label === "RSA PRIVATE KEY") pkcs8 = pkcs1ToPkcs8(der);
  else if (label === "PRIVATE KEY") pkcs8 = der;
  else throw new Error(`unsupported private key PEM label: ${label}`);
  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** GitHub requires `exp` no more than 10 minutes out and tolerates `iat` a
 * little in the past to absorb clock drift between this machine and
 * GitHub's. */
export async function signAppJwt(
  appId: string,
  key: CryptoKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${base64urlJson({ alg: "RS256", typ: "JWT" })}.${
    base64urlJson({ iat: now - 60, exp: now + 600, iss: appId })
  }`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
