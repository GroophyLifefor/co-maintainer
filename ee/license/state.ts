/** What a license means at a given moment: its state and the modules it
 * opens. Pure, so every boundary can be tested with a made-up clock.
 *
 * Reviews never stop here. A state only says which enterprise modules are
 * open, and `free` takes none away from the free product. */
import {
  parseUtc,
  type LicenseKind,
  type LicensePayload,
  type VerifyResult,
} from "./format.ts";

const DAY = 86_400_000;
/** Days after the end: every module stays open and only a note is shown. */
export const GRACE_DAYS = 3;
/** Days after the end: a clear warning on every admin visit. */
export const WARN_DAYS = 7;
/** Days after the end: the request for more time is offered. At the end of
 * these the product falls back to free. Only a new license file undoes it. */
export const FALL_DAYS = 30;
/** How far back the clock may go before it is noted. A bad time server is
 * not punished. */
export const CLOCK_TOLERANCE_MS = DAY;

export type LicenseStatus =
  /** No license file. */
  | "none"
  /** A file that cannot be used: unknown key, bad signature, unreadable. */
  | "invalid"
  /** Valid, and its start is still ahead. Modules are closed. */
  | "pending"
  | "active"
  | "expired-grace"
  | "expired-warn"
  | "extension"
  /** Ended more than 30 days ago. The free product. */
  | "free";

export type LicenseNote =
  | "install_mismatch"
  | "clock_went_back"
  | "invalid_file";

export type LicenseState = {
  status: LicenseStatus;
  /** Module names the license opens right now. Names this build does not
   * know are listed too: the caller decides what it can register. */
  modules: string[];
  kind?: LicenseKind;
  /** Whole days past the end, when it has ended. */
  daysPastEnd?: number;
  /** A staging license reviews but writes nothing to GitHub. */
  dryRun: boolean;
  notes: LicenseNote[];
  /** Why a file was refused, when `status` is `invalid`. */
  invalidReason?: string;
  /** The time the state was worked out at: the later of now and the latest
   * time ever seen. */
  effectiveAt: number;
};

export type EvaluateInput = {
  /** The file's verification, or undefined when there is no file. */
  file: VerifyResult | undefined;
  /** This installation's id. */
  installId: string;
  now: number;
  /** The latest time the product has ever seen, from its own records. */
  lastSeen?: number;
};

/** The latest time seen after this moment. It only moves forward. */
export function nextLastSeen(
  previous: number | undefined,
  now: number,
): number {
  return previous === undefined ? now : Math.max(previous, now);
}

export function evaluateLicense(input: EvaluateInput): LicenseState {
  const effectiveAt = Math.max(input.now, input.lastSeen ?? input.now);
  const notes: LicenseNote[] = [];
  if (
    input.lastSeen !== undefined &&
    input.lastSeen - input.now > CLOCK_TOLERANCE_MS
  ) {
    notes.push("clock_went_back");
  }
  const base = { dryRun: false, notes, effectiveAt };
  if (input.file === undefined) {
    return { ...base, status: "none", modules: [] };
  }
  if (!input.file.ok) {
    return {
      ...base,
      status: "invalid",
      modules: [],
      invalidReason: input.file.reason,
      notes: [...notes, "invalid_file"],
    };
  }
  const license: LicensePayload = input.file.payload;
  const start = parseUtc(license.not_before) as number;
  const end = parseUtc(license.expires_at) as number;
  // A license for another installation still opens its modules: the binding
  // is a note, not a lock, so a rebuilt server is not locked out of its own
  // reviews while it asks for a new file.
  if (license.install_id !== input.installId) notes.push("install_mismatch");
  const open = {
    ...base,
    kind: license.kind,
    notes,
    dryRun: license.kind === "staging",
  };
  if (effectiveAt < start) return { ...open, status: "pending", modules: [] };
  if (effectiveAt <= end) {
    return { ...open, status: "active", modules: license.modules };
  }
  const daysPastEnd = Math.floor((effectiveAt - end) / DAY);
  const ended = { ...open, daysPastEnd };
  // A trial has no grace: when it ends the product is the free one.
  if (license.kind === "trial")
    return { ...ended, status: "free", modules: [] };
  if (daysPastEnd < GRACE_DAYS) {
    return { ...ended, status: "expired-grace", modules: license.modules };
  }
  if (daysPastEnd < WARN_DAYS) {
    return { ...ended, status: "expired-warn", modules: license.modules };
  }
  if (daysPastEnd < FALL_DAYS) {
    return { ...ended, status: "extension", modules: license.modules };
  }
  return { ...ended, status: "free", modules: [] };
}
