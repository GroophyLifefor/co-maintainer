import { parseReviewArgs, type ReviewCliArgs } from "../review_args.ts";
import { setCliInteractive } from "../args.ts";
import {
  addAiMetrics,
  emptyAiMetrics,
  recordAiCost,
} from "../../services/setup.ts";
import { costUsage } from "../../util/cost.ts";
import { costLabel } from "../../util/run_summary.ts";
import { modelSummary, reviewPullRequest } from "../../pr/reviewer.ts";
import { GhClient } from "../../github/gh.ts";
import {
  log,
  startHeartbeat,
  timed,
  withCliLogsToStderr,
} from "../../util/log.ts";
import type { Options } from "../../types.ts";
import { runLocalReview } from "../../local/review_local.ts";
import { runRemoteReview } from "../../remote/client.ts";
import { runRemotePushReview } from "../../remote/push_client.ts";
import { reviewExitCode } from "../review_output.ts";
import {
  buildPrReviewJson,
  reviewExitCodeFromResolved,
} from "../review_result.ts";
import { startPrCarry } from "../pr_carry.ts";
import { exitWith } from "../error.ts";
import { printRunSummary, summaryFromMetrics } from "../../util/run_summary.ts";
import { emitGithubOutput } from "../review_github.ts";
import {
  formatHumanReview,
  humanFindingsFromResolved,
} from "../review_result.ts";
import { withExtensions } from "../../extensions/session.ts";
import { cliPrContext } from "../../extensions/contexts.ts";
import { reviewResultJson } from "../../extensions/review_result.ts";
import { exitCodeWithExtensions } from "../../extensions/report.ts";
import { runSummaryWithExtensions } from "../../extensions/render_json.ts";

export async function runReviewFromCli(args: string[]): Promise<void> {
  const parsed = await parseReviewArgs(args);
  if (parsed.mode === "local") {
    await runLocalReview(parsed);
    return;
  }
  if (parsed.mode === "remote") {
    if (parsed.range) await runRemotePushReview(parsed);
    else await runRemoteReview(parsed);
    return;
  }
  await runReviewPr(parsed.options, parsed);
}

export async function runReview(options: Options): Promise<void> {
  await runReviewPr(options, {
    json: false,
    output: undefined,
    disableCodegraph: false,
    allowToolInstall: false,
    remakeBeforeReview: false,
    fresh: false,
    includeExtensionMarkdowns: false,
  });
}

async function runReviewPr(
  options: Options,
  cli: Pick<
    ReviewCliArgs,
    | "json"
    | "disableCodegraph"
    | "allowToolInstall"
    | "remakeBeforeReview"
    | "output"
    | "fresh"
    | "includeExtensionMarkdowns"
  >,
): Promise<void> {
  setCliInteractive(!cli.json);
  await withCliLogsToStderr(async () => {
    const operationStarted = performance.now();
    const aiMetrics = emptyAiMetrics();
    const stopHeartbeat = startHeartbeat("reviewing pull request");
    try {
      if (options.auth !== "gh") {
        throw new Error("review supports gh authentication only");
      }
      log(
        "review",
        `reading PR #${options.prNumber} in ${options.repo} via gh`,
      );
      log("review", modelSummary(options));
      const client = new GhClient(options.debug);
      const carry = await startPrCarry(client, options, cli.fresh, (message) =>
        log("review", message),
      );
      const { review: result, extensions } = await withExtensions(
        cliPrContext({
          client,
          repo: options.repo,
          prNumber: options.prNumber!,
          prefetched: carry.extras.prefetched,
        }),
        () =>
          timed("review GitHub collection and AI", options.logTime, () =>
            reviewPullRequest(
              client,
              options,
              async (response) => {
                addAiMetrics(aiMetrics, response);
                await recordAiCost(
                  options.repo,
                  "review_pull_request",
                  response,
                );
              },
              undefined,
              undefined,
              undefined,
              // The stored run leaves out what it saw, so the next run sends
              // the files this one dropped.
              { ...carry.extras, catchesUp: true },
            ),
          ),
        (review) => reviewResultJson(review.text, options.reviewBlocking),
      );
      const durationMs = Math.round(performance.now() - operationStarted);
      const usage = {
        tokensIn: aiMetrics.tokensIn,
        tokensOut: aiMetrics.tokensOut,
        ...costUsage(aiMetrics),
      };
      // The engine reports the codegraph state it actually reached, instead of
      // the old `useCodegraph ? "used" : "disabled"` that claimed "used" while
      // stderr said codegraph was missing.
      const codegraphState = result.codegraphState;
      const resolved = await carry.finish(result);
      const warnings = [...carry.warnings, ...result.warnings];
      if (cli.json) {
        console.log(
          buildPrReviewJson({
            repo: options.repo,
            prNumber: options.prNumber!,
            markdown: result.text,
            findings: resolved,
            warnings,
            guideBuiltAt: result.guideBuiltAt,
            codegraphState,
            codegraphReason: null,
            usage,
            durationMs,
            reviewBlocking: options.reviewBlocking,
            diffStats: result.diffStats,
            coverage: result.coverage,
            extensions,
            includeExtensionMarkdowns: cli.includeExtensionMarkdowns,
          }),
        );
      } else if (cli.output === "github") {
        emitGithubOutput({
          title: `${options.repo} · PR #${options.prNumber}`,
          findings: humanFindingsFromResolved(resolved, options.reviewBlocking),
          run: runSummaryWithExtensions(
            summaryFromMetrics(aiMetrics, performance.now() - operationStarted),
            extensions,
          ),
          coverage: result.coverage,
          catchesUp: true,
          extensions,
        });
      } else {
        // One presentation layer for local, PR and remote reviews.
        console.log(
          "\n" +
            formatHumanReview({
              title: `co-maintainer review · ${options.repo} · PR #${options.prNumber}`,
              guideBuiltAt: result.guideBuiltAt,
              codegraphState,
              findings: humanFindingsFromResolved(
                resolved,
                options.reviewBlocking,
              ),
              warnings,
              coverage: result.coverage,
              extensions,
            }) +
            "\n",
        );
        printRunSummary(
          runSummaryWithExtensions(
            summaryFromMetrics(aiMetrics, performance.now() - operationStarted),
            extensions,
          ),
        );
        if (options.logTime) {
          log(
            "time",
            `AI total · calls=${aiMetrics.calls} · input=${aiMetrics.tokensIn} tokens · output=${aiMetrics.tokensOut} tokens · cost=${costLabel(
              aiMetrics,
            )}`,
          );
          console.error(
            `[time] total review · ${((performance.now() - operationStarted) / 1000).toFixed(2)}s`,
          );
        }
      }
      // A blocking finding carried over from an earlier run still blocks, so
      // the resolved rows decide as well as the model's own text.
      exitWith(
        exitCodeWithExtensions(
          cli.json
            ? reviewExitCodeFromResolved(resolved, options.reviewBlocking)
            : Math.max(
                reviewExitCode(result.text, options.reviewBlocking),
                reviewExitCodeFromResolved(resolved, options.reviewBlocking),
              ),
          extensions,
        ),
      );
    } finally {
      // A heartbeat left running on the error path keeps the event loop alive
      // forever, so the process would never drain and the exit code would never
      // be applied.
      stopHeartbeat();
    }
  });
}
