/** `init`/`remake` orchestration. The dashboard calls `runInitOrRemake`
 * directly. It used to re-spawn the CLI as a subprocess, a second
 * execution path with its own failure modes. */
import { recordContradictions } from "../store/rule_events.ts";
import { aiProviderName, createAiProvider } from "../ai/provider.ts";
import { enrichFacts, synthesizeSections } from "../knowledge/synthesis.ts";
import { collectSource } from "../github/collect.ts";
import { GhClient } from "../github/gh.ts";
import { PatClient } from "../github/pat.ts";
import { extractFacts } from "../knowledge/facts.ts";
import {
  reviewSignalCount,
  synthesizeReviewGuides,
} from "../knowledge/guide.ts";
import type { GuideEditInput, ReviewDocuments } from "../knowledge/guide.ts";
import { guideFindingKeys } from "../knowledge/guide.ts";
import type { RuleEntry } from "../knowledge/rules.ts";
import {
  assembleSkill,
  codebaseBody,
  extractSections,
  factSectionHashes,
} from "../knowledge/skill.ts";
import { validateSkill } from "../knowledge/validate.ts";
import { codebaseSectionKeys } from "../knowledge/sections.ts";
import {
  readConfig,
  reposDir,
  resolveRepoSettings,
  resolvedAiToken,
  writeRepoConfig,
} from "../config.ts";
import {
  aiCostKindOf,
  attachAiCostsToJob,
  insertAiCost,
} from "../store/ai_costs.ts";
import { insertFinishedJob } from "../store/jobs.ts";
import { currentRateLimitJobId } from "./rate_limit.ts";
import { readState, writeState } from "../store/skill_state.ts";
import { cacheSet } from "../store/cache_db.ts";
import { log, timed, withCliLogsToStderr, withLogSink } from "../util/log.ts";
import { printRunSummary, summaryFromMetrics } from "../util/run_summary.ts";
import { enqueue, registerHandler } from "./jobs.ts";
import { resolveConcurrency } from "./concurrency.ts";
import { closeAppDb, isAppDbOpen, openAppDb } from "../store/app_db.ts";
import {
  getRepo,
  markKnowledgeBuilt,
  registerCliRepo,
  setDefaultBranch,
} from "../store/repos.ts";
import { nowIso } from "../util/time.ts";
import type { AiResponse, GitHubClient, Options } from "../types.ts";
import type { Fact, Source, State } from "../knowledge/types.ts";
import type { LogFn } from "./jobs.ts";
import type { JobRow } from "../store/rows.ts";
import {
  isNotFound,
  mkdir,
  readTextFile,
  remove,
  stat,
} from "../util/runtime.ts";
import { applyWatchNotes, withMaintainerNotes } from "./watch_notes.ts";
import { addResponseCost, emptyTally, type CostTally } from "../util/cost.ts";
import { costLabel } from "../util/run_summary.ts";
import { formatError } from "../cli/error.ts";
import { buildSetupJson } from "../cli/command_json.ts";
import {
  buildInstructions,
  instructionsJson,
  readRulesFile,
  stabilizeRuleIds,
  writeInstructionsAndRules,
  type InstructionsOutcome,
  type RulesWriteResult,
} from "./rules_build.ts";

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
  // Spend that is not on a review row goes to app.db, which Usage reads and
  // clearing knowledge never touches. app.db is open in serve and during a
  // CLI init or sync. A CLI review records its spend on its own review row.
  const kind = aiCostKindOf(job);
  if (kind && isAppDbOpen()) {
    const jobId = currentRateLimitJobId();
    insertAiCost({
      repo,
      jobId,
      kind,
      job,
      provider: response.provider,
      model: response.model,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      costUsd: response.cost,
      source: jobId ? "server" : "cli",
    });
  }
  // The cache keeps feeding the time and cost estimates.
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

/** Puts the commit watch maintainer notes at the end of the detailed guide,
 * which every review reads. Called after the guides are written, so a guide
 * the AI just rebuilt keeps them. */
async function writeMaintainerNotes(
  repo: string,
  lines: string[],
): Promise<void> {
  const path = `${reposDir()}/${repo}/PR_REVIEW_DETAILED_GUIDE.md`;
  let current = "";
  try {
    current = await readTextFile(path);
  } catch {
    // No detailed guide yet: the notes start one.
  }
  const { writeTextFileAtomic } = await import("../util/atomic.ts");
  await writeTextFileAtomic(path, withMaintainerNotes(current, lines));
}

/** The sections this run rebuilds. With no previous state, or after the high
 * model or the synthesis version changed, that is every section: `undefined`
 * on a first run, all keys after a change. Otherwise the sections whose facts
 * changed, and every codebase section that has facts but is missing from the
 * CODEBASE.md on disk. That last rule rebuilds a section an earlier run lost,
 * for example one 0.6.13 dropped on a sync, instead of keeping it missing
 * until its facts change. */
export function dirtySectionKeys(
  previous: State | undefined,
  options: Pick<Options, "highModel" | "synthesisVersion">,
  hashes: Record<string, string>,
  previousCodebase?: string,
): Set<string> | undefined {
  if (!previous) return undefined;
  const synthesisChanged =
    previous.options.highModel !== options.highModel ||
    previous.options.synthesisVersion !== options.synthesisVersion;
  if (synthesisChanged) return new Set(Object.keys(hashes));
  const onDisk = previousCodebase ? extractSections(previousCodebase) : {};
  return new Set(
    Object.entries(hashes)
      .filter(
        ([key, hash]) =>
          previous.sectionHashes[key] !== hash ||
          (codebaseSectionKeys.has(key) && !onDisk[key]),
      )
      .map(([key]) => key),
  );
}

/** The sections that still have facts and that this run did not rebuild, so
 * their previous text is still right. */
export function unchangedSectionKeys(
  hashes: Record<string, string>,
  dirty: Set<string> | undefined,
): Set<string> {
  if (!dirty) return new Set();
  return new Set(Object.keys(hashes).filter((key) => !dirty.has(key)));
}

/** The CODEBASE.md body. A sync rebuilds only the sections whose facts
 * changed, so a section in `keep` keeps the text the last run wrote, the way
 * `assembleSkill` keeps an unchanged skill section. `keep` holds the
 * unchanged sections and those whose synthesis call failed: a failed call is
 * not an answer. A rebuilt section takes its new text, and one that came back
 * empty is dropped: the old text was written from facts that are gone. */
export function mergeCodebaseSections(
  previousMarkdown: string | undefined,
  overrides: Record<string, string>,
  keep: Set<string>,
): string {
  const previous = previousMarkdown ? extractSections(previousMarkdown) : {};
  const kept = Object.fromEntries(
    Object.entries(previous).filter(([key]) => keep.has(key)),
  );
  return codebaseBody({ ...kept, ...overrides });
}

async function readCodebaseDocument(repo: string): Promise<string | undefined> {
  try {
    return await readTextFile(`${reposDir()}/${repo}/CODEBASE.md`);
  } catch {
    // No CODEBASE.md yet.
    return undefined;
  }
}

/** Writes the codebase-description sections (layout/style/tests/devloop) to
 * their own file, so `review` can check a pull request against how this
 * repository's code actually looks, not just the review-bar checklist. Every
 * section body is authored by the synthesis job. The skill links to this file
 * rather than repeating it. */
async function writeCodebaseDocument(
  repo: string,
  overrides: Record<string, string> = {},
  keep: Set<string> = new Set(),
): Promise<void> {
  const path = `${reposDir()}/${repo}/CODEBASE.md`;
  const previous = await readCodebaseDocument(repo);
  const body = mergeCodebaseSections(previous, overrides, keep);
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

export type ReviewGuideStatus = {
  /** `kept` is a guide the last run wrote that this run could not rebuild. */
  reviewGuide: "detailed" | "single" | "kept" | "skipped";
  detailed: boolean;
};

/** The review guides on disk once this run has written its files. When the AI
 * produced no guide above the signal threshold, `writeReviewDocuments` keeps
 * the last run's files, and every review still reads them. Below the
 * threshold it removes them. */
export async function reviewGuideStatus(
  repo: string,
  documents: ReviewDocuments | undefined,
  signalCount: number,
): Promise<ReviewGuideStatus> {
  if (documents) {
    return documents.detailed
      ? { reviewGuide: "detailed", detailed: true }
      : { reviewGuide: "single", detailed: false };
  }
  const skipped: ReviewGuideStatus = {
    reviewGuide: "skipped",
    detailed: false,
  };
  if (signalCount <= 2) return skipped;
  const directory = `${reposDir()}/${repo}`;
  const exists = (name: string) =>
    stat(`${directory}/${name}`).then(
      () => true,
      () => false,
    );
  if (!(await exists("PR_REVIEW_GUIDE.md"))) return skipped;
  return {
    reviewGuide: "kept",
    detailed: await exists("PR_REVIEW_DETAILED_GUIDE.md"),
  };
}

export function addReviewLink(
  markdown: string,
  guide: ReviewGuideStatus,
): string {
  if (guide.reviewGuide === "skipped") return markdown;
  const detailedLink = guide.detailed
    ? " See [PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md) for evidence."
    : "";
  return `${markdown.trimEnd()}\n\n## Pull request review guides\n\n- Read [PR_REVIEW_GUIDE.md](PR_REVIEW_GUIDE.md).${detailedLink}\n`;
}

/** Thrown at a checkpoint after Stop on the dashboard. Nothing is written
 * once it is thrown. */
export class StoppedError extends Error {}

/** A Stop is honoured between phases: an AI call that already started
 * finishes, then no new phase starts and nothing is written. */
function stopIfAsked(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted) {
    throw new StoppedError(`stopped before ${phase}, nothing was written`);
  }
}

export async function runInitOrRemake(
  options: Options,
  signal?: AbortSignal,
): Promise<void> {
  const openedAppDb = !isAppDbOpen();
  if (openedAppDb) await openAppDb();
  // A run outside a `serve` job is a CLI run. It gets its own finished job
  // row, so the Activity list and Usage show it with its cost.
  const fromCli = openedAppDb && currentRateLimitJobId() === undefined;
  const startedAt = new Date().toISOString();
  let failure: unknown;
  try {
    // With `--json` stdout carries the one document, so progress moves to
    // stderr.
    if (options.json) {
      await withCliLogsToStderr(() => initOrRemake(options, signal));
    } else await initOrRemake(options, signal);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (fromCli) {
      try {
        const jobId = crypto.randomUUID();
        insertFinishedJob({
          id: jobId,
          type: options.command === "remake" ? "remake" : "init",
          repo: options.repo,
          args: { source: "cli" },
          status: failure === undefined ? "done" : "failed",
          startedAt,
          error:
            failure === undefined
              ? undefined
              : failure instanceof Error
                ? failure.message
                : String(failure),
        });
        attachAiCostsToJob(options.repo, startedAt, jobId);
      } catch (error) {
        log(
          "setup",
          `could not record this run for the dashboard: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (openedAppDb) await closeAppDb();
  }
}

/** What the next sync needs to edit the guide: the findings this guide was
 * written from, and how many edits since its last full rewrite. A sync that
 * kept the guide as it was does not count, and a full rewrite starts again. */
export function guideState(
  previous: State | null | undefined,
  outcome: { mode?: "full" | "edit" | "unchanged" },
  documents: ReviewDocuments | undefined,
  facts: Fact[],
): Pick<State, "guide"> {
  if (!documents) return previous?.guide ? { guide: previous.guide } : {};
  const edits = previous?.guide?.edits ?? 0;
  return {
    guide: {
      findings: guideFindingKeys(facts),
      edits:
        outcome.mode === "edit"
          ? edits + 1
          : outcome.mode === "unchanged"
            ? edits
            : 0,
    },
  };
}

/** How many syncs whose guide input changed edit the guide before one
 * rewrites it in full. */
export const DEFAULT_GUIDE_FULL_EVERY = 10;

/** The guide on disk to edit, or `undefined` when this build rewrites it in
 * full: `init`, `sync --full-guide`, `--guide-full-every=1`, the N-th
 * changed sync, or no earlier guide, rules or finding list to edit from. */
export async function guideEditInput(
  options: Options,
  previous: State | null | undefined,
  rules: Record<string, RuleEntry> | undefined,
): Promise<GuideEditInput | undefined> {
  if (options.command === "init" || options.fullGuide) return undefined;
  const every =
    readConfig().repos?.[options.repo]?.guideFullEvery ??
    DEFAULT_GUIDE_FULL_EVERY;
  if (every === 1) return undefined;
  const edits = previous?.guide?.edits ?? 0;
  // The count only decides once the findings changed: a sync whose findings
  // are the same keeps the guide, whatever the count.
  const rewriteIfChanged = every > 0 && edits + 1 >= every;
  if (rewriteIfChanged) {
    log(
      "ai",
      `${edits} edits since the last full rewrite, --guide-full-every=${every}: a changed guide is rewritten in full`,
    );
  }
  const findings = previous?.guide?.findings;
  if (!findings || !rules) return undefined;
  const directory = `${reposDir()}/${options.repo}`;
  // Only a missing file means "no such guide". Any other read error rewrites
  // in full, so the two guides are never edited apart.
  const UNREADABLE = Symbol("unreadable");
  const read = (name: string) =>
    readTextFile(`${directory}/${name}`).catch((error: unknown) =>
      isNotFound(error) ? undefined : UNREADABLE,
    );
  const [guide, detailed] = await Promise.all([
    read("PR_REVIEW_GUIDE.md"),
    read("PR_REVIEW_DETAILED_GUIDE.md"),
  ]);
  if (!guide || guide === UNREADABLE || detailed === UNREADABLE) {
    return undefined;
  }
  // The last build wrote a detailed guide that is gone now: rewrite in full.
  const hadDetailed = Object.values(rules).some(
    (rule) => rule.file === "PR_REVIEW_DETAILED_GUIDE.md",
  );
  if (hadDetailed && detailed === undefined) return undefined;
  // An empty guide file is not a guide to edit.
  if (!guide.trim() || (detailed !== undefined && !detailed.trim())) {
    return undefined;
  }
  return {
    guide,
    ...(detailed !== undefined ? { detailed } : {}),
    rules,
    findings,
    ...(rewriteIfChanged ? { rewriteIfChanged: true } : {}),
  };
}

async function initOrRemake(
  options: Options,
  signal?: AbortSignal,
): Promise<void> {
  const guideOutcome: { mode?: "full" | "edit" | "unchanged" } = {};
  // Turning review references on re-reads every pull request once, so the
  // guide rules get links to the review comments they came from.
  const repoConfig = readConfig().repos?.[options.repo];
  const backfillLinks =
    repoConfig?.reviewReferences === true && !repoConfig.referencesBackfilledAt;
  if (backfillLinks) {
    options = { ...options, refreshCommentLinks: true };
    log(
      "fetch",
      "review references are on: reading every pull request again once for comment links",
    );
  }
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
    `${aiProviderName(options)} providers configured · low=${options.lowModel} · high=${options.highModel}`,
  );

  log("fetch", `${options.repo} via ${options.auth}`);
  const source = await timed("fetch repository data", options.logTime, () =>
    collectSource(client, options, previous, async (codebase) => {
      // `instructionFiles` is set even when missing: it is checked against
      // the blob SHAs saved here, so the old contents must not survive them.
      checkpoint.source = {
        ...checkpoint.source,
        tree: codebase.tree,
        treeSha: codebase.treeSha,
        files: codebase.files,
        instructionFiles: codebase.instructionFiles,
      };
      await writeState(checkpoint);
    }),
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
  let unchangedSections = new Set<string>();
  let instructions: InstructionsOutcome = { status: "failed" };
  let rulesResult: RulesWriteResult | undefined;
  try {
    stopIfAsked(signal, "the AI extraction");
    log("ai", "starting extract_unit jobs");
    facts = await timed("extract_unit AI", options.logTime, () =>
      enrichFacts(lowAi, options.repo, facts, source, options, usage),
    );
    log("ai", `extract_unit complete · ${facts.length} facts`);
    const hashes = await factSectionHashes(facts);
    const dirtySections = dirtySectionKeys(
      previous,
      options,
      hashes,
      await readCodebaseDocument(options.repo),
    );
    unchangedSections = unchangedSectionKeys(hashes, dirtySections);
    stopIfAsked(signal, "the section synthesis");
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
    // A section whose call failed keeps its CODEBASE.md text, as SKILL.md
    // keeps a dropped unit's text.
    for (const key of synth.failed) unchangedSections.add(key);
    log(
      "ai",
      `synth_section complete · ${Object.keys(overrides).length} sections`,
    );
    stopIfAsked(signal, "the review guide");
    log("ai", "starting synth_guide jobs");
    // The last build's rules let the guide AI say which old rule a new line
    // goes against. Read outside the lock: it only shapes the prompt, the ids
    // are mapped under the lock below.
    const previousRules = (await readRulesFile(options.repo))?.rules;
    const edit = await guideEditInput(options, previous, previousRules);
    reviewDocuments = await timed("synth_guide AI", options.logTime, () =>
      synthesizeReviewGuides(
        highAi,
        options.repo,
        options.ai,
        options.highModel ?? "",
        options.aiConcurrent,
        facts,
        usage,
        previousRules,
        edit,
        guideOutcome,
      ),
    );
    log(
      "ai",
      reviewDocuments
        ? `synth_guide complete · ${
            reviewDocuments.detailed ? "short + detailed" : "single guide"
          }`
        : reviewSignalCount(facts) > 2
          ? "synth_guide produced no guide"
          : "synth_guide skipped · fewer than 3 review signals",
    );
    stopIfAsked(signal, "the instructions");
    instructions = await buildInstructions(highAi, options, source, usage);
  } catch (error) {
    if (error instanceof StoppedError) throw error;
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
  const guideStatus = await reviewGuideStatus(
    options.repo,
    reviewDocuments,
    reviewSignalCount(facts),
  );
  result.markdown = addReviewLink(result.markdown, guideStatus);
  // What maintainers said on commit watch issues since the last sync.
  const noteLines = await applyWatchNotes(options.repo, lowAi, (response) =>
    usage("watch_note", response),
  );
  const validation = await timed("validate skill", options.logTime, () =>
    validateSkill(result.markdown, source),
  );
  // There is no deterministic fallback to reassemble from: a skill the AI could
  // not write correctly is reported rather than rebuilt from facts.
  if (!validation.valid) {
    log("validate", `skill problems kept: ${validation.errors.join(", ")}`);
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
      `skill problems kept: ${finalValidation.errors.join(", ")}`,
    );
  }
  stopIfAsked(signal, "writing the files");
  await timed("write skill and state", options.logTime, async () => {
    const { withKnowledgeLock } = await import("../review/guides.ts");
    const { writeTextFileAtomic } = await import("../util/atomic.ts");
    await withKnowledgeLock(options.repo, async () => {
      // Ids are mapped onto the last build's before the guides are written,
      // so a review that cited R4 still points at the same rule.
      const stable = await stabilizeRuleIds(
        options.repo,
        reviewDocuments,
        instructions,
      );
      reviewDocuments = stable.documents;
      instructions = stable.instructions;
      await writeTextFileAtomic(path, result.markdown);
      await writeCodebaseDocument(options.repo, overrides, unchangedSections);
      await writeReviewDocuments(
        options.repo,
        reviewDocuments,
        reviewSignalCount(facts),
      );
      if (noteLines.length > 0) {
        await writeMaintainerNotes(options.repo, noteLines);
      }
      rulesResult = await writeInstructionsAndRules({
        repo: options.repo,
        command: options.command,
        documents: reviewDocuments,
        signalCount: reviewSignalCount(facts),
        instructions,
        source,
        lastIds: stable.lastIds,
      });
      const head = source.commits[0] as { sha?: string } | undefined;
      const baseSha = head?.sha ? String(head.sha) : new Date().toISOString();
      // A CLI init has no app.db row for the repository yet. Without one the
      // dashboard never sees what it built. A dashboard job already has one.
      registerCliRepo(options.repo);
      markKnowledgeBuilt(options.repo, baseSha);
      setDefaultBranch(options.repo, String(source.repo.default_branch ?? ""));
      // The dashboard repo page lists guide rules a newer rule went against.
      recordContradictions(options.repo, rulesResult.contradicted);
    });
    await writeState({
      version: 1,
      repo: options.repo,
      options: optionsForState(options),
      source,
      facts,
      sectionHashes: result.hashes,
      ...guideState(previous, guideOutcome, reviewDocuments, facts),
      scanDone: {
        pullRequests: source.pullRequests.length,
        commits: source.commits.length,
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
    // Remember everything but the token, so `sync owner/repo` alone
    // (no flags, no prompts) reuses what this run resolved.
    // AI, models and auth are not copied: the repository inherits the global
    // values until someone sets its own with `set --repo` or the dashboard.
    // A copy here outranked every later global change without a word.
    await writeRepoConfig(options.repo, {
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
      agentInstructions: options.agentInstructions,
      agentInstructionsMaxChars: options.agentInstructionsMaxChars,
      ...(backfillLinks
        ? { referencesBackfilledAt: new Date().toISOString() }
        : {}),
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
  const summary = summaryFromMetrics(
    aiMetrics,
    performance.now() - operationStarted,
  );
  printRunSummary(summary);
  if (options.json) {
    console.log(
      buildSetupJson({
        command: options.command === "remake" ? "sync" : "init",
        repo: options.repo,
        skillPath: path,
        changed: result.changed,
        facts: facts.length,
        pullRequests: source.pullRequests.length,
        commits: source.commits.length,
        reviewGuide: guideStatus.reviewGuide,
        validation: {
          errors: finalValidation.errors,
          warnings: finalValidation.warnings,
        },
        // Only when the instructions did something, so `sync --json` for a
        // repository without instruction files prints what it printed before.
        ...(rulesResult?.reported
          ? {
              instructions: instructionsJson(instructions),
              ruleChanges: rulesResult.changes,
              contradicted: rulesResult.contradicted,
            }
          : {}),
        summary,
      }),
    );
  }
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
 * alone, no CLI flags, no interactive prompt, there is no terminal here. */
export function optionsFromConfig(
  repo: string,
  command: "init" | "remake",
): Options {
  const config = readConfig();
  const repoConfig = config.repos?.[repo] ?? {};
  const settings = resolveRepoSettings(config, repo);
  const auth = settings.auth.value as Options["auth"];
  if (auth === "pat" && !config.githubPat) {
    throw new Error(
      "auth=pat requires a GitHub PAT. Run: co-maintainer set --github-pat=...",
    );
  }
  const ai = settings.ai.value as Options["ai"];
  const lowModel = settings.lowModel.value;
  const highModel = settings.highModel.value;
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
  const concurrency = resolveConcurrency(repo, config);
  return {
    command,
    repo,
    debug: false,
    logTime: true,
    improveMatrix: 1,
    ghConcurrent: concurrency.gh,
    aiConcurrent: concurrency.ai,
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
    agentInstructions: repoConfig.agentInstructions,
    agentInstructionsMaxChars: repoConfig.agentInstructionsMaxChars,
  };
}

/** `runner` defaults to the real `runInitOrRemake`. Tests substitute a fake
 * to check the option merging and log wiring without touching the network. */
// The signal the queue passes to `run` reaches the phase checkpoints in
// `initOrRemake`: a Stop lets the running fetch or AI call finish, then no new
// phase starts and nothing is written.
export function buildSetupHandler(
  runner: typeof runInitOrRemake = runInitOrRemake,
): {
  run(job: JobRow, jobLog: LogFn, signal?: AbortSignal): Promise<void>;
} {
  return {
    async run(job: JobRow, jobLog: LogFn, signal?: AbortSignal): Promise<void> {
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
        () => runner(options, signal),
      );
      if (!getRepo(job.repo)?.knowledge_built_at) {
        markKnowledgeBuilt(job.repo, await builtBaseSha(job.repo));
      }
      const state = await readState(job.repo);
      setDefaultBranch(
        job.repo,
        String(state?.source.repo.default_branch ?? ""),
      );
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
  const concurrency = resolveConcurrency(repo);
  return enqueue({
    type: command,
    repo,
    args: {
      ghConcurrent: concurrency.gh,
      aiConcurrent: concurrency.ai,
      ...overrides,
    },
    queueKey: `setup:${repo}`,
  });
}
