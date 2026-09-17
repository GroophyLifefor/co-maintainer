/** Per-key async mutex: concurrent callers for the same key run one at a time. */
type Queue = { running: boolean; waiters: Array<() => void> };
const queues = new Map<string, Queue>();

/** @internal For tests — number of keys with an active or queued lock. */
export function keyedLockActiveKeys(): number {
  return queues.size;
}

export async function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  let queue = queues.get(key);
  if (!queue) {
    queue = { running: false, waiters: [] };
    queues.set(key, queue);
  }
  if (queue.running) {
    await new Promise<void>((resolve) => {
      queue!.waiters.push(resolve);
    });
  } else {
    queue.running = true;
  }
  try {
    return await fn();
  } finally {
    const current = queues.get(key);
    if (current) {
      const wake = current.waiters.shift();
      if (wake) wake();
      else queues.delete(key);
    }
  }
}
