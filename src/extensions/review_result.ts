/** `cm-review.json`: the AI review's findings, for the extensions that run
 * after it. The same finding shape `review --json` prints, so an extension
 * reads one format whatever the review type. It holds what the AI answered
 * this round. Carry-over states are worked out after the extensions finish. */
import { parseFindings } from "../pr/findings.ts";
import {
  resolvedFromFirstReview,
  sortResolvedFindings,
  summaryCounts,
  toJsonFinding,
} from "../cli/review_result.ts";
import type { ReviewBlocking } from "../review/blocking.ts";

export function reviewResultJson(
  reviewText: string,
  mode?: ReviewBlocking,
): unknown {
  const findings = sortResolvedFindings(
    resolvedFromFirstReview(parseFindings(reviewText), new Map()),
  );
  return {
    schemaVersion: 1,
    summary: summaryCounts(findings, mode),
    findings: findings.map((row) => toJsonFinding(row, mode)),
  };
}
