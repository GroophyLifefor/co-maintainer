/** A maintainer closes a finding (accepted risk, will not fix) or opens it
 * again, from the dashboard or with `/co-maintainer dismiss` in the finding's
 * thread. The owner has the last word: the model does not have to agree.
 *
 * Closing the last blocking finding approves the commit the review read, the
 * same step a withdrawal in a reply takes. */
import { getFinding, setFindingDismissed } from "../store/findings.ts";
import { getReview } from "../store/reviews.ts";
import { audit } from "./audit.ts";
import {
  approveAfterWithdrawal,
  clientFor,
  resolveInstallationId,
} from "./review.ts";
import { redact } from "../util/redact.ts";
import type { GitHubClient } from "../types.ts";

export type FindingAction = {
  findingId: string;
  close: boolean;
  /** Why, kept in the audit log. */
  reason?: string;
  /** Who did it, in the approval text: a GitHub login, or plain words. */
  by: string;
  /** Who the audit log names. Unset: the dashboard request's user. */
  auditActor?: string;
  /** Set when the caller already holds a client, as a webhook job does. */
  client?: GitHubClient;
  log?: (level: string, message: string) => void;
};

export type FindingActionResult =
  | { ok: true; changed: number; approved: boolean }
  | { ok: false; reason: string };

export async function setFindingClosed(
  action: FindingAction,
): Promise<FindingActionResult> {
  const finding = getFinding(action.findingId);
  if (!finding) return { ok: false, reason: "No finding with that id." };
  const review = getReview(finding.review_id);
  if (!review) return { ok: false, reason: "The finding's review is gone." };
  const changed = setFindingDismissed(finding.id, action.close);
  if (changed === 0) {
    return {
      ok: false,
      reason: action.close
        ? "The finding is already closed."
        : "Only a finding someone closed or the bot withdrew can be opened again.",
    };
  }
  audit(
    "dismiss",
    action.close ? "Closed a finding" : "Opened a finding again",
    {
      target: `${review.repo}${review.pr_number ? `#${review.pr_number}` : ""}`,
      ...(action.auditActor ? { actor: action.auditActor } : {}),
      changes: [
        {
          setting: finding.title.slice(0, 120),
          from: action.close ? "open" : "closed",
          to: action.close
            ? `closed${action.reason ? `: ${action.reason.slice(0, 200)}` : ""}`
            : "open",
        },
      ],
    },
  );
  let approved = false;
  if (action.close && review.kind === "pr" && review.pr_number !== null) {
    const log = action.log ?? (() => {});
    try {
      let client = action.client;
      if (!client) {
        const installation = await resolveInstallationId(review.repo);
        // No App on this repository: nothing to approve with.
        if (installation === undefined) return { ok: true, changed, approved };
        client = clientFor(installation);
      }
      approved =
        (await approveAfterWithdrawal(
          client,
          review.repo,
          review.pr_number,
          finding.path,
          log,
          action.by,
        )) === "approved";
    } catch (error) {
      log("warn", `could not approve after closing: ${redact(String(error))}`);
    }
  }
  return { ok: true, changed, approved };
}
