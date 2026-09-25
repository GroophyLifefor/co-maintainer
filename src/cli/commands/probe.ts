import { clientFor, runInitOrRemake } from "../../services/setup.ts";
import { probePlan } from "../../services/probe.ts";
import { log, startHeartbeat } from "../../util/log.ts";
import { estimateInit, readJobHistory } from "../../ai/estimate.ts";
import { loadPrices } from "../../ai/pricing.ts";
import { cacheSet } from "../../store/cache_db.ts";
import type { Options } from "../../types.ts";

export async function runProbe(options: Options): Promise<void> {
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

  // The estimate is separate from the recommendation: the flags say what to
  // read, this says what that costs in time and dollars (CORE-24). Prices are
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
  console.log("\nestimate");
  console.log(
    `  AI jobs: ${estimate.extract} extract + ${estimate.synth} synth`,
  );
  console.log(
    `  tokens: ${range(estimate.tokensIn)} in · ${range(estimate.tokensOut)} out`,
  );
  console.log(`  time: ${secondsRange(estimate.seconds)}s`);
  if (estimate.usd) {
    console.log(
      `  cost: $${estimate.usd[0].toFixed(4)}-$${estimate.usd[1].toFixed(4)}`,
    );
  } else if (needsPrices && prices.source === "unavailable") {
    console.log("  cost: unknown (could not read OpenRouter prices)");
  } else {
    console.log(
      "  cost: set --ai=openrouter with both models to estimate dollars",
    );
  }
  console.log(
    `  basis: ${
      estimate.basis === "history"
        ? "this repository's recorded jobs"
        : "the cm-dx-lab calibration"
    }; an estimate, not a bill`,
  );
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

/** `120-190` for a token range, rounded to whole tokens. */
function range([low, high]: [number, number]): string {
  const round = (value: number) => Math.round(value).toLocaleString("en-US");
  return `${round(low)}-${round(high)}`;
}

/** `8-14` for a seconds range, rounded to whole seconds. */
function secondsRange([low, high]: [number, number]): string {
  return `${Math.round(low)}-${Math.round(high)}`;
}
