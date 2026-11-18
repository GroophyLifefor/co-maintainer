/** The numbers on the left menu, computed from the same sources as the pages
 * they sit next to: the repository count matches the home list, the failed
 * count is the open failures the home list, the overview and the failed
 * Activity list count too, and setup progress is the same four-step checklist the
 * home banner and /setup use. */
import { listActiveRepos } from "../store/repos.ts";
import { openFailures, openFailuresHref } from "./open_failures.ts";
import { readConfig } from "../config.ts";
import { setupChecklist } from "./setup_checklist.ts";
import { updateNotice, type UpdateNotice } from "./update_check.ts";

export type NavCounts = {
  repos: number;
  /** Open failures of the last 30 days, see `open_failures.ts`. */
  failed: number;
  /** The failed Activity list with the same window. */
  failedHref: string;
  /** "n/4", or "✓" once every required step is done. */
  setup: string;
  /** The newer version notice. Optional so a test source need not name it. */
  update?: UpdateNotice;
};

export function navCounts(webhookUrl: string): NavCounts {
  const now = Date.now();
  const steps = setupChecklist(readConfig().webhookUrl || webhookUrl);
  const done = steps.filter((step) => step.done).length;
  return {
    repos: listActiveRepos().length,
    failed: openFailures(undefined, now),
    failedHref: openFailuresHref(undefined, now),
    setup: done === steps.length ? "✓" : `${done}/${steps.length}`,
    update: updateNotice(),
  };
}
