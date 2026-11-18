/** The numbers on the left menu, computed from the same sources as the pages
 * they sit next to: the repository count matches the home list, the failed
 * count is the failures of the last 30 days nobody dismissed and no later
 * review resolved, and setup progress is the same four-step checklist the
 * home banner and /setup use. */
import { listActiveRepos } from "../store/repos.ts";
import { openFailureCount } from "../store/failures.ts";
import { readConfig } from "../config.ts";
import { daysAgoIso } from "../util/time.ts";
import { setupChecklist } from "./setup_checklist.ts";

export type NavCounts = {
  repos: number;
  /** Failed reviews in the last 30 days, the home list's "failed" window,
   * less the ones dismissed or resolved since. */
  failed: number;
  /** "n/4", or "✓" once every required step is done. */
  setup: string;
};

export function navCounts(webhookUrl: string): NavCounts {
  const since = daysAgoIso(30);
  const steps = setupChecklist(readConfig().webhookUrl || webhookUrl);
  const done = steps.filter((step) => step.done).length;
  return {
    repos: listActiveRepos().length,
    failed: openFailureCount(since),
    setup: done === steps.length ? "✓" : `${done}/${steps.length}`,
  };
}
