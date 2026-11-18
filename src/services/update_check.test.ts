/** The newer version check runs only with CM_UPDATE_URL, at most once a
 * day, and the Update button never offers an older version. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import {
  isNewer,
  parseStable,
  refreshReleaseCheck,
  startUpdate,
  updateNotice,
} from "./update_check.ts";
import { appDbPath } from "../store/app_db.ts";
import { VERSION } from "../version.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFileSync,
} from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

const [major, minor, patch] = parseStable(VERSION.split("-")[0]!)!;
const NEWER = `${major}.${minor}.${patch! + 1}`;
const OLDER = `${major}.${minor}.${Math.max(patch! - 1, 0)}`;

async function withEnv(
  updateUrl: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = ["CM_APP_DB", "CM_UPDATE_URL"];
  const original = keys.map((key) => getEnv(key));
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  if (updateUrl) setEnv("CM_UPDATE_URL", updateUrl);
  else deleteEnv("CM_UPDATE_URL");
  try {
    await fn();
  } finally {
    keys.forEach((key, i) => {
      const value = original[i];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    });
    await removePath(dir, { recursive: true }).catch(() => {});
  }
}

function fakeGithub(tag: string, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({
      tag_name: `v${tag}`,
      html_url: `https://github.com/GroophyLifefor/co-maintainer/releases/tag/v${tag}`,
    });
  }) as typeof fetch;
}

test("versions compare by number and pre-releases are never stable", () => {
  assert.equal(isNewer("0.7.15", "0.7.14"), true);
  assert.equal(isNewer("0.7.14", "0.7.14"), false);
  assert.equal(isNewer("0.7.9", "0.7.14"), false);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.7.15-beta.1", "0.7.14"), false);
  assert.equal(isNewer("0.7.15", "0.7.15-beta.2"), false);
  assert.equal(parseStable("v1.2.3")?.join("."), "1.2.3");
});

test("without CM_UPDATE_URL nothing calls out and no Update is offered", async () => {
  await withEnv(undefined, async () => {
    const calls: string[] = [];
    await refreshReleaseCheck({ fetcher: fakeGithub(NEWER, calls) });
    assert.deepEqual(calls, []);
    assert.deepEqual(updateNotice(), { running: VERSION, canUpdate: false });
    const result = await startUpdate(NEWER, fakeGithub(NEWER, calls));
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
  });
});

test("with CM_UPDATE_URL the check runs at most once a day", async () => {
  await withEnv("https://host.example/update", async () => {
    const calls: string[] = [];
    const now = Date.parse("2026-11-18T10:00:00.000Z");
    await refreshReleaseCheck({
      nowMs: now,
      fetcher: fakeGithub(NEWER, calls),
    });
    await refreshReleaseCheck({
      nowMs: now + 3_600_000,
      fetcher: fakeGithub(NEWER, calls),
    });
    assert.equal(calls.length, 1, "asked twice within a day");
    await refreshReleaseCheck({
      nowMs: now + 25 * 3_600_000,
      fetcher: fakeGithub(NEWER, calls),
    });
    assert.equal(calls.length, 2, "did not ask again after a day");
  });
});

test("the Update button posts the newest version and never an older one", async () => {
  await withEnv("https://host.example/update", async () => {
    writeTextFileSync(
      `${dirname(appDbPath())}/update-check.json`,
      JSON.stringify({
        check: {
          checkedAt: new Date().toISOString(),
          latest: NEWER,
          notesUrl: "https://example.com/notes",
        },
      }),
    );
    const notice = updateNotice();
    assert.equal(notice.latest, NEWER);
    assert.equal(notice.canUpdate, true);
    const posts: { url: string; body: string }[] = [];
    const host = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(input), body: String(init?.body) });
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const older = await startUpdate(OLDER, host);
    assert.equal(older.ok, false);
    const same = await startUpdate(VERSION.split("-")[0]!, host);
    assert.equal(same.ok, false);
    assert.equal(posts.length, 0, "an older version reached the host");
    const result = await startUpdate(NEWER, host);
    assert.equal(result.ok, true);
    assert.deepEqual(posts, [
      {
        url: "https://host.example/update",
        body: JSON.stringify({ version: NEWER, current: VERSION }),
      },
    ]);
    assert.equal(updateNotice().update?.status, "requested");
  });
});
