import { parseFindings } from "../pr/findings.ts";
import { humanCopy } from "../services/review.ts";

export function reviewExitCode(markdown: string): number {
  const findings = parseFindings(markdown);
  const blocking = findings.some((f) =>
    f.blocking === true || /\[P0\b/i.test(f.heading)
  );
  return blocking ? 1 : 0;
}

export function printLocalReview(
  header: string,
  markdown: string,
): void {
  console.log(`\n${header}\n\n${humanCopy(markdown)}\n`);
}
