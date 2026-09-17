import { tryLoadLocalCarry } from "./carry_over_store.ts";
import { cacheDelete, cacheSet } from "../store/cache_db.ts";

const NS = "local-review";

Deno.test("tryLoadLocalCarry: missing key", async () => {
  const result = await tryLoadLocalCarry("missing-repo", "/nope", "x");
  if (result.unavailable || result.data !== null) {
    throw new Error(JSON.stringify(result));
  }
});

Deno.test("tryLoadLocalCarry: invalid JSON is unavailable", async () => {
  const root = await Deno.makeTempDir();
  const key = `o/r\0${root}\0main`;
  await cacheSet(NS, key, "{not json");
  const result = await tryLoadLocalCarry("o/r", root, "main");
  await cacheDelete(NS, key);
  await Deno.remove(root, { recursive: true });
  if (!result.unavailable || result.data !== null) {
    throw new Error(JSON.stringify(result));
  }
});
