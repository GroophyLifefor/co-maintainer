import { AsyncLocalStorage } from "node:async_hooks";

/** Outside a job, `log()` just prints to the console. Inside one (wrapped
 * with `withLogSink`), it also reaches `job_logs` and any live SSE
 * subscriber, without threading a logger through every function signature. */
type Sink = (phase: string, message: string) => void;
const sinkStorage = new AsyncLocalStorage<Sink>();

export function withLogSink<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  return sinkStorage.run(sink, fn);
}

export function log(phase: string, message: string): void {
  const sink = sinkStorage.getStore();
  if (sink) sink(phase, message);
  else console.log(`[${phase}] ${message}`);
}

export function startHeartbeat(phase: string | (() => string)): () => void {
  const started = Date.now();
  const label = () => typeof phase === "function" ? phase() : phase;
  const timer = setInterval(() => {
    log(
      "progress",
      `still running ${label()} · ${
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
      log(
        "time",
        `${label} · ${((performance.now() - started) / 1000).toFixed(2)}s`,
      );
    }
  }
}
