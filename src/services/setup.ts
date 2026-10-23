/** `init`/`remake` orchestration. The dashboard calls `runInitOrRemake`
 * directly; it used to re-spawn the CLI as a subprocess, a second
 * execution path with its own failure modes. */
import { createAiProvider } from "../ai/provider.ts";
import { enrichFacts, synthesizeSections } from "../knowledge/synthesis.ts";
import { collectSource } from "../github/collect.ts";
import { GhClient } from "../github/gh.ts";
import { PatClient } from "../github/pat.ts";
import { extractFacts } from "../knowledge/facts.ts";
import {
  reviewSignalCount,
  synthesizeReviewGuides,
} from "../knowledge/guide.ts";
import type { ReviewDocuments } from "../knowledge/guide.ts";
import {
  assembleSkill,
  codebaseBody,
  factSectionHashes,
} from "../knowledge/skill.ts";
import { validateSkill } from "../knowledge/validate.ts";
import {
  readConfig,
  reposDir,
  resolvedAiToken,
  writeRepoConfig,
} from "../config.ts";
import { readState, writeState } from "../store/skill_state.ts";
import { cacheSet } from "../store/cache_db.ts";
import { log, timed, withLogSink } from "../util/log.ts";
import { printRunSummary, summaryFromMetrics } from "../util/run_summary.ts";
import { enqueue, registerHandler } from "./jobs.ts";
import { closeAppDb, isAppDbOpen, openAppDb } from "../store/app_db.ts";
import { getRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { nowIso } from "../util/time.ts";
import type { AiResponse, GitHubClient, Options } from "../types.ts";
import type { Source, State } from "../knowledge/types.ts";
import type { LogFn } from "./jobs.ts";
import type { JobRow } from "../store/rows.ts";
import { mkdir, readTextFile, remove } from "../util/runtime.ts";
import { addResponseCost, emptyTally, type CostTally } from "../util/cost.ts";
import { costLabel } from "../util/run_summary.ts";
import { formatError } from "../cli/error.ts";

export type AiMetrics = CostTally & {
  calls: number;
  tokensIn: number;
  tokensOut: number;
};

export function emptyAiMetrics(): AiMetrics {
  return { calls: 0, tokensIn: 0, tokensOut: 0, ...emptyTally() };
}

/** One AI response into the run totals. */
export function addAiMetrics(metrics: AiMetrics, response: AiResponse): void {
  metrics.calls++;
  metrics.tokensIn += response.tokensIn;
  metrics.tokensOut += response.tokensOut;
  addResponseCost(metrics, response);
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
      usd: response.cost ?? null,
      status: response.cost === undefined ? "unknown" : "known",
    }),
  );
}

export function clientFor(options: Options): GitHubClient {
  if (options.auth === "pat") {
    return new PatClient(options.githubPat ?? "");
  }
  return new GhClient(options.debug);
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
  await mkdir(`${reposDir()}/${repo}`, { recursive: true });
  return path;
}

async function writeReviewDocuments(
  repo: string,
  documents: ReviewDocuments | undefined,
  signalCount: number,
): Promise<void> {
  const directory = `${reposDir()}/${repo}`;
  if (!documents) {
    // `undefined` means two different things. Below the signal threshold there
    // is nothing to write, so the files are removed and the reason is one line.
    // When the AI produced no usable guide, the existing files are kept: a
    // provider hiccup must not delete a guide the last run wrote.
    if (signalCount <= 2) {
      log(
        "write",
        `PR_REVIEW_GUIDE.md skipped: found ${signalCount} review signals, needs at least 3`,
      );
      await Promise.all([
        remove(`${directory}/PR_REVIEW_GUIDE.md`).catch(() => {}),
        remove(`${directory}/PR_REVIEW_DETAILED_GUIDE.md`).catch(() => {}),
      ]);
    } else {
      log(
        "write",
        "PR_REVIEW_GUIDE.md not regenerated: the AI produced no guide, keeping any existing file",
      );
    }
    return;
  }
  const { writeTextFileAtomic } = await import("../util/atomic.ts");
  await writeTextFileAtomic(`${directory}/PR_REVIEW_GUIDE.md`, documents.guide);
  if (documents.detailed) {
    await writeTextFileAtomic(
      `${directory}/PR_REVIEW_DETAILED_GUIDE.md`,
      documents.detailed,
    );
  } else {
    await remove(`${directory}/PR_REVIEW_DETAILED_GUIDE.md`).catch(() => {});
  }
}

/** Writes the codebase-description sections (layout/style/tests/devloop) to
 * their own file, so `review` can check a pull request against how this
 * repository's code actually looks, not just the review-bar checklist. Every
 * section body is authored by the synthesis job; the skill links to this file
 * rather than repeating it. */
async function writeCodebaseDocument(
  repo: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  const path = `${reposDir()}/${repo}/CODEBASE.md`;
  const body = codebaseBody(overrides);
  if (!body) {
    // Keep any existing file: `SKILL.md` links to it, and removing it would
    // leave that link dangling. A guide the last run wrote is better than a
    // broken link.
    log(
      "write",
      "CODEBASE.md not regenerated: the AI produced no codebase sections, keeping any existing file",
    );
    return;
  }
  const { writeTextFileAtomic } = await import("../util/atomic.ts");
  await writeTextFileAtomic(
    path,
    `# Codebase conventions for ${repo}\n\nHow this repository's code is actually structured and written. A pull request that departs from these observed conventions is worth flagging even without a matching review-bar rule.\n\n${body}\n`,
  );
}

function addReviewLink(
  markdown: string,
  documents: ReviewDocuments | undefined,
): string {
  if (!documents) return markdown;
  const detailedLink = documents.detailed
    ? " See [PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md) for evidence."
    : "";
  return `${markdown.trimEnd()}\n\n## Pull request review guides\n\n- Read [PR_REVIEW_GUIDE.md](PR_REVIEW_GUIDE.md).${detailedLink}\n`;
}

export async function runInitOrRemake(options: Options): Promise<void> {
  const openedAppDb = !isAppDbOpen();
  if (openedAppDb) await openAppDb();
  try {
    await initOrRemake(options);
  } finally {
    if (openedAppDb) await closeAppDb();
  }
}

async function initOrRemake(options: Options): Promise<void> {
  const operationStarted = performance.now();
  const aiMetrics = emptyAiMetrics();
  const previous = await readState(options.repo);
  if (options.command === "remake" && !previous) {
    throw new Error(
      "sync requires a previous init or sync for this repository",
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
  // Every guide is AI-authored: with no provider there is nothing to build.
  if (!lowAi || !highAi) {
    throw new Error(
      "init requires an AI provider. Run: co-maintainer set --ai=openrouter --token=... --low-model=... --high-model=...",
    );
  }
  log(
    "ai",
    `${options.ai} providers configured · low=${options.lowModel} · high=${options.highModel}`,
  );

  log("fetch", `${options.repo} via ${options.auth}`);
  const source = await timed("fetch repository data", options.logTime, () =>
    collectSource(
      client,
      options,
      previous,
      async (pullRequests, cache) => {
        checkpoint.source.pullRequests = pullRequests;
        checkpoint.source.pullRequestCache = cache;
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
    previousMarkdown = await readTextFile(path);
  } catch {
    // init can create the first output.
  }
  const factsStarted = performance.now();
  let facts = extractFacts(source, options);
  if (options.logTime) {
    log(
      "time",
      `extract deterministic facts · ${((performance.now() - factsStarted) / 1000).toFixed(2)}s`,
    );
  }
  const usage = async (job: string, response: AiResponse) => {
    addAiMetrics(aiMetrics, response);
    await recordAiCost(options.repo, job, response);
  };
  let overrides: Record<string, string> = {};
  let reviewDocuments: ReviewDocuments | undefined;
  try {
    log("ai", "starting extract_unit jobs");
    facts = await timed("extract_unit AI", options.logTime, () =>
      enrichFacts(lowAi, options.repo, facts, source, options, usage),
    );
    log("ai", `extract_unit complete · ${facts.length} facts`);
    const hashes = await factSectionHashes(facts);
    const synthesisChanged =
      previous &&
      (previous.options.highModel !== options.highModel ||
        previous.options.synthesisVersion !== options.synthesisVersion);
    const dirtySections = previous
      ? synthesisChanged
        ? new Set(Object.keys(hashes))
        : new Set(
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
    const synth = await timed("synth_section AI", options.logTime, () =>
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
    overrides = synth.overrides;
    log(
      "ai",
      `synth_section complete · ${Object.keys(overrides).length} sections`,
    );
    log("ai", "starting synth_guide jobs");
    reviewDocuments = await timed("synth_guide AI", options.logTime, () =>
      synthesizeReviewGuides(
        highAi,
        options.repo,
        options.ai,
        options.highModel ?? "",
        options.aiConcurrent,
        facts,
        usage,
      ),
    );
    log(
      "ai",
      reviewDocuments
        ? `synth_guide complete · ${
            reviewDocuments.detailed ? "short + detailed" : "single guide"
          }`
        : "synth_guide skipped · fewer than 3 review signals",
    );
  } catch (error) {
    // Nothing is written on an AI failure. Fetching and extraction are cached,
    // so a rerun picks up where this stopped instead of starting over.
    throw new Error(
      `AI failed to generate the guides: ${formatError(error)}. ` +
        "Fetching and extraction are cached, so rerunning `co-maintainer sync <owner/repo>` continues without re-fetching.",
    );
  }
  let result = await timed("assemble skill", options.logTime, () =>
    assembleSkill(
      options.repo,
      facts,
      previousMarkdown,
      previous?.sectionHashes ?? {},
      overrides,
    ),
  );
  result.markdown = addReviewLink(result.markdown, reviewDocuments);
  const validation = await timed("validate skill", options.logTime, () =>
    validateSkill(result.markdown, source),
  );
  // There is no deterministic fallback to reassemble from: a skill the AI could
  // not write correctly is reported rather than rebuilt from facts.
  if (!validation.valid) {
    log("validate", `skill problems kept: ${validation.errors.join("; ")}`);
  }
  const finalValidation = await timed(
    "final skill validation",
    options.logTime,
    () => validateSkill(result.markdown, source, "warning"),
  );
  if (finalValidation.warnings.length) {
    log(
      "validate",
      `stale references kept: ${finalValidation.warnings.join(", ")}`,
    );
  }
  if (!finalValidation.valid) {
    log(
      "validate",
      `skill problems kept: ${finalValidation.errors.join("; ")}`,
    );
  }
  await timed("write skill and state", options.logTime, async () => {
    const { withKnowledgeLock } = await import("../review/guides.ts");
    const { writeTextFileAtomic } = await import("../util/atomic.ts");
    await withKnowledgeLock(options.repo, async () => {
      await writeTextFileAtomic(path, result.markdown);
      await writeCodebaseDocument(options.repo, overrides);
      await writeReviewDocuments(
        options.repo,
        reviewDocuments,
        reviewSignalCount(facts),
      );
      const head = source.commits[0] as { sha?: string } | undefined;
      const baseSha = head?.sha ? String(head.sha) : new Date().toISOString();
      markKnowledgeBuilt(options.repo, baseSha);
    });
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
    // Remember everything but the token, so `sync owner/repo` alone
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
      onlyRequestChangedPr: options.onlyRequestChangedPr,
      prState: options.prState,
    });
  });
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
  printRunSummary(
    summaryFromMetrics(aiMetrics, performance.now() - operationStarted),
  );
  if (options.logTime) {
    log(
      "time",
      `AI total · calls=${aiMetrics.calls} · input=${aiMetrics.tokensIn} tokens · output=${aiMetrics.tokensOut} tokens · cost=${costLabel(
        aiMetrics,
      )}`,
    );
    log(
      "time",
      `total init/sync · ${((performance.now() - operationStarted) / 1000).toFixed(2)}s`,
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
  const aiToken = resolvedAiToken(config, ai);
  // Every guide is AI-authored: init and sync cannot run without a provider.
  if (ai === "none") {
    throw new Error(
      "init and sync need an AI provider. Run: co-maintainer set --ai=openrouter --token=... --low-model=... --high-model=...",
    );
  }
  if (!aiToken || !lowModel || !highModel) {
    throw new Error(
      "AI is enabled but token/low-model/high-model are not fully configured. Run: " +
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
    aiToken,
    lowModel,
    highModel,
    synthesisVersion: 17,
    includeCodebase: repoConfig.includeCodebase ?? true,
    includePullRequests: repoConfig.includePullRequests ?? true,
    includePullRequestChanges: repoConfig.includePullRequestChanges ?? true,
    includeCommitHistory: repoConfig.includeCommitHistory ?? true,
    includeHowRepoWorks: repoConfig.includeHowRepoWorks ?? true,
    onlyRequestChangedPr: repoConfig.onlyRequestChangedPr === true,
    prState: repoConfig.prState,
    maxCommits: repoConfig.maxCommits ?? config.defaults?.maxCommits,
    maxPrMonths: repoConfig.maxPrMonths ?? config.defaults?.maxPrMonths,
    maxPullRequestChangeLines:
      repoConfig.maxPullRequestChangeLines ??
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
): {
  run(job: JobRow, jobLog: LogFn): Promise<void>;
} {
  return {
    async run(job: JobRow, jobLog: LogFn): Promise<void> {
      const overrides = JSON.parse(job.args || "{}") as Partial<Options>;
      const options: Options = {
        ...optionsFromConfig(job.repo, job.type as "init" | "remake"),
        ...overrides,
        command: job.type as Options["command"],
        repo: job.repo,
      };
      if (options.command === "remake" && !(await readState(options.repo))) {
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
      if (!getRepo(job.repo)?.knowledge_built_at) {
        markKnowledgeBuilt(job.repo, await builtBaseSha(job.repo));
      }
    },
  };
}

/** The head commit of the default branch as of the fetch that just ran.
 * Falls back to the build timestamp when commit history was not collected,
 * which is what this column held before. */
async function builtBaseSha(repo: string): Promise<string> {
  const state = await readState(repo);
  const head = state?.source.commits[0] as { sha?: string } | undefined;
  return head?.sha ? String(head.sha) : nowIso();
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
  return enqueue({
    type: command,
    repo,
    args: overrides,
    queueKey: `setup:${repo}`,
  });
}
