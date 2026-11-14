/** Runs the extensions of one review.
 *
 * The AI review is the start point and never waits for an extension. An
 * extension with no run-after starts with the review, one with `--run-after`
 * starts when its target finishes, and `--parallelism=false` with no run-after
 * waits for the review. Every extension that becomes ready at the same moment
 * starts in priority order, 3 first, ties in registration order. There is no
 * other limit: `max-concurrent-jobs` already bounds the reviews.
 *
 * A run ends in one of three states. `retry` is never final: it is honoured up
 * to the registration's limit and then becomes Failed. */
import {
  formatTimeout,
  REVIEW_TARGET,
  type ExtensionRegistration,
} from "./registry.ts";
import { runCommandOnce, substitute, type ProcessOutcome } from "./process.ts";
import {
  parseResponse,
  type ExtensionData,
  type ExtensionFindingInput,
  type ExtensionResponse,
  type ExtensionUsage,
  type ExtensionVerdict,
} from "./schema.ts";
import { markFinished, markStarted, type RunFolder } from "./run_folder.ts";

export type ExtensionResult = {
  /** The registered name, which is the extension's id in every output. */
  name: string;
  status: "ok" | "failed" | "skipped";
  verdict: ExtensionVerdict | null;
  reason: string | null;
  markdown: string;
  findings: ExtensionFindingInput[];
  data: ExtensionData;
  extraData: unknown;
  usage: ExtensionUsage | null;
  /** stdout and stderr with the exit code, kept for a failure. */
  details: string | null;
  durationMs: number;
  attempts: number;
};

export type RunnerInput = {
  /** The registrations that apply to this review, in registration order. */
  registrations: ExtensionRegistration[];
  folder: RunFolder;
  /** The working directory a local review's extensions run in. */
  cwd?: string;
  /** Resolves true once the review results are written, false when the
   * review did not finish. */
  reviewDone: Promise<boolean>;
  signal?: AbortSignal;
  rerunOnRestart: (registration: ExtensionRegistration) => boolean;
  killGraceMs?: number;
  /** Waits out a `retryAfterSeconds`. Tests pass a shorter one. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
};

const EMPTY_DATA: ExtensionData = { media: [], metrics: [] };

function blank(
  name: string,
  status: "failed" | "skipped",
  reason: string,
): ExtensionResult {
  return {
    name,
    status,
    verdict: null,
    reason,
    markdown: "",
    findings: [],
    data: EMPTY_DATA,
    extraData: null,
    usage: null,
    details: null,
    durationMs: 0,
    attempts: 0,
  };
}

/** A Failed result for an extension that never ran. */
export function failedResult(name: string, reason: string): ExtensionResult {
  return blank(name, "failed", reason);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The target an extension waits for: its run-after, or the review when it
 * may not run alongside it. */
export function dependencyOf(
  registration: Pick<ExtensionRegistration, "runAfter" | "parallelism">,
): string | undefined {
  if (registration.runAfter) return registration.runAfter;
  return registration.parallelism === false ? REVIEW_TARGET : undefined;
}

/** Names whose run-after chain loops. `register` refuses a cycle, so this
 * only catches a config edited by hand, which would otherwise wait forever. */
function namesInCycles(registrations: ExtensionRegistration[]): Set<string> {
  const next = new Map(registrations.map((entry) => [entry.name, entry]));
  const looping = new Set<string>();
  for (const start of registrations) {
    const seen = new Set<string>([start.name]);
    let current = start.runAfter;
    while (current && current !== REVIEW_TARGET && next.has(current)) {
      if (seen.has(current)) {
        looping.add(start.name);
        break;
      }
      seen.add(current);
      current = next.get(current)!.runAfter;
    }
  }
  return looping;
}

/** Orders a set that becomes ready together: priority 3 first, ties in
 * registration order. */
export function startOrder(
  registrations: ExtensionRegistration[],
): ExtensionRegistration[] {
  return registrations
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (b.entry.priority ?? 0) - (a.entry.priority ?? 0) || a.index - b.index,
    )
    .map(({ entry }) => entry);
}

function failureReason(outcome: ProcessOutcome, problem: string): string {
  if (outcome.spawnError)
    return `the command could not start: ${outcome.spawnError}`;
  if (outcome.stdoutTooLarge) return "stdout was larger than 16 MiB";
  if (outcome.stdout.trim() === "" && outcome.exitCode !== 0) {
    return outcome.signal
      ? `the command was killed by ${outcome.signal} and printed no response`
      : `the command exited with code ${outcome.exitCode} and printed no response`;
  }
  return `the response does not match the schema: ${problem}`;
}

function fromResponse(
  name: string,
  response: ExtensionResponse,
  outcome: ProcessOutcome,
  started: number,
  attempts: number,
): ExtensionResult {
  const status = response.status === "ok" ? "ok" : response.status;
  return {
    name,
    status: status as ExtensionResult["status"],
    verdict: response.verdict ?? null,
    reason:
      response.reason ??
      (status === "failed" ? "the extension reported a failure" : null),
    markdown: response.markdown,
    findings: response.findings,
    data: response.data,
    extraData: response.extraData,
    usage: response.usage ?? null,
    details: status === "failed" ? outcome.details : null,
    durationMs: Math.round(performance.now() - started),
    attempts,
  };
}

/** One extension from its first attempt to its final state: schema retries,
 * requested retries, the timeout and a cancel. */
export async function runAttempts(input: {
  registration: ExtensionRegistration;
  command: string;
  cwd?: string;
  signal?: AbortSignal;
  killGraceMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}): Promise<ExtensionResult> {
  const { registration } = input;
  const sleep = input.sleep ?? defaultSleep;
  const log = input.log ?? (() => {});
  const started = performance.now();
  let attempts = 0;
  let schemaRetries = 0;
  let requested = 0;
  const failed = (reason: string, details: string | null) => ({
    ...blank(registration.name, "failed", reason),
    details,
    durationMs: Math.round(performance.now() - started),
    attempts,
  });
  while (true) {
    attempts++;
    log(`extension ${registration.name}: attempt ${attempts}`);
    const outcome = await runCommandOnce({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: registration.timeoutSeconds * 1000,
      signal: input.signal,
      killGraceMs: input.killGraceMs,
    });
    if (outcome.canceled) {
      return failed("the review was cancelled", outcome.details);
    }
    if (outcome.timedOut) {
      return failed(
        `timed out after ${formatTimeout(registration.timeoutSeconds)}`,
        outcome.details,
      );
    }
    const parsed = outcome.stdoutTooLarge
      ? ({ ok: false, reason: "stdout too large" } as const)
      : parseResponse(outcome.stdout);
    if (!parsed.ok) {
      const unsupported = parsed.reason.startsWith("unsupported schemaVersion");
      const reason = unsupported
        ? parsed.reason
        : failureReason(outcome, parsed.reason);
      if (!unsupported && schemaRetries < registration.retryOnFailTimes) {
        schemaRetries++;
        log(`extension ${registration.name}: ${reason}, retrying`);
        continue;
      }
      return failed(reason, outcome.details);
    }
    const response = parsed.response;
    if (response.status === "retry") {
      if (requested >= registration.maxRequestedRetries) {
        return failed(
          `asked for a retry more than ${registration.maxRequestedRetries} time${
            registration.maxRequestedRetries === 1 ? "" : "s"
          }. Last reason: ${response.reason}`,
          outcome.details,
        );
      }
      requested++;
      log(
        `extension ${registration.name}: asked to retry in ${response.retryAfterSeconds}s (${response.reason})`,
      );
      await sleep((response.retryAfterSeconds ?? 0) * 1000, input.signal);
      if (input.signal?.aborted) {
        return failed("the review was cancelled", outcome.details);
      }
      continue;
    }
    return fromResponse(
      registration.name,
      response,
      outcome,
      started,
      attempts,
    );
  }
}

export async function runExtensions(
  input: RunnerInput,
): Promise<ExtensionResult[]> {
  const byName = new Map(
    input.registrations.map((entry) => [entry.name, entry]),
  );
  const looping = namesInCycles(input.registrations);
  const results = new Map<string, Promise<ExtensionResult>>();
  let reviewFinished = false;
  void input.reviewDone.then((done) => {
    reviewFinished = done;
  });

  const runOne = async (
    registration: ExtensionRegistration,
  ): Promise<ExtensionResult> => {
    const name = registration.name;
    if (looping.has(name)) {
      return blank(name, "skipped", "its run-after chain is a cycle");
    }
    const target = dependencyOf(registration);
    if (target === REVIEW_TARGET) {
      if (!(await input.reviewDone)) {
        return blank(name, "failed", "the review did not finish");
      }
      reviewFinished = true;
    } else if (target !== undefined) {
      const waitedOn = byName.get(target);
      const pending = results.get(target);
      if (!waitedOn || !pending) {
        return blank(
          name,
          "skipped",
          `it runs after ${target}, which does not run for this review`,
        );
      }
      const outcome = await pending;
      if (outcome.status === "skipped") {
        return blank(
          name,
          "skipped",
          `it runs after ${target}, which was skipped`,
        );
      }
      if (outcome.status === "failed" && waitedOn.failFast) {
        return blank(name, "skipped", `it runs after ${target}, which failed`);
      }
    }
    if (input.signal?.aborted) {
      return blank(name, "failed", "the review was cancelled");
    }
    if (
      input.folder.restarted &&
      input.folder.startedBefore.has(name) &&
      !input.folder.finishedBefore.has(name) &&
      !input.rerunOnRestart(registration)
    ) {
      return blank(
        name,
        "failed",
        "co-maintainer restarted while it was running, and it is set not to run again",
      );
    }
    await markStarted(input.folder, name);
    const command = substitute(registration.command, {
      details_path: input.folder.detailsPath,
      review_result_path: reviewFinished ? input.folder.reviewResultPath : "",
      diff_path: input.folder.diffPath,
    });
    const result = await runAttempts({
      registration,
      command,
      cwd: input.cwd,
      signal: input.signal,
      killGraceMs: input.killGraceMs,
      sleep: input.sleep,
      log: input.log,
    });
    // A cancel is not a finish: a restart after it reruns the extension.
    if (!input.signal?.aborted) {
      await markFinished(input.folder, name).catch(() => {});
    }
    return result;
  };

  // Every promise is in the map before any of them looks a target up, and the
  // ones that become ready together resume in the order they were made, which
  // is priority order.
  for (const registration of startOrder(input.registrations)) {
    results.set(
      registration.name,
      Promise.resolve()
        .then(() => runOne(registration))
        .catch((error: unknown) =>
          blank(
            registration.name,
            "failed",
            `co-maintainer could not run it: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
    );
  }
  const settled = await Promise.all(
    input.registrations.map((entry) => results.get(entry.name)!),
  );
  return settled;
}
