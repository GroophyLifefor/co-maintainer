import { parseArgs } from "../cli/args.ts";
import {
  filterReviewConfigArgs,
  type ReviewCliArgs,
} from "../cli/review_args.ts";
import {
  buildLocalReviewJson,
  formatHumanLocalReview,
  resolvedFromFirstReview,
  reviewExitCodeFromResolved,
} from "../cli/review_result.ts";
import { emptyAiMetrics, recordAiCost, runInitOrRemake } from "../services/setup.ts";
import { aiFor } from "../services/review.ts";
import { loadGuides } from "../review/guides.ts";
import {
  buildCarryPromptSection,
  classifyCarryItems,
  incrementalDiffPaths,
  parsePreviousVerdicts,
  resolveCarryOutcomes,
  type CarryPrevious,
  type ResolvedFinding,
  type StoredFinding,
} from "../review/carry_over.ts";
import { revisionHash } from "../review/revision.ts";
import type { ParsedFinding } from "../pr/findings.ts";
import { parseFindings } from "../pr/findings.ts";
import { reviewWorkspaceRevision } from "../pr/reviewer.ts";
import { runCommand } from "../pr/checkout.ts";
import { log, startHeartbeat, timed, withCliLogsToStderr } from "../util/log.ts";
import { setCliInteractive } from "../cli/args.ts";
import { prepareLocalCodegraph } from "./codegraph_prepare.ts";
import {
  acquireLocalReviewLock,
  type LocalReviewLock,
} from "./review_lock.ts";
import {
  assertGitQuiet,
  currentBranch,
  detectRemoteRepo,
  gitRoot,
  headSha,
  ReviewCliError,
} from "./git_ops.ts";
import {
  buildLocalRevision,
  mergeBase,
  resolveBaseRef,
} from "./git_revision.ts";
import {
  clearLocalCarry,
  localSubjectId,
  saveLocalCarry,
  tryLoadLocalCarry,
} from "./carry_over_store.ts";

function storedFindings(
  resolved: ResolvedFinding[],
): StoredFinding[] {
  return resolved
    .filter((row) => row.state === "new" || row.state === "open")
    .map((row) => ({
      id: row.id,
      path: row.path,
      lineFrom: row.lineFrom,
      lineTo: row.lineTo,
      title: row.title,
      bodyMd: row.bodyMd,
      anchorText: row.anchorText,
      severity: row.severity,
      firstSeenReviewId: row.firstSeenReviewId,
    }));
}

function fail(error: ReviewCliError, json: boolean): never {
  if (json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: { code: error.code, message: error.message, hint: error.hint },
      exitCode: error.exitCode,
    }));
  } else {
    console.error(error.message);
    if (error.hint) console.error(`Hint: ${error.hint}`);
  }
  Deno.exit(error.exitCode);
}

function installInterruptCleanup(
  releaseSync: () => (() => void) | null,
): () => void {
  const onSignal = () => {
    releaseSync()?.();
    Deno.exit(130);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, onSignal);
    } catch {
      // unavailable on some platforms
    }
  }
  return () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      try {
        Deno.removeSignalListener(signal, onSignal);
      } catch {
        // ignore
      }
    }
  };
}

export async function runLocalReview(cli: ReviewCliArgs & { mode: "local" }): Promise<void> {
  const json = cli.json;
  setCliInteractive(!json);
  let lock: LocalReviewLock | null = null;
  const clearInterrupt = installInterruptCleanup(() => lock?.releaseSync ?? null);
  await withCliLogsToStderr(async () => {
  try {
    const cwd = Deno.cwd();
    const root = await gitRoot(cwd);
    await assertGitQuiet(root);
    const repo = await detectRemoteRepo(root, cli.repoOverride);
    const branch = await currentBranch(root, cli.branch);
    const options = parseArgs([
      "review",
      repo,
      ...filterReviewConfigArgs(cli.rawArgs),
    ]);
    options.useCodegraph = cli.disableCodegraph ? false : true;

    const guides = await loadGuides(repo);
    if (!guides.shortGuide && !guides.skill) {
      throw new ReviewCliError(
        "not_initialized",
        `Review guides are missing for ${repo}.`,
        `co-maintainer init ${repo}`,
      );
    }
    if (cli.remakeBeforeReview) {
      await runInitOrRemake({ ...options, command: "remake" });
    }

    const remotes = await runCommand("git", ["remote"], root);
    const remoteName = ["upstream", "origin"].find((n) =>
      remotes.stdout.split("\n").map((l) => l.trim()).includes(n)
    ) ?? remotes.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0]!;
    const base = await resolveBaseRef(root, remoteName, cli.toBranch, runCommand);
    const baseSha = await mergeBase(root, base.ref, remoteName, runCommand);
    const built = await buildLocalRevision(root, baseSha, base.label, runCommand);
    let revision = built.revision;
    const warnings = built.warnings.map((w) => ({
      code: w.code,
      message: w.message,
    }));
    if (revision.files.length === 0) {
      if (json) {
        console.log(JSON.stringify({
          schemaVersion: 1,
          ok: true,
          mode: "local",
          message: "No changes to review.",
        }));
      } else {
        console.log("No changes to review.");
      }
      Deno.exit(0);
    }

    const subjectId = localSubjectId(repo, root, branch);
    if (cli.fresh) await clearLocalCarry(repo, root, branch);
    const carryLoad = await tryLoadLocalCarry(repo, root, branch);
    if (carryLoad.unavailable) {
      warnings.push({
        code: "carry_over_unavailable",
        message:
          "Could not read the local carry-over cache; continuing without prior findings.",
      });
    }
    const previous = carryLoad.data;
    let carryPrevious: CarryPrevious | null = null;
    let carryItems: ReturnType<typeof classifyCarryItems> = [];
    const extras: { carryPrompt?: string; unchangedPaths?: string[] } = {};
    if (previous) {
      carryPrevious = {
        files: previous.files,
        visiblePaths: new Set(previous.visiblePaths),
        findings: previous.findings,
        guideBuiltAt: previous.guideBuiltAt,
      };
      const { unchanged } = incrementalDiffPaths(revision, previous.files);
      extras.unchangedPaths = unchanged;
      carryItems = classifyCarryItems(
        carryPrevious,
        revision,
        carryPrevious.visiblePaths,
        guides.guideBuiltAt,
      );
      extras.carryPrompt = buildCarryPromptSection(carryItems, revision);
    }

    const sha = await headSha(root);
    const revisionHashBefore = await revisionHash(revision);
    lock = await acquireLocalReviewLock(root);
    const codegraphPrep = await prepareLocalCodegraph({
      gitRoot: root,
      enabled: options.useCodegraph === true,
      allowInstall: cli.allowToolInstall,
      interactive: !json,
    });
    extras.prepareCodegraphTools = () => Promise.resolve(codegraphPrep.tools);
    const stopHeartbeat = startHeartbeat("reviewing local changes");
    const started = performance.now();
    const aiMetrics = emptyAiMetrics();
    let response;
    try {
      response = await timed("local review AI", options.logTime, () =>
        reviewWorkspaceRevision(
          revision,
          options,
          sha,
          async (usage) => {
            aiMetrics.calls++;
            aiMetrics.tokensIn += usage.tokensIn;
            aiMetrics.tokensOut += usage.tokensOut;
            if (usage.cost === undefined) aiMetrics.costKnown = false;
            else aiMetrics.cost += usage.cost;
            await recordAiCost(repo, "review_local", usage);
          },
          aiFor(options),
          (message) => log("review", message),
          extras,
        )
      );
    } finally {
      await lock?.release();
      lock = null;
    }
    stopHeartbeat();
    const codegraphState = codegraphPrep.state;

    const visiblePaths = new Set(response.visiblePaths);
    if (carryPrevious) {
      carryItems = classifyCarryItems(
        carryPrevious,
        revision,
        visiblePaths,
        response.guideBuiltAt,
      );
    }
    const parsed = parseFindings(response.text);
    const filesByPath = new Map(revision.files.map((f) => [f.path, f]));
    const allResolved = carryPrevious
      ? resolveCarryOutcomes(
        carryItems,
        revision,
        visiblePaths,
        parsePreviousVerdicts(response.text),
        parsed,
        response.guideBuiltAt,
        carryPrevious,
      )
      : resolvedFromFirstReview(parsed, filesByPath);
    const findingsToStore = storedFindings(allResolved);

    const afterBuilt = await buildLocalRevision(
      root,
      baseSha,
      base.label,
      runCommand,
    );
    const revisionHashAfter = await revisionHash(afterBuilt.revision);
    if (revisionHashAfter !== revisionHashBefore) {
      warnings.push({
        code: "working_tree_changed",
        message:
          "Files changed while the review was running. Results reflect the state at submit time.",
      });
    }

    try {
      await saveLocalCarry({
        subjectId,
        files: revision.files,
        visiblePaths: [...visiblePaths],
        findings: findingsToStore,
        guideBuiltAt: response.guideBuiltAt,
      });
    } catch {
      warnings.push({
        code: "carry_over_unavailable",
        message: "Could not save local carry-over state for the next review.",
      });
    }

    const header =
      `co-maintainer review · ${repo} · ${branch} → ${base.label}`;
    const durationMs = Math.round(performance.now() - started);
    const usage = {
      tokensIn: aiMetrics.tokensIn,
      tokensOut: aiMetrics.tokensOut,
      costUsd: aiMetrics.costKnown ? aiMetrics.cost : null,
    };
    if (json) {
      console.log(buildLocalReviewJson({
        repo,
        branch,
        baseLabel: base.label,
        revision,
        guideBuiltAt: response.guideBuiltAt,
        codegraphState,
        codegraphReason: codegraphPrep.reason,
        findings: allResolved,
        warnings,
        usage,
        durationMs,
      }));
    } else {
      console.log(
        "\n" +
          formatHumanLocalReview(
            header,
            revision,
            response.guideBuiltAt,
            codegraphState,
            allResolved,
            warnings,
          ) +
          "\n",
      );
    }
    Deno.exit(reviewExitCodeFromResolved(allResolved));
  } catch (error) {
    if (error instanceof ReviewCliError) fail(error, json);
    throw error;
  } finally {
    clearInterrupt();
  }
  });
}
