/** A remote review's time limit ends every wait, not only the loop's top. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startDeadline } from "./deadline.ts";

class TimedOut extends Error {}
const timedOut = (): never => {
  throw new TimedOut("the limit was reached");
};

test("a wait that never ends fails with the limit's error once the limit passes", async () => {
  const limit = startDeadline(Date.now() + 30, timedOut);
  const stalled = new Promise<never>(() => {});
  await assert.rejects(limit.bounded(stalled), TimedOut);
  limit.clear();
});

test("work that ends before the limit keeps its value", async () => {
  const limit = startDeadline(Date.now() + 5_000, timedOut);
  assert.equal(await limit.bounded(Promise.resolve(7)), 7);
  limit.clear();
});

test("check throws only once the limit has passed, and no limit never throws", () => {
  startDeadline(Date.now() + 5_000, timedOut).check();
  assert.throws(
    () => startDeadline(Date.now() - 1, timedOut).check(),
    TimedOut,
  );
  startDeadline(undefined, timedOut).check();
});
