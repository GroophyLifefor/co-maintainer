import { importAppPrivateKey, pkcs1ToPkcs8, signAppJwt } from "./jwt.ts";
import { TEST_PKCS1_PEM as PKCS1_PEM } from "../testing/fixtures/rsa_key.ts";

// The PKCS#8 and public key below came from the same key via `openssl pkcs8
// -topk8` and `openssl rsa -pubout`, so the assertions compare this code's
// output against a real tool's, not against itself.

const GOLDEN_PKCS8_DER_BASE64 =
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCzH+q/sip/PHUYF+MAFbmQf5LdPfaHP0p30fRftN1FOWZ3H0seDJ5THhVfmSBhClM+fNUPKu8wt4DII1bVvy5a967yvP5lu131gj1AQXdSyYZsqyH78vU0lmGqkpv04mntqiZE8G04BfaaH/U6hjg5aHe3mhTgSk59EKif5e3dKxZ8K7J3ANyVnQTkMewmlQQMUdxkjKjN3+jm8CzU4o8MVXTRAWirrmZsqeKMBGjN7+J31yV3asd12A8FBZd+LwNnQiW4uy4XWgGRK0bgxMsfR4jwygE1m5RhnjPZOpYLGrQrxhynHDeHx8P2TMHivrLxJRXdzRjaM/JNjqRupYzfAgMBAAECggEACSrk2VXK3gM1R6aP/CT11S2U/H9w2srZoANIsLicKzBSYbNiJVIRAlZY/Vu5cANWxQJ05xdT8ZgwCPjiDK4sYa8pLuGPBZw5eq4P6Mt7n2roAdofsvo5eYJe0kY5oXwQXtUQAK7rcBbCCxuqnImvs/nNnWx54rbQMzoYie0l0jq4jGJCBry9lmZI+y6NavpUnGTOX2hqrDhwXwXg+10wMmf9flzoajUcZQ5XnqDIyD5WYqT57gMq9vh+rDhCzcX5AzV4kra1OtqUP0v9DeEKxToHv4xa8NYOJl3S5zC9VGi7gjVApmN2sI/nLZlrK/ZZVr5RMDYbnsM1vltYNb4jEQKBgQDeSvfb9SMqv6dP3QI1UU9ntMRw9yJ227aUJD0CfXwxoElm0fEfIDSOwOZ27tAi8DSC0ZD0a7rV2wz6WuujdwugWFvxPIIBPL6UZn7U3IcJFGOIpWa8BHuqkHJWVfxvgDHIcPgLCNBlB25D8vbM6YYQ+9G7DEUdQbDDNNORHe1gkQKBgQDOSTvLiucSATgeA0qVwer1KjKMrNezH/WdgxDJsq6P04BXIz+MVNOkMOqJA271nENbzy5fhveGFJhaaEPg0Tusixp6OviffIC0pxMmOaj0dXPltyKc4paviaih/gxcalCwLUg/T/RmqvGHoebv63tD25SDrK7Hy4jbWjwOYsTObwKBgC8J1iEpYmOtYo43yjvWFONxERCGeziDjcMTWAWq4BjwPhgP3OIlQnniv+Hy7wA1rCbyiaXvFf4i+EAR9UMF8ePgTrRhhXEVlY55keUhNUHqmpVTysWGfVS+dDNoxp4hlmc/4H0VRGPciqy+QRNjZwc5Akx+cDGcsPbdutc+afjBAoGBAMiV8WzUXiflw5l7fdTtQPiv1YNwtjVZSE2nGnXmJ1N3R35zqeFcwocPgZ9FFWoCToVBikgdRya7dAHFDOvYyHvYryBXo1YBjG0dYMN0odNDOjUOxLtkoT2DT9Rk4cQjJN6KyYu2xWHnqwBF7/cvNScgpuL60OE6CpOwxGEArXpFAoGBAJCHw2hOlOHf/mMxSlic12jISrW7gPO3C+WqBkBxtT2QPtu5muxN76+NzTwJ/PuJrVBdvPGhuKvdVn1IVc/7q2xhm/OeKDhQzgepgpcTfhBuxmqzCLck7K7wCp48GLz/DSc9ioBVOHB3eQ5xz4kVMrj/e5wzf2L70+T4T+L4WkoB";

const SPKI_PUBLIC_DER_BASE64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsx/qv7Iqfzx1GBfjABW5kH+S3T32hz9Kd9H0X7TdRTlmdx9LHgyeUx4VX5kgYQpTPnzVDyrvMLeAyCNW1b8uWveu8rz+Zbtd9YI9QEF3UsmGbKsh+/L1NJZhqpKb9OJp7aomRPBtOAX2mh/1OoY4OWh3t5oU4EpOfRCon+Xt3SsWfCuydwDclZ0E5DHsJpUEDFHcZIyozd/o5vAs1OKPDFV00QFoq65mbKnijARoze/id9cld2rHddgPBQWXfi8DZ0IluLsuF1oBkStG4MTLH0eI8MoBNZuUYZ4z2TqWCxq0K8Ycpxw3h8fD9kzB4r6y8SUV3c0Y2jPyTY6kbqWM3wIDAQAB";

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function pkcs1DerFromPem(pem: string): Uint8Array {
  const body = pem
    .replace("-----BEGIN RSA PRIVATE KEY-----", "")
    .replace("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  return fromBase64(body);
}

Deno.test("pkcs1ToPkcs8 matches openssl's own PKCS#8 conversion byte for byte", () => {
  const pkcs1 = pkcs1DerFromPem(PKCS1_PEM);
  const converted = pkcs1ToPkcs8(pkcs1);
  if (toBase64(converted) !== GOLDEN_PKCS8_DER_BASE64) {
    throw new Error("converted DER does not match openssl's PKCS#8 output");
  }
});

Deno.test("importAppPrivateKey imports the PKCS#1 PEM and can sign", async () => {
  const key = await importAppPrivateKey(PKCS1_PEM);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode("hello"),
  );
  if (signature.byteLength !== 256) {
    throw new Error(
      `expected a 2048-bit signature, got ${signature.byteLength} bytes`,
    );
  }
});

Deno.test("signAppJwt produces a JWT verifiable with the matching public key", async () => {
  const key = await importAppPrivateKey(PKCS1_PEM);
  const jwt = await signAppJwt("4900449", key);
  const [headerB64, payloadB64, signatureB64] = jwt.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error(`not a three-part JWT: ${jwt}`);
  }

  const publicKey = await crypto.subtle.importKey(
    "spki",
    fromBase64(SPKI_PUBLIC_DER_BASE64) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = fromBase64(
    signatureB64.replace(/-/g, "+").replace(/_/g, "/"),
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature as BufferSource,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!verified) {
    throw new Error("signature did not verify against the matching public key");
  }

  const header = JSON.parse(
    atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")),
  );
  if (header.alg !== "RS256" || header.typ !== "JWT") {
    throw new Error(`unexpected header: ${JSON.stringify(header)}`);
  }
  const payload = JSON.parse(
    atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")),
  );
  if (payload.iss !== "4900449") throw new Error("iss was not the App ID");
  if (payload.exp - payload.iat > 660) {
    throw new Error(
      "exp is further than GitHub's 10-minute ceiling plus drift allowance",
    );
  }
});

Deno.test("importAppPrivateKey also accepts an already-PKCS#8 key", async () => {
  const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${
    GOLDEN_PKCS8_DER_BASE64.match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----`;
  const key = await importAppPrivateKey(pkcs8Pem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode("hello"),
  );
  if (signature.byteLength !== 256) {
    throw new Error("PKCS#8 import did not produce a usable signing key");
  }
});
