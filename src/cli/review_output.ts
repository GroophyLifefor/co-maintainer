import { parseFindings } from "../pr/findings.ts";
import {
  DEFAULT_REVIEW_BLOCKING,
  isBlocking,
  type ReviewBlocking,
} from "../review/blocking.ts";
import { humanCopy } from "../services/review.ts";

export function reviewExitCode(
  markdown: string,
  mode: ReviewBlocking = DEFAULT_REVIEW_BLOCKING,
): number {
  const findings = parseFindings(markdown);
  const blocking = findings.some((f) =>
    isBlocking(mode, {
      severity: f.severity,
      blocked: f.blocking,
      text: f.heading,
    }),
  );
  return blocking ? 1 : 0;
}

export function printLocalReview(header: string, markdown: string): void {
  console.log(`\n${header}\n\n${humanCopy(markdown)}\n`);
}
