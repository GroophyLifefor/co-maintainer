/** Per-key async mutex: concurrent callers for the same key run one at a time. */
const tails = new Map<string, Promise<void>>();

function lock(key: string): Promise<() => void> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, prev.then(() => next));
  return prev.then(() => release);
}

export async function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await lock(key);
  try {
    return await fn();
  } finally {
    release();
  }
}
