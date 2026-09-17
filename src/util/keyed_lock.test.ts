import { keyedLockActiveKeys, withKeyedLock } from "./keyed_lock.ts";

Deno.test("keyed_lock: serializes concurrent callers on the same key", async () => {
  let active = 0;
  let peak = 0;
  await Promise.all([
    withKeyedLock("same", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
    }),
    withKeyedLock("same", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
    }),
  ]);
  if (peak > 1) {
    throw new Error(`expected peak concurrency 1, got ${peak}`);
  }
});

Deno.test("keyed_lock: drops map entry when the queue drains", async () => {
  const keys = Array.from({ length: 20 }, (_, i) => `repo-${i}`);
  for (const key of keys) {
    await withKeyedLock(key, async () => {});
  }
  if (keyedLockActiveKeys() !== 0) {
    throw new Error(`expected empty lock map, size ${keyedLockActiveKeys()}`);
  }
});
