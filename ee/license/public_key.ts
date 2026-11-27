/** Prints the public half of the license signing key, ready to paste into
 * `keys.ts`. Meant to be run once on the machine that holds the private key.
 *
 *   node ee/license/public_key.ts /path/to/private-key.pem [key-id]
 *
 * It reads the private key file and prints only the public key and the key id.
 * The private key is never printed, never copied, never written anywhere and
 * never put in an error message. */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PublicKeyLine = { kid: string; pem: string; snippet: string };

/** The public key of an Ed25519 private key given as PEM text, with a key id
 * (the one asked for, or `k-` and the start of the public key's hash). */
export function publicKeyFrom(privatePem: string, kid?: string): PublicKeyLine {
  let publicKey;
  try {
    const privateKey = createPrivateKey(privatePem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("not an Ed25519 key");
    }
    publicKey = createPublicKey(privateKey);
  } catch {
    // The reason is not passed on: it could quote the file.
    throw new Error(
      "the file is not an unencrypted Ed25519 private key in PEM form",
    );
  }
  const pem = String(publicKey.export({ type: "spki", format: "pem" })).trim();
  const der = publicKey.export({ type: "spki", format: "der" });
  const id =
    kid ?? `k-${createHash("sha256").update(der).digest("hex").slice(0, 8)}`;
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) {
    throw new Error("the key id may hold letters, digits, . _ - only");
  }
  const snippet = `  "${id}": \`${pem}\n\`,`;
  return { kid: id, pem, snippet };
}

function main(): void {
  const [path, kid] = process.argv.slice(2);
  if (!path) {
    console.error(
      "usage: node ee/license/public_key.ts PRIVATE_KEY.pem [key-id]",
    );
    process.exitCode = 2;
    return;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error("cannot read that file");
    process.exitCode = 2;
    return;
  }
  try {
    const result = publicKeyFrom(text, kid);
    console.log(`key id: ${result.kid}`);
    console.log("");
    console.log(result.pem);
    console.log("");
    console.log("Add this line inside LICENSE_KEYS in ee/license/keys.ts:");
    console.log(result.snippet);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
