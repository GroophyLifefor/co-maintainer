/** `PR_REVIEW_GUIDE.md` skipped: says why.
 *
 * The guide is built by the AI below three review signals `writeReviewDocuments`
 * deletes the file without a word, so a user on a small repository could not
 * tell why the third guide was missing. The fix is one log line naming the count
 * and the threshold; the threshold is unchanged.
 */
import { test } from "node:test";
import {
  createCliHarness,
  writeHarnessConfig,
} from "../testing/cli_harness.ts";
import { reviewSignalCount } from "../knowledge/guide.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import { testFact } from "../testing/helpers.ts";

test("reviewSignalCount counts review findings that carry an impact and an action", () => {
  const base = testFact("Rule.", "historical-example", "PR #2");
  const signals = [
    { ...base, sectionKey: "review", impact: "it regresses", action: "fix it" },
    { ...base, sectionKey: "review", claim: "No impact." },
    { ...base, sectionKey: "review-bar" },
    { ...base, sectionKey: "tests" },
  ];
  if (reviewSignalCount(signals) !== 1) {
    throw new Error(`signals: ${reviewSignalCount(signals)} (want 1)`);
  }
});

test("init with too few review signals says why the guide is missing", async () => {
  const harness = await createCliHarness();
  const server = await startFakeOpenRouter("success", {
    chatContent: (prompt) =>
      prompt.includes("JSON array")
        ? "[]"
        : "## Section\n\n- Follow the repository convention.\n",
  });
  try {
    await writeHarnessConfig(`${harness.home}/config/config.json`, {
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    });
    const result = await harness.run({
      args: ["init", "fixture/repo", "--include-pull-requests"],
      openrouterUrl: server.url,
      env: { CM_FAKE_AI: undefined, CM_FAKE_REVIEW_FILE: undefined },
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
    await server.close();
    await harness.cleanup();
  }
});
