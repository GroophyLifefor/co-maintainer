/** One error shape for every CLI failure (CORE-10).
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
 * undici pool does not keep the process alive). CORE-11. */
export function exitWith(code: number): void {
  process.exitCode = code;
}
