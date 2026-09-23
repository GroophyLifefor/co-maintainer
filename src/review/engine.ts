/** Review prompt, tool loop, and improvement passes — PR adapter calls this
 * after building a `Revision` and carry-over input. */
import type { GitHubClient, Options } from "../types.ts";
import type { Snapshot } from "../pr/snapshot.ts";
import type { AiProvider, AiResponse } from "../types.ts";
import { type ReviewExtras, reviewPullRequest } from "../pr/reviewer.ts";

type UsageSink = (response: AiResponse) => Promise<void>;
type ProgressSink = (message: string) => void;

export async function runReviewEngine(
  client: GitHubClient,
  options: Options,
  usage?: UsageSink,
  snapshot?: Snapshot,
  ai?: AiProvider,
  progress?: ProgressSink,
  extras?: ReviewExtras,
): Promise<
  AiResponse & {
    visiblePaths: string[];
    guideBuiltAt: string | null;
    codegraphState: "used" | "disabled" | "unavailable";
  }
> {
  return reviewPullRequest(
    client,
    options,
    usage,
    snapshot,
    ai,
    progress,
    extras,
  );
}
