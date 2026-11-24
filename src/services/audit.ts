/** Writes the audit log from the places that change things. The person is
 * the signed-in user of the request, kept for the length of one request, so
 * a handler records an action without passing the session around. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  insertAudit,
  type AuditChange,
  type AuditKind,
} from "../store/audit.ts";
import { readConfig } from "../config.ts";
import { getRepo } from "../store/repos.ts";

const scope = new AsyncLocalStorage<{ actor?: string }>();

/** Runs one request with room for its signed-in user. */
export function inAuditScope<T>(fn: () => T): T {
  return scope.run({}, fn);
}

/** Called once the request's session is known. */
/** Who the current request acts for, when known. */
export function currentAuditActor(): string | undefined {
  return scope.getStore()?.actor;
}

export function setAuditActor(actor: string): void {
  const store = scope.getStore();
  if (store) store.actor = actor;
}

/** Records an action of the current request. `actor` names the person when
 * there is no session yet, as on a sign-in. A failure to write never fails
 * the action itself. */
export function audit(
  kind: AuditKind,
  summary: string,
  opts: { target?: string; changes?: AuditChange[]; actor?: string } = {},
): void {
  try {
    insertAudit({
      actor: opts.actor ?? scope.getStore()?.actor ?? "unknown",
      kind,
      summary,
      target: opts.target,
      changes: opts.changes,
    });
  } catch (error) {
    console.error(
      "[audit] Could not write the audit log:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** A setting whose value is a secret by its name: keys, tokens, passwords,
 * private keys and webhook secrets. Only that it changed is recorded. */
const SECRET = /(token|secret|password|privatekey|pat$|apikey|key$)/i;

function shortValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "not set";
  const textValue = typeof value === "string" ? value : JSON.stringify(value);
  return textValue.length > 200 ? `${textValue.slice(0, 199)}…` : textValue;
}

/** What changed between two snapshots of a set of settings, one entry per
 * setting whose value differs. Secrets say "changed" or "removed" and never
 * show a value. */
export function settingChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditChange[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes: AuditChange[] = [];
  for (const name of names.sort()) {
    const from = before[name];
    const to = after[name];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    if (SECRET.test(name)) {
      changes.push({
        setting: name,
        from: from ? "hidden" : "not set",
        to: to ? "changed, hidden" : "removed",
      });
      continue;
    }
    changes.push({ setting: name, from: shortValue(from), to: shortValue(to) });
  }
  return changes;
}

/** The global settings as the audit log compares them: every saved value
 * but the per repository ones, which have their own entries. */
export function settingsSnapshot(): Record<string, unknown> {
  // Cleared values are kept out of sight, the audit log included: one of them
  // may be a key.
  const {
    repos: _repos,
    clearedSettings: _cleared,
    ...rest
  } = readConfig() as Record<string, unknown>;
  return rest;
}

/** Repository columns that are not settings: names, times and what a sync
 * wrote. Everything else on the row, and the repository's saved config, is a
 * setting the log compares. */
const NOT_SETTINGS = new Set([
  "full_name",
  "installation_id",
  "active",
  "knowledge_built_at",
  "knowledge_base_sha",
  "created_at",
  "added_from",
  "default_branch",
  "settings",
  "removed_by_github_at",
  "returned_at",
]);

/** One repository's settings as the audit log compares them. */
export function repoSnapshot(fullName: string): Record<string, unknown> {
  const row = (getRepo(fullName) ?? {}) as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (!NOT_SETTINGS.has(name)) snapshot[name] = value;
  }
  const saved = readConfig().repos?.[fullName] ?? {};
  return { ...snapshot, ...(saved as Record<string, unknown>) };
}
