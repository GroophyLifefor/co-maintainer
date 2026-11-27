import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { makeTestManifestSigner } from "../simulate/license_signer.ts";
import { checkEeFiles, eeNote, verifyManifest } from "./manifest.ts";

const FILES = {
  "license/format.ts": "export const a = 1;\n",
  "license/state.ts": "export const b = 2;\n",
  "sso/oidc.ts": "export const c = 3;\n",
};

/** The files under a folder as path to content, the way the product would
 * read `ee/` from disk. */
function readTree(root: string, dir = root, out: Record<string, string> = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) readTree(root, full, out);
    else
      out[relative(root, full).split("\\").join("/")] = readFileSync(
        full,
        "utf8",
      );
  }
  return out;
}

function withTree(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "cm-ee-"));
  try {
    for (const [path, content] of Object.entries(FILES)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("files as the release shipped them are clean, and say nothing", () => {
  const signer = makeTestManifestSigner();
  const result = verifyManifest(signer.sign(FILES), signer.keys);
  assert.ok(result.ok);
  withTree((root) => {
    const check = checkEeFiles(result.manifest, readTree(root));
    assert.equal(check.clean, true);
    assert.equal(eeNote(check, true), undefined);
  });
});

test("a changed, a missing and an added file are each named", () => {
  const signer = makeTestManifestSigner();
  const result = verifyManifest(signer.sign(FILES), signer.keys);
  assert.ok(result.ok);
  withTree((root) => {
    writeFileSync(join(root, "license/state.ts"), "export const b = 999;\n");
    rmSync(join(root, "sso/oidc.ts"));
    writeFileSync(join(root, "license/extra.ts"), "export const x = 1;\n");
    const check = checkEeFiles(result.manifest, readTree(root));
    assert.deepEqual(check.changed, ["license/state.ts"]);
    assert.deepEqual(check.missing, ["sso/oidc.ts"]);
    assert.deepEqual(check.added, ["license/extra.ts"]);
    assert.equal(check.clean, false);
    assert.deepEqual(eeNote(check, true), {
      kind: "ee_modified",
      changed: ["license/state.ts"],
      missing: ["sso/oidc.ts"],
      added: ["license/extra.ts"],
    });
  });
});

test("files named like the language's own properties are compared like any other", () => {
  const signer = makeTestManifestSigner();
  const names = ["__proto__", "toString", "constructor", "hasOwnProperty"];
  const files = Object.create(null) as Record<string, string>;
  for (const name of names) files[name] = `content of ${name}`;
  const result = verifyManifest(signer.sign(files), signer.keys);
  assert.ok(result.ok);
  assert.deepEqual(
    Object.keys(result.manifest.files).sort(),
    [...names].sort(),
  );
  // Nothing is there: each is missing, and none of them throws.
  const none = checkEeFiles(result.manifest, {});
  assert.deepEqual(none.missing, [...names].sort());
  // All are there as shipped: clean.
  const whole = Object.create(null) as Record<string, string>;
  for (const name of names) whole[name] = `content of ${name}`;
  assert.equal(checkEeFiles(result.manifest, whole).clean, true);
  // One of them changed.
  (whole as Record<string, unknown>)["toString"] = "changed";
  assert.deepEqual(checkEeFiles(result.manifest, whole).changed, ["toString"]);
});

test("without a license there is no note, however the files differ", () => {
  const signer = makeTestManifestSigner();
  const result = verifyManifest(signer.sign(FILES), signer.keys);
  assert.ok(result.ok);
  const check = checkEeFiles(result.manifest, {
    "license/format.ts": "changed",
  });
  assert.equal(check.clean, false);
  assert.equal(eeNote(check, false), undefined);
});

test("a manifest signed by another key, edited, or not a manifest is refused", () => {
  const signer = makeTestManifestSigner();
  const other = makeTestManifestSigner("manifest-test-2");
  assert.equal(
    (verifyManifest(other.sign(FILES), signer.keys) as { reason: string })
      .reason,
    "unknown_key",
  );
  const [body, signature] = signer.sign(FILES).split(".") as [string, string];
  const edited = Buffer.from(
    Buffer.from(body, "base64url")
      .toString("utf8")
      .replace(/[0-9a-f]{4}/, "0000"),
  ).toString("base64url");
  assert.equal(
    (
      verifyManifest(`${edited}.${signature}`, signer.keys) as {
        reason: string;
      }
    ).reason,
    "bad_signature",
  );
  for (const text of ["", "x", "a.b.c", "!!.??"]) {
    assert.equal(verifyManifest(text, signer.keys).ok, false, text);
  }
  assert.equal(
    (verifyManifest(signer.sign(FILES), {}) as { reason: string }).reason,
    "unknown_key",
  );
});

test("a license key does not verify a manifest, and a manifest key does not verify a license", async () => {
  const { makeTestSigner } = await import("../simulate/license_signer.ts");
  const { verifyLicenseFile } = await import("./format.ts");
  const licenseSigner = makeTestSigner("shared");
  const manifestSigner = makeTestManifestSigner("shared");
  // The same key id, different keys and different prefixes: neither passes as the other.
  assert.equal(
    verifyManifest(licenseSigner.sign(), manifestSigner.keys).ok,
    false,
  );
  assert.equal(
    verifyLicenseFile(manifestSigner.sign(FILES), licenseSigner.keys).ok,
    false,
  );
  assert.equal(
    verifyManifest(licenseSigner.sign(), licenseSigner.keys).ok,
    false,
  );
});
