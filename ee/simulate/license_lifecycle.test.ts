/** A customer's whole license life on one database file that is closed and
 * opened again at every step, as restarts do: a license with three modules, a
 * renewal that takes one module out, then a license that is not renewed. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { currentLicense, installId, loadLicense } from "../license/runtime.ts";
import { sqliteLicenseStore } from "../license/sqlite_store.ts";
import { iso, makeTestSigner } from "./license_signer.ts";

const DAY = 86_400_000;
const START = Date.parse("2027-03-01T00:00:00Z");
const FIRST_END = Date.parse("2028-03-01T00:00:00Z");
const SECOND_END = Date.parse("2029-03-01T00:00:00Z");

test("a license is renewed with one module less and then left to end, across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-license-life-"));
  const path = join(dir, "app.db");
  let db: DatabaseSync | undefined;
  const restart = () => {
    db?.close();
    db = new DatabaseSync(path);
    return sqliteLicenseStore(db);
  };
  try {
    const signer = makeTestSigner();
    db = new DatabaseSync(path);
    const id = installId(sqliteLicenseStore(db));
    const first = signer.sign({
      id: "lic-one",
      install_id: id,
      modules: ["sso", "rbac", "audit"],
      expires_at: iso(FIRST_END),
    });
    assert.equal(
      loadLicense(sqliteLicenseStore(db), signer.keys, first, START).ok,
      true,
    );

    const at = (when: number) => currentLicense(restart(), signer.keys, when);
    const active = at(START + DAY);
    assert.equal(active.status, "active");
    assert.deepEqual(active.modules, ["sso", "rbac", "audit"]);

    // The end passes with no renewal yet, and the warning comes on day 3.
    assert.equal(at(FIRST_END + 1).status, "expired-grace");
    assert.equal(at(FIRST_END + 3 * DAY).status, "expired-warn");

    // The renewal arrives on day 5 with the audit module taken out.
    const renewal = signer.sign({
      id: "lic-two",
      install_id: id,
      modules: ["sso", "rbac"],
      not_before: iso(START),
      expires_at: iso(SECOND_END),
    });
    const loaded = loadLicense(
      restart(),
      signer.keys,
      renewal,
      FIRST_END + 5 * DAY,
    );
    assert.deepEqual(loaded, {
      ok: true,
      licenseId: "lic-two",
      replaced: true,
    });
    const renewed = at(FIRST_END + 6 * DAY);
    assert.equal(renewed.status, "active");
    assert.deepEqual(renewed.modules, ["sso", "rbac"]);

    // The second license is not renewed: the free product after 30 days.
    assert.equal(at(SECOND_END + 10 * DAY).status, "extension");
    const free = at(SECOND_END + 31 * DAY);
    assert.equal(free.status, "free");
    assert.deepEqual(free.modules, []);

    // Nothing is lost on the way: the file and the first license are still
    // there, and the changes are in the log in order.
    const store = restart();
    assert.equal(store.getActive()?.licenseId, "lic-two");
    assert.deepEqual(
      sqliteLicenseStore(db)
        .history()
        .map((file) => file.licenseId),
      ["lic-one"],
    );
    assert.deepEqual(
      sqliteLicenseStore(db)
        .events()
        .filter((event) => event.kind === "state_changed")
        .map((event) => event.detail),
      [
        "(first) -> active",
        "active -> expired-grace",
        "expired-grace -> expired-warn",
        "expired-warn -> active",
        "active -> extension",
        "extension -> free",
      ],
    );

    // A new file brings the modules back.
    const later = signer.sign({
      id: "lic-three",
      install_id: id,
      modules: ["sso"],
      not_before: iso(SECOND_END),
      expires_at: iso(SECOND_END + 365 * DAY),
    });
    assert.equal(
      loadLicense(restart(), signer.keys, later, SECOND_END + 40 * DAY).ok,
      true,
    );
    const back = at(SECOND_END + 41 * DAY);
    assert.equal(back.status, "active");
    assert.deepEqual(back.modules, ["sso"]);
  } finally {
    try {
      db?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
