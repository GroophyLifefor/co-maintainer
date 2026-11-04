/** The numbers on the left menu, computed from the same sources as the pages
 * they sit next to: the repository count and the 30 day failed reviews match
 * the home list, and setup progress is the same four-step checklist the home
 * banner and /setup use. */
import { listActiveRepos } from "../store/repos.ts";
import { reviewStats } from "../store/reviews.ts";
import { readConfig } from "../config.ts";
import { daysAgoIso } from "../util/time.ts";
import { setupChecklist } from "./setup_checklist.ts";

export type NavCounts = {
  repos: number;
  /** Failed reviews in the last 30 days, the home list's "failed" window. */
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
    failed: reviewStats(since).failed,
    setup: done === steps.length ? "✓" : `${done}/${steps.length}`,
  };
}
