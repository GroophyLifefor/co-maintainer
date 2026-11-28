import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { iso, makeTestSigner } from "../simulate/license_signer.ts";
import { currentLicense, installId, loadLicense } from "./runtime.ts";
import { sqliteLicenseStore } from "./sqlite_store.ts";

const DAY = 86_400_000;
const START = Date.parse("2027-03-01T00:00:00Z");
const END = Date.parse("2028-03-01T00:00:00Z");

/** A database file, closed and opened again between steps, as a restart does. */
function withFile(run: (open: () => DatabaseSync) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cm-license-"));
  const path = join(dir, "app.db");
  const opened: DatabaseSync[] = [];
  try {
    run(() => {
      const db = new DatabaseSync(path);
      opened.push(db);
      return db;
    });
  } finally {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the install id and the file in use survive a restart", () => {
  withFile((open) => {
    const signer = makeTestSigner();
    const first = open();
    const id = installId(sqliteLicenseStore(first));
    const text = signer.sign({ install_id: id });
    const loaded = loadLicense(
      sqliteLicenseStore(first),
      signer.keys,
      text,
      START,
    );
    assert.equal(loaded.ok, true);
    first.close();

    const second = sqliteLicenseStore(open());
    assert.equal(installId(second), id);
    assert.equal(second.getActive()?.text, text);
    assert.equal(
      currentLicense(second, signer.keys, START + DAY).status,
      "active",
    );
  });
});

test("the days past the end change the state in step, and a restart does not reset them", () => {
  withFile((open) => {
    const signer = makeTestSigner();
    let db = open();
    const id = installId(sqliteLicenseStore(db));
    loadLicense(
      sqliteLicenseStore(db),
      signer.keys,
      signer.sign({ install_id: id, expires_at: iso(END) }),
      START,
    );
    const statusAt = (days: number, hours = 0): string => {
      db.close();
      db = open();
      return currentLicense(
        sqliteLicenseStore(db),
        signer.keys,
        END + days * DAY + hours * 3_600_000,
      ).status;
    };
    assert.equal(statusAt(-1), "active");
    assert.equal(statusAt(0, 1), "expired-grace");
    assert.equal(statusAt(3), "expired-warn");
    assert.equal(statusAt(7), "extension");
    assert.equal(statusAt(29), "extension");
    assert.equal(statusAt(30), "free");
    const changes = sqliteLicenseStore(db)
      .events()
      .filter((event) => event.kind === "state_changed")
      .map((event) => event.detail);
    assert.deepEqual(changes, [
      "(first) -> active",
      "active -> expired-grace",
      "expired-grace -> expired-warn",
      "expired-warn -> extension",
      "extension -> free",
    ]);
  });
});

test("a clock moved back after a restart does not bring an ended license back", () => {
  withFile((open) => {
    const signer = makeTestSigner();
    let db = open();
    const id = installId(sqliteLicenseStore(db));
    loadLicense(
      sqliteLicenseStore(db),
      signer.keys,
      signer.sign({ install_id: id, expires_at: iso(END) }),
      START,
    );
    const ended = currentLicense(
      sqliteLicenseStore(db),
      signer.keys,
      END + 40 * DAY,
    );
    db.close();
    db = open();
    const back = currentLicense(
      sqliteLicenseStore(db),
      signer.keys,
      START + DAY,
    );
    assert.equal(back.status, ended.status);
    assert.ok(back.notes.includes("clock_went_back"));
  });
});

test("a replaced file goes to the history and every change of state is logged", () => {
  withFile((open) => {
    const signer = makeTestSigner();
    const store = sqliteLicenseStore(open());
    const id = installId(store);
    loadLicense(store, signer.keys, signer.sign({ install_id: id }), START);
    loadLicense(
      store,
      signer.keys,
      signer.sign({ install_id: id, license_id: "lic-two" }),
      START + DAY,
    );
    assert.equal(store.history().length, 1);
    currentLicense(store, signer.keys, START + 2 * DAY);
    currentLicense(store, signer.keys, END + 40 * DAY);
    const changes = store
      .events()
      .filter((event) => event.kind === "state_changed");
    assert.ok(changes.length >= 2, JSON.stringify(changes));
  });
});
