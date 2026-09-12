/** `init`/`remake` orchestration. The dashboard calls `runInitOrRemake`
 * directly; it used to re-spawn the CLI as a subprocess, a second
 * execution path with its own failure modes. */
import { createAiProvider } from "../ai/provider.ts";
import { ensureCodegraph } from "../tools/codegraph.ts";
import { enrichFacts, synthesizeSections } from "../knowledge/synthesis.ts";
import { collectSource } from "../github/collect.ts";
import { GhClient } from "../github/gh.ts";
import { PatClient } from "../github/pat.ts";
import { extractFacts } from "../knowledge/facts.ts";
import { buildReviewDocuments } from "../knowledge/guide.ts";
import {
  assembleSkill,
  extractSections,
  factSectionHashes,
} from "../knowledge/skill.ts";
import { validateSkill } from "../knowledge/validate.ts";
import { readConfig, reposDir, writeRepoConfig } from "../config.ts";
import { readState, writeState } from "../store/skill_state.ts";
import { cacheSet } from "../store/cache_db.ts";
import { log, timed, withLogSink } from "../util/log.ts";
import { enqueue, registerHandler } from "./jobs.ts";
import { markKnowledgeBuilt } from "../store/repos.ts";
import { nowIso } from "../util/time.ts";
import type { AiResponse, GitHubClient, Options } from "../types.ts";
import type { Source, State } from "../knowledge/types.ts";
import type { LogFn } from "./jobs.ts";
import type { JobRow } from "../store/rows.ts";

export type AiMetrics = {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  costKnown: boolean;
};

export function emptyAiMetrics(): AiMetrics {
  return { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, costKnown: true };
}

export async function recordAiCost(
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

export function clientFor(options: Options): GitHubClient {
  if (options.auth === "pat") {
    return new PatClient(options.githubPat ?? "");
  }
  return new GhClient();
}

function optionsForState(
  options: Options,
): Omit<Options, "command" | "aiToken" | "githubPat"> {
  const { command: _, aiToken: __, githubPat: ___, ...rest } = options;
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

export async function runInitOrRemake(options: Options): Promise<void> {
  // Before any work or any spend: indexing needs codegraph, and declining to
  // install it ends the command rather than silently producing a lesser index.
  await ensureCodegraph({ allowInstall: options.allowToolInstall });
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
    () =>
      validateSkill(result.markdown, `${reposDir()}/${options.repo}`, source),
  );
  if (!validation.valid && Object.keys(overrides).length) {
    log("validate", `AI output rejected: ${validation.errors.join("; ")}`);
    overrides = {};
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
  const finalValidation = await timed(
    "final skill validation",
    options.logTime,
    () =>
      validateSkill(result.markdown, `${reposDir()}/${options.repo}`, source),
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

/** Builds `Options` for a server-triggered `init`/`remake` from config
 * alone — no CLI flags, no interactive prompt, there is no terminal here. */
export function optionsFromConfig(
  repo: string,
  command: "init" | "remake",
): Options {
  const config = readConfig();
  const repoConfig = config.repos?.[repo] ?? {};
  const auth = repoConfig.auth ?? config.auth ?? "gh";
  if (auth === "pat" && !config.githubPat) {
    throw new Error(
      "auth=pat requires a GitHub PAT; run: co-maintainer set --github-pat=...",
    );
  }
  const ai = repoConfig.ai ?? config.ai ?? "none";
  const lowModel = repoConfig.lowModel ?? config.lowModel;
  const highModel = repoConfig.highModel ?? config.highModel;
  if (ai !== "none" && (!config.token || !lowModel || !highModel)) {
    throw new Error(
      "AI is enabled but token/low-model/high-model are not fully configured; run: " +
        "co-maintainer set --token=... --low-model=... --high-model=...",
    );
  }
  return {
    command,
    repo,
    debug: false,
    logTime: true,
    improveMatrix: 1,
    ghConcurrent: 1,
    aiConcurrent: 3,
    auth,
    githubPat: config.githubPat,
    ai,
    aiToken: config.token,
    lowModel,
    highModel,
    synthesisVersion: 16,
    includeCodebase: repoConfig.includeCodebase ?? true,
    includePullRequests: repoConfig.includePullRequests ?? true,
    includePullRequestChanges: repoConfig.includePullRequestChanges ?? true,
    includeCommitHistory: repoConfig.includeCommitHistory ?? true,
    includeHowRepoWorks: repoConfig.includeHowRepoWorks ?? true,
    maxCommits: repoConfig.maxCommits ?? config.defaults?.maxCommits,
    maxPrMonths: repoConfig.maxPrMonths ?? config.defaults?.maxPrMonths,
    maxPullRequestChangeLines: repoConfig.maxPullRequestChangeLines ??
      config.defaults?.maxPullRequestChangeLines,
    maxComments: repoConfig.maxComments,
  };
}

/** `runner` defaults to the real `runInitOrRemake`; tests substitute a fake
 * to check the option merging and log wiring without touching the network. */
// ponytail: the AbortSignal the queue passes to `run` is not threaded
// through `runInitOrRemake`'s GitHub fetch loops, so `cancel()` on a
// running init/remake marks it canceled and stops it being picked up
// again, but does not interrupt in-flight fetches — a live job keeps
// running to natural completion. Wire the signal into `github/collect.ts`'s
// `mapPool` if truly stopping a large in-flight fetch turns out to matter.
export function buildSetupHandler(
  runner: typeof runInitOrRemake = runInitOrRemake,
): { run(job: JobRow, jobLog: LogFn): Promise<void> } {
  return {
    async run(job: JobRow, jobLog: LogFn): Promise<void> {
      const overrides = JSON.parse(job.args || "{}") as Partial<Options>;
      const options: Options = {
        ...optionsFromConfig(job.repo, job.type as "init" | "remake"),
        ...overrides,
        command: job.type as Options["command"],
        repo: job.repo,
      };
      if (
        options.command === "remake" && !(await readState(options.repo))
      ) {
        jobLog(
          "info",
          "No previous init in the cache. Building knowledge from scratch.",
        );
        options.command = "init";
      }
      await withLogSink(
        (phase, message) => jobLog("info", `[${phase}] ${message}`),
        () => runner(options),
      );
      // The newest commit the fetch saw is the base the guide describes.
      // Drift compares against it; without a real sha it can only fall
      // back to a date range.
      markKnowledgeBuilt(job.repo, await builtBaseSha(job.repo));
    },
  };
}

/** The head commit of the default branch as of the fetch that just ran.
 * Falls back to the build timestamp when commit history was not collected,
 * which is what this column held before. */
async function builtBaseSha(repo: string): Promise<string> {
  const state = await readState(repo);
  const head = state?.source.commits[0] as { sha?: string } | undefined;
  return head?.sha ?? nowIso();
}

/** No `reconcile` hook: `run` is idempotent, so an orphan from a crash is
 * simply requeued and run again from the top. */
export function registerSetupJobHandler(): void {
  const handler = buildSetupHandler();
  registerHandler("init", handler);
  registerHandler("remake", handler);
}

export function enqueueSetup(
  repo: string,
  command: "init" | "remake",
  overrides: Partial<Options> = {},
): { id: string; debounced: boolean } {
  return enqueue({ type: command, repo, args: overrides });
}
