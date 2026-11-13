import { parseArgs } from "../cli/args.ts";
import {
  filterReviewConfigArgs,
  loadReviewSystemPromptFlags,
  reviewSystemPromptLimitFor,
  type ReviewCliArgs,
} from "../cli/review_args.ts";
import {
  buildLocalReviewJson,
  formatHumanLocalReview,
  humanFindingsFromResolved,
  reviewExitCodeFromResolved,
  type ReviewWarning,
} from "../cli/review_result.ts";
import {
  addAiMetrics,
  emptyAiMetrics,
  recordAiCost,
  runInitOrRemake,
} from "../services/setup.ts";
import { aiFor } from "../services/review.ts";
import { loadGuides } from "../review/guides.ts";
import { hasGuides, notInitializedError } from "../review/not_initialized.ts";
import { guideRebuiltSince } from "../review/carry_over.ts";
import {
  finishCarryRun,
  startCarryRun,
  storedFindings,
} from "../cli/review_carry.ts";
import { revisionHash } from "../review/revision.ts";
import { type ReviewExtras, reviewWorkspaceRevision } from "../pr/reviewer.ts";
import { runCommand } from "../pr/checkout.ts";
import {
  log,
  startHeartbeat,
  timed,
  withCliLogsToStderr,
} from "../util/log.ts";
import { printRunSummary, summaryFromMetrics } from "../util/run_summary.ts";
import { emitGithubOutput } from "../cli/review_github.ts";
import { setCliInteractive } from "../cli/args.ts";
import { prepareLocalCodegraph } from "./codegraph_prepare.ts";
import { canPrompt } from "../tools/codegraph.ts";
import { acquireLocalReviewLock, type LocalReviewLock } from "./review_lock.ts";
import {
  assertGitQuiet,
  currentBranch,
  detectRemoteRepo,
  gitRoot,
  headSha,
  ReviewCliError,
} from "./git_ops.ts";
import { EXIT_RUNTIME, exitWith } from "../cli/error.ts";
import {
  armInterrupt,
  disarmInterrupt,
  interrupted,
} from "../util/interrupt.ts";
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
import { costUsage } from "../util/cost.ts";

function fail(error: ReviewCliError, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: { code: error.code, message: error.message, hint: error.hint },
        exitCode: error.exitCode,
      }),
    );
  } else {
    console.error(error.message);
    if (error.hint) console.error(`Hint: ${error.hint}`);
  }
  // Set the exit code and return; `process.exit` here would assert in libuv on
  // Windows whenever a fetch pool is open.
  exitWith(error.exitCode);
}

/** Ctrl-C stops the review: the lock is released, `--json` gets the one
 * "aborted" document, the exit code is 3, and the armed interrupt aborts the
 * model call in flight so the event loop drains and the process ends. The
 * review checks `interrupted()` before it prints or saves anything, so no
 * second output follows. A second Ctrl-C meets Node's default and ends the
 * process at once, as it does for `review --remote`. */
function installInterruptCleanup(
  releaseSync: () => (() => void) | null,
  json: boolean,
): () => void {
  const controller = armInterrupt();
  const remove = () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      try {
        process.removeListener(signal, onSignal);
      } catch {
        // ignore
      }
    }
  };
  const onSignal = () => {
    remove();
    releaseSync()?.();
    if (json) {
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: {
            code: "aborted",
            message: "Review canceled.",
          },
          exitCode: EXIT_RUNTIME,
        }),
      );
    }
    exitWith(EXIT_RUNTIME);
    controller.abort();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      process.on(signal, onSignal);
    } catch {
      // unavailable on some platforms
    }
  }
  return () => {
    remove();
    disarmInterrupt();
  };
}

export async function runLocalReview(
  cli: ReviewCliArgs & { mode: "local" },
): Promise<void> {
  const json = cli.json;
  setCliInteractive(!json);
  let lock: LocalReviewLock | null = null;
  const clearInterrupt = installInterruptCleanup(
    () => lock?.releaseSync ?? null,
    json,
  );
  await withCliLogsToStderr(async () => {
    try {
      const cwd = process.cwd();
      const root = await gitRoot(cwd);
      await assertGitQuiet(root);
      const repo = await detectRemoteRepo(root, cli.repoOverride);
      const branch = await currentBranch(root, cli.branch);
      const options = await parseArgs([
        "review",
        repo,
        ...filterReviewConfigArgs(cli.rawArgs),
      ]);
      options.useCodegraph = cli.disableCodegraph ? false : true;
      const promptFlags = await loadReviewSystemPromptFlags(
        cli,
        reviewSystemPromptLimitFor(repo),
      );
      options.reviewSystemPromptAdd = promptFlags.add;
      options.reviewSystemPromptOverride = promptFlags.override;

      const guides = await loadGuides(repo);
      if (!hasGuides(guides)) {
        // A `ReviewCliError`, so `fail()` below prints it the way local review
        // always has, without the `[error] ` prefix the top level adds.
        const missing = notInitializedError(repo);
        throw new ReviewCliError(
          missing.code,
          missing.message,
          missing.hint,
          missing.exitCode,
        );
      }
      if (cli.remakeBeforeReview) {
        if (options.auth !== "gh") {
          throw new ReviewCliError(
            "usage",
            "Sync before review requires GitHub CLI authentication (`--auth=gh`).",
          );
        }
        await runInitOrRemake({ ...options, command: "remake" });
        if (interrupted()) return;
      }

      const remotes = await runCommand("git", ["remote"], root);
      const remoteName =
        ["upstream", "origin"].find((n) =>
          remotes.stdout
            .split("\n")
            .map((l) => l.trim())
            .includes(n),
        ) ??
        remotes.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)[0]!;
      const base = await resolveBaseRef(
        root,
        remoteName,
        cli.toBranch,
        runCommand,
      );
      const baseSha = await mergeBase(root, base.ref, remoteName, runCommand);
      const built = await buildLocalRevision(
        root,
        baseSha,
        base.label,
        runCommand,
      );
      let revision = built.revision;
      const warnings: ReviewWarning[] = built.warnings.map((w) => ({
        code: w.code,
        message: w.message,
      }));
      if (interrupted()) return;
      if (revision.files.length === 0) {
        if (json) {
          console.log(
            JSON.stringify({
              schemaVersion: 1,
              ok: true,
              mode: "local",
              message: "No changes to review.",
            }),
          );
        } else {
          console.log("No changes to review.");
        }
        // `exitWith` only sets the code. Without the return the review went
        // on with an empty diff, called the model and printed a second report.
        exitWith(0);
        return;
      }

      const subjectId = localSubjectId(repo, root, branch);
      if (cli.fresh) await clearLocalCarry(repo, root, branch);
      const carryLoad = await tryLoadLocalCarry(repo, root, branch);
      if (carryLoad.unavailable) {
        warnings.push({
          code: "carry_over_unavailable",
          message:
            "Could not read the local carry-over cache. Continuing without prior findings.",
        });
      }
      let previous = carryLoad.data;
      // A guide rebuilt after the last review judged its findings under rules
      // that no longer exist. Rather than let those stale findings mask new
      // ones, start fresh automatically — the same effect as
      // `--fresh`, without making the user remember the flag.
      if (
        previous &&
        guideRebuiltSince(previous.guideBuiltAt, guides.guideBuiltAt)
      ) {
        await clearLocalCarry(repo, root, branch).catch(() => {});
        previous = null;
      }
      const carryRun = startCarryRun(previous, revision, guides.guideBuiltAt);
      // Local carry-over leaves out what the last run saw, so a file this
      // run drops is sent by the next one.
      const extras: ReviewExtras = { ...carryRun.extras, catchesUp: true };

      const sha = await headSha(root);
      const revisionHashBefore = await revisionHash(revision);
      lock = await acquireLocalReviewLock(root);
      const codegraphPrep = await prepareLocalCodegraph({
        gitRoot: root,
        enabled: options.useCodegraph === true,
        allowInstall: cli.allowToolInstall,
        // `--json` output must stay machine-readable, so never prompt then;
        // `canPrompt` adds the TTY and CI checks.
        interactive: !json && canPrompt(),
      });
      // Ctrl-C at the install prompt or during the index: stop before the
      // model call. The handler has released the lock.
      if (interrupted()) return;
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
              addAiMetrics(aiMetrics, usage);
              await recordAiCost(repo, "review_local", usage);
            },
            aiFor(options),
            (message) => log("review", message),
            extras,
          ),
        );
      } finally {
        // Stopping the heartbeat on the error path too, otherwise the interval
        // keeps the event loop alive and a post-fetch exit never lands.
        stopHeartbeat();
        await lock?.release();
        lock = null;
      }
      // Ctrl-C during the model call: the handler has printed the one output
      // and set the exit code, so nothing is saved or printed after it.
      if (interrupted()) return;
      const codegraphState = codegraphPrep.state;
      warnings.push(...response.warnings);

      const { resolved: allResolved, visiblePaths } = finishCarryRun(
        carryRun,
        revision,
        response,
      );
      const findingsToStore = storedFindings(allResolved);

      const afterBuilt = await buildLocalRevision(
        root,
        baseSha,
        base.label,
        runCommand,
      );
      const revisionHashAfter = await revisionHash(afterBuilt.revision);
      if (interrupted()) return;
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

      if (interrupted()) return;
      const header = `co-maintainer review · ${repo} · ${branch} → ${base.label}`;
      const durationMs = Math.round(performance.now() - started);
      const usage = {
        tokensIn: aiMetrics.tokensIn,
        tokensOut: aiMetrics.tokensOut,
        ...costUsage(aiMetrics),
      };
      if (json) {
        console.log(
          buildLocalReviewJson({
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
            reviewBlocking: options.reviewBlocking,
            coverage: response.coverage,
          }),
        );
      } else if (cli.output === "github") {
        emitGithubOutput({
          title: header,
          findings: humanFindingsFromResolved(
            allResolved,
            options.reviewBlocking,
          ),
          run: summaryFromMetrics(aiMetrics, performance.now() - started),
          coverage: response.coverage,
          catchesUp: true,
        });
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
              options.reviewBlocking,
              response.coverage,
            ) +
            "\n",
        );
        printRunSummary(
          summaryFromMetrics(aiMetrics, performance.now() - started),
        );
      }
      exitWith(reviewExitCodeFromResolved(allResolved, options.reviewBlocking));
    } catch (error) {
      // After Ctrl-C the aborted model call or sync throws. The handler has
      // already printed the one output and set the exit code.
      if (interrupted()) return;
      if (error instanceof ReviewCliError) {
        fail(error, json);
        return;
      }
      throw error;
    } finally {
      clearInterrupt();
    }
  });
}
