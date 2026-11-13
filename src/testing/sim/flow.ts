/** What a flow is, and how one runs.
 *
 * A flow is one file under `flows/`: a name, the fake AI's script, the steps
 * that drive the product, and the checks and scores that judge what it did.
 * Each flow runs in its own world (sandbox, simulated GitHub, trace), so no
 * flow sees another's files. The checks and scores in `checks/common.ts` are
 * added to every flow.
 *
 * Product modules are imported inside a step (`await import(...)`), never at
 * the top of a flow file: the world sets the env first, and a module must not
 * read it before then. */
import type { Options } from "../../types.ts";
import { watchAi } from "./ai_watch.ts";
import {
  commonChecks,
  commonScores,
  type CheckResult,
  type Score,
} from "./checks/common.ts";
import { type AiRule, FakeAi } from "./fake_ai.ts";
import { Faults } from "./faults.ts";
import { installFetch } from "./fetch.ts";
import { ghStandIn } from "./gh_stand_in.ts";
import type { SimGithub } from "./github.ts";
import type { StepResult } from "./report.ts";
import { SAMPLE_REPO } from "./sample_repo.ts";
import { SimServer } from "./server.ts";
import {
  dumpDatabase,
  readFiles,
  readGitTrace,
  readSandbox,
  Trace,
} from "./trace.ts";
import { AI_HOSTS, createWorld, type SimRepo, type World } from "./world.ts";

export type { CheckResult, Score };

export type Step = {
  name: string;
  /** Drives the product. What it returns is shown on the step's line. */
  run(sim: Sim): Promise<string | void> | string | void;
  /** The step is meant to fail: it passes when `run` throws. The error is
   * kept in `sim.errors` either way. */
  expectError?: boolean;
};

export type Flow = {
  name: string;
  /** One sentence for `--help` and the report. */
  description: string;
  /** The fake AI's answers. Without `--ai` a call no rule answers fails the
   * "every AI call scripted" check. With `--ai` the real model answers. */
  ai?: AiRule[];
  steps: Step[];
  /** Deterministic: a failing check fails the run. */
  checks?(sim: Sim): CheckResult[] | Promise<CheckResult[]>;
  /** Only reported. Scores may call a judge model; they run before the
   * checks, so a judge call that leaves the simulation still fails the run. */
  scores?(sim: Sim): Score[] | Promise<Score[]>;
  /** Inherited checks this flow turns off, each with the reason the report
   * shows, e.g. `{ "cost recorded for every AI call": "..." }`. */
  skipInherited?: Record<string, string>;
};

/** Returns the flow unchanged. It only lets the editor check the shape. */
export function defineFlow(flow: Flow): Flow {
  return flow;
}

/** A check result in one call. */
export function check(name: string, ok: boolean, detail = ""): CheckResult {
  return { name, ok, detail };
}

/** What the runner was told on the command line. */
export type RunSettings = {
  mode: "fake" | "live";
  provider: Options["ai"];
  /** The real key with `--ai`. Without it each world makes one up. */
  aiKey?: string;
  lowModel: string;
  highModel: string;
  judge?: { provider: Options["ai"]; key: string; model: string };
  /** The run's start on the `performance.now()` clock. */
  origin: number;
};

/** Everything a step, a check or a score can reach. */
export type Sim = {
  flow: string;
  mode: "fake" | "live";
  world: World;
  github: SimGithub;
  trace: Trace;
  /** The fake AI. `sim.ai.use(...)` adds rules in the middle of a flow. */
  ai: FakeAi;
  /** `sim.faults.add({ target: "github", kind: "500", path: "/check-runs" })`
   * makes the next matching call fail. */
  faults: Faults;
  /** The `serve` side: config, app.db, webhooks, jobs, remote tokens. */
  server: SimServer;
  /** Product options with the world's credentials: PAT auth and the run's
   * AI provider and models. `patch` overrides any of them. */
  options(patch?: Partial<Options>): Options;
  /** Creates a repository GitHub knows, the sample one by default. */
  repo(fullName: string, files?: Record<string, string>): SimRepo;
  /** Runs the CLI in this process, as `co-maintainer <args>`, and returns
   * what it printed and its exit code. */
  cli(args: string[]): Promise<CliRun>;
  paths: {
    reposDir: string;
    appDb: string;
    cacheDb: string;
    clonesDir: string;
  };
  /** What each step threw, by step name. */
  errors: Map<string, unknown>;
  /** The flow's own values, kept from one step to the next. */
  state: Record<string, unknown>;
  /** Set when every `--judge-*` flag was given. */
  judge?: { options: Options; model: string };
};

export type CliRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** What `run` threw, after the CLI reported it. */
  error?: unknown;
};

export type FlowResult = {
  name: string;
  description: string;
  passed: boolean;
  startMs: number;
  durationMs: number;
  steps: StepResult[];
  checks: CheckResult[];
  scores: Score[];
  /** Everything the report keeps about this flow. */
  trace: Record<string, unknown>;
};

export type Printer = {
  step(step: StepResult): void;
  check(check: CheckResult): void;
  score(score: Score): void;
};

/** Captures what the product prints. `console.log` writes through
 * `process.stdout.write`, so patching the two streams catches both. */
async function captured<T>(
  fn: () => Promise<T>,
): Promise<{ stdout: string; stderr: string; result?: T; error?: unknown }> {
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const sink =
    (into: string[]) =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      into.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      const done = rest.find((item) => typeof item === "function");
      if (typeof done === "function") done();
      return true;
    };
  process.stdout.write = sink(out) as typeof process.stdout.write;
  process.stderr.write = sink(err) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { stdout: out.join(""), stderr: err.join(""), result };
  } catch (error) {
    return { stdout: out.join(""), stderr: err.join(""), error };
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
}

function baseOptions(settings: RunSettings, world: World): Options {
  return {
    command: "init",
    repo: "",
    debug: false,
    logTime: false,
    improveMatrix: 1,
    ghConcurrent: 4,
    aiConcurrent: 3,
    auth: "pat",
    githubPat: world.secrets.pat,
    // The fake AI answers OpenRouter's protocol through the caught fetch.
    ai: settings.provider,
    aiToken: world.secrets.aiKey,
    lowModel: settings.lowModel,
    highModel: settings.highModel,
    synthesisVersion: 17,
    includeCodebase: true,
    includePullRequests: false,
    includePullRequestChanges: false,
    includeCommitHistory: false,
    includeHowRepoWorks: false,
    onlyRequestChangedPr: false,
    maxPrMonths: 12,
  };
}

/** Product state kept in modules, not in the sandbox, that would reach the
 * next flow in this process. Each item here has a clear function the product
 * already exports. What is left is named in CONTRIBUTING.md: it is keyed by
 * something new in every world (installation id, job id, sandbox path) or
 * clears itself. */
async function resetProductState(): Promise<void> {
  (await import("../../remote/server/byok_keys.ts")).clearByokKeysForTest();
  (await import("../../services/watch_status.ts")).clearWatchStatusCache();
  // `--json` turns prompts off for the process. The next flow starts as a
  // fresh CLI would.
  (await import("../../cli/args.ts")).setCliInteractive(true);
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Runs one flow in a fresh world and prints each line as it happens. */
export async function runFlow(
  flow: Flow,
  settings: RunSettings,
  print: Printer,
  keepSandbox = false,
): Promise<FlowResult> {
  const flowStarted = performance.now();
  const steps: StepResult[] = [];
  const trace = new Trace(settings.origin);
  const finishStep = (
    name: string,
    from: number,
    ok: boolean,
    detail: string,
  ) => {
    const step = {
      name: `${flow.name}: ${name}`,
      ok,
      startMs: Math.round(from - settings.origin),
      ms: performance.now() - from,
      detail,
    };
    steps.push(step);
    print.step(step);
  };

  let at = performance.now();
  const world = createWorld({ aiKey: settings.aiKey });
  if (settings.judge?.key) {
    world.addSecret("judge key", settings.judge.key, AI_HOSTS);
  }
  const fakeAi = new FakeAi();
  fakeAi.use(...(flow.ai ?? []));
  const faults = new Faults();
  const restoreFetch = installFetch({
    world,
    trace,
    ai: settings.mode,
    fakeAi,
    faults,
  });
  // Product modules load only now, after the world has set the env.
  const { setGhRunner } = await import("../../github/gh.ts");
  setGhRunner(ghStandIn({ github: world.github, trace, faults }));
  const restoreAi = await watchAi(trace);
  const server = new SimServer(world, trace, {
    ai: settings.provider,
    token: world.secrets.aiKey,
    lowModel: settings.lowModel,
    highModel: settings.highModel,
  });
  const { reposDir, cacheDbPath } = await import("../../config.ts");
  const { appDbPath } = await import("../../store/app_db.ts");
  const { withLogSink } = await import("../../util/log.ts");
  const sim: Sim = {
    flow: flow.name,
    mode: settings.mode,
    world,
    github: world.github,
    trace,
    ai: fakeAi,
    faults,
    server,
    options: (patch = {}) => ({ ...baseOptions(settings, world), ...patch }),
    repo: (fullName, files = SAMPLE_REPO) => world.createRepo(fullName, files),
    cli: async (args) => {
      const { run, reportCliError } = await import("../../cli/main.ts");
      const argv = process.argv;
      const exitCode = process.exitCode;
      process.argv = [argv[0]!, "co-maintainer", ...args];
      process.exitCode = 0;
      try {
        const output = await captured(async () => {
          try {
            await run(args);
          } catch (error) {
            reportCliError(error);
            throw error;
          }
        });
        const exit = Number(process.exitCode ?? 0);
        // What the CLI printed is searched for secrets like any other place.
        // The arguments keep only the names of the secrets they carried.
        let shown = args;
        for (const secret of world.secretValues()) {
          shown = shown.map((arg) =>
            arg.replaceAll(secret.value, `[${secret.name}]`),
          );
        }
        trace.cli.push({
          step: trace.step,
          startMs: trace.now(),
          args: shown,
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: exit,
        });
        return {
          stdout: output.stdout,
          stderr: output.stderr,
          exitCode: exit,
          ...(output.error === undefined ? {} : { error: output.error }),
        };
      } finally {
        process.argv = argv;
        process.exitCode = exitCode;
      }
    },
    paths: {
      reposDir: reposDir(),
      appDb: appDbPath(),
      cacheDb: cacheDbPath(),
      clonesDir: process.env.CM_CLONES_DIR ?? "",
    },
    errors: new Map(),
    state: {},
    judge: settings.judge
      ? {
          options: {
            ...baseOptions(settings, world),
            ai: settings.judge.provider,
            aiToken: settings.judge.key,
          },
          model: settings.judge.model,
        }
      : undefined,
  };
  finishStep("sandbox ready", at, true, world.root);

  let checks: CheckResult[] = [];
  let scores: Score[] = [];
  try {
    let stopped = false;
    for (const step of flow.steps) {
      if (stopped) break;
      at = performance.now();
      trace.step = step.name;
      let error: unknown;
      let detail = "";
      try {
        const result = await withLogSink(
          (phase, text) => trace.log(phase, text),
          async () => step.run(sim),
        );
        detail = typeof result === "string" ? result : "";
      } catch (caught) {
        error = caught;
        sim.errors.set(step.name, caught);
      }
      const ok = step.expectError ? error !== undefined : error === undefined;
      if (error !== undefined) {
        detail = detail || message(error);
      } else if (step.expectError) {
        detail = detail || "no error, one was expected";
      }
      finishStep(step.name, at, ok, detail);
      // Later steps build on this one, so after an unexpected failure they
      // would only fail for the same reason.
      if (!ok) stopped = true;
    }

    at = performance.now();
    trace.step = "scores";
    try {
      scores = [...((await flow.scores?.(sim)) ?? [])];
    } catch (error) {
      // A score never fails the run, a judge that could not answer included.
      scores = [
        {
          name: "flow scores",
          value: null,
          detail: "",
          fakeAi: settings.mode === "fake",
          skipped: `failed: ${message(error)}`,
        },
      ];
    }
    scores.push(...commonScores(trace, settings.mode));
    finishStep("scores", at, true, `${scores.length} scores`);

    trace.step = "checks";
    try {
      checks = [...((await flow.checks?.(sim)) ?? [])];
    } catch (error) {
      checks = [check("flow checks ran", false, message(error))];
    }
    const inherited = commonChecks({
      trace,
      mode: settings.mode,
      github: world.github,
      secrets: world.secretValues(),
      files: readSandbox(world.root),
      appDbPath: appDbPath(),
      cacheDbPath: cacheDbPath(),
      unusedFaults: faults.unused(),
      unusedRules: fakeAi.unused().map((rule) => rule.name ?? ""),
    }).map((result) => {
      const reason = flow.skipInherited?.[result.name];
      return reason ? { ...result, ok: true, skipped: reason } : result;
    });
    // A flow check with the same name as an inherited one replaces it.
    const own = new Set(checks.map((result) => result.name));
    checks.push(...inherited.filter((result) => !own.has(result.name)));
    for (const result of checks) print.check(result);
    for (const score of scores) print.score(score);

    return {
      name: flow.name,
      description: flow.description,
      passed:
        steps.every((step) => step.ok) &&
        checks.every((result) => result.ok || result.skipped !== undefined),
      startMs: Math.round(flowStarted - settings.origin),
      durationMs: Math.round(performance.now() - flowStarted),
      steps,
      checks,
      scores,
      trace: {
        github: trace.github,
        githubWrites: world.github.writes,
        ai: trace.ai,
        completions: trace.completions,
        remote: trace.remote,
        webhooks: trace.webhooks,
        jobs: trace.jobs,
        cli: trace.cli,
        credentials: trace.credentials,
        faults: {
          fired: faults.fired.map((fired) => ({
            ...fired,
            fault: { ...fired.fault, path: String(fired.fault.path ?? "") },
          })),
          unused: faults.unused().map((fault) => ({
            ...fault,
            path: String(fault.path ?? ""),
          })),
        },
        unusedAiRules: fakeAi.unused().map((rule) => rule.name ?? ""),
        leaks: trace.leaks,
        logs: trace.logs,
        git: readGitTrace(world.gitTracePath, Date.now() - trace.now()),
        files: readFiles(reposDir()),
        databases: {
          app: dumpDatabase(appDbPath()),
          cache: dumpDatabase(cacheDbPath()),
        },
      },
    };
  } finally {
    await resetProductState();
    await server.stop();
    restoreAi();
    setGhRunner(undefined);
    restoreFetch();
    if (!keepSandbox) world.dispose();
  }
}
