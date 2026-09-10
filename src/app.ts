import { parseArgs } from "./cli/args.ts";
import { runSet } from "./cli/set.ts";
import { createAiProvider } from "./ai/ai.ts";
import { enrichFacts, synthesizeSections } from "./ai/jobs.ts";
import { collectSource } from "./data/data.ts";
import { GhClient } from "./data/gh.ts";
import { PatClient } from "./data/pat.ts";
import { extractFacts } from "./analysis/facts.ts";
import { analyzeProbe } from "./analysis/probe.ts";
import { buildReviewDocuments } from "./analysis/review.ts";
import {
  assembleSkill,
  extractSections,
  factSectionHashes,
} from "./analysis/skill.ts";
import { validateSkill } from "./analysis/validate.ts";
import { reposDir, writeRepoConfig } from "./config.ts";
import { reviewPullRequest } from "./review.ts";
import { readState, writeState } from "./state/state.ts";
import { cacheSet } from "./state/database.ts";
import { startHeartbeat, timed } from "./log.ts";
import type { AiResponse, Json, Options, Source, State } from "./types.ts";

function log(phase: string, message: string): void {
  console.log(`[${phase}] ${message}`);
}

type AiMetrics = {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  costKnown: boolean;
};

function emptyAiMetrics(): AiMetrics {
  return { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, costKnown: true };
}

function optionsForState(
  options: Options,
): Omit<Options, "command" | "aiToken"> {
  const { command: _, aiToken: __, ...rest } = options;
  return rest;
}

function emptyState(options: Options): State {
  const source: Source = {
    repo: {},
    tree: [],
    treeSha: {},
    files: {},
    pullRequests: [],
    commits: [],
  };
  return {
    version: 1,
    repo: options.repo,
    options: optionsForState(options),
    source,
    facts: [],
    sectionHashes: {},
    scanDone: {
      pullRequests: 0,
      commits: 0,
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

function clientFor(options: Options) {
  if (options.auth === "pat") {
    return new PatClient(
      Deno.env.get("GITHUB_TOKEN") ?? Deno.env.get("GH_TOKEN") ?? "",
    );
  }
  return new GhClient();
}

async function skillPath(repo: string): Promise<string> {
  const path = `${reposDir()}/${repo}/SKILL.md`;
  await Deno.mkdir(`${reposDir()}/${repo}`, { recursive: true });
  return path;
}

async function writeReviewDocuments(
  repo: string,
  documents: ReturnType<typeof buildReviewDocuments>,
): Promise<void> {
  const directory = `${reposDir()}/${repo}`;
  if (!documents) {
    await Promise.all([
      Deno.remove(`${directory}/PR_REVIEW_GUIDE.md`).catch(() => {}),
      Deno.remove(`${directory}/PR_REVIEW_DETAILED_GUIDE.md`).catch(() => {}),
    ]);
    return;
  }
  await Deno.writeTextFile(`${directory}/PR_REVIEW_GUIDE.md`, documents.guide);
  if (documents.detailed) {
    await Deno.writeTextFile(
      `${directory}/PR_REVIEW_DETAILED_GUIDE.md`,
      documents.detailed,
    );
  } else {
    await Deno.remove(`${directory}/PR_REVIEW_DETAILED_GUIDE.md`).catch(
      () => {},
    );
  }
}

/** Splits the codebase-description sections (layout/style/tests/devloop) out
 * of the assembled skill into their own file, so `review` can check a pull
 * request against how this repository's code actually looks, not just the
 * review-bar checklist mined from past PR comments. */
async function writeCodebaseDocument(
  repo: string,
  skillMarkdown: string,
): Promise<void> {
  const path = `${reposDir()}/${repo}/CODEBASE.md`;
  const sections = extractSections(skillMarkdown);
  const body = ["layout", "style", "tests", "devloop"]
    .map((key) => sections[key])
    .filter(Boolean)
    .join("\n\n");
  if (!body) {
    await Deno.remove(path).catch(() => {});
    return;
  }
  await Deno.writeTextFile(
    path,
    `# Codebase conventions for ${repo}\n\nHow this repository's code is actually structured and written. A pull request that departs from these observed conventions is worth flagging even without a matching review-bar rule.\n\n${body}\n`,
  );
}

function addReviewLink(
  markdown: string,
  documents: ReturnType<typeof buildReviewDocuments>,
): string {
  if (!documents) return markdown;
  const detailedLink = documents.detailed
    ? " See [PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md) for evidence."
    : "";
  return `${markdown.trimEnd()}\n\n## Pull request review guides\n\n- Read [PR_REVIEW_GUIDE.md](PR_REVIEW_GUIDE.md).${detailedLink}\n`;
}

async function recordAiCost(
  repo: string,
  job: string,
  response: AiResponse,
): Promise<void> {
  await cacheSet(
    "cost",
    `${repo}:${crypto.randomUUID()}`,
    JSON.stringify({
      at: new Date().toISOString(),
      job,
      provider: response.provider,
      model: response.model,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      usd: response.provider === "hetzner" ? 0 : response.cost ?? null,
    }),
  );
}

async function runInitOrRemake(options: Options): Promise<void> {
  const operationStarted = performance.now();
  const aiMetrics = emptyAiMetrics();
  const previous = await readState(options.repo);
  if (options.command === "remake" && !previous) {
    throw new Error(
      "remake requires a previous init or remake for this repository",
    );
  }
  if (options.command === "remake" && previous) {
    options.maxCommits ??= previous.options.maxCommits;
    options.maxPrMonths ??= previous.options.maxPrMonths;
    options.maxPullRequestChangeLines ??=
      previous.options.maxPullRequestChangeLines;
  }
  const checkpoint = previous ?? emptyState(options);
  const client = clientFor(options);
  const lowAi = createAiProvider(options, options.lowModel ?? "");
  const highAi = createAiProvider(options, options.highModel ?? "");
  if (lowAi || highAi) {
    log(
      "ai",
      `${options.ai} providers configured · low=${options.lowModel} · high=${options.highModel}`,
    );
  }

  log("fetch", `${options.repo} via ${options.auth}`);
  const source = await timed(
    "fetch repository data",
    options.logTime,
    () =>
      collectSource(
        client,
        options,
        previous,
        async (pullRequests) => {
          checkpoint.source.pullRequests = pullRequests;
          checkpoint.scanDone = {
            ...checkpoint.scanDone,
            pullRequests: pullRequests.length,
            updatedAt: new Date().toISOString(),
          };
          await writeState(checkpoint);
        },
        async (codebase) => {
          checkpoint.source = {
            ...checkpoint.source,
            tree: codebase.tree,
            treeSha: codebase.treeSha,
            files: codebase.files,
          };
          await writeState(checkpoint);
        },
      ),
  );
  log(
    "fetch",
    `source ready · ${
      Object.keys(source.files).length
    } files · ${source.pullRequests.length} PRs · ${source.commits.length} commits`,
  );
  const path = await skillPath(options.repo);
  let previousMarkdown: string | undefined;
  try {
    previousMarkdown = await Deno.readTextFile(path);
  } catch {
    // init can create the first output.
  }
  const factsStarted = performance.now();
  let facts = extractFacts(source, options);
  if (options.logTime) {
    log(
      "time",
      `extract deterministic facts · ${
        ((performance.now() - factsStarted) / 1000).toFixed(2)
      }s`,
    );
  }
  let overrides: Record<string, string> = {};
  if (lowAi) {
    log("ai", "starting extract_unit jobs");
    const usage = async (job: string, response: AiResponse) => {
      aiMetrics.calls++;
      aiMetrics.tokensIn += response.tokensIn;
      aiMetrics.tokensOut += response.tokensOut;
      if (response.provider === "hetzner") aiMetrics.cost += 0;
      else if (response.cost === undefined) aiMetrics.costKnown = false;
      else aiMetrics.cost += response.cost;
      await recordAiCost(options.repo, job, response);
    };
    facts = await timed(
      "extract_unit AI",
      options.logTime,
      () =>
        enrichFacts(
          lowAi,
          options.repo,
          facts,
          source,
          options,
          usage,
        ),
    );
    log("ai", `extract_unit complete · ${facts.length} facts`);
    const hashes = await factSectionHashes(facts);
    const synthesisChanged = previous &&
      (previous.options.highModel !== options.highModel ||
        previous.options.synthesisVersion !== options.synthesisVersion);
    const dirtySections = previous
      ? synthesisChanged ? new Set(Object.keys(hashes)) : new Set(
        Object.entries(hashes)
          .filter(([key, hash]) => previous.sectionHashes[key] !== hash)
          .map(([key]) => key),
      )
      : undefined;
    log(
      "ai",
      `starting synth_section jobs${
        dirtySections ? ` · ${dirtySections.size} dirty sections` : ""
      }`,
    );
    if (highAi) {
      overrides = await timed(
        "synth_section AI",
        options.logTime,
        () =>
          synthesizeSections(
            highAi,
            options.repo,
            facts,
            previousMarkdown,
            options.ai,
            options.highModel ?? "",
            options.aiConcurrent,
            usage,
            dirtySections,
          ),
      );
    }
    log(
      "ai",
      `synth_section complete · ${Object.keys(overrides).length} sections`,
    );
  }
  let result = await timed(
    "assemble skill",
    options.logTime,
    () =>
      assembleSkill(
        options.repo,
        facts,
        previousMarkdown,
        previous?.sectionHashes ?? {},
        overrides,
      ),
  );
  const reviewDocuments = buildReviewDocuments(facts);
  await writeReviewDocuments(options.repo, reviewDocuments);
  result.markdown = addReviewLink(result.markdown, reviewDocuments);
  const validation = await timed(
    "validate skill",
    options.logTime,
    () => validateSkill(result.markdown, `${reposDir()}/${options.repo}`, source),
  );
  if (!validation.valid && Object.keys(overrides).length) {
    log("validate", `AI output rejected: ${validation.errors.join("; ")}`);
    result = await timed(
      "reassemble valid skill",
      options.logTime,
      () =>
        assembleSkill(
          options.repo,
          facts,
          previousMarkdown,
          previous?.sectionHashes ?? {},
          overrides,
        ),
    );
    result.markdown = addReviewLink(result.markdown, reviewDocuments);
  }
  let finalValidation = await timed(
    "final skill validation",
    options.logTime,
    () => validateSkill(result.markdown, `${reposDir()}/${options.repo}`, source),
  );
  if (!finalValidation.valid) {
    throw new Error(
      `generated skill is invalid: ${finalValidation.errors.join("; ")}`,
    );
  }
  await timed(
    "write skill and state",
    options.logTime,
    async () => {
      await Deno.writeTextFile(path, result.markdown);
      await writeCodebaseDocument(options.repo, result.markdown);
      await writeState({
        version: 1,
        repo: options.repo,
        options: optionsForState(options),
        source,
        facts,
        sectionHashes: result.hashes,
        scanDone: {
          pullRequests: source.pullRequests.length,
          commits: source.commits.length,
          updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      });
      // Remember everything but the token, so `remake owner/repo` alone
      // (no flags, no prompts) reuses what this run resolved.
      await writeRepoConfig(options.repo, {
        auth: options.auth,
        ai: options.ai,
        lowModel: options.lowModel,
        highModel: options.highModel,
        maxCommits: options.maxCommits,
        maxPrMonths: options.maxPrMonths,
        maxPullRequestChangeLines: options.maxPullRequestChangeLines,
        maxComments: options.maxComments,
        includeCodebase: options.includeCodebase,
        includePullRequests: options.includePullRequests,
        includePullRequestChanges: options.includePullRequestChanges,
        includeCommitHistory: options.includeCommitHistory,
        includeHowRepoWorks: options.includeHowRepoWorks,
      });
    },
  );
  log(
    "write",
    `${path} · ${
      result.changed.length
        ? `updated ${result.changed.join(", ")}`
        : "already current"
    }`,
  );
  log(
    "done",
    `${facts.length} facts · ${source.pullRequests.length} pull requests · ${source.commits.length} commits`,
  );
  if (options.logTime) {
    log(
      "time",
      `AI total · calls=${aiMetrics.calls} · input=${aiMetrics.tokensIn} tokens · output=${aiMetrics.tokensOut} tokens · cost=${
        aiMetrics.costKnown ? aiMetrics.cost.toFixed(4) : "unknown"
      }`,
    );
    log(
      "time",
      `total init/remake · ${
        ((performance.now() - operationStarted) / 1000).toFixed(2)
      }s`,
    );
  }
}

async function runProbe(options: Options): Promise<void> {
  const operationStarted = performance.now();
  const stopHeartbeat = startHeartbeat("probing repository");
  const client = clientFor(options);
  log("probe", `reading ${options.repo} via ${options.auth}`);
  const meta = await timed(
    "probe repository metadata",
    options.logTime,
    () => client.request<Json>(`repos/${options.repo}`),
  );
  let latestReleaseAt = "";
  log("probe", "reading release metadata");
  try {
    const releases = await timed(
      "probe release metadata",
      options.logTime,
      () =>
        client.pages<Json>(
          `repos/${options.repo}/releases?per_page=1`,
          1,
        ),
    );
    latestReleaseAt = String(
      releases[0]?.published_at ?? releases[0]?.created_at ?? "",
    );
  } catch {
    // Release metadata is an optional probe signal.
  }
  log("probe", "reading pull request list");
  const pulls = await timed(
    "probe pull request listing",
    options.logTime,
    () =>
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
  await timed(
    "probe PR detail sampling",
    options.logTime,
    async () => {
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
              `PR detail sampling · ${completed}/${samplePulls.length} · ${
                Math.round((completed / samplePulls.length) * 100)
              }%`,
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
      detailSamples.push(
        ...details.filter((detail): detail is Json => !!detail),
      );
    },
  );
  const branch = String(meta.default_branch ?? "main");
  log(
    "probe",
    `sampled ${detailSamples.length} PR details; reading ${branch} commit history`,
  );
  const commits = await timed(
    "probe commit history",
    options.logTime,
    () =>
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
  const analysis = await timed(
    "probe analysis",
    options.logTime,
    async () =>
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
  await timed(
    "probe report write",
    options.logTime,
    () => cacheSet("probe", options.repo, JSON.stringify(report)),
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
  console.log(
    "  This is a recommendation only; probe does not create or modify a skill.",
  );
  if (options.logTime) {
    console.log(
      `  total time: ${
        ((performance.now() - operationStarted) / 1000).toFixed(2)
      }s`,
    );
  }
  stopHeartbeat();
}

async function runReview(options: Options): Promise<void> {
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
  console.log(`\n${result.text}\n`);
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
}

export async function run(args: string[]): Promise<void> {
  if (args[0] === "set") {
    await runSet(args.slice(1));
    return;
  }
  const options = parseArgs(args);
  if (options.command === "probe") await runProbe(options);
  else if (options.command === "review") await runReview(options);
  else await runInitOrRemake(options);
}
