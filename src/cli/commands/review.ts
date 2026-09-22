import { parseReviewArgs, type ReviewCliArgs } from "../review_args.ts";
import { setCliInteractive } from "../args.ts";
import { emptyAiMetrics, recordAiCost } from "../../services/setup.ts";
import { reviewPullRequest } from "../../pr/reviewer.ts";
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
import { printLocalReview, reviewExitCode } from "../review_output.ts";
import {
  buildPrReviewJson,
  resolvedFromFirstReview,
  reviewExitCodeFromResolved,
} from "../review_result.ts";
import { parseFindings } from "../../pr/findings.ts";
import { exitWith } from "../error.ts";

export async function runReviewFromCli(args: string[]): Promise<void> {
  const parsed = await parseReviewArgs(args);
  if (parsed.mode === "local") {
    await runLocalReview(parsed);
    return;
  }
  if (parsed.mode === "remote") {
    await runRemoteReview(parsed);
    return;
  }
  await runReviewPr(parsed.options, parsed);
}

export async function runReview(options: Options): Promise<void> {
  await runReviewPr(options, {
    json: false,
    disableCodegraph: false,
    allowToolInstall: false,
    remakeBeforeReview: false,
  });
}

async function runReviewPr(
  options: Options,
  cli: Pick<
    ReviewCliArgs,
    "json" | "disableCodegraph" | "allowToolInstall" | "remakeBeforeReview"
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
      const result = await timed(
        "review GitHub collection and AI",
        options.logTime,
        () =>
          reviewPullRequest(
            new GhClient(options.debug),
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
      const durationMs = Math.round(performance.now() - operationStarted);
      const usage = {
        tokensIn: aiMetrics.tokensIn,
        tokensOut: aiMetrics.tokensOut,
        costUsd: aiMetrics.costKnown ? aiMetrics.cost : null,
      };
      const codegraphState = options.useCodegraph ? "used" : "disabled";
      const findings = resolvedFromFirstReview(
        parseFindings(result.text),
        new Map(),
      );
      if (cli.json) {
        console.log(
          buildPrReviewJson({
            repo: options.repo,
            prNumber: options.prNumber!,
            markdown: result.text,
            guideBuiltAt: result.guideBuiltAt,
            codegraphState,
            codegraphReason: null,
            usage,
            durationMs,
          }),
        );
      } else {
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
          console.error(
            `[time] total review · ${((performance.now() - operationStarted) / 1000).toFixed(2)}s`,
          );
        }
      }
      exitWith(
        cli.json
          ? reviewExitCodeFromResolved(findings)
          : reviewExitCode(result.text),
      );
    } finally {
      // A heartbeat left running on the error path keeps the event loop alive
      // forever, so the process would never drain and the exit code would never
      // be applied. CORE-11.
      stopHeartbeat();
    }
  });
}
