/** Remote review wire protocol — plan §15.1–15.2. */

export const REMOTE_SCHEMA_VERSION = 1;
export const MIN_CLIENT_SCHEMA = 1;
export const MIN_SERVER_SCHEMA = 1;

/** README install line for 426 responses (plan §14.4). */
export const REMOTE_CLI_UPGRADE_COMMAND = "npm install -g co-maintainer@latest";

export const REMOTE_MAX_BODY_BYTES = 52_428_800;
export const REMOTE_SYNC_INTERVAL_SECONDS = 3;

/** SHA-256 of sorted `fixtures/v<N>/*.json` (name + contents, `\r\n` normalized
 * to `\n`); bump with schema version. */
export const REMOTE_FIXTURE_HASH: Record<number, string> = {
  1: "71e4e5f8637eab4b53d47817a688812a517310d967abe26aa0d7f4e7d7d65092",
};

export const REMOTE_SYNC_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "canceled",
] as const;

export type RemoteSyncStatus = (typeof REMOTE_SYNC_STATUSES)[number];

/** Tool names the server may invoke via the bridge (plan §13.6, §14.5). */
export const REMOTE_KNOWN_TOOL_NAMES = new Set([
  "codegraph-query",
  "codegraph-node",
  "codegraph-explore",
  "codegraph-callers",
  "codegraph-callees",
  "codegraph-impact",
  "codegraph-affected",
  "read-full-diff",
]);
