import { CliError, EXIT_USAGE } from "../cli/error.ts";
import type { LoadedGuides } from "./guides.ts";

export const NOT_INITIALIZED = "not_initialized";

/** A repository that was never initialized has no guides, and its review
 * cannot run. Local, pull request and remote review all stop with this one
 * error, so a script can branch on the code and the user reads the same hint
 * wherever they ran the command. `onHost` names the server when the guides
 * are missing there rather than on this machine. */
export function notInitializedError(repo: string, onHost?: string): CliError {
  return new CliError(
    NOT_INITIALIZED,
    `Review guides are missing for ${repo}${onHost ? ` on ${onHost}` : ""}.`,
    `co-maintainer init ${repo}`,
    EXIT_USAGE,
  );
}

/** Stops before any work when neither the short guide nor the skill exists.
 * Those are the two files a review prompt can be built from. */
export function assertGuides(
  repo: string,
  guides: Pick<LoadedGuides, "shortGuide" | "skill">,
): void {
  if (!guides.shortGuide && !guides.skill) throw notInitializedError(repo);
}
