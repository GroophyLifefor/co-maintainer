/** Ctrl-C for a CLI run that must stop its model calls.
 *
 * A local review arms this while it runs. On SIGINT or SIGTERM it aborts the
 * signal, and every AI provider passes the signal to `fetch`: the call in
 * flight stops at once and no new call is sent. The alternative,
 * `process.exit`, asserts in libuv on Windows while a fetch is open (see
 * `exitWith`). When nothing is armed, as in `serve`, the signal is
 * `undefined` and requests run exactly as before. */
import { setMaxListeners } from "node:events";

let controller: AbortController | undefined;

/** Starts a run that Ctrl-C can stop. Returns the controller to abort. */
export function armInterrupt(): AbortController {
  controller = new AbortController();
  // A sync before the review runs many calls at once, each one listening.
  setMaxListeners(0, controller.signal);
  return controller;
}

export function disarmInterrupt(): void {
  controller = undefined;
}

/** The signal every AI request carries, or `undefined` when no run is armed. */
export function interruptSignal(): AbortSignal | undefined {
  return controller?.signal;
}

export function interrupted(): boolean {
  return controller?.signal.aborted === true;
}
