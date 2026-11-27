import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LICENSE_PREFIX, verifyLicenseFile } from "./format.ts";
import { publicKeyFrom } from "./public_key.ts";

const SCRIPT = join(import.meta.dirname, "public_key.ts");

function privatePem(): {
  pem: string;
  key: ReturnType<typeof generateKeyPairSync>;
} {
  const key = generateKeyPairSync("ed25519");
  return {
    key,
    pem: String(key.privateKey.export({ type: "pkcs8", format: "pem" })),
  };
}

test("the printed public key verifies what the private key signed, pasted as printed", () => {
  const { pem, key } = privatePem();
  const out = publicKeyFrom(pem, "k-prod-1");
  assert.equal(out.kid, "k-prod-1");
  // Paste the snippet into an object the way keys.ts holds it.
  const keys = new Function(`return {\n${out.snippet}\n};`)() as Record<
    string,
    string
  >;
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      id: "l",
      kid: "k-prod-1",
      kind: "enterprise",
      customer: { id: "c", name: "n" },
      install_id: "i",
      seats: 1,
      modules: [],
      issued_at: "2027-01-01T00:00:00Z",
      not_before: "2027-01-01T00:00:00Z",
      expires_at: "2028-01-01T00:00:00Z",
    }),
  );
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(LICENSE_PREFIX), payload]),
    key.privateKey,
  );
  const file = `${payload.toString("base64url")}.${signature.toString("base64url")}`;
  assert.ok(verifyLicenseFile(file, keys).ok);
});

test("without a key id one is made from the public key, the same every time", () => {
  const { pem } = privatePem();
  const a = publicKeyFrom(pem);
  assert.match(a.kid, /^k-[0-9a-f]{8}$/);
  assert.equal(publicKeyFrom(pem).kid, a.kid);
});

test("the command prints the public key and never a trace of the private one", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-pubkey-"));
  try {
    const { pem } = privatePem();
    const file = join(dir, "private.pem");
    writeFileSync(file, pem, { mode: 0o600 });
    const out = execFileSync(process.execPath, [SCRIPT, file, "k-test"], {
      encoding: "utf8",
    });
    assert.match(out, /key id: k-test/);
    assert.match(out, /BEGIN PUBLIC KEY/);
    assert.doesNotMatch(out, /PRIVATE/);
    const body = pem.split("\n")[1]!;
    assert.equal(out.includes(body), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong file stops with a message that quotes nothing from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-pubkey-"));
  try {
    const secretWord = "TOPSECRETTEXT";
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const files: Record<string, string> = {
      text: `${secretWord}\n`,
      rsa: String(rsa.privateKey.export({ type: "pkcs8", format: "pem" })),
      empty: "",
    };
    for (const [name, content] of Object.entries(files)) {
      const file = join(dir, name);
      writeFileSync(file, content);
      const run = spawnSync(process.execPath, [SCRIPT, file], {
        encoding: "utf8",
      });
      assert.equal(run.status, 1, name);
      assert.doesNotMatch(run.stderr + run.stdout, new RegExp(secretWord));
      assert.doesNotMatch(run.stderr + run.stdout, /BEGIN PRIVATE/);
    }
    const missing = spawnSync(process.execPath, [SCRIPT, join(dir, "nope")], {
      encoding: "utf8",
    });
    assert.equal(missing.status, 2);
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    assert.equal(none.status, 2);
    assert.throws(() => publicKeyFrom(privatePem().pem, "bad id!"), /key id/);
    for (const bad of [
      "__proto__",
      "_x",
      "constructor",
      "prototype",
      "",
      "-k",
    ]) {
      assert.throws(() => publicKeyFrom(privatePem().pem, bad), /key id/, bad);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
