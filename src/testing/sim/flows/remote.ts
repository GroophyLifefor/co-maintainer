/** Remote review and push review: `review --remote` and `--range`.
 *
 * The client and the server run in this one process. The server is the one
 * `sim.server` starts, with `sim/sample` initialized; the client is a real
 * clone of `sim/sample` with a change, running the real CLI from inside it.
 * The remote wire tags every call with the side that made it, so the checks
 * can tell the client's calls from the server's.
 *
 * Feature flows build on the exports: `REMOTE_AI` and `PUSH_AI`,
 * `startRemoteServer`, `clientChange`, `runRemoteReview`, `runPushReview` and
 * the small readers below them. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { finding, type AiRule } from "../fake_ai.ts";
import {
  check,
  defineFlow,
  type CheckResult,
  type CliRun,
  type Score,
  type Sim,
} from "../flow.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";
import { dumpDatabase, readFiles } from "../trace.ts";
import { INIT_AI } from "./init.ts";
import {
  type Checkout,
  cliIn,
  clientCheckout,
  type CodegraphRun,
  installCodegraphStandIn,
  remoteWire,
  serveWhile,
} from "./remote_support.ts";

export { type Checkout, remoteWire, serveWhile } from "./remote_support.ts";

type Json = Record<string, unknown>;

/** The finding the first remote review reports. */
export const REMOTE_FINDING = finding({
  path: "src/format.ts",
  line: 7,
  title: "percentOf divides by zero when total is 0",
  body: "percentOf divides by total without a guard, so a total of 0 prints NaN%.",
  severity: "P1",
  blocking: true,
});

/** What the server's model answers a remote review with. A change that
 * names `percentOf` gets one codegraph round first, the way a model checks a
 * caller before it reports. The second round of the same branch answers the
 * carried finding as still open. `ratioOf` is the BYOK review's change, and
 * `login` is the old-shape request's diff. */
export const REMOTE_AI: AiRule[] = [
  {
    name: "remote second round",
    job: "review_local",
    prompt: "PREVIOUS FINDINGS",
    reply: {
      json: {
        findings: [],
        previousFindings: [
          { id: "F1", state: "open", path: "src/format.ts", lineFrom: 7 },
        ],
      },
    },
  },
  {
    name: "remote review asks codegraph",
    job: "review_local",
    prompt: "percentOf",
    reply: ({ round }) =>
      round === 0
        ? {
            toolCalls: [
              { name: "codegraph-query", arguments: { search: "clamp" } },
            ],
          }
        : { findings: [REMOTE_FINDING] },
  },
  {
    name: "remote review on the client's key",
    job: "review_local",
    prompt: "ratioOf",
    reply: {
      findings: [
        finding({
          path: "src/math.ts",
          line: 10,
          title: "ratioOf has no test",
          body: "ratioOf is exported without a test in test/math.test.ts.",
          severity: "P3",
        }),
      ],
    },
  },
  {
    name: "remote review of an old client",
    job: "review_local",
    prompt: "export function login",
    reply: { findings: [] },
  },
];

/** What the server's model answers a push review with: one P1, which commit
 * watch turns into an issue. */
export const PUSH_AI: AiRule[] = [
  {
    name: "push review",
    job: "review_push",
    prompt: "lerp",
    reply: {
      findings: [
        finding({
          path: "src/math.ts",
          line: 11,
          title: "lerp swaps its bounds",
          body: "lerp returns b when t is 0, so every caller gets the far end.",
          severity: "P1",
          blocking: true,
        }),
      ],
    },
  },
];

/** One CLI run against the remote server, and what it left behind. */
export type RemoteRun = CliRun & {
  step: string;
  /** The last JSON line the CLI printed, with `--json`. */
  json?: Json;
  /** The jobs the server answered a submit with, in order. */
  jobIds: string[];
  /** codegraph runs the client made that answered a tool call. */
  toolRuns: CodegraphRun[];
  /** The checkout the client ran in, resolved. */
  cwd: string;
};

type State = {
  token: string;
  dev: Checkout;
  runs: Map<string, RemoteRun>;
  byokKey: string;
  push: { before: string; after: string };
  oldShape: {
    handshake: number;
    submits: { status: number; jobId?: string }[];
    final?: Json;
    syncs: number;
  };
  tooLarge: { status: number; body: Json };
  deleted: { status: number; jobId: string }[];
};

function state(sim: Sim): State {
  return (sim.state.remote ??= {
    runs: new Map(),
    deleted: [],
  }) as State;
}

/** The server side: `sim/sample` (or `repo`) initialized with the init
 * flow's AI answers, `serve` started, a remote token, the codegraph
 * stand-in and the remote wire. Returns the token. */
export async function startRemoteServer(
  sim: Sim,
  config: Record<string, unknown> = {},
  repo = SAMPLE_REPO_NAME,
): Promise<string> {
  sim.repo(repo);
  const { runInitOrRemake } = await import("../../../services/setup.ts");
  await runInitOrRemake(sim.options({ command: "init", repo }));
  await sim.server.start(config);
  const token = await sim.server.remoteToken("client");
  await installCodegraphStandIn(sim);
  remoteWire(sim);
  return token;
}

/** A clone of `repo` on a new `branch`, with `files` written and committed. */
export function clientChange(
  sim: Sim,
  name: string,
  branch: string,
  files: Record<string, string>,
  repo = SAMPLE_REPO_NAME,
): Checkout {
  const checkout = clientCheckout(sim, repo, name);
  checkout.git(["switch", "-q", "-c", branch]);
  checkout.write(files);
  checkout.commit(`change on ${branch}`);
  return checkout;
}

async function runClient(
  sim: Sim,
  checkout: Checkout,
  args: string[],
  env: Record<string, string> = {},
  waitMs?: number,
): Promise<RemoteRun> {
  const codegraph = await installCodegraphStandIn(sim);
  const before = codegraph.toolRuns().length;
  const step = sim.trace.step;
  const run = await serveWhile(
    sim,
    () => cliIn(sim, checkout.dir, args, env),
    waitMs,
  );
  const last = run.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  let json: Json | undefined;
  if (args.includes("--json")) {
    try {
      json = JSON.parse(last) as Json;
    } catch {
      json = undefined;
    }
  }
  const result: RemoteRun = {
    ...run,
    step,
    ...(json ? { json } : {}),
    jobIds: remoteCalls(sim, step, "/api/remote/reviews", "POST")
      .map((call) => (call.response as Json | null)?.jobId)
      .filter((id): id is string => typeof id === "string"),
    toolRuns: codegraph.toolRuns().slice(before),
    cwd: realpathSync(checkout.dir),
  };
  state(sim).runs.set(step, result);
  return result;
}

/** `co-maintainer review --remote` in `checkout`, against the simulated
 * server, while the server runs its jobs. */
export async function runRemoteReview(
  sim: Sim,
  checkout: Checkout,
  args: string[] = [],
  env: Record<string, string> = {},
  waitMs?: number,
): Promise<RemoteRun> {
  const token = (args.find((arg) => arg.startsWith("--remote-token=")) ??
    `--remote-token=${state(sim).token}`) as string;
  return await runClient(
    sim,
    checkout,
    [
      "review",
      "--remote",
      `--remote-host=${sim.server.remoteUrl}`,
      token,
      ...args.filter((arg) => !arg.startsWith("--remote-token=")),
    ],
    env,
    waitMs,
  );
}

/** `co-maintainer review --remote --range=<before>..<after>` in `checkout`,
 * as a CI step after a push. */
export async function runPushReview(
  sim: Sim,
  checkout: Checkout,
  range: { before: string; after: string },
  args: string[] = [],
): Promise<RemoteRun> {
  return await runRemoteReview(sim, checkout, [
    `--range=${range.before}..${range.after}`,
    ...args,
  ]);
}

/** Remote calls of one step, as the core traced them (the server's real
 * answers). `path` matches the end of the URL's path. */
export function remoteCalls(
  sim: Sim,
  step: string,
  path?: string | RegExp,
  method?: string,
) {
  return sim.trace.remote.filter((call) => {
    if (call.step !== step) return false;
    if (method && call.method !== method) return false;
    const pathname = new URL(call.url).pathname;
    if (path === undefined) return true;
    return typeof path === "string"
      ? pathname.endsWith(path)
      : path.test(pathname);
  });
}

/** Rows of the server's app.db. */
export function appRows<T = Json>(
  sim: Sim,
  sql: string,
  ...params: string[]
): T[] {
  if (!existsSync(sim.paths.appDb)) return [];
  const database = new DatabaseSync(sim.paths.appDb, { readOnly: true });
  try {
    return database.prepare(sql).all(...params) as T[];
  } finally {
    database.close();
  }
}

/** The first user message of each model call of `job` in `step`. */
export function promptsOf(sim: Sim, step: string, job: string): string[] {
  return sim.trace.completions
    .filter((call) => call.step === step && call.job === job)
    .map((call) => call.firstUser);
}

const SYNC = /\/sync$/;

/** Tool calls the model asked for in `step`, from its answers. */
function askedTools(sim: Sim, step: string): string[] {
  return sim.trace.ai
    .filter((call) => call.step === step)
    .flatMap((call) => {
      const choices = ((call.response as Json | null)?.choices ?? []) as Json[];
      const calls = ((choices[0]?.message as Json | undefined)?.tool_calls ??
        []) as { function: { name: string; arguments: string } }[];
      return calls.map(
        (tool) =>
          `${tool.function.name} ${JSON.stringify(JSON.parse(tool.function.arguments))}`,
      );
    });
}

/** Tool calls the server handed the client in `step`'s sync answers. */
function deliveredTools(sim: Sim, step: string): string[] {
  return remoteCalls(sim, step, SYNC).flatMap((call) =>
    (((call.response as Json | null)?.toolCalls ?? []) as Json[]).map(
      (tool) => `${String(tool.name)} ${JSON.stringify(tool.arguments)}`,
    ),
  );
}

/** codegraph runs as tool calls, `codegraph-query {"search":"x"}`. */
function ranTools(runs: CodegraphRun[]): string[] {
  return runs.map((run) =>
    run.argv[0] === "query"
      ? `codegraph-query ${JSON.stringify({ search: run.argv[1] })}`
      : `codegraph-${run.argv[0]} ${JSON.stringify(run.argv.slice(1))}`,
  );
}

const sameList = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const STEP = {
  first: "remote review, a tool round, --json",
  second: "second round, carry-over, human output",
  byok: "own key (BYOK)",
  push: "push review --range",
  clean: "clean tree",
  badToken: "refused: bad token",
  unknownRepo: "refused: unknown repository",
  noGuides: "refused: repository without guides",
  clientCap: "refused: payload over the advertised limit",
  serverCap: "refused: payload over the server limit",
  oldShape: "old-shape request and a retried submit",
  cancel: "cancelled run",
  fault: "sync call times out",
} as const;

function runOf(sim: Sim, step: string): RemoteRun | undefined {
  return state(sim).runs.get(step);
}

function errorCode(run: RemoteRun | undefined): string {
  return String(((run?.json?.error ?? {}) as Json).code ?? "");
}

function jobRow(sim: Sim, jobId: string | undefined) {
  return appRows<{ status: string; cancel_reason: string | null }>(
    sim,
    "SELECT status, cancel_reason FROM jobs WHERE id = ?",
    jobId ?? "",
  )[0];
}

function reviewRow(sim: Sim, jobId: string | undefined) {
  return appRows<{
    id: string;
    kind: string;
    status: string;
    billed_to: string | null;
    findings_count: number | null;
    tokens_in: number | null;
  }>(
    sim,
    "SELECT id, kind, status, billed_to, findings_count, tokens_in FROM reviews WHERE job_id = ?",
    jobId ?? "",
  )[0];
}

function remoteChecks(sim: Sim): CheckResult[] {
  const s = state(sim);
  const wire = remoteWire(sim);
  const first = runOf(sim, STEP.first);
  const firstJob = first?.jobIds[0];
  const firstJson = first?.json ?? {};
  const firstFindings = (firstJson.findings ?? []) as Json[];
  const handshake = remoteCalls(sim, STEP.first, "/api/remote/handshake")[0];
  const features = ((handshake?.response as Json | null)?.features ??
    []) as string[];
  const reviewSystem = sim.trace.completions.find(
    (call) => call.step === STEP.first && call.job === "review_local",
  )?.system;
  const firstPrompt = promptsOf(sim, STEP.first, "review_local")[0] ?? "";

  const aiCalls = wire.calls.filter((call) => call.kind === "ai");
  const clientAi = aiCalls.filter((call) => call.side !== "server");
  const remote = wire.calls.filter((call) => call.kind === "remote");

  const asked = askedTools(sim, STEP.first);
  const delivered = deliveredTools(sim, STEP.first);
  const ran = ranTools(first?.toolRuns ?? []);
  const allDelivered = sim.trace.remote.flatMap((call) =>
    SYNC.test(new URL(call.url).pathname) ? deliveredTools(sim, call.step) : [],
  );
  const allRan = ranTools([...s.runs.values()].flatMap((run) => run.toolRuns));
  const toolAnswer = sim.trace.ai
    .filter((call) => call.step === STEP.first && call.job === "review_local")
    .flatMap((call) =>
      (((call.request as Json | null)?.messages ?? []) as Json[]).filter(
        (message) => message.role === "tool",
      ),
    )
    .map((message) => String(message.content ?? ""));

  const firstSyncs = remoteCalls(sim, STEP.first, SYNC);
  const doneSyncs = firstSyncs.filter(
    (call) => (call.response as Json | null)?.status === "done",
  );
  const firstReview = reviewRow(sim, firstJob);
  const firstRows = appRows(
    sim,
    "SELECT id FROM findings WHERE review_id = ?",
    firstReview?.id ?? "",
  );
  const inputsLeft = appRows(sim, "SELECT job_id FROM remote_review_inputs");

  const second = runOf(sim, STEP.second);
  const secondPrompt = promptsOf(sim, STEP.second, "review_local")[0] ?? "";
  const secondDiff = secondPrompt.slice(secondPrompt.lastIndexOf("DIFF:"));
  const secondReview = reviewRow(sim, second?.jobIds[0]);
  const config = sim.world.readConfig();

  const byok = runOf(sim, STEP.byok);
  const byokAi = wire.calls.filter(
    (call) => call.step === STEP.byok && call.kind === "ai",
  );
  const byokReview = reviewRow(sim, byok?.jobIds[0]);
  const keyPlaces = byokKeyPlaces(sim, s.byokKey);

  const push = runOf(sim, STEP.push);
  const pushJson = push?.json ?? {};
  const pushSubmit = remoteCalls(
    sim,
    STEP.push,
    "/api/remote/reviews",
    "POST",
  )[0];
  const pushBody = (pushSubmit?.request as Json | null)?.push as
    | Json
    | undefined;
  const pushReview = reviewRow(sim, push?.jobIds[0]);
  const issues = sim.github.writesTo(/^repos\/sim\/sample\/issues$/, "POST");
  const pushAi = wire.calls.filter(
    (call) => call.step === STEP.push && call.kind === "ai",
  );

  const clean = runOf(sim, STEP.clean);
  const refusals = [
    STEP.badToken,
    STEP.unknownRepo,
    STEP.noGuides,
    STEP.clientCap,
    STEP.serverCap,
  ];
  const refusalJobs = sim.trace.jobs.filter((job) =>
    (refusals as string[]).includes(job.step),
  );
  const refusalAi = sim.trace.completions.filter((call) =>
    (refusals as string[]).includes(call.step),
  );
  const badToken = runOf(sim, STEP.badToken);
  const unknownRepo = runOf(sim, STEP.unknownRepo);
  const noGuides = runOf(sim, STEP.noGuides);
  const noGuidesHandshake = remoteCalls(
    sim,
    STEP.noGuides,
    "/api/remote/handshake",
  )[0];
  const clientCap = runOf(sim, STEP.clientCap);
  const capSubmits = remoteCalls(
    sim,
    STEP.clientCap,
    "/api/remote/reviews",
    "POST",
  );

  const old = s.oldShape;
  const oldJobs = sim.trace.jobs.filter((job) => job.step === STEP.oldShape);

  const cancel = runOf(sim, STEP.cancel);
  const cancelJob = jobRow(sim, cancel?.jobIds[0]);
  const cancelReview = reviewRow(sim, cancel?.jobIds[0]);
  const deleted = s.deleted[0];

  const deleteAt =
    remoteCalls(sim, STEP.cancel, /\/reviews\/[^/]+$/, "DELETE")[0]?.startMs ??
    Infinity;
  const afterCancel = sim.trace.ai.filter(
    (call) => call.step === STEP.cancel && call.startMs > deleteAt,
  );
  const faultAi = sim.trace.ai.filter((call) => call.step === STEP.fault);

  const fault = runOf(sim, STEP.fault);
  const faultJob = jobRow(sim, fault?.jobIds[0]);
  const faultReview = reviewRow(sim, fault?.jobIds[0]);

  const unrepeatable = (
    reason: string,
    name: string,
    ok: boolean,
    detail: string,
  ) =>
    ok
      ? check(name, true, detail)
      : { ...check(name, false, detail), skipped: reason };

  return [
    check(
      "handshake advertises byok and push",
      features.includes("byok") && features.includes("push"),
      `features ${JSON.stringify(features)}`,
    ),
    check(
      "--json printed the server's result and exited 1 on a blocking finding",
      first?.exitCode === 1 &&
        firstJson.ok === true &&
        firstJson.mode === "remote" &&
        firstFindings.length === 1 &&
        firstFindings[0]?.blocking === true &&
        String(firstFindings[0]?.body ?? "").includes("NaN%") &&
        (firstJson.remote as Json | undefined)?.jobId === firstJob,
      `exit ${first?.exitCode} · ${firstFindings.length} findings · job ${String((firstJson.remote as Json | undefined)?.jobId ?? "none")}`,
    ),
    unrepeatable(
      "product bug: findingsMarkdownFromJson drops the JSON title, so every finding's title is its heading",
      "a finding keeps the title the model gave it",
      firstFindings[0]?.title === REMOTE_FINDING.title,
      `title ${JSON.stringify(firstFindings[0]?.title ?? null)}`,
    ),
    check(
      "the server reviewed with its own guides",
      Boolean(
        reviewSystem?.includes("Use named exports, not default exports."),
      ),
      reviewSystem
        ? `${reviewSystem.length} chars of system prompt`
        : "no review call",
    ),
    check(
      "the client's change reached the server's model",
      firstPrompt.includes("+export function percentOf") &&
        firstPrompt.includes("FILE: src/format.ts"),
      `${firstPrompt.length} chars`,
    ),
    check(
      "every AI call came from the server, none from the client",
      aiCalls.length > 0 && clientAi.length === 0,
      `${aiCalls.length - clientAi.length} server calls · ${clientAi.length} from ${[...new Set(clientAi.map((call) => call.side))].join(", ") || "nowhere else"}`,
    ),
    check(
      "every remote call came from the client",
      remote.length > 0 && remote.every((call) => call.side === "client"),
      `${remote.length} calls · sides ${[...new Set(remote.map((call) => call.side))].join(", ")}`,
    ),
    check(
      "the client ran exactly the tools the model asked for, in its checkout",
      asked.length > 0 &&
        sameList(asked, delivered) &&
        sameList(asked, ran) &&
        (first?.toolRuns ?? []).every(
          (run) => realpathSync(run.cwd) === first?.cwd,
        ),
      `asked ${JSON.stringify(asked)} · sent ${JSON.stringify(delivered)} · ran ${JSON.stringify(ran)}`,
    ),
    check(
      "no tool ran on the client that the server did not send",
      allRan.every(
        (tool) =>
          allRan.filter((other) => other === tool).length <=
          allDelivered.filter((other) => other === tool).length,
      ),
      `${allRan.length} runs · ${allDelivered.length} sent over the whole flow`,
    ),
    check(
      "the tool's answer from the client reached the model",
      toolAnswer.some((content) =>
        content.includes("src/math.ts:5  export function clamp"),
      ),
      toolAnswer.length
        ? `${toolAnswer.length} tool messages · ${toolAnswer[0]!.split("\n")[0]}`
        : "no tool message",
    ),
    check(
      "the sync loop stopped at the first done answer",
      firstSyncs.length >= 2 &&
        doneSyncs.length === 1 &&
        firstSyncs.at(-1) === doneSyncs[0],
      `${firstSyncs.length} syncs · ${doneSyncs.length} done`,
    ),
    check(
      "the server stored the review and its finding, and dropped the job input",
      firstReview?.status === "done" &&
        firstReview.billed_to === "server" &&
        firstReview.findings_count === 1 &&
        firstReview.tokens_in ===
          (firstJson.usage as Json | undefined)?.tokensIn &&
        firstRows.length === 1 &&
        inputsLeft.length === 0,
      `review ${firstReview?.status ?? "missing"} · ${firstRows.length} findings · ${inputsLeft.length} inputs left`,
    ),
    check(
      "the second round carried the first finding over",
      secondPrompt.includes("PREVIOUS FINDINGS") &&
        secondPrompt.includes("percentOf divides by total") &&
        /UNCHANGED SINCE LAST REVIEW[^]*- src\/format\.ts/.test(secondPrompt) &&
        secondDiff.includes("FILE: src/math.ts") &&
        !secondDiff.includes("FILE: src/format.ts"),
      `${secondPrompt.length} chars`,
    ),
    unrepeatable(
      "product bug: the remote job reads only new findings (resolvedFromFirstReview) and drops the model's previous-finding verdicts",
      "the second round still reports the finding the model kept open",
      (secondReview?.findings_count ?? 0) >= 1,
      `second review stored ${secondReview?.findings_count ?? "no"} findings · exit ${second?.exitCode}`,
    ),
    check(
      "human output: title, server log lines, the one-time notice",
      second?.exitCode === 0 &&
        Boolean(
          second.stdout.includes(
            "co-maintainer review · sim/sample · sim/feature (remote)",
          ),
        ) &&
        Boolean(
          second.stderr.includes("remote review started for sim/sample"),
        ) &&
        second.stderr.split("Remote review sends your unpublished diff")
          .length === 2 &&
        ((config.remoteNoticeShownFor ?? []) as string[]).includes(
          sim.server.remoteUrl,
        ),
      `exit ${second?.exitCode} · ${second?.stdout.length ?? 0} chars out`,
    ),
    check(
      "the client's own key paid for its review",
      byok?.exitCode === 0 &&
        byokAi.length > 0 &&
        byokAi.every((call) => call.key === "client key") &&
        byokReview?.billed_to === "byok" &&
        (byok.json?.usage as Json | undefined)?.billedTo === "byok",
      `exit ${byok?.exitCode} · keys ${JSON.stringify([...new Set(byokAi.map((call) => call.key))])} · billed ${byokReview?.billed_to ?? "?"}`,
    ),
    check(
      "the client's key was used, never stored",
      keyPlaces.stored.length === 0 &&
        keyPlaces.inTrace === 1 &&
        keyPlaces.held === 0,
      `stored in ${keyPlaces.stored.join(", ") || "nothing"} · ${keyPlaces.inTrace} trace entry (the submit) · ${keyPlaces.held} held in memory`,
    ),
    check(
      "push review exits 0 with a P1 and reports the range",
      push?.exitCode === 0 &&
        pushJson.mode === "push" &&
        ((pushJson.findings ?? []) as Json[]).length === 1 &&
        (pushJson.push as Json | undefined)?.after === s.push?.after &&
        pushBody?.before === s.push?.before &&
        pushBody?.ref === "refs/heads/main",
      `exit ${push?.exitCode} · mode ${String(pushJson.mode)} · ${((pushJson.findings ?? []) as Json[]).length} findings`,
    ),
    check(
      "the push's diff reached the server's model, on the server's key",
      promptsOf(sim, STEP.push, "review_push").some((prompt) =>
        prompt.includes("+export function lerp"),
      ) &&
        pushAi.length > 0 &&
        pushAi.every(
          (call) => call.side === "server" && call.key === "server AI key",
        ),
      `${pushAi.length} AI calls`,
    ),
    check(
      "commit watch opened one issue for the P1 and stored a push review",
      issues.length === 1 &&
        issues[0]!.step === STEP.push &&
        JSON.stringify(issues[0]!.body ?? "").includes("lerp returns b") &&
        JSON.stringify(issues[0]!.body ?? "").includes(s.push?.after ?? "-") &&
        pushReview?.kind === "push" &&
        pushReview.status === "done" &&
        pushReview.billed_to === "server",
      `${issues.length} issues · review ${pushReview?.kind ?? "?"} ${pushReview?.status ?? "missing"}`,
    ),
    check(
      "a clean tree says so and sends nothing to the server",
      clean?.exitCode === 0 &&
        clean.stdout.trim().split("\n").length === 1 &&
        clean.json?.message === "No changes to review." &&
        remoteCalls(sim, STEP.clean).length === 0 &&
        sim.trace.ai.filter((call) => call.step === STEP.clean).length === 0,
      `exit ${clean?.exitCode} · ${clean?.stdout.trim().split("\n").length ?? 0} output lines · ${remoteCalls(sim, STEP.clean).length} remote calls · ${sim.trace.ai.filter((call) => call.step === STEP.clean).length} AI calls`,
    ),
    check(
      "a bad token is refused with exit 2 and a hint",
      badToken?.exitCode === 2 &&
        Boolean(badToken.stderr.includes("rejected the remote review token")) &&
        Boolean(badToken.stderr.includes("Remote review tokens")),
      `exit ${badToken?.exitCode} · ${badToken?.stderr.split("\n")[0] ?? ""}`,
    ),
    check(
      "an unknown repository is refused with exit 2",
      unknownRepo?.exitCode === 2 &&
        Boolean(
          unknownRepo.stderr.includes(
            "Sorry, we could not access this repository.",
          ),
        ),
      `exit ${unknownRepo?.exitCode} · ${unknownRepo?.stderr.split("\n")[0] ?? ""}`,
    ),
    check(
      "a repository without guides is refused with exit 2",
      noGuides?.exitCode === 2 &&
        noGuidesHandshake?.status === 409 &&
        Boolean(
          noGuides.stderr.includes(
            "Sorry, we could not access this repository.",
          ),
        ),
      `exit ${noGuides?.exitCode} · handshake ${noGuidesHandshake?.status ?? "none"}`,
    ),
    check(
      "a payload over the advertised limit is refused before it is sent",
      clientCap?.exitCode === 2 &&
        errorCode(clientCap) === "payload_too_large" &&
        capSubmits.length === 0,
      `exit ${clientCap?.exitCode} · ${errorCode(clientCap)} · ${capSubmits.length} submits`,
    ),
    check(
      "the server refuses a body over its limit with 413",
      s.tooLarge?.status === 413 &&
        ((s.tooLarge.body.error ?? {}) as Json).code === "payload_too_large",
      `status ${s.tooLarge?.status}`,
    ),
    check(
      "refusals started no job and no AI call",
      refusalJobs.length === 0 && refusalAi.length === 0,
      `${refusalJobs.length} jobs · ${refusalAi.length} AI calls`,
    ),
    check(
      "an old-shape request (the v1 fixtures) still gets a review",
      old?.handshake === 200 &&
        old.submits[0]?.status === 202 &&
        old.final?.status === "done" &&
        Array.isArray((old.final.result as Json | undefined)?.findings),
      `handshake ${old?.handshake} · submit ${old?.submits[0]?.status} · final ${String(old?.final?.status)} after ${old?.syncs} syncs`,
    ),
    check(
      "a retried submit gets the same job, not a second one",
      old?.submits.length === 2 &&
        old.submits[1]?.status === 202 &&
        old.submits[1].jobId === old.submits[0]?.jobId &&
        oldJobs.length === 1,
      `jobs ${JSON.stringify(old?.submits.map((submit) => submit.jobId?.slice(0, 8)))} · ${oldJobs.length} ran`,
    ),
    check(
      "a cancelled run stops the job and the client says so",
      deleted?.status === 204 &&
        deleted.jobId === cancel?.jobIds[0] &&
        cancel?.exitCode === 2 &&
        errorCode(cancel) === "client_canceled" &&
        cancelJob?.status === "canceled" &&
        cancelJob.cancel_reason === "client_canceled" &&
        cancelReview?.status === "aborted",
      `delete ${deleted?.status} · exit ${cancel?.exitCode} ${errorCode(cancel)} · job ${cancelJob?.status}/${cancelJob?.cancel_reason} · review ${cancelReview?.status}`,
    ),
    unrepeatable(
      "product bug: reviewWorkspaceRevision passes no abort signal to the tool loop, so the aborted tool call goes back to the model as a tool error and one more round is paid for",
      "a cancelled review makes no further model call",
      deleteAt !== Infinity && afterCancel.length === 0 && faultAi.length === 1,
      `${afterCancel.length} AI calls after the cancel · ${faultAi.length} AI calls in the timed-out review`,
    ),
    check(
      "a timed-out sync fails the client, and the server cancels the orphaned job",
      fault?.exitCode === 3 &&
        errorCode(fault) === "network_failed" &&
        faultJob?.status === "canceled" &&
        faultJob.cancel_reason === "client_timeout" &&
        faultReview?.status === "aborted",
      `exit ${fault?.exitCode} ${errorCode(fault)} · job ${faultJob?.status}/${faultJob?.cancel_reason} · review ${faultReview?.status}`,
    ),
  ];
}

/** Where the BYOK key turned up. Stored: app.db, cache.db, config.json, any
 * file in the sandbox, the product's logs and job logs. In the trace it must
 * be in exactly one entry: the submit that carried it. */
function byokKeyPlaces(
  sim: Sim,
  key: string | undefined,
): { stored: string[]; inTrace: number; held: number } {
  if (!key) return { stored: ["(no key)"], inTrace: 0, held: -1 };
  const stored: string[] = [];
  const has = (text: string) => text.includes(key);
  if (has(JSON.stringify(dumpDatabase(sim.paths.appDb)))) stored.push("app.db");
  if (has(JSON.stringify(dumpDatabase(sim.paths.cacheDb))))
    stored.push("cache.db");
  for (const file of readFiles(sim.world.root)) {
    if (has(file.content)) stored.push(`file ${file.path}`);
  }
  if (has(JSON.stringify(sim.trace.logs))) stored.push("logs");
  const traceLists = [
    sim.trace.github,
    sim.trace.ai,
    sim.trace.remote,
    sim.trace.webhooks,
    sim.trace.completions,
    sim.trace.jobs,
  ];
  const inTrace = traceLists
    .flat()
    .filter((entry) => has(JSON.stringify(entry))).length;
  return { stored, inTrace, held: Number(sim.state.byokHeld ?? -1) };
}

function remoteScores(sim: Sim): Score[] {
  const fakeAi = sim.mode === "fake";
  const s = state(sim);
  const ok = [...s.runs.values()].filter(
    (run) => run.exitCode === 0 || run.exitCode === 1,
  );
  const syncs = ok.map((run) => remoteCalls(sim, run.step, SYNC).length);
  const prompts = sim.trace.completions.filter(
    (call) => call.job === "review_local" && call.step === STEP.first,
  );
  const toolChars = ok
    .flatMap((run) => remoteCalls(sim, run.step, SYNC))
    .flatMap(
      (call) =>
        ((call.request as Json | null)?.toolResults ?? []) as {
          output?: string;
        }[],
    )
    .reduce((sum, result) => sum + (result.output?.length ?? 0), 0);
  const second = promptsOf(sim, STEP.second, "review_local")[0] ?? "";
  return [
    {
      name: "sync calls per remote review",
      value: syncs.length
        ? syncs.reduce((a, b) => a + b, 0) / syncs.length
        : null,
      detail: `${syncs.join(", ")} over ${syncs.length} finished runs, at a ${remoteWire(sim).handshake.intervalSeconds}s interval`,
      fakeAi,
    },
    {
      name: "remote review prompt size",
      value: prompts[0]?.firstUser.length ?? null,
      detail: `${prompts[0]?.system.length ?? 0} chars of system prompt with the server's guides`,
      fakeAi,
    },
    {
      name: "tool output sent back by the client",
      value: toolChars,
      detail: "characters of tool results in sync requests",
      fakeAi,
    },
    {
      name: "carried findings in the second round",
      value: (second.match(/^F\d+ · /gm) ?? []).length,
      detail: "VERIFY entries in the second round's prompt",
      fakeAi,
    },
  ];
}

const percentOf = `${SAMPLE_REPO["src/format.ts"]}\nexport function percentOf(part: number, total: number): string {\n  return formatPercent(part / total);\n}\n`;

export default defineFlow({
  name: "remote",
  description:
    "remote review and push review, with the client and the server in one process",
  ai: [...INIT_AI, ...REMOTE_AI, ...PUSH_AI],
  steps: [
    {
      name: "server with guides",
      async run(sim) {
        state(sim).token = await startRemoteServer(sim, {
          remoteByokPolicy: "allow",
        });
        return `${SAMPLE_REPO_NAME} initialized · token created · codegraph stand-in`;
      },
    },
    {
      name: "client checkout with a change",
      run(sim) {
        state(sim).dev = clientChange(sim, "dev", "sim/feature", {
          "src/format.ts": percentOf,
        });
        return "sim/feature adds percentOf";
      },
    },
    {
      name: STEP.first,
      async run(sim) {
        const run = await runRemoteReview(sim, state(sim).dev, ["--json"]);
        return `exit ${run.exitCode} · ${remoteCalls(sim, STEP.first, SYNC).length} syncs · ${run.toolRuns.length} tool runs`;
      },
    },
    {
      name: STEP.second,
      async run(sim) {
        const { dev } = state(sim);
        dev.write({
          "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}\nexport const ZERO = 0;\n`,
        });
        dev.commit("Add ZERO");
        const run = await runRemoteReview(sim, dev);
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.byok,
      async run(sim) {
        const wire = remoteWire(sim);
        // Random per run, like the world's secrets. It stays out of
        // `world.secrets`: the core's leak check would find it in the one
        // submit body that must carry it. The flow checks it itself.
        const key = `sim-client-key-${crypto.randomUUID().replaceAll("-", "")}`;
        state(sim).byokKey = key;
        wire.keys.set("client key", key);
        const checkout = clientChange(sim, "byok", "sim/byok", {
          "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}\nexport function ratioOf(a: number, b: number): number {\n  return a / b;\n}\n`,
        });
        const run = await runRemoteReview(
          sim,
          checkout,
          ["--remote-byok", "--json"],
          { CM_REMOTE_BYOK: key },
        );
        const { byokKeyCountForTest } =
          await import("../../../remote/server/byok_keys.ts");
        sim.state.byokHeld = byokKeyCountForTest();
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.push,
      async run(sim) {
        const range = sim.github.commitToDefault(
          SAMPLE_REPO_NAME,
          {
            "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}\nexport function lerp(a: number, b: number, t: number): number {\n  return b + (a - b) * t;\n}\n`,
          },
          "Add lerp",
        );
        state(sim).push = range;
        const ci = clientCheckout(sim, SAMPLE_REPO_NAME, "ci");
        const run = await runPushReview(sim, ci, range, ["--json"]);
        return `exit ${run.exitCode} · ${range.before.slice(0, 7)}..${range.after.slice(0, 7)}`;
      },
    },
    {
      name: STEP.clean,
      async run(sim) {
        const clean = clientCheckout(sim, SAMPLE_REPO_NAME, "clean");
        clean.git(["switch", "-q", "-c", "sim/clean"]);
        const run = await runRemoteReview(sim, clean, ["--json"]);
        return `exit ${run.exitCode} · ${remoteCalls(sim, STEP.clean).length} remote calls`;
      },
    },
    {
      name: STEP.badToken,
      async run(sim) {
        const run = await runRemoteReview(sim, state(sim).dev, [
          "--remote-token=cmr_not-a-real-token",
        ]);
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.unknownRepo,
      async run(sim) {
        const run = await runRemoteReview(sim, state(sim).dev, [
          "--repo=sim/unknown",
        ]);
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.noGuides,
      async run(sim) {
        sim.repo("sim/bare", { "README.md": "# bare\n" });
        // Known to the server the way an App installation makes it known,
        // with no init run.
        const { activateRepo } = await import("../../../store/repos.ts");
        activateRepo("sim/bare", sim.github.installation.id);
        const checkout = clientChange(
          sim,
          "bare",
          "sim/docs",
          {
            "README.md": "# bare\n\nMore words.\n",
          },
          "sim/bare",
        );
        const run = await runRemoteReview(sim, checkout);
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.clientCap,
      async run(sim) {
        const wire = remoteWire(sim);
        wire.handshake.maxBodyBytes = 64;
        try {
          const run = await runRemoteReview(sim, state(sim).dev, ["--json"]);
          return `exit ${run.exitCode}`;
        } finally {
          delete wire.handshake.maxBodyBytes;
        }
      },
    },
    {
      name: STEP.serverCap,
      async run(sim) {
        const { REMOTE_MAX_BODY_BYTES } =
          await import("../../../remote/schema.ts");
        // A Blob, so the trace keeps `{}` instead of 50 MB of text.
        const response = await remoteWire(sim).asClient(() =>
          fetch(`${sim.server.remoteUrl}/api/remote/reviews`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${state(sim).token}`,
              "content-type": "application/json",
            },
            body: new Blob([new Uint8Array(REMOTE_MAX_BODY_BYTES + 1)]),
          }),
        );
        state(sim).tooLarge = {
          status: response.status,
          body: (await response.json()) as Json,
        };
        return `status ${response.status}`;
      },
    },
    {
      name: STEP.oldShape,
      async run(sim) {
        const s = state(sim);
        const fixture = (name: string) =>
          JSON.parse(
            readFileSync(
              join(import.meta.dirname, "../../../remote/fixtures/v1", name),
              "utf8",
            ),
          ) as Json;
        const post = (path: string, body: unknown) =>
          fetch(`${sim.server.remoteUrl}${path}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${s.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
        const old: State["oldShape"] = { handshake: 0, submits: [], syncs: 0 };
        s.oldShape = old;
        await serveWhile(sim, async () => {
          const handshake = await post("/api/remote/handshake", {
            ...fixture("handshake.request.json"),
            repo: SAMPLE_REPO_NAME,
          });
          old.handshake = handshake.status;
          const submit = {
            ...fixture("submit.request.json"),
            requestId: crypto.randomUUID(),
            repo: SAMPLE_REPO_NAME,
            branch: "sim/old-client",
          };
          // The second submit is the client retrying after it lost the first
          // answer: same request id, while the job is still queued.
          for (let attempt = 0; attempt < 2; attempt++) {
            const response = await post("/api/remote/reviews", submit);
            const body = (await response.json()) as Json;
            old.submits.push({
              status: response.status,
              ...(typeof body.jobId === "string" ? { jobId: body.jobId } : {}),
            });
          }
          const jobId = old.submits[0]?.jobId;
          if (!jobId) return;
          for (let poll = 0; poll < 500; poll++) {
            const sync = await post(`/api/remote/reviews/${jobId}/sync`, {
              ...fixture("sync.request.json"),
              afterLogSeq: 0,
              toolResults: [],
            });
            old.syncs++;
            old.final = (await sync.json()) as Json;
            if (
              old.final.status !== "queued" &&
              old.final.status !== "running"
            ) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        });
        return `${old.submits.map((submit) => submit.status).join(", ")} · ${String(old.final?.status)}`;
      },
    },
    {
      name: STEP.cancel,
      async run(sim) {
        const s = state(sim);
        const wire = remoteWire(sim);
        // The person stops the review while the client answers a tool call:
        // the cancel reaches the server before the tool result does.
        wire.beforeRemote = async (call) => {
          const results = (call.body as Json | null)?.toolResults;
          const jobId = /\/reviews\/([^/]+)\/sync$/.exec(call.path)?.[1];
          if (!jobId || !Array.isArray(results) || !results.length) return;
          if (s.deleted.length) return;
          const response = await fetch(
            `${sim.server.remoteUrl}/api/remote/reviews/${jobId}`,
            {
              method: "DELETE",
              headers: { authorization: `Bearer ${call.token}` },
            },
          );
          s.deleted.push({ status: response.status, jobId });
        };
        try {
          const run = await runRemoteReview(sim, s.dev, ["--fresh", "--json"]);
          return `exit ${run.exitCode} · ${errorCode(run)}`;
        } finally {
          delete wire.beforeRemote;
        }
      },
    },
    {
      name: STEP.fault,
      async run(sim) {
        const { startRemoteWatchdog, stopRemoteWatchdog } =
          await import("../../../remote/server/sessions.ts");
        sim.faults.add({
          target: "remote",
          kind: "timeout",
          method: "POST",
          path: SYNC,
        });
        // The watchdog checks once a second. A short timeout makes its first
        // check cancel the job nobody syncs any more.
        sim.world.writeConfig({ remoteSyncTimeoutSeconds: 0.2 });
        startRemoteWatchdog();
        try {
          const run = await runRemoteReview(
            sim,
            state(sim).dev,
            ["--fresh", "--json"],
            {},
            5000,
          );
          return `exit ${run.exitCode} · ${errorCode(run)}`;
        } finally {
          stopRemoteWatchdog();
          sim.world.writeConfig({ remoteSyncTimeoutSeconds: undefined });
        }
      },
    },
  ],
  checks: (sim) => remoteChecks(sim),
  scores: (sim) => remoteScores(sim),
});
