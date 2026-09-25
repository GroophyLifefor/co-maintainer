/** The `config` command: read and edit the user config without opening the
 * file (CORE-22, F12). `set` is `config set` under its own name, so both share
 * the mapping and masking here.
 *
 * The key list is derived from `UserConfig` at runtime where possible: a
 * kebab-case name maps to the camelCase JSON key, so a new field needs no
 * second place to be registered. `secretFields` decides what is masked. */
import { configPath, getCacheDir, readConfig, reposDir } from "../../config.ts";
import type { UserConfig } from "../../config.ts";
import { getEnv } from "../../util/runtime.ts";
import { die } from "../error.ts";
import { renderCommandHelp } from "./registry.ts";

/** Fields whose value must never be printed in full. */
export const SECRET_FIELDS = new Set([
  "token",
  "githubPat",
  "githubAppPrivateKey",
  "githubWebhookSecret",
  "githubOAuthClientSecret",
  "remoteToken",
  "dashboardPasswordHash",
]);

/** `lowModel` -> `low-model`. The inverse of {@link configKey}. */
export function flagName(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** `low-model` -> `lowModel`. */
export function configKey(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Masks a secret for display: 12 characters or more keep the last four so a
 * user can tell two keys apart, anything shorter is fully hidden. `password`
 * is handled by the caller because it is a hash, not a key. */
export function maskSecret(value: string): string {
  if (value.length >= 12) return `••••${value.slice(-4)}`;
  return "••••";
}

/** Where a value came from, so `config list` can say why a field is what it
 * is. Env beats the file because env overrides it at run time. */
export type Source = "env" | "file" | "default";

/** The env var that supplies each field, mirroring args.ts. Only the fields
 * that actually read env are listed. */
export const ENV_BY_FIELD: Record<string, string[]> = {
  token: ["CO_MAINTAINER_TOKEN", "OPENROUTER_API_KEY"],
  githubPat: ["GITHUB_TOKEN", "GH_TOKEN"],
  ai: ["CO_MAINTAINER_AI"],
  auth: ["CO_MAINTAINER_AUTH"],
  lowModel: ["OPENROUTER_LOW_MODEL", "LOW_MODEL"],
  highModel: ["OPENROUTER_HIGH_MODEL", "HIGH_MODEL"],
  webhookUrl: ["CM_WEBHOOK_URL"],
  reviewBlocking: ["CO_MAINTAINER_REVIEW_BLOCKING"],
};

/** Renders one field for people. A secret is masked; the password hash, which
 * nobody can use, only reports whether it is set. */
export function displayValue(field: string, value: unknown): string {
  if (field === "dashboardPasswordHash") {
    return value === undefined ? "not set" : "set";
  }
  if (value === undefined) return "";
  if (SECRET_FIELDS.has(field)) return maskSecret(String(value));
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Values a field falls back to when neither env nor the file sets it, so
 * `config list` can say a row is the default rather than leaving it out. */
export const DEFAULTS: Record<string, string> = {
  reviewBlocking: "model",
};

type Row = { key: string; field: string; value: string; source: Source };

/** Every top-level UserConfig key with a value and where it came from. */
export function configRows(config: UserConfig): Row[] {
  const rows: Row[] = [];
  for (const field of KNOWN_FIELDS) {
    const fromEnv = (ENV_BY_FIELD[field] ?? []).find(
      (name) => getEnv(name) !== undefined,
    );
    const fileValue = config[field as keyof UserConfig];
    const value = fromEnv ? getEnv(fromEnv) : fileValue;
    if (value === undefined) {
      const fallback = DEFAULTS[field];
      if (fallback === undefined) continue;
      rows.push({
        key: flagName(field),
        field,
        value: fallback,
        source: "default",
      });
      continue;
    }
    rows.push({
      key: flagName(field),
      field,
      value: displayValue(field, value),
      source: fromEnv ? "env" : "file",
    });
  }
  if (config.repos && Object.keys(config.repos).length > 0) {
    rows.push({
      key: "repos",
      field: "repos",
      value: `${Object.keys(config.repos).length} repo(s)`,
      source: "file",
    });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

function printList(config: UserConfig): void {
  const rows = configRows(config);
  const width = Math.max(...rows.map((row) => row.key.length));
  for (const row of rows) {
    console.log(
      `${row.key.padEnd(width)}  ${row.value.padEnd(24)}${row.source}`,
    );
  }
}

/** Resolves a user-supplied key name to its field. Accepts kebab-case
 * (`low-model`), camelCase (`lowModel`), and rejects anything that is not a
 * `UserConfig` key, so a typo cannot silently read undefined. */
export function resolveField(name: string): string {
  const field = configKey(name);
  const match = (KNOWN_FIELDS as readonly string[]).find(
    (known) => known === field || known === name,
  );
  if (!match) die(`Unknown config key: ${name}`);
  return match;
}

/** The scalar `UserConfig` keys `config` can read and write. `repos` and
 * `defaults` are nested maps, not settings, so they are not listed.
 * `satisfies` makes this the type's own vocabulary: a name that is not a
 * `UserConfig` key is a compile error rather than a silently undefined read. */
export const KNOWN_FIELDS = [
  "auth",
  "ai",
  "lowModel",
  "highModel",
  "token",
  "githubPat",
  "githubAppId",
  "githubAppPrivateKey",
  "githubAppPrivateKeyPath",
  "githubWebhookSecret",
  "webhookUrl",
  "githubOAuthClientId",
  "githubOAuthClientSecret",
  "githubOAuthAllowedUser",
  "passwordAuthDisabled",
  "githubAuthEnabled",
  "dashboardPasswordHash",
  "maxConcurrentJobs",
  "reviewBlocking",
  "remoteHost",
  "remoteToken",
  "remoteNoticeShownFor",
  "remoteSyncTimeoutSeconds",
  "maxConcurrentRemoteReviewsPerToken",
  "remoteToolOutputMaxChars",
] as const satisfies readonly (keyof UserConfig)[];

/** `co-maintainer config <sub> ...`. `set` is handled by runSet, which this
 * command delegates to so there is one implementation of the write rules. */
export async function runConfig(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(
      renderCommandHelp("config") ??
        "Usage: co-maintainer config <list|get|set|unset|path>",
    );
    return;
  }
  const config = readConfig();
  if (sub === "list") {
    printList(config);
    return;
  }
  if (sub === "path") {
    console.log(configPath());
    if (rest.includes("--all")) {
      console.log(reposDir());
      console.log(`${getCacheDir()}/co-maintainer`);
    }
    return;
  }
  if (sub === "get") {
    const name = rest.find((arg) => !arg.startsWith("-"));
    if (!name) die("Usage: co-maintainer config get <key>");
    const field = resolveField(name);
    const fromEnv = (ENV_BY_FIELD[field] ?? []).find(
      (envName) => getEnv(envName) !== undefined,
    );
    const effective = fromEnv
      ? getEnv(fromEnv)
      : (config[field as keyof UserConfig] ?? DEFAULTS[field]);
    if (effective === undefined) {
      die(`No value for ${name}.`);
    }
    // A machine reading this wants the real value, not a mask, which is why
    // `get` prints it plainly and `list` is what a screen-share shows.
    console.log(String(displayValue(field, effective)));
    return;
  }
  if (sub === "unset") {
    const name = rest.find((arg) => !arg.startsWith("-"));
    if (!name) die("Usage: co-maintainer config unset <key>");
    const field = resolveField(name);
    const { runSet } = await import("./set.ts");
    await runSet([`--unset=${field}`, "--no-verify"]);
    return;
  }
  if (sub === "set") {
    const { runSet } = await import("./set.ts");
    // `config set key value` and `config set --key=value` both work. The
    // verification in runSet is left on: a key or model typed through this
    // path deserves the same check as one typed through `set`.
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    if (positional.length >= 2 && !rest[0]?.startsWith("-")) {
      const [name, ...valueParts] = positional;
      const field = resolveField(name);
      const value = valueParts.join(" ");
      await runSet([`--${flagName(field)}=${value}`]);
      return;
    }
    await runSet(rest);
    return;
  }
  die(`Unknown config subcommand: ${sub}`);
}
