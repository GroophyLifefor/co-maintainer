/** How a review decides a blocking finding (CORE-41, plan decision 2 option C).
 *
 * F19: the same pull request was reviewed twice, the same P2 finding came back
 * `non-blocking` the first time and `blocking` the second, and the exit code
 * changed because the model's own label moved. `model` keeps that behavior
 * (the model decides) because it is what 0.4.13 shipped; `severity` ignores
 * the model's label and uses a fixed threshold, so the same finding set always
 * yields the same exit code.
 *
 * This is the one place that answers "does this finding block". Every review
 * path — local, PR, remote and the GitHub App — calls it, so the modes cannot
 * drift apart.
 */

export type ReviewBlocking = "model" | "severity";

export const DEFAULT_REVIEW_BLOCKING: ReviewBlocking = "model";

/** Reads a config, flag or env value. Anything but `severity` is the default,
 * so an unset or mistyped value never silently tightens the rule. */
export function reviewBlockingFrom(value: unknown): ReviewBlocking {
  return value === "severity" ? "severity" : DEFAULT_REVIEW_BLOCKING;
}

/** One finding, in the shape any of the review paths happens to have. Only
 * `severity` is always available; the other two describe the model's own
 * claim, which `severity` mode ignores. */
export type BlockingInput = {
  severity?: string;
  /** The model's structured `blocking` field, when the answer was JSON. */
  blocked?: boolean;
  /** The heading or title text, when the answer came from Markdown. */
  text?: string;
};

/** The model's claim as written into a heading: `[P2 · non-blocking] …`. An
 * unrecognised heading says nothing, rather than guessing "not blocking". */
function claimFromText(text: string): boolean | undefined {
  if (/non-blocking\]/i.test(text)) return false;
  if (/·\s*blocking\]/i.test(text)) return true;
  return undefined;
}

/** Whether one finding blocks under the configured rule.

 * `model`: the model decides. A P0 always blocks even when the model labeled
 * it otherwise, which is the 0.4.13 rule and is kept so no existing review
 * changes its exit code.
 * `severity`: P0 and P1 block, P2 and P3 do not, whatever the model said. */
export function isBlocking(
  mode: ReviewBlocking,
  finding: BlockingInput,
): boolean {
  const severity = finding.severity?.toUpperCase();
  if (mode === "severity") {
    return severity === "P0" || severity === "P1";
  }
  if (severity === "P0") return true;
  if (finding.blocked === true) return true;
  return finding.text ? claimFromText(finding.text) === true : false;
}

/** The impact label a heading carries, kept in sync with the decision: a P1
 * the model called non-blocking reads `blocking` under `severity` mode. */
export function impactWord(
  mode: ReviewBlocking,
  finding: BlockingInput,
): "blocking" | "non-blocking" {
  return isBlocking(mode, finding) ? "blocking" : "non-blocking";
}
