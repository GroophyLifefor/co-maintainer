import { clientFor, runInitOrRemake } from "../../services/setup.ts";
import { probePlan } from "../../services/probe.ts";
import { log, startHeartbeat, withCliLogsToStderr } from "../../util/log.ts";
import { estimateCostLine } from "../../ai/estimate.ts";
import { estimateProbe } from "../../services/probe_estimate.ts";
import { renderProbe, wantsColor } from "../../services/probe_render.ts";
import { getEnv } from "../../util/runtime.ts";
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
  // read, this says what that costs in time and dollars.
  const estimate = await estimateProbe(plan, {
    repo: options.repo,
    ai: options.ai,
    lowModel: options.lowModel,
    highModel: options.highModel,
    ghConcurrent: options.ghConcurrent,
    aiConcurrent: options.aiConcurrent,
  });
  const recommended = estimate.recommended;
  const costLine = estimateCostLine(
    recommended.ai,
    options.ai,
    estimate.pricesUnavailable,
    !estimate.modelsMissing,
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
          pullRequestsInWindow: recommended.pullRequests,
          sampledPullRequests: Number(analysis.report.sampledPullRequests ?? 0),
          commits: Number(analysis.report.commits ?? 0),
          usefulCommits: Number(analysis.report.usefulCommits ?? 0),
          maxPrMonths: analysis.maxPrMonths ?? null,
          maxCommits: analysis.maxCommits ?? null,
          maxPullRequestChangeLines: analysis.maxPullRequestChangeLines ?? null,
          reasons: analysis.reasons,
        },
        estimate: recommended.ai,
        costNote: costLine,
        probe: estimate,
        durationMs: Math.round(performance.now() - operationStarted),
        commitWatch,
      }),
    );
    return;
  }
  stopHeartbeat();
  console.log(
    "\n" +
      renderProbe({
        repo: options.repo,
        plan,
        estimate,
        ai: options.ai,
        commitWatch,
        color: wantsColor(Boolean(process.stdout.isTTY), getEnv),
      }),
  );
  if (options.logTime) {
    console.log(
      `  total time: ${((performance.now() - operationStarted) / 1000).toFixed(2)}s`,
    );
  }

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
