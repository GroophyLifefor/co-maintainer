/** Remote review wire protocol — plan §15.1–15.2. */

export const REMOTE_SCHEMA_VERSION = 1;
export const MIN_CLIENT_SCHEMA = 1;
export const MIN_SERVER_SCHEMA = 1;

/** README install line for 426 responses (plan §14.4). */
export const REMOTE_CLI_UPGRADE_COMMAND =
  "deno install -f -g -A --min-dep-age=0 --name co-maintainer jsr:@murat/co-maintainer";

export const REMOTE_MAX_BODY_BYTES = 52_428_800;
export const REMOTE_SYNC_INTERVAL_SECONDS = 3;

/** SHA-256 of sorted `fixtures/v<N>/*.json` (name + contents); bump with schema version. */
export const REMOTE_FIXTURE_HASH: Record<number, string> = {
  1: "1cbb11016227fcc7fc58b692ed5a2b72dc9b0e23b4cf68858e2d7facc98efd79",
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
