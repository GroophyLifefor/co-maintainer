import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import {
  LICENSE_PREFIX,
  parseUtc,
  verifyLicenseFile,
  type PublicKeys,
} from "./format.ts";
import { LICENSE_KEYS } from "./keys.ts";
import { CLOCK_TOLERANCE_MS, evaluateLicense, nextLastSeen } from "./state.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2027-03-01T00:00:00Z");
const END = Date.parse("2027-04-01T00:00:00Z");

const active = generateKeyPairSync("ed25519");
const spare = generateKeyPairSync("ed25519");
const pem = (key: KeyObject) =>
  String(key.export({ type: "spki", format: "pem" }));
const KEYS: PublicKeys = {
  "k-active": pem(active.publicKey),
  "k-spare": pem(spare.publicKey),
};

const base = () => ({
  v: 1,
  id: "lic-1",
  kid: "k-active",
  kind: "enterprise",
  customer: { id: "c-1", name: "Example Co" },
  install_id: "inst-1",
  seats: 40,
  modules: ["sso", "rbac"],
  issued_at: "2027-03-01T00:00:00Z",
  not_before: "2027-03-01T00:00:00Z",
  expires_at: "2027-04-01T00:00:00Z",
});

/** Signs the way the private signing tool would. The product never does. */
function signed(
  payload: Record<string, unknown>,
  key = active.privateKey,
  prefix = LICENSE_PREFIX,
): string {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(prefix, "utf8"), bytes]),
    key,
  );
  return `${bytes.toString("base64url")}.${signature.toString("base64url")}`;
}

const state = (
  file: string | undefined,
  now: number,
  extra: { lastSeen?: number; installId?: string } = {},
) =>
  evaluateLicense({
    file: file === undefined ? undefined : verifyLicenseFile(file, KEYS),
    installId: extra.installId ?? "inst-1",
    now,
    ...(extra.lastSeen === undefined ? {} : { lastSeen: extra.lastSeen }),
  });

test("a license signed by a trusted key verifies and reads back", () => {
  const result = verifyLicenseFile(signed(base()), KEYS);
  assert.ok(result.ok);
  assert.equal(result.payload.customer.name, "Example Co");
  assert.deepEqual(result.payload.modules, ["sso", "rbac"]);
});

test("the spare key verifies a license signed with it", () => {
  const result = verifyLicenseFile(
    signed({ ...base(), kid: "k-spare" }, spare.privateKey),
    KEYS,
  );
  assert.ok(result.ok);
});

test("a license signed by another key, or edited after signing, is refused", () => {
  const other = generateKeyPairSync("ed25519");
  const wrongKey = verifyLicenseFile(signed(base(), other.privateKey), KEYS);
  assert.deepEqual(wrongKey.ok ? null : wrongKey.reason, "bad_signature");
  const [payload, signature] = signed(base()).split(".") as [string, string];
  const edited = Buffer.from(
    JSON.stringify({ ...base(), seats: 4000 }),
    "utf8",
  ).toString("base64url");
  const forged = verifyLicenseFile(`${edited}.${signature}`, KEYS);
  assert.equal(forged.ok ? null : forged.reason, "bad_signature");
  assert.notEqual(payload, edited);
});

test("a signature made for something else cannot pass as a license", () => {
  const result = verifyLicenseFile(
    signed(base(), active.privateKey, "something-else\n"),
    KEYS,
  );
  assert.equal(result.ok ? null : result.reason, "bad_signature");
});

test("an unknown key id is refused, and so is every file when no key is trusted", () => {
  const unknown = verifyLicenseFile(signed({ ...base(), kid: "nope" }), KEYS);
  assert.equal(unknown.ok ? null : unknown.reason, "unknown_key");
  const none = verifyLicenseFile(signed(base()), LICENSE_KEYS);
  assert.equal(none.ok ? null : none.reason, "unknown_key");
  assert.deepEqual(LICENSE_KEYS, {}, "no test key is in the production list");
  const proto = verifyLicenseFile(
    signed({ ...base(), kid: "__proto__" }),
    KEYS,
  );
  assert.equal(proto.ok ? null : proto.reason, "unknown_key");
});

test("a newer format version is refused with its own reason, unknown fields and modules are ignored", () => {
  const newer = verifyLicenseFile(signed({ ...base(), v: 2 }), KEYS);
  assert.equal(newer.ok ? null : newer.reason, "unknown_version");
  const extra = verifyLicenseFile(
    signed({ ...base(), future_field: 1, modules: ["sso", "from-the-future"] }),
    KEYS,
  );
  assert.ok(extra.ok);
  assert.deepEqual(extra.payload.modules, ["sso", "from-the-future"]);
  assert.equal("future_field" in extra.payload, false);
});

test("a file that is not a license never throws and says it is malformed", () => {
  for (const text of ["", "x", "a.b.c", "!!!.???", "e30.AAAA", "bnVsbA.AAAA"]) {
    const result = verifyLicenseFile(text, KEYS);
    assert.equal(result.ok, false, text);
  }
});

test("a signed payload with a bad field is refused with the field's name", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["kind", { kind: "gold" }],
    ["seats", { seats: -1 }],
    ["seats", { seats: 1.5 }],
    ["modules", { modules: "sso" }],
    ["expires_at", { expires_at: "2027-04-01" }],
    ["expires_at", { expires_at: "2027-02-01T00:00:00Z" }],
    ["install_id", { install_id: "" }],
    ["customer", { customer: { id: "", name: "x" } }],
  ];
  for (const [field, patch] of cases) {
    const result = verifyLicenseFile(signed({ ...base(), ...patch }), KEYS);
    assert.equal(result.ok ? null : result.reason, "bad_payload");
    assert.equal(result.ok ? null : result.detail, field);
  }
});

test("the license holds no price, discount, credit or contact", () => {
  const result = verifyLicenseFile(
    signed({ ...base(), price: 9, discount: 1, credit: 2, contact: "a@b.c" }),
    KEYS,
  );
  assert.ok(result.ok);
  for (const key of ["price", "discount", "credit", "contact"]) {
    assert.equal(key in result.payload, false, key);
  }
});

test("times are accepted in one form only", () => {
  assert.equal(parseUtc("2027-04-01T00:00:00Z"), END);
  for (const bad of ["2027-04-01", "2027-04-01T00:00:00+03:00", 5, undefined]) {
    assert.equal(parseUtc(bad), undefined);
  }
});

test("the states follow the 3, 7 and 30 day lines after the end", () => {
  const file = signed(base());
  const at = (days: number, hours = 0) =>
    state(file, END + days * DAY + hours * 3_600_000);
  assert.equal(state(file, T0 - DAY).status, "pending");
  assert.deepEqual(state(file, T0 - DAY).modules, []);
  assert.equal(state(file, T0).status, "active");
  assert.equal(state(file, END).status, "active", "the end moment is inside");
  assert.equal(at(0, 1).status, "expired-grace");
  assert.equal(at(2, 23).status, "expired-grace");
  assert.equal(at(3).status, "expired-warn");
  assert.equal(at(6, 23).status, "expired-warn");
  assert.equal(at(7).status, "extension");
  assert.equal(at(29, 23).status, "extension");
  assert.equal(at(30).status, "free");
  assert.deepEqual(at(30).modules, []);
  // Until the 30th day every module stays open.
  for (const days of [1, 4, 10, 29]) {
    assert.deepEqual(at(days).modules, ["sso", "rbac"], `day ${days}`);
  }
});

test("a trial has no grace: it is the free product the moment it ends", () => {
  const file = signed({ ...base(), kind: "trial" });
  assert.equal(state(file, END).status, "active");
  assert.equal(state(file, END + 1000).status, "free");
  assert.deepEqual(state(file, END + 1000).modules, []);
});

test("a staging license is a dry run, an enterprise one is not", () => {
  assert.equal(state(signed({ ...base(), kind: "staging" }), T0).dryRun, true);
  assert.equal(state(signed(base()), T0).dryRun, false);
});

test("a license for another installation keeps its modules open and says so", () => {
  const result = state(signed(base()), T0 + DAY, { installId: "inst-2" });
  assert.equal(result.status, "active");
  assert.deepEqual(result.modules, ["sso", "rbac"]);
  assert.ok(result.notes.includes("install_mismatch"));
  assert.equal(state(signed(base()), T0 + DAY).notes.length, 0);
});

test("no file, or an unusable one, is the free product and nothing throws", () => {
  const none = state(undefined, T0);
  assert.equal(none.status, "none");
  assert.deepEqual(none.modules, []);
  const bad = state("garbage", T0);
  assert.equal(bad.status, "invalid");
  assert.equal(bad.invalidReason, "malformed");
  assert.ok(bad.notes.includes("invalid_file"));
});

test("the clock going back does not bring an ended license back", () => {
  const file = signed(base());
  const seen = END + 40 * DAY;
  const rolled = state(file, T0, { lastSeen: seen });
  assert.equal(rolled.status, "free");
  assert.equal(rolled.effectiveAt, seen);
  assert.ok(rolled.notes.includes("clock_went_back"));
});

test("a clock that is a little behind is not noted", () => {
  const file = signed(base());
  const slight = state(file, T0 + 10 * DAY, {
    lastSeen: T0 + 10 * DAY + CLOCK_TOLERANCE_MS,
  });
  assert.equal(slight.notes.includes("clock_went_back"), false);
  const more = state(file, T0 + 10 * DAY, {
    lastSeen: T0 + 10 * DAY + CLOCK_TOLERANCE_MS + 1,
  });
  assert.ok(more.notes.includes("clock_went_back"));
});

test("the latest time seen only moves forward", () => {
  assert.equal(nextLastSeen(undefined, 5), 5);
  assert.equal(nextLastSeen(10, 5), 10);
  assert.equal(nextLastSeen(10, 20), 20);
});
