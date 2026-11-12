/** One error shape for every CLI failure.
 *
 * The message is the first line the user reads, `hint` is an optional
 * follow-up line printed as `Hint: ...`, and `exitCode` is the documented
 * contract: 1 only for blocking review findings, 2 for usage and precondition
 * errors, 3 for runtime failures. Anything thrown that is not a `CliError` is
 * treated as a runtime failure (3), which is the safe default for the network,
 * provider and filesystem errors the CLI does not classify yet.
 */
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;
export const EXIT_RUNTIME = 3;

export class CliError extends Error {
  code: string;
  hint?: string;
  exitCode: number;

  constructor(
    code: string,
    message: string,
    hint?: string,
    exitCode = EXIT_USAGE,
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

/** Throws a usage or precondition error. Kept as a helper so the existing
 * `die(...)` call sites read the same as before. */
export function die(message: string, code = "usage"): never {
  throw new CliError(code, message, undefined, EXIT_USAGE);
}

/** Ends the CLI with `code`, letting the event loop drain first.
 *
 * `process.exit` while undici's fetch connection pool is still open asserts in
 * libuv on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 * file src\win\async.c, line 94`) and the process dies with 0xC0000409 instead
 * of the intended code. Every provider and remote call uses fetch, so this is
 * reachable from any error path after a request. Setting `exitCode` and letting
 * the loop empty is what the probe confirms is crash-free and immediate (the
 * undici pool does not keep the process alive). */
export function exitWith(code: number): void {
  process.exitCode = code;
}

/** Renders an error the way the CLI prints it: the message, then `Hint: ...`
 * when there is one. Used where an error becomes a log line rather than the
 * top-level exit, so a hint is not lost just because the failure was
 * quarantined. */
export function formatError(error: unknown): string {
  if (error instanceof CliError) {
    return error.hint ? `${error.message} Hint: ${error.hint}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // Keep the raw value when it does not parse.
    return url;
  }
}

/** A failed `fetch` as a message that names the host and the cause.
 * Node's own text is only `fetch failed`, which says neither. */
export function networkFailure(url: string, error: unknown): CliError {
  const code = (error as { cause?: { code?: string } }).cause?.code;
  return new CliError(
    "network_failed",
    `Could not reach ${hostOf(url)}${code ? `: ${code}` : "."}`,
    undefined,
    EXIT_RUNTIME,
  );
}

/** A response whose body stopped arriving, as a message that names the host
 * and the cause. The host was reached, so "Could not reach" would be wrong,
 * and Node's own text is only `terminated`, which says neither. */
export function connectionCut(url: string, error: unknown): CliError {
  const cause = (error as { cause?: { code?: string; message?: string } })
    .cause;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
  return new CliError(
    "connection_cut",
    `${hostOf(url)} closed the connection before the answer was complete${
      detail ? ` (${detail}).` : "."
    }`,
    "The request reached the provider and the answer was cut off. Run the command again.",
    EXIT_RUNTIME,
  );
}

/** Reads a response body. fetch rejects with a `TypeError` when the
 * connection closes mid-body; that becomes {@link connectionCut}. */
export async function readBody(
  url: string,
  response: Response,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (error instanceof TypeError) throw connectionCut(url, error);
    throw error;
  }
}
