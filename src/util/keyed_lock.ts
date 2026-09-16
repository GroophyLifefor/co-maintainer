/** Per-key async mutex: concurrent callers for the same key run one at a time. */
const tails = new Map<string, Promise<void>>();

export async function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = tails.get(key);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = (prev ?? Promise.resolve()).then(() => gate);
  tails.set(key, tail);
  await (prev ?? Promise.resolve());
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
