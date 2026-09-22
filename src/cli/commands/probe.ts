import { clientFor, runInitOrRemake } from "../../services/setup.ts";
import { analyzeProbe } from "../../knowledge/probe.ts";
import { cacheSet } from "../../store/cache_db.ts";
import { estimateInit, readJobHistory } from "../../ai/estimate.ts";
import { loadPrices } from "../../ai/pricing.ts";
import { detectRemoteRepo } from "../../local/git_ops.ts";
import { log, startHeartbeat, timed } from "../../util/log.ts";
import type { Json, Options } from "../../types.ts";

export async function runProbe(options: Options): Promise<void> {
  const operationStarted = performance.now();
  const stopHeartbeat = startHeartbeat("probing repository");
  const client = clientFor(options);
  log("probe", `reading ${options.repo} via ${options.auth}`);
  const meta = await timed("probe repository metadata", options.logTime, () =>
    client.request<Json>(`repos/${options.repo}`),
  );
  let latestReleaseAt = "";
  log("probe", "reading release metadata");
  try {
    const releases = await timed(
      "probe release metadata",
      options.logTime,
      () => client.pages<Json>(`repos/${options.repo}/releases?per_page=1`, 1),
    );
    latestReleaseAt = String(
      releases[0]?.published_at ?? releases[0]?.created_at ?? "",
    );
  } catch {
    // Release metadata is an optional probe signal.
  }
  log("probe", "reading pull request list");
  const pulls = await timed("probe pull request listing", options.logTime, () =>
    client.pages<Json>(
      `repos/${options.repo}/pulls?state=all&sort=updated&direction=desc`,
      undefined,
      (page, fetched) =>
        log(
          "probe",
          `pull request listing · page ${page} · fetched ${fetched} · total unknown`,
        ),
    ),
  );
  const yearBuckets = new Map<number, Json[]>();
  for (const pull of pulls) {
    const year = new Date(String(pull.updated_at)).getFullYear();
    yearBuckets.set(year, [...(yearBuckets.get(year) ?? []), pull]);
  }
  const sampleTargets = new Map<number, Json>();
  for (const pull of pulls.slice(0, 30)) {
    sampleTargets.set(Number(pull.number), pull);
  }
  for (const yearPulls of yearBuckets.values()) {
    for (const pull of yearPulls.slice(0, 3)) {
      sampleTargets.set(Number(pull.number), pull);
    }
  }
  const samplePulls = [...sampleTargets.values()];
  const detailSamples: Json[] = [];
  log(
    "probe",
    `sampling ${samplePulls.length} pull request details · concurrency=${options.ghConcurrent}`,
  );
  await timed("probe PR detail sampling", options.logTime, async () => {
    const details: (Json | undefined)[] = new Array(samplePulls.length);
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < samplePulls.length) {
        const index = cursor++;
        const pull = samplePulls[index];
        try {
          details[index] = await client.request<Json>(
            `repos/${options.repo}/pulls/${Number(pull.number)}`,
          );
        } catch {
          // A missing detail should not invalidate the rest of the probe.
        } finally {
          completed++;
          log(
            "probe",
            `PR detail sampling · ${completed}/${samplePulls.length} · ${Math.round(
              (completed / samplePulls.length) * 100,
            )}%`,
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(options.ghConcurrent, samplePulls.length) },
        worker,
      ),
    );
    detailSamples.push(...details.filter((detail): detail is Json => !!detail));
  });
  const branch = String(meta.default_branch ?? "main");
  log(
    "probe",
    `sampled ${detailSamples.length} PR details; reading ${branch} commit history`,
  );
  const commits = await timed("probe commit history", options.logTime, () =>
    client.pages<Json>(
      `repos/${options.repo}/commits?sha=${encodeURIComponent(branch)}`,
      undefined,
      (page, fetched) =>
        log(
          "probe",
          `commit history · page ${page} · fetched ${fetched} · total unknown`,
        ),
    ),
  );
  const analysis = await timed("probe analysis", options.logTime, async () =>
    analyzeProbe(
      { ...meta, latest_release_at: latestReleaseAt },
      pulls,
      detailSamples,
      commits,
    ),
  );
  const recommendation = ["--include-codebase"];
  if (analysis.includePullRequests) {
    recommendation.push("--include-pull-requests");
  }
  if (analysis.includePullRequestChanges) {
    recommendation.push("--include-pull-request-changes");
  }
  if (analysis.includeCommitHistory) {
    recommendation.push("--include-commit-history");
  }
  if (pulls.length || Boolean(meta.has_issues)) {
    recommendation.push("--include-how-repo-works");
  }
  if (analysis.maxPullRequestChangeLines) {
    recommendation.push(
      `--max-pull-request-change-lines=${analysis.maxPullRequestChangeLines}`,
    );
  }
  if (analysis.maxPrMonths) {
    recommendation.push(`--max-pr-months=${analysis.maxPrMonths}`);
  }
  if (analysis.maxCommits) {
    recommendation.push(`--max-commits=${analysis.maxCommits}`);
  }
  const command = [
    "co-maintainer",
    "init",
    options.repo,
    ...recommendation,
  ].join(" ");
  const report = {
    repo: options.repo,
    ...analysis.report,
    recommendations: {
      includePullRequests: analysis.includePullRequests,
      includePullRequestChanges: analysis.includePullRequestChanges,
      includeCommitHistory: analysis.includeCommitHistory,
      maxPrMonths: analysis.maxPrMonths ?? "all",
      maxCommits: analysis.maxCommits ?? "all",
      maxPullRequestChangeLines: analysis.maxPullRequestChangeLines ?? "all",
    },
    reasons: analysis.reasons,
    recommendedCommand: command,
    createdAt: new Date().toISOString(),
  };
  await timed("probe report write", options.logTime, () =>
    cacheSet("probe", options.repo, JSON.stringify(report)),
  );
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
