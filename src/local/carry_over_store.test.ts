import { tryLoadLocalCarry } from "./carry_over_store.ts";
import { cacheDelete, cacheSet } from "../store/cache_db.ts";
import { removePath, tempDir } from "../testing/runtime.ts";
import { test } from "node:test";

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
