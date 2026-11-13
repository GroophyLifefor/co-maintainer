import { CliError, EXIT_USAGE } from "../cli/error.ts";
import type { LoadedGuides } from "./guides.ts";

export const NOT_INITIALIZED = "not_initialized";

/** A repository that was never initialized has no guides, and its review
 * cannot run. Local, pull request and remote review all stop with this one
 * code and exit code, so a script can branch on them. `onHost` names the
 * server when the guides are missing there. The guides of a remote review live
 * on that server, so the hint says where to run `init`: run on this machine it
 * would build local guides and change nothing for the remote review. */
export function notInitializedError(repo: string, onHost?: string): CliError {
  return new CliError(
    NOT_INITIALIZED,
    `Review guides are missing for ${repo}${onHost ? ` on ${onHost}` : ""}.`,
    onHost
      ? `Run co-maintainer init ${repo} on the server at ${onHost}.`
      : `co-maintainer init ${repo}`,
    EXIT_USAGE,
  );
}

/** True when the short guide or the skill exists. Those are the two files a
 * review prompt can be built from. */
export function hasGuides(
  guides: Pick<LoadedGuides, "shortGuide" | "skill">,
): boolean {
  return Boolean(guides.shortGuide || guides.skill);
}

/** Stops before any work when the repository has no guides. */
export function assertGuides(
  repo: string,
  guides: Pick<LoadedGuides, "shortGuide" | "skill">,
): void {
  if (!hasGuides(guides)) throw notInitializedError(repo);
}
