/** Extension registrations: what `extension register` saves, how a value is
 * checked, and which registrations apply to one review.
 *
 * Registrations live in `config.json` as an `extensions` array. The array
 * order is the registration order, which breaks priority ties, so an update
 * rewrites an entry in place instead of moving it to the end. */
import { readConfig, writeUserConfig, type UserConfig } from "../config.ts";
import { getEnv } from "../util/runtime.ts";

/** The review kinds an extension can run in. `pr` is a pull request review,
 * from the CLI or from `serve`. */
export const REVIEW_TYPES = ["local", "pr", "remote"] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

/** The run-after target that means "the AI review itself". */
export const REVIEW_TARGET = "review";

export const MAX_PRIORITY = 3;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const DEFAULT_MAX_REQUESTED_RETRIES = 3;
const MAX_TIMEOUT_SECONDS = 6 * 3600;
const MAX_RETRIES = 10;

export type ExtensionRegistration = {
  name: string;
  command: string;
  /** `*`, `owner/repo`, `owner/*`, `*\/repo`, comma separated. */
  repos: string;
  /** Unset means every review type. */
  reviewTypes?: ReviewType[];
  /** An extension name or `review`. */
  runAfter?: string;
  parallelism: boolean;
  priority: number;
  failFast: boolean;
  retryOnFailTimes: number;
  maxRequestedRetries: number;
  timeoutSeconds: number;
  /** Unset follows the global `extensionRerunOnRestart`. */
  rerunOnRestart?: boolean;
  disabled?: boolean;
};

/** `CM_EXTENSIONS_DISABLED=1` turns extensions off hard. The hosted cloud sets
 * it from outside the container, so nothing in the user's data volume can turn
 * them back on. */
export function extensionsDisabled(): boolean {
  return getEnv("CM_EXTENSIONS_DISABLED") === "1";
}

export const DISABLED_MESSAGE =
  "Extensions are turned off on this machine (CM_EXTENSIONS_DISABLED=1).";

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function nameProblem(name: string): string | undefined {
  if (!NAME.test(name)) {
    return "--name must be 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit";
  }
  if (name.toLowerCase() === REVIEW_TARGET) {
    return `--name cannot be "${REVIEW_TARGET}", it is the name of the AI review`;
  }
  return undefined;
}

const REPO_PART = /^(\*|[A-Za-z0-9_.-]+)$/;

/** Checks a `--repos` value. Each entry is `*` or `owner/repo` where either
 * side may be `*`. */
export function reposProblem(value: string): string | undefined {
  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    if (entry === "*") continue;
    const parts = entry.split("/");
    if (
      parts.length !== 2 ||
      !REPO_PART.test(parts[0]!) ||
      !REPO_PART.test(parts[1]!)
    ) {
      return `--repos has "${entry}", which is not owner/repo, owner/*, */repo or *`;
    }
  }
  return undefined;
}

/** Whether a registration's `repos` pattern covers `repo`. GitHub names are
 * case-insensitive, so the match is too. */
export function matchesRepo(pattern: string, repo: string): boolean {
  const [owner = "", name = ""] = repo.toLowerCase().split("/");
  return pattern.split(",").some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "*") return true;
    const [wantOwner, wantName] = entry.split("/");
    return (
      (wantOwner === "*" || wantOwner === owner) &&
      (wantName === "*" || wantName === name)
    );
  });
}

export function parseReviewTypes(value: string): ReviewType[] | string {
  const types = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (types.length === 0) return "--review-types needs at least one type";
  for (const type of types) {
    if (!(REVIEW_TYPES as readonly string[]).includes(type)) {
      return `--review-types must be a list of: ${REVIEW_TYPES.join(", ")}`;
    }
  }
  return [...new Set(types)] as ReviewType[];
}

/** `10m`, `30s`, `1h` or a plain number of seconds. */
export function parseTimeout(value: string): number | string {
  const match = value.trim().match(/^(\d+)(s|m|h)?$/);
  const problem = "--timeout must look like 30s, 10m or 1h, at most 6h";
  if (!match) return problem;
  const unit = match[2] ?? "s";
  const seconds =
    Number(match[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
  if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) return problem;
  return seconds;
}

/** `600` reads back as `10m`. */
export function formatTimeout(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function parseCount(
  value: string,
  flag: string,
  max: number,
): number | string {
  const number = Number(value);
  if (value.trim() === "" || !Number.isInteger(number) || number < 0) {
    return `${flag} must be a whole number from 0 to ${max}`;
  }
  if (number > max) return `${flag} must be a whole number from 0 to ${max}`;
  return number;
}

export const LIMITS = { maxRetries: MAX_RETRIES };

export function parseBoolean(value: string, flag: string): boolean | string {
  if (value === "true") return true;
  if (value === "false") return false;
  return `${flag} must be true or false`;
}

/** The registrations in config.json, oldest first. A malformed entry is
 * dropped rather than failing every review. */
export function readRegistrations(
  config: Pick<UserConfig, "extensions"> = readConfig(),
): ExtensionRegistration[] {
  const raw = config.extensions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ExtensionRegistration =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.name === "string" &&
      typeof entry.command === "string",
  );
}

export async function writeRegistrations(
  registrations: ExtensionRegistration[],
): Promise<void> {
  await writeUserConfig({
    extensions: registrations.length > 0 ? registrations : undefined,
  });
}

/** The first cycle the run-after links form, as `a -> b -> a`, or undefined.
 * `review` is the start point and never waits, so it cannot close a cycle. */
export function runAfterCycle(
  registrations: Pick<ExtensionRegistration, "name" | "runAfter">[],
): string | undefined {
  const next = new Map(
    registrations.map((entry) => [entry.name, entry.runAfter]),
  );
  for (const start of next.keys()) {
    const seen: string[] = [start];
    let current = next.get(start);
    while (current && current !== REVIEW_TARGET && next.has(current)) {
      if (current === start) return [...seen, start].join(" -> ");
      if (seen.includes(current)) break;
      seen.push(current);
      current = next.get(current);
    }
  }
  return undefined;
}

/** Whether `rerunOnRestart` is on for one registration: its own value, then the
 * global config key, then on. */
export function rerunsOnRestart(
  registration: Pick<ExtensionRegistration, "rerunOnRestart">,
  config: Pick<UserConfig, "extensionRerunOnRestart"> = readConfig(),
): boolean {
  return registration.rerunOnRestart ?? config.extensionRerunOnRestart ?? true;
}

/** The registrations that run for one review: enabled, matching the repository
 * and the review type, in registration order. */
export function applicableRegistrations(
  registrations: ExtensionRegistration[],
  repo: string,
  type: ReviewType,
): ExtensionRegistration[] {
  return registrations.filter(
    (entry) =>
      !entry.disabled &&
      matchesRepo(entry.repos ?? "*", repo) &&
      (!entry.reviewTypes || entry.reviewTypes.includes(type)),
  );
}
