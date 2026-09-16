import { withKeyedLock } from "./keyed_lock.ts";

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
