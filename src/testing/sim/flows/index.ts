/** Every flow `e2e:simulate` runs, in order. A new flow is one file in this
 * directory and one line here. */
import type { Flow } from "../flow.ts";

export const FLOWS: Flow[] = [
  (await import("./init.ts")).default,
  // One line per flow, above this comment.
];
