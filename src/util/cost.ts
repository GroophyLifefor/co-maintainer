/** What an AI run cost, and how sure we are. A missing cost is never `$0`:
 * `known` includes a real zero (a free model), `unknown` carries a reason.
 * The reason texts live here so the CLI, the JSON and the dashboard say the
 * same thing. */

export type CostReason =
  | "provider_did_not_report"
  | "partial"
  | "recorded_before_0_5_1"
  | "not_recorded";

export type CostStatus = "known" | "unknown";
export type BilledTo = "server" | "byok";

export type CostOutcome =
  | { status: "known"; usd: number }
  | { status: "unknown"; reason: CostReason };

/** How many AI calls reported a cost and how many did not. */
export type CostCalls = { known: number; unknown: number };

export type CostTally = {
  cost: number;
  knownCalls: number;
  unknownCalls: number;
};

export function emptyTally(): CostTally {
  return { cost: 0, knownCalls: 0, unknownCalls: 0 };
}

/** A response merged from several calls carries its own `costCalls`. A plain
 * response is one call. */
export function addResponseCost(
  tally: CostTally,
  response: { cost?: number; costCalls?: CostCalls },
): void {
  const calls =
    response.costCalls ??
    (response.cost === undefined
      ? { known: 0, unknown: 1 }
      : { known: 1, unknown: 0 });
  tally.knownCalls += calls.known;
  tally.unknownCalls += calls.unknown;
  tally.cost += response.cost ?? 0;
}

/** Every call reported: known. None did: the provider does not report. Some
 * did: partial, and the known part is dropped so a total never looks
 * complete. No call at all: the run ended before a cost was recorded. */
export function settle(tally: CostTally): CostOutcome {
  if (tally.knownCalls === 0 && tally.unknownCalls === 0) {
    return { status: "unknown", reason: "not_recorded" };
  }
  if (tally.unknownCalls === 0) return { status: "known", usd: tally.cost };
  return {
    status: "unknown",
    reason: tally.knownCalls === 0 ? "provider_did_not_report" : "partial",
  };
}

const REASON_TEXT: Record<CostReason, string> = {
  provider_did_not_report:
    "The provider did not report the cost for this review.",
  partial: "Some AI calls in this review did not report a cost.",
  recorded_before_0_5_1: "Recorded before 0.5.1, the cost was not saved.",
  not_recorded: "The review ended before its cost was recorded.",
};

/** `provider` names the service in the first sentence, as in "OpenAI did not
 * report the cost for this review." */
export function costReasonText(reason: CostReason, provider?: string): string {
  if (reason === "provider_did_not_report" && provider) {
    return `${provider} did not report the cost for this review.`;
  }
  return REASON_TEXT[reason];
}

/** The cost part of a review JSON `usage` object. `costUsd` stays `null`
 * when the cost is unknown, as it always did. */
export function costUsage(tally: CostTally): {
  costUsd: number | null;
  costStatus: CostStatus;
  costNote: CostReason | null;
  billedTo: BilledTo;
} {
  const outcome = settle(tally);
  return outcome.status === "known"
    ? {
        costUsd: outcome.usd,
        costStatus: "known",
        costNote: null,
        billedTo: "server",
      }
    : {
        costUsd: null,
        costStatus: "unknown",
        costNote: outcome.reason,
        billedTo: "server",
      };
}

/** The columns `setReviewStatus` writes for a finished review. */
export function costColumns(outcome: CostOutcome): {
  cost: number | undefined;
  cost_status: CostStatus;
  cost_note: CostReason | null;
} {
  return outcome.status === "known"
    ? { cost: outcome.usd, cost_status: "known", cost_note: null }
    : { cost: undefined, cost_status: "unknown", cost_note: outcome.reason };
}
