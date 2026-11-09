import { clientFor, runInitOrRemake } from "../../services/setup.ts";
import { probePlan } from "../../services/probe.ts";
import { log, startHeartbeat, withCliLogsToStderr } from "../../util/log.ts";
import {
  estimateCostLine,
  estimateInit,
  readJobHistory,
} from "../../ai/estimate.ts";
import { loadPrices } from "../../ai/pricing.ts";
import { cacheSet } from "../../store/cache_db.ts";
import { buildProbeJson } from "../command_json.ts";
import { appPushStateWithoutDb } from "../../services/watch_status.ts";
import type { GitHubClient, Json, Options } from "../../types.ts";

export async function runProbe(options: Options): Promise<void> {
  // With `--json` stdout carries the one document, so progress moves to stderr.
  if (options.json) await withCliLogsToStderr(() => probe(options));
  else await probe(options);
}

async function probe(options: Options): Promise<void> {
  const operationStarted = performance.now();
  const stopHeartbeat = startHeartbeat("probing repository");
  const client = clientFor(options);
  log("probe", `reading ${options.repo} via ${options.auth}`);
  const plan = await probePlan(client, options.repo, {
    ghConcurrent: options.ghConcurrent,
    logTime: options.logTime,
    log: (message) => log("probe", message),
  });
  const analysis = plan.analysis;
  const command = plan.command;
  await cacheSet("probe", options.repo, JSON.stringify(plan.report));

  // The estimate is separate from the recommendation: the flags say what to
  // read, this says what that costs in time and dollars. Prices are
  // only fetched when an OpenRouter model would actually be billed, so a
  // plain `--ai=none` probe makes no network call.
  const needsPrices =
    options.ai === "openrouter" &&
    Boolean(options.lowModel && options.highModel);
  const [prices, history] = await Promise.all([
    needsPrices
      ? loadPrices()
      : Promise.resolve({ prices: new Map(), source: "unavailable" as const }),
    readJobHistory(options.repo),
  ]);
  const estimate = estimateInit({
    pullRequests: analysis.includePullRequests
      ? Number(analysis.report.pullRequests ?? 0)
      : 0,
    includeCodebase: analysis.includePullRequests,
    lowModel: options.lowModel,
    highModel: options.highModel,
    prices: prices.prices,
    history,
  });
  const costLine = estimateCostLine(
    estimate,
    options.ai,
    needsPrices && prices.source === "unavailable",
  );
  const commitWatch = await commitWatchState(client, options.repo);
  if (options.json) {
    stopHeartbeat();
    console.log(
      buildProbeJson({
        repo: options.repo,
        recommended: command,
        research: {
          pullRequests: Number(analysis.report.pullRequests ?? 0),
          sampledPullRequests: Number(analysis.report.sampledPullRequests ?? 0),
          commits: Number(analysis.report.commits ?? 0),
          usefulCommits: Number(analysis.report.usefulCommits ?? 0),
          maxPrMonths: analysis.maxPrMonths ?? null,
          maxCommits: analysis.maxCommits ?? null,
          maxPullRequestChangeLines: analysis.maxPullRequestChangeLines ?? null,
          reasons: analysis.reasons,
        },
        estimate,
        costNote: costLine,
        durationMs: Math.round(performance.now() - operationStarted),
        commitWatch,
      }),
    );
    return;
  }
  console.log(`\nrecommended\n  ${command}`);
  console.log("\nresearch");
  console.log(
    `  PRs: ${analysis.report.pullRequests} · sampled: ${analysis.report.sampledPullRequests}`,
  );
  console.log(
    `  commits: ${analysis.report.commits} · useful: ${analysis.report.usefulCommits}`,
  );
  console.log(
    `  windows: PR months=${analysis.maxPrMonths ?? "all"} · commits=${
      analysis.maxCommits ?? "all"
    } · diff lines=${analysis.maxPullRequestChangeLines ?? "all"}`,
  );
  for (const reason of analysis.reasons) console.log(`  - ${reason}`);
  console.log("\nestimate");
  console.log(
    `  AI jobs: ${estimate.extract} extract + ${estimate.synth} synth`,
  );
  console.log(
    `  tokens: ${range(estimate.tokensIn)} in · ${range(estimate.tokensOut)} out`,
  );
  console.log(`  time: ${secondsRange(estimate.seconds)}s`);
  console.log(`  cost: ${costLine}`);
  console.log(
    `  basis: ${
      estimate.basis === "history"
        ? "this repository's recorded jobs"
        : "the cm-dx-lab calibration"
    }; an estimate, not a bill`,
  );
  if (commitWatch) {
    console.log(
      `\ncommit watch   ${
        commitWatch.app === "on"
          ? "✓ App (push event on)"
          : "○ App (push event off)"
      }   ${commitWatch.branch ?? ""}`.trimEnd(),
    );
  }
  console.log("\nnext");
  console.log(`  ${command}`);
  console.log(`  or run it now: co-maintainer probe ${options.repo} --run`);
  console.log("  Probe only reads. It does not write guides.");
  if (options.logTime) {
    console.log(
      `  total time: ${((performance.now() - operationStarted) / 1000).toFixed(2)}s`,
    );
  }
  stopHeartbeat();

  if (options.run) {
    // Same process, no re-spawn: the dashboard learned that lesson already
    // (the second path had its own failure modes). `init` inherits the
    // recommended flags, which is exactly the command printed above.
    options.command = "init";
    await runInitOrRemake(options);
  }
}

/** Commit watch through the App, when this machine has the App configured.
 * Without it there is nothing to say and the line is left out. */
async function commitWatchState(
  client: GitHubClient,
  repo: string,
): Promise<{ app: "on" | "off"; branch: string | null } | undefined> {
  const app = await appPushStateWithoutDb(repo);
  if (!app) return undefined;
  let branch: string | null = null;
  try {
    const info = await client.request<Json>(`repos/${repo}`);
    branch =
      typeof info.default_branch === "string" ? info.default_branch : null;
  } catch {
    // The line still says whether the App watches.
  }
  return { app, branch };
}

/** `120-190` for a token range, rounded to whole tokens. */
function range([low, high]: [number, number]): string {
  const round = (value: number) => Math.round(value).toLocaleString("en-US");
  return `${round(low)}-${round(high)}`;
}

/** `8-14` for a seconds range, rounded to whole seconds. */
function secondsRange([low, high]: [number, number]): string {
  return `${Math.round(low)}-${Math.round(high)}`;
}
