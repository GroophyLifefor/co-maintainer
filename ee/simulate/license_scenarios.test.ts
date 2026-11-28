/** The licenses a customer can have, each tried end to end through the
 * check and the states: valid, ended, changed after signing, for another
 * installation, for another customer, signed by another key, a trial, a
 * staging one, and a clock moved back. Reviews never stop: what changes is
 * which modules are open. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyLicenseFile } from "../license/format.ts";
import { evaluateLicense } from "../license/state.ts";
import { iso, makeTestSigner } from "./license_signer.ts";

const DAY = 86_400_000;
const START = Date.parse("2027-03-01T00:00:00Z");
const END = Date.parse("2028-03-01T00:00:00Z");

const signer = makeTestSigner();
const stateOf = (
  file: string | undefined,
  now: number,
  extra: {
    installId?: string;
    lastSeen?: number;
    keys?: typeof signer.keys;
  } = {},
) =>
  evaluateLicense({
    file:
      file === undefined
        ? undefined
        : verifyLicenseFile(file, extra.keys ?? signer.keys),
    installId: extra.installId ?? "install-1",
    now,
    ...(extra.lastSeen === undefined ? {} : { lastSeen: extra.lastSeen }),
  });

test("a valid license opens its modules for its installation", () => {
  const state = stateOf(signer.sign(), START + 10 * DAY);
  assert.equal(state.status, "active");
  assert.deepEqual(state.modules, ["sso", "rbac"]);
  assert.deepEqual(state.notes, []);
});

test("an ended license keeps its modules for 30 days, then the product is free", () => {
  const file = signer.sign();
  assert.equal(stateOf(file, END + 2 * DAY).status, "expired-grace");
  assert.equal(stateOf(file, END + 5 * DAY).status, "expired-warn");
  assert.equal(stateOf(file, END + 20 * DAY).status, "extension");
  const free = stateOf(file, END + 31 * DAY);
  assert.equal(free.status, "free");
  assert.deepEqual(free.modules, []);
});

test("a license changed after it was signed opens nothing", () => {
  const state = stateOf(signer.tampered(), START + DAY);
  assert.equal(state.status, "invalid");
  assert.equal(state.invalidReason, "bad_signature");
  assert.deepEqual(state.modules, []);
});

test("tampering changes the file whatever the license holds", () => {
  for (const seats of [0, 50, 51, 9999]) {
    const state = stateOf(signer.tampered({ seats }), START + DAY);
    assert.equal(state.status, "invalid", `seats ${seats}`);
    assert.equal(state.invalidReason, "bad_signature", `seats ${seats}`);
  }
});

test("a license for another installation keeps its modules and says so", () => {
  const state = stateOf(signer.sign({ install_id: "install-2" }), START + DAY);
  assert.equal(state.status, "active");
  assert.deepEqual(state.modules, ["sso", "rbac"]);
  assert.ok(state.notes.includes("install_mismatch"));
});

test("a license for another customer's installation is the same: a note, never a lock", () => {
  const file = signer.sign({
    customer: { id: "customer-2", name: "Other Co" },
    install_id: "install-9",
  });
  const state = stateOf(file, START + DAY);
  assert.equal(state.status, "active");
  assert.ok(state.notes.includes("install_mismatch"));
});

test("a license signed by a key this build does not trust opens nothing", () => {
  const other = makeTestSigner("test-2");
  const state = stateOf(other.sign(), START + DAY);
  assert.equal(state.status, "invalid");
  assert.equal(state.invalidReason, "unknown_key");
  // The same file is valid for a build that trusts that key.
  assert.equal(
    stateOf(other.sign(), START + DAY, { keys: other.keys }).status,
    "active",
  );
});

test("a license whose start is ahead opens nothing yet", () => {
  const state = stateOf(signer.sign(), START - DAY);
  assert.equal(state.status, "pending");
  assert.deepEqual(state.modules, []);
});

test("a trial has no grace and a staging license writes nothing to GitHub", () => {
  const trial = signer.sign({
    kind: "trial",
    expires_at: iso(START + 30 * DAY),
  });
  assert.equal(stateOf(trial, START + 29 * DAY).status, "active");
  assert.equal(stateOf(trial, START + 31 * DAY).status, "free");
  const staging = stateOf(signer.sign({ kind: "staging" }), START + DAY);
  assert.equal(staging.dryRun, true);
  assert.equal(stateOf(signer.sign(), START + DAY).dryRun, false);
});

test("a clock moved back does not bring an ended license back, a new license does", () => {
  const old = signer.sign();
  const seen = END + 60 * DAY;
  const back = stateOf(old, START, { lastSeen: seen });
  assert.equal(back.status, "free");
  assert.ok(back.notes.includes("clock_went_back"));
  const renewed = signer.sign({ expires_at: iso(END + 365 * DAY) });
  assert.equal(stateOf(renewed, seen, { lastSeen: seen }).status, "active");
});

test("no license, a garbled one and an empty one are all the free product", () => {
  for (const file of [undefined, "garbage", ""]) {
    const state = stateOf(file, START);
    assert.deepEqual(state.modules, [], String(file));
    assert.ok(["none", "invalid"].includes(state.status), String(file));
  }
});

test("a module taken out at renewal closes, the others stay", () => {
  const before = stateOf(
    signer.sign({ modules: ["sso", "rbac", "audit"] }),
    START + DAY,
  );
  const after = stateOf(signer.sign({ modules: ["sso", "rbac"] }), START + DAY);
  assert.deepEqual(before.modules, ["sso", "rbac", "audit"]);
  assert.deepEqual(after.modules, ["sso", "rbac"]);
});
