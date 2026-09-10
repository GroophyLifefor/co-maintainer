export function startHeartbeat(phase: string | (() => string)): () => void {
  const started = Date.now();
  const label = () => typeof phase === "function" ? phase() : phase;
  const timer = setInterval(() => {
    console.log(
      `[progress] still running ${label()} · ${
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
