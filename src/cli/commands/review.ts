import { parseReviewArgs } from "../review_args.ts";
import { emptyAiMetrics, recordAiCost } from "../../services/setup.ts";
import { reviewPullRequest } from "../../pr/reviewer.ts";
import { GhClient } from "../../github/gh.ts";
import { log, startHeartbeat, timed } from "../../util/log.ts";
import type { Options } from "../../types.ts";
import { runLocalReview } from "../../local/review_local.ts";
import { printLocalReview, reviewExitCode } from "../review_output.ts";

export async function runReviewFromCli(args: string[]): Promise<void> {
  const parsed = parseReviewArgs(args);
  if (parsed.mode === "local") {
    await runLocalReview(parsed);
    return;
  }
  await runReviewPr(parsed.options);
}

export async function runReview(options: Options): Promise<void> {
  await runReviewPr(options);
}

async function runReviewPr(options: Options): Promise<void> {
  const operationStarted = performance.now();
  const aiMetrics = emptyAiMetrics();
  const stopHeartbeat = startHeartbeat("reviewing pull request");
  if (options.auth !== "gh") {
    throw new Error("review supports gh authentication only");
  }
  log("review", `reading PR #${options.prNumber} in ${options.repo} via gh`);
  const result = await timed(
    "review GitHub collection and AI",
    options.logTime,
    () =>
      reviewPullRequest(
        new GhClient(),
        options,
        async (response) => {
          aiMetrics.calls++;
          aiMetrics.tokensIn += response.tokensIn;
          aiMetrics.tokensOut += response.tokensOut;
          if (response.cost === undefined) aiMetrics.costKnown = false;
          else aiMetrics.cost += response.cost;
          await recordAiCost(options.repo, "review_pull_request", response);
        },
      ),
  );
  printLocalReview(
    `co-maintainer review · ${options.repo} · PR #${options.prNumber}`,
    result.text,
  );
  if (options.logTime) {
    log(
      "time",
      `AI total · calls=${aiMetrics.calls} · input=${aiMetrics.tokensIn} tokens · output=${aiMetrics.tokensOut} tokens · cost=${
        aiMetrics.costKnown ? aiMetrics.cost.toFixed(4) : "unknown"
      }`,
    );
    console.log(
      `[time] total review · ${
        ((performance.now() - operationStarted) / 1000).toFixed(2)
      }s`,
    );
  }
  stopHeartbeat();
  Deno.exit(reviewExitCode(result.text));
}
