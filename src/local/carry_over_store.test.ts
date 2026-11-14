import {
  clearPrCarry,
  prSubjectId,
  savePrCarry,
  tryLoadLocalCarry,
  tryLoadPrCarry,
} from "./carry_over_store.ts";
import { cacheDelete, cacheSet } from "../store/cache_db.ts";
import { removePath, tempDir } from "../testing/runtime.ts";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const NS = "local-review";

test("tryLoadLocalCarry: missing key", async () => {
  const result = await tryLoadLocalCarry("missing-repo", "/nope", "x");
  if (result.unavailable || result.data !== null) {
    throw new Error(JSON.stringify(result));
  }
});

test("tryLoadLocalCarry: invalid JSON is unavailable", async () => {
  const root = await tempDir();
  const key = `o/r\0${root}\0main`;
  await cacheSet(NS, key, "{not json");
  const result = await tryLoadLocalCarry("o/r", root, "main");
  await cacheDelete(NS, key);
  await removePath(root, { recursive: true });
  if (!result.unavailable || result.data !== null) {
    throw new Error(JSON.stringify(result));
  }
});

test("a pull request snapshot round-trips with its head and is keyed by number", async () => {
  const repo = "o/pr-store";
  await clearPrCarry(repo, 5);
  await clearPrCarry(repo, 6);
  await savePrCarry({
    subjectId: prSubjectId(repo, 5),
    files: [],
    visiblePaths: ["a.ts"],
    findings: [],
    guideBuiltAt: "2026-01-01T00:00:00.000Z",
    headSha: "abc123",
  });
  const five = await tryLoadPrCarry(repo, 5);
  const six = await tryLoadPrCarry(repo, 6);
  const localLike = await tryLoadLocalCarry(repo, "/work", "main");
  await clearPrCarry(repo, 5);
  const gone = await tryLoadPrCarry(repo, 5);
  if (five.data?.headSha !== "abc123") throw new Error(JSON.stringify(five));
  if (six.data !== null) throw new Error("pull request 6 saw pull request 5");
  if (localLike.data !== null) throw new Error("a local key saw a PR snapshot");
  if (gone.data !== null) throw new Error("clearPrCarry left the snapshot");
});
