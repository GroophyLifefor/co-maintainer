/** `PR_REVIEW_GUIDE.md` skipped: says why (CORE-31 / F05).
 *
 * F05: `buildReviewDocuments` returned `undefined` below three review signals
 * and `writeReviewDocuments` deleted the file without a word, so a user on a
 * small repository could not tell why the third guide was missing. The fix is
 * one log line naming the count and the threshold; the threshold is unchanged.
 */
import { test } from "node:test";
import {
  createCliHarness,
  writeHarnessConfig,
} from "../testing/cli_harness.ts";
import { reviewSignalCount } from "../knowledge/guide.ts";
import { testFact } from "../testing/helpers.ts";

test("reviewSignalCount counts only PR-derived review-bar facts", () => {
  const facts = [
    testFact("Include tests.", "current", "review discussion (2 mentions)"),
    testFact("Keep it focused.", "historical-example", "PR #2"),
    // A `review-bar` fact with non-PR evidence must not count.
    testFact("Follow the template.", "current", "CONTRIBUTING.md"),
    // A non-`review-bar` fact must not count either.
    testFact("Use tabs.", "current", "PR #9"),
  ].map((item, index) =>
    // `testFact` always uses the `tests` section; the review signals live in
    // `review-bar`, so the first, second and fourth entries move there.
    index === 3 ? item : { ...item, sectionKey: "review-bar" },
  );
  if (reviewSignalCount(facts) !== 2) {
    throw new Error(`signals: ${reviewSignalCount(facts)} (want 2)`);
  }
});

test("init with too few review signals says why the guide is missing", async () => {
  const harness = await createCliHarness();
  try {
    await writeHarnessConfig(`${harness.home}/config/config.json`, {
      auth: "gh",
      ai: "none",
    });
    const result = await harness.run({
      args: ["init", "fixture/repo", "--include-pull-requests"],
    });
    const output = `${result.stdout}${result.stderr}`;
    if (result.code !== 0) {
      throw new Error(`init exited ${result.code}:\n${output}`);
    }
    const want =
      /\[write\] PR_REVIEW_GUIDE\.md skipped: found \d+ review signals, needs at least 3/;
    if (!want.test(output)) {
      throw new Error(`no skip reason in the output:\n${output}`);
    }
  } finally {
    await harness.cleanup();
  }
});
