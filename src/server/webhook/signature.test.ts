import { hmacSha256Hex, verifySignature } from "./signature.ts";

const SECRET = "it's a secret";
const encoder = new TextEncoder();

Deno.test("verifySignature accepts a matching sha256 header", async () => {
  const body = encoder.encode(`{"ok":true}`);
  const hex = await hmacSha256Hex(SECRET, body);
  if (!await verifySignature(SECRET, body, `sha256=${hex}`)) {
    throw new Error("a correct signature was rejected");
  }
});

Deno.test("verifySignature rejects a wrong digest, a missing prefix, and a missing header", async () => {
  const body = encoder.encode("body");
  const hex = await hmacSha256Hex(SECRET, body);
  if (await verifySignature(SECRET, body, `sha256=${"aa".repeat(32)}`)) {
    throw new Error("a mismatched digest was accepted");
  }
  if (await verifySignature(SECRET, body, hex)) {
    throw new Error("a header without the sha256= prefix was accepted");
  }
  if (await verifySignature(SECRET, body, null)) {
    throw new Error("a missing header was accepted");
  }
});

Deno.test("verifySignature rejects a digest of a different body", async () => {
  const hex = await hmacSha256Hex(SECRET, encoder.encode("one"));
  if (await verifySignature(SECRET, encoder.encode("two"), `sha256=${hex}`)) {
    throw new Error("the signature of a different body was accepted");
  }
});
