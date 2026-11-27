/** What the product does with a license over time: the installation's id, the
 * one active file, the daily check, and the record of every change of state.
 *
 * It does not touch a disk or a clock itself. A `LicenseStore` holds the
 * state, the caller gives the time, and the keys are handed in, so every
 * moment can be made up in a test. The store that keeps this in the product's
 * own database is a separate step.
 *
 * Reviews never depend on anything here: a file that is bad, a store that
 * fails and a check that throws all leave the product as the free one. */
import { randomUUID } from "node:crypto";
import {
  verifyLicenseFile,
  type PublicKeys,
  type VerifyFailure,
} from "./format.ts";
import {
  evaluateLicense,
  nextLastSeen,
  type LicenseState,
  type LicenseStatus,
} from "./state.ts";

export const CHECK_EVERY_MS = 86_400_000;

export type StoredLicense = {
  /** The file's text, as it was loaded. */
  text: string;
  loadedAt: number;
  /** The license's own id, read when it was loaded. */
  licenseId: string;
};

export type LicenseEvent = {
  at: number;
  kind: "loaded" | "refused" | "state_changed";
  detail: string;
};

/** Where the license state lives. Everything is plain data. */
export type LicenseStore = {
  getInstallId(): string | undefined;
  setInstallId(id: string): void;
  getLastSeen(): number | undefined;
  setLastSeen(at: number): void;
  getLastChecked(): number | undefined;
  setLastChecked(at: number): void;
  /** The one file in use. */
  getActive(): StoredLicense | undefined;
  setActive(file: StoredLicense): void;
  /** Files that were replaced, newest last. */
  pushHistory(file: StoredLicense): void;
  /** The last state that was worked out from a file that read well. */
  getLastGood(): LicenseState | undefined;
  setLastGood(state: LicenseState): void;
  /** The last state that was recorded, to tell a change from a repeat. */
  getLastStatus(): LicenseStatus | undefined;
  setLastStatus(status: LicenseStatus): void;
  appendEvent(event: LicenseEvent): void;
};

/** A store in memory, for tests and for a product that has no database yet. */
export function memoryLicenseStore(): LicenseStore & {
  history: StoredLicense[];
  events: LicenseEvent[];
} {
  let installId: string | undefined;
  let lastSeen: number | undefined;
  let lastChecked: number | undefined;
  let active: StoredLicense | undefined;
  let lastGood: LicenseState | undefined;
  let lastStatus: LicenseStatus | undefined;
  const history: StoredLicense[] = [];
  const events: LicenseEvent[] = [];
  return {
    history,
    events,
    getInstallId: () => installId,
    setInstallId: (id) => {
      installId = id;
    },
    getLastSeen: () => lastSeen,
    setLastSeen: (at) => {
      lastSeen = at;
    },
    getLastChecked: () => lastChecked,
    setLastChecked: (at) => {
      lastChecked = at;
    },
    getActive: () => active,
    setActive: (file) => {
      active = file;
    },
    pushHistory: (file) => {
      history.push(file);
    },
    getLastGood: () => lastGood,
    setLastGood: (state) => {
      lastGood = state;
    },
    getLastStatus: () => lastStatus,
    setLastStatus: (status) => {
      lastStatus = status;
    },
    appendEvent: (event) => {
      events.push(event);
    },
  };
}

/** The installation's id: made once, then the same. It leaves with the data,
 * so moving the data moves the id. */
export function installId(store: LicenseStore): string {
  const known = store.getInstallId();
  if (known) return known;
  const made = `install-${randomUUID()}`;
  store.setInstallId(made);
  return made;
}

export type LoadResult =
  | { ok: true; licenseId: string; replaced: boolean }
  | { ok: false; reason: VerifyFailure | "empty" };

/** Takes a license file into use. A file that does not verify is refused and
 * the one in use stays. A valid one becomes the only active file and the
 * earlier one goes to the history. */
export function loadLicense(
  store: LicenseStore,
  keys: PublicKeys,
  text: string,
  now: number,
): LoadResult {
  if (text.trim() === "") {
    store.appendEvent({ at: now, kind: "refused", detail: "empty" });
    return { ok: false, reason: "empty" };
  }
  const result = verifyLicenseFile(text, keys);
  if (!result.ok) {
    store.appendEvent({ at: now, kind: "refused", detail: result.reason });
    return { ok: false, reason: result.reason };
  }
  const previous = store.getActive();
  if (previous) store.pushHistory(previous);
  store.setActive({
    text: text.trim(),
    loadedAt: now,
    licenseId: result.payload.id,
  });
  store.appendEvent({
    at: now,
    kind: "loaded",
    detail: `${result.payload.kind} ${result.payload.id} for ${result.payload.customer.name}`,
  });
  // The next check works the new file out at once.
  store.setLastChecked(0);
  return {
    ok: true,
    licenseId: result.payload.id,
    replaced: previous !== undefined,
  };
}

/** The license's state now. The latest time seen only moves forward. A change
 * of state is written down once. A file that no longer reads, though it did
 * when it was loaded, does not drop the product to free at once: the last
 * state that read well is kept, with a note. */
export function currentLicense(
  store: LicenseStore,
  keys: PublicKeys,
  now: number,
): LicenseState {
  const lastSeen = nextLastSeen(store.getLastSeen(), now);
  store.setLastSeen(lastSeen);
  store.setLastChecked(now);
  const active = store.getActive();
  const state = evaluateLicense({
    file: active ? verifyLicenseFile(active.text, keys) : undefined,
    installId: installId(store),
    now,
    lastSeen,
  });
  let result = state;
  if (state.status === "invalid") {
    const good = store.getLastGood();
    if (good) {
      // Kept as it was when it last read well, with a note: it is not worked
      // out again, since the file it came from cannot be read now.
      result = {
        ...good,
        notes: good.notes.includes("invalid_file")
          ? good.notes
          : [...good.notes, "invalid_file"],
      };
      // Kept with its note, so a call between two checks shows the failure too.
      store.setLastGood(result);
    }
  } else if (state.status !== "none") {
    store.setLastGood(state);
  }
  if (store.getLastStatus() !== result.status) {
    store.appendEvent({
      at: now,
      kind: "state_changed",
      detail: `${store.getLastStatus() ?? "(first)"} -> ${result.status}`,
    });
    store.setLastStatus(result.status);
  }
  return result;
}

/** True when the daily check is due. */
export function checkDue(store: LicenseStore, now: number): boolean {
  const last = store.getLastChecked();
  return last === undefined || now - last >= CHECK_EVERY_MS || now < last;
}

/** The daily check: works the state out when it is due and otherwise answers
 * from the last state that was saved. Never throws, even when the store is
 * the thing that fails. */
export function dailyCheck(
  store: LicenseStore,
  keys: PublicKeys,
  now: number,
): LicenseState | undefined {
  try {
    if (!checkDue(store, now)) return store.getLastGood();
    return currentLicense(store, keys, now);
  } catch {
    // The product stays as it is: nothing about a license stops a review.
    try {
      return store.getLastGood();
    } catch {
      return undefined;
    }
  }
}
