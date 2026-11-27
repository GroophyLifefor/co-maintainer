import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTestSigner, iso } from "../simulate/license_signer.ts";
import {
  CHECK_EVERY_MS,
  checkDue,
  currentLicense,
  dailyCheck,
  installId,
  loadLicense,
  memoryLicenseStore,
} from "./runtime.ts";

const DAY = 86_400_000;
const START = Date.parse("2027-03-01T00:00:00Z");
const END = Date.parse("2028-03-01T00:00:00Z");

function setup() {
  const store = memoryLicenseStore();
  const signer = makeTestSigner();
  const id = installId(store);
  return { store, signer, id };
}

test("the installation id is made once and stays the same", () => {
  const store = memoryLicenseStore();
  const first = installId(store);
  assert.match(first, /^install-[0-9a-f-]{36}$/);
  assert.equal(installId(store), first);
});

test("a valid file loaded for this installation becomes active", () => {
  const { store, signer, id } = setup();
  const text = signer.sign({ install_id: id });
  const loaded = loadLicense(store, signer.keys, text, START);
  assert.deepEqual(loaded, {
    ok: true,
    licenseId: "lic-test",
    replaced: false,
  });
  const state = currentLicense(store, signer.keys, START + DAY);
  assert.equal(state.status, "active");
  assert.deepEqual(state.modules, ["sso", "rbac"]);
  assert.deepEqual(state.notes, []);
});

test("a file that does not verify is refused and the one in use stays", () => {
  const { store, signer, id } = setup();
  loadLicense(store, signer.keys, signer.sign({ install_id: id }), START);
  for (const [text, reason] of [
    ["", "empty"],
    ["garbage", "malformed"],
    [signer.tampered({ install_id: id }), "bad_signature"],
    [
      makeTestSigner("other").sign({ install_id: id, kid: "other" }),
      "unknown_key",
    ],
  ] as const) {
    const result = loadLicense(store, signer.keys, text, START + DAY);
    assert.deepEqual(result, { ok: false, reason }, reason);
  }
  assert.equal(
    currentLicense(store, signer.keys, START + DAY).status,
    "active",
  );
  assert.equal(store.events.filter((e) => e.kind === "refused").length, 4);
});

test("only the last valid file is active, the earlier ones go to the history", () => {
  const { store, signer, id } = setup();
  loadLicense(
    store,
    signer.keys,
    signer.sign({ install_id: id, id: "lic-a" }),
    START,
  );
  const second = loadLicense(
    store,
    signer.keys,
    signer.sign({ install_id: id, id: "lic-b", modules: ["sso"] }),
    START + DAY,
  );
  assert.deepEqual(second, { ok: true, licenseId: "lic-b", replaced: true });
  assert.deepEqual(
    store.history.map((h) => h.licenseId),
    ["lic-a"],
  );
  assert.deepEqual(
    currentLicense(store, signer.keys, START + 2 * DAY).modules,
    ["sso"],
  );
});

test("the state follows the 3, 7 and 30 day lines, and each change is written down once", () => {
  const { store, signer, id } = setup();
  loadLicense(store, signer.keys, signer.sign({ install_id: id }), START);
  const status = (days: number, hours = 0) =>
    currentLicense(store, signer.keys, END + days * DAY + hours * 3_600_000)
      .status;
  assert.equal(
    currentLicense(store, signer.keys, START + DAY).status,
    "active",
  );
  assert.equal(status(0, 1), "expired-grace");
  assert.equal(status(1), "expired-grace");
  assert.equal(status(3), "expired-warn");
  assert.equal(status(7), "extension");
  assert.equal(status(29), "extension");
  assert.equal(status(30), "free");
  assert.equal(status(31), "free");
  const changes = store.events
    .filter((e) => e.kind === "state_changed")
    .map((e) => e.detail);
  assert.deepEqual(changes, [
    "(first) -> active",
    "active -> expired-grace",
    "expired-grace -> expired-warn",
    "expired-warn -> extension",
    "extension -> free",
  ]);
});

test("a clock moved back does not bring an ended license back, a new file does", () => {
  const { store, signer, id } = setup();
  loadLicense(store, signer.keys, signer.sign({ install_id: id }), START);
  currentLicense(store, signer.keys, END + 40 * DAY);
  const back = currentLicense(store, signer.keys, START + DAY);
  assert.equal(back.status, "free");
  assert.ok(back.notes.includes("clock_went_back"));
  loadLicense(
    store,
    signer.keys,
    signer.sign({
      install_id: id,
      id: "lic-renewed",
      expires_at: iso(END + 400 * DAY),
    }),
    START + DAY,
  );
  const renewed = currentLicense(store, signer.keys, END + 40 * DAY);
  assert.equal(renewed.status, "active");
});

test("a file for another installation keeps its modules and says so", () => {
  const { store, signer } = setup();
  loadLicense(
    store,
    signer.keys,
    signer.sign({ install_id: "install-elsewhere" }),
    START,
  );
  const state = currentLicense(store, signer.keys, START + DAY);
  assert.equal(state.status, "active");
  assert.ok(state.notes.includes("install_mismatch"));
});

test("a stored file that no longer reads keeps the last good state, with a note", () => {
  const { store, signer, id } = setup();
  loadLicense(store, signer.keys, signer.sign({ install_id: id }), START);
  assert.equal(
    currentLicense(store, signer.keys, START + DAY).status,
    "active",
  );
  // The build's keys change in an upgrade: the file does not verify now.
  const afterUpgrade = makeTestSigner("replaced").keys;
  const state = currentLicense(store, afterUpgrade, START + 2 * DAY);
  assert.equal(state.status, "active");
  assert.deepEqual(state.modules, ["sso", "rbac"]);
  assert.ok(state.notes.includes("invalid_file"));
  // With nothing good before it, a bad file is just invalid.
  const fresh = memoryLicenseStore();
  fresh.setActive({ text: "garbage", loadedAt: START, licenseId: "x" });
  assert.equal(currentLicense(fresh, signer.keys, START).status, "invalid");
});

test("the daily check runs when it is due and answers from the last state otherwise", () => {
  const { store, signer, id } = setup();
  loadLicense(store, signer.keys, signer.sign({ install_id: id }), START);
  assert.equal(checkDue(store, START), true, "a new file is checked at once");
  const first = dailyCheck(store, signer.keys, START + DAY);
  assert.equal(first?.status, "active");
  assert.equal(checkDue(store, START + DAY + CHECK_EVERY_MS - 1), false);
  assert.equal(checkDue(store, START + DAY + CHECK_EVERY_MS), true);
  assert.equal(checkDue(store, START), true, "a clock set back is checked");
  const events = store.events.length;
  dailyCheck(store, signer.keys, START + DAY + 1000);
  assert.equal(
    store.events.length,
    events,
    "nothing is written between checks",
  );
});

test("a check never throws, the product stays as it is", () => {
  const { signer } = setup();
  const broken = memoryLicenseStore();
  broken.getLastChecked = () => {
    throw new Error("the store is down");
  };
  assert.equal(dailyCheck(broken, signer.keys, START), undefined);
});
