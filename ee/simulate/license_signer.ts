/** The signing side of the license, for tests only.
 *
 * The product only verifies. The real private key is held by one person,
 * offline, and the real signing tool is not in this repository. This makes a
 * throwaway key pair and signs licenses with it, so the checks that sit on
 * the product's side can be tried with files of every kind: valid, ended,
 * changed after signing, for another installation or another customer.
 *
 * A key made here is only ever handed to a check as a test key list. It is
 * never in `LICENSE_KEYS`. */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  LICENSE_PREFIX,
  type LicensePayload,
  type PublicKeys,
} from "../license/format.ts";

export type TestSigner = {
  /** The key list to hand to the checks. */
  keys: PublicKeys;
  kid: string;
  /** Signs a license. Fields not given get ordinary values. */
  sign(overrides?: Partial<LicensePayload> & Record<string, unknown>): string;
  /** A signed file, then one byte of its payload changed. */
  tampered(overrides?: Partial<LicensePayload>): string;
};

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function makeTestSigner(kid = "test-1"): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys: PublicKeys = {
    [kid]: String(publicKey.export({ type: "spki", format: "pem" })),
  };
  createPublicKey(keys[kid]!);
  const signWith = (
    key: KeyObject,
    payload: Record<string, unknown>,
  ): string => {
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(LICENSE_PREFIX, "utf8"), bytes]),
      key,
    );
    return `${bytes.toString("base64url")}.${signature.toString("base64url")}`;
  };
  const payload = (
    overrides: Partial<LicensePayload> & Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    v: 1,
    id: "lic-test",
    kid,
    kind: "enterprise",
    customer: { id: "customer-1", name: "Example Co" },
    install_id: "install-1",
    seats: 50,
    modules: ["sso", "rbac"],
    issued_at: "2027-03-01T00:00:00Z",
    not_before: "2027-03-01T00:00:00Z",
    expires_at: "2028-03-01T00:00:00Z",
    ...overrides,
  });
  return {
    keys,
    kid,
    sign: (overrides) => signWith(privateKey, payload(overrides)),
    tampered: (overrides) => {
      const [body, signature] = signWith(privateKey, payload(overrides)).split(
        ".",
      ) as [string, string];
      // One field of the signed payload is changed whatever the overrides
      // were, and the change is checked: a helper that returned the file
      // unchanged would make a test of a refused file test a valid one.
      const original = Buffer.from(body, "base64url").toString("utf8");
      const parsed = JSON.parse(original) as { seats: number };
      parsed.seats += 1;
      const changed = JSON.stringify(parsed);
      if (changed === original) {
        throw new Error("the tampered license is the same as the signed one");
      }
      return `${Buffer.from(changed, "utf8").toString("base64url")}.${signature}`;
    },
  };
}

/** Signs a manifest the way the build would. Test use only. */
export function makeTestManifestSigner(kid = "manifest-test-1"): {
  keys: Record<string, string>;
  kid: string;
  sign(files: Record<string, string | Buffer>): string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = {
    [kid]: String(publicKey.export({ type: "spki", format: "pem" })),
  };
  return {
    keys,
    kid,
    sign: (files) => {
      const hashes: Record<string, string> = {};
      for (const [path, content] of Object.entries(files)) {
        hashes[path] = createHash("sha256").update(content).digest("hex");
      }
      const bytes = Buffer.from(
        JSON.stringify({ v: 1, kid, files: hashes }),
        "utf8",
      );
      const signature = sign(
        null,
        Buffer.concat([Buffer.from("co-maintainer-ee-manifest-v1\n"), bytes]),
        privateKey,
      );
      return `${bytes.toString("base64url")}.${signature.toString("base64url")}`;
    },
  };
}
