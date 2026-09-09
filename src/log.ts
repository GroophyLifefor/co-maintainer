export function startHeartbeat(phase: string): () => void {
  const started = Date.now();
  const timer = setInterval(() => {
    console.log(
      `[progress] still running ${phase} · ${
        Math.round((Date.now() - started) / 1000)
      }s elapsed`,
    );
  }, 15_000);
  return () => clearInterval(timer);
}

export async function timed<T>(
  label: string,
  enabled: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    if (enabled) {
      console.log(
        `[time] ${label} · ${
          ((performance.now() - started) / 1000).toFixed(2)
        }s`,
      );
    }
  }
}
