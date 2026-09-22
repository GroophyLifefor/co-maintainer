import { AsyncLocalStorage } from "node:async_hooks";

/** Outside a job, `log()` just prints to the console. Inside one (wrapped
 * with `withLogSink`), it also reaches `job_logs` and any live SSE
 * subscriber, without threading a logger through every function signature. */
type Sink = (phase: string, message: string) => void;
const sinkStorage = new AsyncLocalStorage<Sink>();
let cliLogsToStderr = false;

/** Plan §8.4 — progress and logs on stderr during CLI review. */
export function withCliLogsToStderr<T>(fn: () => Promise<T>): Promise<T> {
  const prev = cliLogsToStderr;
  cliLogsToStderr = true;
  return fn().finally(() => {
    cliLogsToStderr = prev;
  });
}

export function withLogSink<T>(sink: Sink, fn: () => Promise<T>): Promise<T> {
  return sinkStorage.run(sink, fn);
}

export function log(phase: string, message: string): void {
  const sink = sinkStorage.getStore();
  if (sink) sink(phase, message);
  else if (cliLogsToStderr) console.error(`[${phase}] ${message}`);
  else console.log(`[${phase}] ${message}`);
}

/** True inside a dashboard job (one wrapped with `withLogSink`), where a
 * diagnostic line belongs in the job log rather than the server's terminal. */
export function hasLogSink(): boolean {
  return sinkStorage.getStore() !== undefined;
}

export function startHeartbeat(phase: string | (() => string)): () => void {
  const started = Date.now();
  const label = () => (typeof phase === "function" ? phase() : phase);
  const timer = setInterval(() => {
    log(
      "progress",
      `still running ${label()} · ${Math.round((Date.now() - started) / 1000)}s elapsed`,
    );
  }, 15_000);
  // Never keep the process alive on its own (CORE-11). A long operation holds
  // the loop open through its own pending async work (a fetch, a child), so the
  // heartbeat still fires; but once that work is gone the timer must not be the
  // reason the process cannot drain and apply its exit code. Every call site
  // used to clear this by hand on the success path only, so any thrown error
  // leaked it and the CLI hung instead of exiting.
  timer.unref();
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
