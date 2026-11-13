/** Extensions, end to end: a real script, run through the real shell by the
 * real runner, in every review mode.
 *
 * The flow writes one small Node script into the sandbox. Each registration
 * runs it with a mode word, and the script records what it received (its
 * arguments, its environment, its working directory, the run folder's files
 * and the run's start record) in a log the checks read. Then it answers the
 * way its mode says: a blocking finding, a hostile answer, too many findings,
 * a crash, a timeout, a child that keeps the pipe open, a retry.
 *
 * Local review, a CLI pull request review, the App review with two rounds and
 * a remote review each run it. Ordering, failures, tracking, cost and the hard
 * off switch are checked from the log, the output and what reached GitHub. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  check,
  defineFlow,
  scriptedCheck,
  type CheckResult,
  type Sim,
} from "../flow.ts";
import type { AiRule } from "../fake_ai.ts";
import { REMOTE_HOST } from "../fetch.ts";
import type { SimPull } from "../github.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";
import {
  APP_REPO,
  appRows,
  FIXED_MATH,
  OPENED_MATH,
  openPull,
  pushRound,
  serveRepo,
  writesIn,
} from "./app.ts";
import { openChangePull, parseJsonOutput, reviewCli } from "./cli_pr.ts";
import {
  checkoutStep,
  configureCli,
  LOCAL_CHANGE,
  localState,
  NO_CODEGRAPH,
  runReview,
  type ReviewRun,
} from "./local.ts";
import {
  clientChange,
  installCodegraphStandIn,
  remoteWire,
  runRemoteReview,
  type RemoteRun,
} from "./remote.ts";

type Json = Record<string, unknown>;

/** Every review in this flow gets an empty answer from the model, so what
 * blocks a review or posts a comment comes from the extensions alone. */
const EXTENSION_AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "empty review",
    job: /^review_(pull_request|local)$/,
    reply: { findings: [] },
  },
];

const STEP = {
  setup: "served repository and the extension script",
  plain: "local review without extensions",
  register: "extension register",
  local: "local review with an extension",
  disabled: "extensions turned off",
  pr: "pull request review with an extension",
  app1: "App review round 1",
  app2: "App review round 2",
  hostile: "App review of a hostile and a crowded answer",
  failures: "App review with failing extensions",
  ordering: "local review with ordered extensions",
  remote: "remote review with an extension",
} as const;

/** The script every registration runs. Its mode is its fourth argument and
 * its log its fifth: both are written in the command, not substituted. */
const SCRIPT = String.raw`import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
const [detailsPath, resultPath, diffPath, mode, log] = process.argv.slice(2);
// First, before anything can fail: proof that this command ran at all.
if (mode === "evil") writeFileSync(log + ".evil", "ran");
const FENCE = String.fromCharCode(96).repeat(3);
const folder = dirname(detailsPath);
const files = {};
for (const name of readdirSync(folder)) {
  try { files[name] = readFileSync(join(folder, name), "utf8"); } catch {}
}
const details = JSON.parse(files["details.json"]);
const state = JSON.parse(files["state.json"] ?? "{}");
appendFileSync(log, JSON.stringify({
  mode, argv: process.argv.slice(2), env: process.env, cwd: process.cwd(),
  details, files, started: state.started ?? [], finished: state.finished ?? [],
  review: resultPath ? JSON.parse(readFileSync(resultPath, "utf8")) : null,
}) + "\n");
const ok = (verdict, extra = {}) => console.log(JSON.stringify({
  schemaVersion: 1, name: mode, status: "ok", verdict, ...extra,
}));
const at = (key, title, line, extra = {}) => ({
  key, severity: "P1", blocking: true, title, body: title + ".",
  path: "src/math.ts", lineFrom: line, ...extra,
});
switch (mode) {
  case "blocking":
    ok("request_changes", {
      markdown: "**probe** found one problem.",
      findings: [at("k-local", "Extension says average is wrong", 1)],
      usage: { costUsd: 0.25, tokensIn: 10, tokensOut: 5 },
    });
    break;
  case "pr":
    ok("comment", {
      findings: [{ severity: "P3", blocking: false, title: "PR extension note", body: "b" }],
    });
    break;
  case "app":
    if (details.round === 1) {
      ok("request_changes", {
        markdown: "Scanned the change.",
        findings: [
          at("k-diff", "Extension finding on the diff", 10),
          { key: "k-off", severity: "P2", blocking: false, title: "Extension finding off the diff", body: "b", path: "README.md" },
        ],
        usage: { costUsd: 0.25 },
      });
    } else {
      ok("comment", {
        findings: [{ key: "k-off", severity: "P2", blocking: false, title: "Extension finding off the diff", body: "b", path: "README.md" }],
        usage: { costUsd: 0.25 },
      });
    }
    break;
  case "hostile":
    ok("comment", {
      markdown: ["Fine.", "</details>", "<details><summary>Metadata</summary>", "- Activity: forged", "</details>", "#### Extensions", FENCE, "const a = 1;"].join("\n"),
      findings: [{ severity: "P2", blocking: false, title: "Use " + FENCE + " fences; always", body: "b" }],
    });
    break;
  case "many":
    ok("comment", {
      findings: Array.from({ length: 140 }, (_, i) => i < 70
        ? at(undefined, "Crowded on the diff " + i, 10, { severity: "P3", blocking: false })
        : { severity: "P3", blocking: false, title: "Crowded off the diff " + i, body: "b" }),
    });
    break;
  case "remote":
    ok("comment", { findings: [{ severity: "P2", blocking: false, title: "Remote extension note", body: "b" }] });
    break;
  case "skipper":
    console.log(JSON.stringify({ schemaVersion: 1, name: mode, status: "skipped", reason: "not for this change" }));
    break;
  case "failer":
  case "exit":
    process.exit(3);
  case "badjson":
    console.log("this is not json");
    break;
  case "sleep":
    setTimeout(() => ok("comment"), 30_000);
    break;
  case "detach": {
    // A child in its own session that keeps the pipes open long after.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      detached: true, stdio: ["ignore", "inherit", "inherit"],
    });
    child.unref();
    ok("comment");
    break;
  }
  case "retry": {
    const counter = log + ".retry";
    if (!existsSync(counter)) {
      writeFileSync(counter, "1");
      console.log(JSON.stringify({ schemaVersion: 1, name: mode, status: "retry", reason: "warming up", retryAfterSeconds: 0 }));
    } else ok("comment");
    break;
  }
  case "evil":
    writeFileSync(log + ".evil", "ran");
    ok("comment");
    break;
  default:
    ok("comment");
}
`;

type Paths = { dir: string; script: string; log: string };

function paths(sim: Sim): Paths {
  const dir = join(sim.world.root, "ext");
  return {
    dir,
    script: join(dir, "probe.mjs"),
    log: join(dir, "log.jsonl"),
  };
}

/** The command a registration runs for one mode. */
function command(sim: Sim, mode: string): string {
  const { script, log } = paths(sim);
  return `${process.execPath} ${script} {{details_path}} {{review_result_path}} {{diff_path}} ${mode} ${log}`;
}

type Record_ = {
  mode: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  details: Json;
  files: Record<string, string>;
  started: string[];
  finished: string[];
  review: Json | null;
  index: number;
  step?: string;
};

/** Every run of the script, in the order they started. */
function records(sim: Sim): Record_[] {
  const { log } = paths(sim);
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => ({ ...(JSON.parse(line) as Record_), index }));
}

type State = {
  local: Map<string, ReviewRun>;
  /** How many script runs the log held when each step started. */
  logAt: Map<string, number>;
  cli: Map<string, { exitCode: number; stdout: string; stderr: string }>;
  pulls: Map<string, SimPull>;
  remote?: RemoteRun;
  remoteSubmit?: Json;
  ms: Map<string, number>;
  /** The review without a registration created no run folder at all. */
  plainLeftNoFolder?: boolean;
  /** The registrations in config.json right after `extension register`. */
  saved?: string[];
};

function state(sim: Sim): State {
  return (sim.state.extensions ??= {
    local: new Map(),
    logAt: new Map(),
    cli: new Map(),
    pulls: new Map(),
    ms: new Map(),
  }) as State;
}

/** The script runs a step made. */
function recordsIn(sim: Sim, step: string): Record_[] {
  const all = records(sim);
  const s = state(sim);
  const order = Object.values(STEP) as string[];
  const from = s.logAt.get(step) ?? all.length;
  const next = order
    .slice(order.indexOf(step) + 1)
    .map((name) => s.logAt.get(name))
    .find((value) => value !== undefined);
  return all.slice(from, next ?? all.length);
}

function register(sim: Sim, entries: Json[]): void {
  sim.world.writeConfig({ extensions: entries });
}

/** A step that marks where its script runs start in the log. */
function marked(name: string, run: (sim: Sim) => Promise<string>) {
  return {
    name,
    timeoutMs: 90_000,
    async run(sim: Sim) {
      state(sim).logAt.set(name, records(sim).length);
      const started = performance.now();
      try {
        return await run(sim);
      } finally {
        state(sim).ms.set(name, Math.round(performance.now() - started));
      }
    },
  };
}

async function localRun(
  sim: Sim,
  label: string,
  args: string[],
  env?: Record<string, string>,
): Promise<ReviewRun> {
  const co = localState(sim).checkouts.get("ext")!;
  const run = await runReview(
    sim,
    co,
    label,
    [NO_CODEGRAPH, ...args],
    env ? { env } : {},
  );
  state(sim).local.set(label, run);
  return run;
}

async function extensionsRoot(): Promise<string> {
  const { extensionsRoot: root } =
    await import("../../../extensions/run_folder.ts");
  return root();
}

function leftovers(root: string): string[] {
  return existsSync(root) ? readdirSync(root) : [];
}

/** The App review a step posted. */
function postedReview(
  sim: Sim,
  step: string,
):
  | {
      body: string;
      event: string;
      comments: { path: string; line: number; body: string }[];
    }
  | undefined {
  const write = writesIn(sim, step).find(
    (item) =>
      item.method === "POST" && /\/pulls\/\d+\/reviews$/.test(item.path),
  );
  return write?.body as never;
}

export default defineFlow({
  name: "extensions",
  description:
    "a real extension script runs in local, pull request, App and remote review, with ordering, failures, tracking, cost and the off switch",
  ai: EXTENSION_AI,
  skipInherited: {
    "cost recorded for every AI call":
      "this flow runs App reviews, whose tokens only the reviews table holds, and a remote review, whose tokens both the cost rows and the reviews table hold, so neither total the check compares can match. The app and remote flows keep the check, and this flow checks the extension's cost itself",
  },
  steps: [
    {
      name: STEP.setup,
      async run(sim) {
        await serveRepo(sim);
        configureCli(sim);
        const p = paths(sim);
        mkdirSync(p.dir, { recursive: true });
        writeFileSync(p.script, SCRIPT);
        return `${APP_REPO} served · script at ${p.script}`;
      },
    },
    checkoutStep("ext", { repo: APP_REPO, ...LOCAL_CHANGE }),
    marked(STEP.plain, async (sim) => {
      register(sim, []);
      const run = await localRun(sim, STEP.plain, ["--json"]);
      state(sim).plainLeftNoFolder = !existsSync(await extensionsRoot());
      return `exit ${run.cli.exitCode}`;
    }),
    marked(STEP.register, async (sim) => {
      const run = await sim.cli([
        "extension",
        "register",
        "--name=probe",
        `--command=${command(sim, "blocking")}`,
        "--parallelism=false",
      ]);
      state(sim).cli.set(STEP.register, run);
      state(sim).saved = (
        (sim.world.readConfig().extensions as Json[] | undefined) ?? []
      ).map((entry) => `${entry.name} ${entry.command}`);
      return `exit ${run.exitCode}`;
    }),
    marked(STEP.local, async (sim) => {
      const run = await localRun(sim, STEP.local, ["--json"]);
      return `exit ${run.cli.exitCode}`;
    }),
    marked(STEP.disabled, async (sim) => {
      const refused = await sim.cli(
        ["extension", "register", "--name=other", "--command=true"],
        { env: { CM_EXTENSIONS_DISABLED: "1" } },
      );
      state(sim).cli.set(STEP.disabled, refused);
      const run = await localRun(sim, STEP.disabled, ["--json"], {
        CM_EXTENSIONS_DISABLED: "1",
      });
      return `register exit ${refused.exitCode} · review exit ${run.cli.exitCode}`;
    }),
    marked(STEP.pr, async (sim) => {
      register(sim, [{ name: "pr-probe", command: command(sim, "pr") }]);
      const pull = openChangePull(sim, { title: "Extension pull request" });
      state(sim).pulls.set(STEP.pr, pull);
      const run = await reviewCli(sim, pull.number, ["--json"]);
      state(sim).cli.set(STEP.pr, run);
      return `#${pull.number} · exit ${run.exitCode}`;
    }),
    marked(STEP.app1, async (sim) => {
      register(sim, [{ name: "app-probe", command: command(sim, "app") }]);
      const round = await openPull(sim, {
        title: "Add divide and average",
        files: { "src/math.ts": OPENED_MATH },
      });
      state(sim).pulls.set(STEP.app1, round.pull);
      return `#${round.pull.number} · ${round.jobs.map((job) => job.status).join(", ")}`;
    }),
    marked(STEP.app2, async (sim) => {
      const round = await pushRound(sim, state(sim).pulls.get(STEP.app1)!, {
        "src/math.ts": FIXED_MATH,
      });
      return `${round.jobs.map((job) => job.status).join(", ")}`;
    }),
    marked(STEP.hostile, async (sim) => {
      register(sim, [
        { name: "hostile", command: command(sim, "hostile") },
        { name: "many", command: command(sim, "many") },
      ]);
      const round = await openPull(sim, {
        title: "Crowded change",
        files: { "src/math.ts": OPENED_MATH.replace("divide", "split") },
      });
      state(sim).pulls.set(STEP.hostile, round.pull);
      return `${round.jobs.map((job) => job.status).join(", ")}`;
    }),
    marked(STEP.failures, async (sim) => {
      register(sim, [
        { name: "crash", command: command(sim, "exit") },
        { name: "garbled", command: command(sim, "badjson") },
        { name: "slow", command: command(sim, "sleep"), timeoutSeconds: 1 },
        { name: "detached", command: command(sim, "detach") },
        { name: "retrying", command: command(sim, "retry") },
      ]);
      const round = await openPull(sim, {
        title: "Change with failing extensions",
        files: { "src/math.ts": OPENED_MATH.replace("divide", "quotient") },
      });
      state(sim).pulls.set(STEP.failures, round.pull);
      return `${round.jobs.map((job) => job.status).join(", ")}`;
    }),
    marked(STEP.ordering, async (sim) => {
      register(sim, [
        { name: "low", command: command(sim, "order-low"), parallelism: false },
        {
          name: "high",
          command: command(sim, "order-high"),
          parallelism: false,
          priority: 3,
        },
        {
          name: "after-low",
          command: command(sim, "order-after"),
          runAfter: "low",
        },
        { name: "skipper", command: command(sim, "skipper") },
        {
          name: "after-skipper",
          command: command(sim, "never-after-skip"),
          runAfter: "skipper",
        },
        { name: "failer", command: command(sim, "failer"), failFast: true },
        {
          name: "after-failer",
          command: command(sim, "never-after-fail"),
          runAfter: "failer",
        },
        { name: "loner", command: command(sim, "order-loner") },
      ]);
      const run = await localRun(sim, STEP.ordering, ["--json"]);
      return `exit ${run.cli.exitCode}`;
    }),
    marked(STEP.remote, async (sim) => {
      register(sim, [
        { name: "remote-probe", command: command(sim, "remote") },
      ]);
      const token = await sim.server.remoteToken("client");
      await installCodegraphStandIn(sim);
      remoteWire(sim);
      const dev = clientChange(sim, "remote-dev", "sim/remote-ext", {
        "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}\nexport const TWO = 2;\n`,
      });
      // The client tries to make the server run a command of its own.
      const inner = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (
          url.hostname === REMOTE_HOST &&
          url.pathname === "/api/remote/reviews" &&
          init?.method === "POST" &&
          typeof init.body === "string"
        ) {
          const body = JSON.parse(init.body) as Json;
          body.extensions = [
            { name: "evil", command: command(sim, "evil"), repos: "*" },
          ];
          body.extensionCommand = command(sim, "evil");
          state(sim).remoteSubmit = body;
          return inner(input, { ...init, body: JSON.stringify(body) });
        }
        return inner(input, init);
      };
      try {
        const run = await runRemoteReview(sim, dev, [
          `--remote-token=${token}`,
          "--json",
        ]);
        state(sim).remote = run;
        return `exit ${run.exitCode}`;
      } finally {
        globalThis.fetch = inner;
      }
    }),
  ],
  async checks(sim) {
    const s = state(sim);
    const results: CheckResult[] = [];
    const root = await extensionsRoot();
    const all = records(sim);
    const secrets = sim.world.secretValues().map((secret) => secret.value);
    secrets.push(join(sim.world.root, "config.json"));

    // No extension registered.
    const plain = s.local.get(STEP.plain);
    const plainFindings = (plain?.json?.findings as Json[] | undefined) ?? [];
    results.push(
      check(
        "without a registration --json has extensions [] and every finding extensionId null, and nothing runs",
        plain?.json !== undefined &&
          JSON.stringify(plain.json.extensions) === "[]" &&
          plainFindings.every((row) => row.extensionId === null) &&
          !("reviewCostUsd" in ((plain.json.usage as Json) ?? {})) &&
          recordsIn(sim, STEP.plain).length === 0 &&
          s.plainLeftNoFolder === true,
        `extensions ${JSON.stringify(plain?.json?.extensions)} · ${plainFindings.length} findings · ${recordsIn(sim, STEP.plain).length} script runs · run folder ${s.plainLeftNoFolder ? "never made" : "made"}`,
      ),
    );

    // Local review with one blocking extension.
    const local = s.local.get(STEP.local);
    const localRecord = recordsIn(sim, STEP.local)[0];
    const localExt = ((local?.json?.findings as Json[] | undefined) ?? []).find(
      (row) => row.extensionId === "probe",
    );
    results.push(
      check(
        "extension register saves the registration in config.json",
        s.cli.get(STEP.register)?.exitCode === 0 &&
          JSON.stringify(s.saved) ===
            JSON.stringify([`probe ${command(sim, "blocking")}`]),
        `exit ${s.cli.get(STEP.register)?.exitCode} · saved ${JSON.stringify(s.saved)}`,
      ),
      check(
        "a request_changes verdict makes the local review exit 1 with the finding in --json",
        local?.cli.exitCode === 1 &&
          localExt?.blocking === true &&
          localExt.key === "k-local" &&
          (local.json?.extensions as Json[] | undefined)?.[0]?.verdict ===
            "request_changes",
        `exit ${local?.cli.exitCode} · ${JSON.stringify(localExt)}`,
      ),
      check(
        "details.json holds the review's context the way the issue describes it",
        localRecord !== undefined &&
          localRecord.details.schemaVersion === 1 &&
          localRecord.details.reviewType === "local" &&
          localRecord.details.repo === APP_REPO &&
          localRecord.details.prNumber === null &&
          localRecord.details.branch === "feature/average" &&
          localRecord.details.workdir === localRecord.cwd &&
          String(localRecord.details.diffPath).endsWith("/diff.patch") &&
          String(localRecord.details.reviewResultPath).endsWith(
            "/cm-review.json",
          ) &&
          localRecord.files["diff.patch"]?.includes(
            "diff --git a/src/math.ts",
          ) === true &&
          localRecord.review !== null,
        localRecord
          ? JSON.stringify(localRecord.details)
          : "the script did not run",
      ),
      check(
        "the run folder is gone after every review",
        leftovers(root).length === 0,
        `${leftovers(root).length} left in ${root}`,
      ),
    );

    // What the command received.
    const leaks: string[] = [];
    for (const record of all) {
      const seen = JSON.stringify({
        argv: record.argv,
        env: record.env,
        files: record.files,
      });
      for (const secret of secrets) {
        if (seen.includes(secret))
          leaks.push(`${record.mode}: ${secret.slice(0, 12)}`);
      }
    }
    const envKeys = new Set(all.flatMap((record) => Object.keys(record.env)));
    const argsOk = all.every(
      (record) =>
        record.argv.length === 5 &&
        record.argv[0]!.startsWith(root) &&
        record.argv[0]!.endsWith("/details.json") &&
        (record.argv[1] === "" ||
          record.argv[1]!.endsWith("/cm-review.json")) &&
        record.argv[2]!.endsWith("/diff.patch") &&
        record.argv[4] === paths(sim).log,
    );
    results.push(
      check(
        "the command gets only the three paths and an empty environment, with no token, key, secret or key path anywhere it can read",
        all.length > 0 &&
          argsOk &&
          [...envKeys].every((key) =>
            ["PWD", "SHLVL", "_", "OLDPWD"].includes(key),
          ) &&
          leaks.length === 0,
        `${all.length} runs · env keys ${[...envKeys].join(",") || "none"} · leaks ${leaks.join(", ") || "none"}`,
      ),
    );

    // The off switch.
    const refused = s.cli.get(STEP.disabled);
    const disabled = s.local.get(STEP.disabled);
    results.push(
      check(
        "CM_EXTENSIONS_DISABLED=1: register refuses and a review runs no script",
        refused?.exitCode === 2 &&
          refused.stderr.includes("CM_EXTENSIONS_DISABLED=1") &&
          JSON.stringify(disabled?.json?.extensions) === "[]" &&
          recordsIn(sim, STEP.disabled).length === 0,
        `register exit ${refused?.exitCode} · review extensions ${JSON.stringify(disabled?.json?.extensions)} · ${recordsIn(sim, STEP.disabled).length} runs`,
      ),
    );

    // CLI pull request review.
    const prRun = s.cli.get(STEP.pr) as
      | (ReturnType<State["cli"]["get"]> & {
          github?: () => { method: string; url: string }[];
        })
      | undefined;
    const prJson = prRun ? parseJsonOutput(prRun.stdout) : undefined;
    const pull = s.pulls.get(STEP.pr);
    const prCalls = sim.cliRuns
      .filter((run) => run.step === STEP.pr)
      .flatMap((run) => run.github())
      .map((call) => `${call.method} ${new URL(call.url).pathname}`);
    const reads = (suffix: string) =>
      prCalls.filter(
        (call) =>
          call === `GET /repos/${APP_REPO}/pulls/${pull?.number}${suffix}`,
      ).length;
    const prRecord = recordsIn(sim, STEP.pr)[0];
    results.push(
      check(
        "a CLI pull request review joins the extension's findings and reads the pull request once",
        ((prJson?.findings as Json[] | undefined) ?? []).some(
          (row) =>
            row.extensionId === "pr-probe" && row.title === "PR extension note",
        ) &&
          reads("") === 1 &&
          reads("/files") === 1 &&
          prRecord?.details.prNumber === pull?.number &&
          prRecord?.details.reviewType === "pr" &&
          String(prRecord?.details.headSha ?? "").length === 40,
        `pull read ${reads("")} · files read ${reads("/files")} · details ${prRecord ? JSON.stringify(prRecord.details) : "none"}`,
      ),
    );

    // App review.
    const posted1 = postedReview(sim, STEP.app1);
    const inline = posted1?.comments.find((comment) =>
      comment.body.startsWith("[P1 · blocking] · extension: app-probe"),
    );
    results.push(
      check(
        "the App review carries the Extensions section, an inline comment, a summary entry, the Metadata lines, and the verdict's event",
        posted1 !== undefined &&
          posted1.event === "REQUEST_CHANGES" &&
          inline?.path === "src/math.ts" &&
          inline.line === 10 &&
          posted1.body.includes(
            "- [P2 · non-blocking] · extension: app-probe: Extension finding off the diff (README.md)",
          ) &&
          posted1.body.includes("#### Extensions") &&
          posted1.body.includes("<details><summary>app-probe</summary>") &&
          posted1.body.includes("- Extensions: [app-probe]") &&
          posted1.body.includes("- Requested changes: [app-probe]"),
        posted1
          ? `${posted1.event} · ${posted1.comments.length} comments`
          : "no review posted",
      ),
    );

    // Tracking across rounds.
    const reviews = appRows<{
      id: string;
      job_id: string;
      cost: number | null;
      status: string;
    }>(
      sim,
      "SELECT id, job_id, cost, status FROM reviews WHERE pr_number = ? ORDER BY round, created_at",
      s.pulls.get(STEP.app1)?.number ?? -1,
    );
    const round2 = reviews[1];
    const tracked = round2
      ? appRows<{ key: string; state: string }>(
          sim,
          "SELECT key, state FROM extension_findings WHERE review_id = ?",
          round2.id,
        )
      : [];
    const stateOf = (key: string) =>
      tracked.find((row) => row.key === key)?.state;
    const posted2 = postedReview(sim, STEP.app2);
    results.push(
      scriptedCheck(
        sim,
        "a keyed finding seen again stays open, one that is gone is closed",
        stateOf("k-off") === "open" &&
          stateOf("k-diff") === "closed" &&
          posted2?.body.includes(
            "Extension finding off the diff (README.md) (still open)",
          ) === true &&
          posted2.event !== "REQUEST_CHANGES",
        `${JSON.stringify(tracked)} · round 2 ${posted2?.event ?? "not posted"}`,
        "the review event also follows the findings the model reports",
      ),
      check(
        "a keyed finding seen again stays open, one that is gone is closed, in the posted review",
        stateOf("k-off") === "open" &&
          stateOf("k-diff") === "closed" &&
          posted2?.body.includes(
            "Extension finding off the diff (README.md) (still open)",
          ) === true,
        `${JSON.stringify(tracked)} · round 2 ${posted2?.event ?? "not posted"}`,
      ),
    );

    // Cost.
    const round1 = reviews[0];
    const aiCost = sim.trace.completions
      .filter((call) => call.step === STEP.app1)
      .reduce((sum, call) => sum + (call.cost ?? 0), 0);
    const localUsage = (local?.json?.usage ?? {}) as Json;
    results.push(
      check(
        "a review's total includes the extension's reported cost once",
        round1 !== undefined &&
          Math.abs((round1.cost ?? -1) - (aiCost + 0.25)) < 1e-9 &&
          localUsage.extensionsCostUsd === 0.25 &&
          Math.abs(
            Number(localUsage.costUsd) -
              Number(localUsage.reviewCostUsd) -
              0.25,
          ) < 1e-9,
        `App total ${round1?.cost} over AI ${aiCost} · local ${JSON.stringify(localUsage)}`,
      ),
    );

    // Hostile and crowded answers.
    const hostile = postedReview(sim, STEP.hostile);
    const opens = hostile?.body.match(/<details>/gi)?.length ?? 0;
    const closes = hostile?.body.match(/<\/details>/gi)?.length ?? 0;
    const extensionComments =
      hostile?.comments.filter((comment) =>
        comment.body.includes("extension: many"),
      ).length ?? 0;
    results.push(
      check(
        "a hostile answer leaves the review intact",
        hostile !== undefined &&
          opens === closes &&
          (hostile.body.match(/<summary>Metadata<\/summary>/g) ?? []).length ===
            1 &&
          (hostile.body.match(/^#### Extensions$/gm) ?? []).length === 1 &&
          !hostile.body.includes("Use ``` fences"),
        hostile ? `${opens} open, ${closes} close details` : "no review posted",
      ),
      check(
        "more findings than the cap: inline comments are capped and the body fits and says how many more",
        hostile !== undefined &&
          extensionComments === 50 &&
          hostile.body.length <= 250_000 &&
          /- and \d+ more, see the dashboard/.test(hostile.body),
        hostile
          ? `${extensionComments} inline · body ${hostile.body.length} chars · ${/- and (\d+) more/.exec(hostile.body)?.[1] ?? "no"} more`
          : "no review posted",
      ),
    );

    // Failures.
    const failing = postedReview(sim, STEP.failures);
    const failRows = (() => {
      const review = appRows<{ id: string }>(
        sim,
        "SELECT id FROM reviews WHERE pr_number = ?",
        s.pulls.get(STEP.failures)?.number ?? -1,
      )[0];
      return review
        ? appRows<{
            name: string;
            status: string;
            reason: string | null;
            attempts: number;
          }>(
            sim,
            "SELECT name, status, reason, attempts FROM extension_results WHERE review_id = ?",
            review.id,
          )
        : [];
    })();
    const row = (name: string) => failRows.find((item) => item.name === name);
    results.push(
      check(
        "failing extensions are reported, the review is still posted, and nothing hangs",
        failing !== undefined &&
          row("crash")?.status === "failed" &&
          row("crash")?.reason?.includes("exited with code 3") === true &&
          row("garbled")?.status === "failed" &&
          row("garbled")?.reason?.includes("does not match the schema") ===
            true &&
          row("slow")?.status === "failed" &&
          row("slow")?.reason === "timed out after 1s" &&
          row("detached")?.status === "ok" &&
          row("retrying")?.status === "ok" &&
          row("retrying")?.attempts === 2 &&
          ["crash", "garbled", "slow"].every((name) =>
            failing.body.includes(
              `${name} extension failed, you can see details in dashboard`,
            ),
          ) &&
          (s.ms.get(STEP.failures) ?? Infinity) < 15_000,
        `${JSON.stringify(failRows)} · ${s.ms.get(STEP.failures)} ms`,
      ),
    );

    // Ordering.
    const ordered = recordsIn(sim, STEP.ordering);
    const byMode = (mode: string) =>
      ordered.find((record) => record.mode === mode);
    const low = byMode("order-low");
    const after = byMode("order-after");
    const orderJson = s.local.get(STEP.ordering)?.json;
    const status = (name: string) =>
      ((orderJson?.extensions as Json[] | undefined) ?? []).find(
        (item) => item.id === name,
      )?.status;
    results.push(
      check(
        "ready together, priority 3 starts before priority 0",
        low !== undefined &&
          low.started.indexOf("high") !== -1 &&
          low.started.indexOf("high") < low.started.indexOf("low"),
        low ? `started ${low.started.join(" > ")}` : "low did not run",
      ),
      check(
        "a run-after extension starts after its target finished, with the review results",
        after !== undefined &&
          after.finished.includes("low") &&
          after.argv[1]!.endsWith("/cm-review.json") &&
          after.review !== null,
        after
          ? `finished before it: ${after.finished.join(",")} · review results ${JSON.stringify(after.argv[1])}`
          : "after-low did not run",
      ),
      check(
        "a skipped target skips what waits on it, and a fail-fast failure skips what waits on it",
        byMode("never-after-skip") === undefined &&
          byMode("never-after-fail") === undefined &&
          status("after-skipper") === "skipped" &&
          status("after-failer") === "skipped" &&
          status("loner") === "ok",
        `after-skipper ${status("after-skipper")} · after-failer ${status("after-failer")} · loner ${status("loner")}`,
      ),
    );

    // Remote review.
    const remote = s.remote;
    const remoteRecords = recordsIn(sim, STEP.remote);
    const remoteFindings = (remote?.json?.findings as Json[] | undefined) ?? [];
    results.push(
      scriptedCheck(
        sim,
        "a remote review runs the server's extension on the server and the client sees its result",
        remote?.exitCode === 0 &&
          remoteRecords.length === 1 &&
          remoteRecords[0]!.details.reviewType === "remote" &&
          remoteRecords[0]!.details.workdir === "" &&
          remoteFindings.some(
            (item) =>
              item.extensionId === "remote-probe" &&
              item.title === "Remote extension note",
          ),
        `exit ${remote?.exitCode} · ${remoteRecords.length} server runs · ${remoteFindings.length} findings`,
        "the exit code follows the findings the model reports",
      ),
      check(
        "a remote review runs the server's extension once on the server, and the client sees its finding",
        (remote?.exitCode === 0 || remote?.exitCode === 1) &&
          remoteRecords.length === 1 &&
          remoteRecords[0]!.details.reviewType === "remote" &&
          remoteRecords[0]!.details.workdir === "" &&
          remoteFindings.some(
            (item) =>
              item.extensionId === "remote-probe" &&
              item.title === "Remote extension note",
          ),
        `exit ${remote?.exitCode} · ${remoteRecords.length} server runs · ${remoteFindings.length} findings`,
      ),
      check(
        "a remote client cannot make the server run a command",
        s.remoteSubmit !== undefined &&
          !existsSync(`${paths(sim).log}.evil`) &&
          remoteRecords.every((record) => record.mode === "remote"),
        `submit carried ${Object.keys(s.remoteSubmit ?? {})
          .filter((key) => key.startsWith("extension"))
          .join(
            ", ",
          )} · marker ${existsSync(`${paths(sim).log}.evil`) ? "written" : "absent"}`,
      ),
    );
    return results;
  },
});
