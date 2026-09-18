import { hashRemoteFixtures } from "./fixtures.ts";
import {
  MIN_CLIENT_SCHEMA,
  MIN_SERVER_SCHEMA,
  REMOTE_CLI_UPGRADE_COMMAND,
  REMOTE_FIXTURE_HASH,
  REMOTE_SCHEMA_VERSION,
} from "./schema.ts";
import {
  validateHandshakeRequest,
  validateRemotePath,
  validateSubmitRequest,
  validateSyncRequest,
  validateSyncResponseStatus,
} from "./validate.ts";
import { readTextFile } from "../testing/runtime.ts";
import { test } from "node:test";

async function loadFixture(name: string): Promise<unknown> {
  const text = await readTextFile(
    new URL(`./fixtures/v1/${name}`, import.meta.url),
  );
  return JSON.parse(text);
}

test("remote fixtures: hash matches schema.ts", async () => {
  const hash = await hashRemoteFixtures(REMOTE_SCHEMA_VERSION);
  const expected = REMOTE_FIXTURE_HASH[REMOTE_SCHEMA_VERSION];
  if (!expected || expected === "PLACEHOLDER") {
    throw new Error(
      `update REMOTE_FIXTURE_HASH[${REMOTE_SCHEMA_VERSION}] to: ${hash}`,
    );
  }
  if (hash !== expected) {
    throw new Error(`fixture hash mismatch: got ${hash}, expected ${expected}`);
  }
});

test("remote validators accept v1 fixtures", async () => {
  const handshake = await loadFixture("handshake.request.json");
  if (validateHandshakeRequest(handshake)) {
    throw new Error("handshake request");
  }
  const submit = await loadFixture("submit.request.json");
  if (validateSubmitRequest(submit)) {
    throw new Error("submit request");
  }
  const sync = await loadFixture("sync.request.json");
  if (validateSyncRequest(sync)) {
    throw new Error("sync request");
  }
  const syncResp = (await loadFixture("sync.response.json")) as Record<
    string,
    unknown
  >;
  if (validateSyncResponseStatus(syncResp.status)) {
    throw new Error("sync response status");
  }
});

test("remote wire constants are frozen", () => {
  // Bumping these changes the protocol; a 426/upgrade loop depends on the
  // exact upgrade command reaching older clients.
  if (REMOTE_SCHEMA_VERSION !== 1) {
    throw new Error(`REMOTE_SCHEMA_VERSION changed: ${REMOTE_SCHEMA_VERSION}`);
  }
  if (MIN_CLIENT_SCHEMA !== 1) {
    throw new Error(`MIN_CLIENT_SCHEMA changed: ${MIN_CLIENT_SCHEMA}`);
  }
  if (MIN_SERVER_SCHEMA !== 1) {
    throw new Error(`MIN_SERVER_SCHEMA changed: ${MIN_SERVER_SCHEMA}`);
  }
  if (REMOTE_CLI_UPGRADE_COMMAND !== "npm install -g co-maintainer@latest") {
    throw new Error(
      `REMOTE_CLI_UPGRADE_COMMAND changed: ${REMOTE_CLI_UPGRADE_COMMAND}`,
    );
  }
});

test("validateSubmitRequest rejects duplicate paths", () => {
  const body = {
    schemaVersion: 1,
    requestId: "550e8400-e29b-41d4-a716-446655440000",
    repo: "o/r",
    branch: "main",
    revision: {
      files: [
        {
          path: "a.ts",
          previousPath: null,
          status: "modified",
          binary: false,
          additions: 1,
          deletions: 0,
          patch: "x",
        },
        {
          path: "a.ts",
          previousPath: null,
          status: "modified",
          binary: false,
          additions: 1,
          deletions: 0,
          patch: "y",
        },
      ],
    },
  };
  const err = validateSubmitRequest(body);
  if (!err?.includes("duplicate")) {
    throw new Error(`expected duplicate path error, got ${err}`);
  }
});

test("validateRemotePath rejects absolute and escaping paths", () => {
  for (const path of [
    "../etc/passwd",
    "/etc/passwd",
    "C:/Windows/System32",
    "src/../outside.ts",
  ]) {
    const err = validateRemotePath("revision.files[0].path", path);
    if (!err) throw new Error(`expected reject for ${path}`);
  }
  if (validateRemotePath("revision.files[0].path", "src/foo.ts")) {
    throw new Error("expected relative path to pass");
  }
});

test("validateSubmitRequest rejects non-string branch", () => {
  const base = {
    schemaVersion: 1,
    requestId: "550e8400-e29b-41d4-a716-446655440000",
    repo: "o/r",
    revision: {
      files: [
        {
          path: "a.ts",
          previousPath: null,
          status: "modified",
          binary: false,
          additions: 1,
          deletions: 0,
          patch: "x",
        },
      ],
    },
  };
  const err = validateSubmitRequest({ ...base, branch: 123 });
  if (!err?.includes("branch")) {
    throw new Error(`expected branch error, got ${err}`);
  }
});
