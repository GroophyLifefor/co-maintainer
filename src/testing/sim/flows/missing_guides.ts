/** A repository that was never initialized, in every review mode.
 *
 * It has no guides, so its review cannot run. Local review, `review owner/repo
 * N`, `review --remote` and `review --remote --range` have to say the same
 * thing: the code `not_initialized`, exit code 2 and the init hint, with no
 * model call and no write to GitHub. This flow runs all four on one repository
 * in the human, `--json` and `--output=github` outputs and compares them. It
 * also checks that a server which does not know a repository is told apart
 * from one without guides, that a push the App covers still exits 0, and that
 * a server's own text reaches the terminal without control characters.
 *
 * The remote server is the real one, with the repository known to it and no
 * guides written. Only the hostile text is scripted, by answering one
 * handshake in the flow itself. */
import { check, defineFlow, type CheckResult, type CliRun } from "../flow.ts";
import { REMOTE_HOST } from "../fetch.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import { remoteWire } from "./remote_support.ts";
import {
  clientChange,
  clientCheckout,
  PERCENT_OF_CHANGE,
  remoteCalls,
  runPushReview,
  runRemoteReview,
  type RemoteRun,
} from "./remote.ts";
import { openChangePull, reviewCli, runsOf } from "./cli_pr.ts";
import {
  checkoutStep,
  configureCli,
  LOCAL_CHANGE,
  localState,
  NO_CODEGRAPH,
  reviewStep,
} from "./local.ts";

type Json = Record<string, unknown>;

/** The one repository every mode reviews, with no guides. */
const REPO = "sim/unguided";
/** A repository the server does not know. */
const UNKNOWN = "sim/nowhere";
/** A repository the GitHub App covers, with no guides. */
const COVERED = "sim/covered";

const MESSAGE = `Review guides are missing for ${REPO}`;
const LOCAL_HINT = `co-maintainer init ${REPO}`;

/** What a hostile or broken server could put in an error text. */
const HOSTILE = "\u001b]52;c;aGk=\u0007bad\u001b[2J\rgateway";
const HOSTILE_CLEAN = "]52;c;aGk=bad[2Jgateway";

/** A change the push step has not put on the default branch yet. */
const ONE_MORE = {
  "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}\nexport const ONE = 1;\n`,
};

const STEP = {
  setup: "repository without guides",
  local: "local review",
  pr: "pull request review",
  server: "server that knows the repository",
  remote: "remote review",
  unknown: "remote review of an unknown repository",
  push: "push review",
  skipped: "push review the App covers",
  hostile: "server text with control characters",
} as const;

type Mode = "local" | "pr" | "remote" | "push";
type Format = "human" | "json" | "github";

type Case = {
  id: string;
  mode: Mode;
  format: Format;
  run: CliRun;
  /** The hint this mode prints. */
  hint: string;
};

type State = {
  token: string;
  prNumber: number;
  cases: Case[];
  remote: Map<string, RemoteRun>;
};

function state(sim: { state: Record<string, unknown> }): State {
  return (sim.state.missingGuides ??= {
    cases: [],
    remote: new Map(),
  }) as State;
}

function serverHint(sim: { server: { remoteUrl: string } }): string {
  return `Run co-maintainer init ${REPO} on the server at ${new URL(sim.server.remoteUrl).host}.`;
}

const FORMATS: { format: Format; args: string[] }[] = [
  { format: "human", args: [] },
  { format: "json", args: ["--json"] },
  { format: "github", args: ["--output=github"] },
];

/** The error a `--json` run printed, when it printed one. */
function jsonError(run: CliRun): { code?: string; hint?: string } | undefined {
  const last = run.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    const body = JSON.parse(last) as Json;
    return body.ok === false ? (body.error as Json) : undefined;
  } catch {
    return undefined;
  }
}

function hasControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code <= 0x08 && code >= 0) ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

export default defineFlow({
  name: "missing-guides",
  description:
    "a repository without guides gives not_initialized, exit 2 and the init hint in local, pull request, remote and push review",
  // Nothing here may reach a model, so there is no rule to answer one.
  ai: [],
  steps: [
    {
      name: STEP.setup,
      run(sim) {
        sim.repo(REPO);
        configureCli(sim);
        return `${REPO} opened on GitHub, init never run`;
      },
    },
    // Local review.
    checkoutStep("local", { repo: REPO, ...LOCAL_CHANGE }),
    ...FORMATS.map(({ format, args }) =>
      reviewStep(`${STEP.local} ${format}`, "local", [...args, NO_CODEGRAPH]),
    ),
    {
      name: `${STEP.local} collected`,
      run(sim) {
        for (const { format } of FORMATS) {
          const run = localState(sim).runs.get(`${STEP.local} ${format}`)!;
          state(sim).cases.push({
            id: `local ${format}`,
            mode: "local",
            format,
            run: run.cli,
            hint: LOCAL_HINT,
          });
        }
        return "3 runs";
      },
    },
    // Pull request review.
    {
      name: STEP.pr,
      async run(sim) {
        const pull = openChangePull(sim, { repo: REPO, title: "A change" });
        state(sim).prNumber = pull.number;
        const codes: number[] = [];
        for (const { format, args } of FORMATS) {
          const run = await reviewCli(sim, pull.number, args, REPO);
          state(sim).cases.push({
            id: `pull request ${format}`,
            mode: "pr",
            format,
            run,
            hint: LOCAL_HINT,
          });
          codes.push(run.exitCode);
        }
        return `exit ${codes.join(", ")}`;
      },
    },
    // Remote and push review, against a server that knows the repository and
    // has no guides for it.
    {
      name: STEP.server,
      async run(sim) {
        await sim.server.start({});
        state(sim).token = await sim.server.remoteToken("client");
        remoteWire(sim);
        const { activateRepo } = await import("../../../store/repos.ts");
        // Known the way a dashboard entry makes it known, with no App.
        activateRepo(REPO, undefined);
        // Known through an App installation, so a push gets a skipped check.
        sim.repo(COVERED);
        activateRepo(COVERED, sim.github.installation.id);
        return `${REPO} and ${COVERED} known, no guides`;
      },
    },
    {
      name: STEP.remote,
      async run(sim) {
        const dev = clientChange(
          sim,
          "dev",
          "sim/feature",
          PERCENT_OF_CHANGE,
          REPO,
        );
        const codes: number[] = [];
        for (const { format, args } of FORMATS) {
          const run = await runRemoteReview(sim, dev, [
            `--remote-token=${state(sim).token}`,
            ...args,
          ]);
          state(sim).remote.set(`remote ${format}`, run);
          state(sim).cases.push({
            id: `remote ${format}`,
            mode: "remote",
            format,
            run,
            hint: serverHint(sim),
          });
          codes.push(run.exitCode);
        }
        return `exit ${codes.join(", ")}`;
      },
    },
    {
      name: STEP.unknown,
      async run(sim) {
        const dev = clientChange(
          sim,
          "unknown",
          "sim/unknown",
          PERCENT_OF_CHANGE,
          REPO,
        );
        const run = await runRemoteReview(sim, dev, [
          `--remote-token=${state(sim).token}`,
          `--repo=${UNKNOWN}`,
          "--json",
        ]);
        state(sim).remote.set("unknown", run);
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.push,
      async run(sim) {
        const range = sim.github.commitToDefault(
          REPO,
          PERCENT_OF_CHANGE,
          "Add percentOf",
        );
        const ci = clientCheckout(sim, REPO, "ci");
        const codes: number[] = [];
        for (const { format, args } of FORMATS) {
          const run = await runPushReview(sim, ci, range, [
            `--remote-token=${state(sim).token}`,
            ...args,
          ]);
          state(sim).remote.set(`push ${format}`, run);
          state(sim).cases.push({
            id: `push ${format}`,
            mode: "push",
            format,
            run,
            hint: serverHint(sim),
          });
          codes.push(run.exitCode);
        }
        return `exit ${codes.join(", ")}`;
      },
    },
    {
      name: STEP.skipped,
      async run(sim) {
        const range = sim.github.commitToDefault(
          COVERED,
          PERCENT_OF_CHANGE,
          "Add percentOf",
        );
        const ci = clientCheckout(sim, COVERED, "covered");
        const run = await runPushReview(sim, ci, range, [
          `--remote-token=${state(sim).token}`,
        ]);
        state(sim).remote.set("skipped", run);
        return `exit ${run.exitCode}`;
      },
    },
    {
      name: STEP.hostile,
      async run(sim) {
        const dev = clientChange(sim, "hostile", "sim/hostile", ONE_MORE, REPO);
        // The server answers the handshake with a text full of escape
        // sequences. This sits on top of the wire, so the answer is the
        // flow's and the server never sees the call.
        const inner = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          if (
            url.hostname === REMOTE_HOST &&
            url.pathname === "/api/remote/handshake"
          ) {
            return Response.json(
              { error: { code: "internal", message: HOSTILE, requestId: "x" } },
              { status: 502 },
            );
          }
          return inner(input, init);
        };
        try {
          for (const [id, args] of [
            ["hostile human", []],
            ["hostile json", ["--json"]],
          ] as const) {
            const run = await runRemoteReview(sim, dev, [
              `--remote-token=${state(sim).token}`,
              ...args,
            ]);
            state(sim).remote.set(id, run);
          }
        } finally {
          globalThis.fetch = inner;
        }
        return "502 with escape sequences, human and json";
      },
    },
  ],
  checks(sim) {
    const s = state(sim);
    const results: CheckResult[] = [];
    const failing = (ok: (c: Case) => boolean) =>
      s.cases.filter((c) => !ok(c)).map((c) => c.id);
    const every = (name: string, ok: (c: Case) => boolean, detail: string) => {
      const bad = failing(ok);
      results.push(
        check(
          name,
          s.cases.length === 12 && bad.length === 0,
          bad.length
            ? `fails in: ${bad.join(", ")}`
            : `${s.cases.length} runs: ${detail}`,
        ),
      );
    };

    every(
      "every mode and output stops with exit code 2",
      (c) => c.run.exitCode === 2,
      "local, pull request, remote and push, in human, json and github",
    );
    every(
      "every mode names the repository and says its guides are missing",
      (c) => {
        const text = c.format === "json" ? c.run.stdout : c.run.stderr;
        return text.includes(MESSAGE);
      },
      MESSAGE,
    );
    every(
      "every --json run prints the error code not_initialized and the hint of its mode",
      (c) => {
        if (c.format !== "json") return true;
        const error = jsonError(c.run);
        return error?.code === "not_initialized" && error.hint === c.hint;
      },
      "same code in all four modes",
    );
    every(
      "every human and github run prints the hint of its mode on a Hint line",
      (c) => c.format === "json" || c.run.stderr.includes(`Hint: ${c.hint}`),
      "co-maintainer init for local and pull request, on the server for remote and push",
    );
    every(
      "human and github runs print nothing on stdout, json prints one error document",
      (c) =>
        c.format === "json"
          ? c.run.stdout.trim().split("\n").length === 1
          : c.run.stdout === "",
      "stdout is empty or one JSON line",
    );
    every(
      "no mode calls a model",
      (c) => c.run.completions().length === 0 && c.run.ai().length === 0,
      "0 AI calls in each run",
    );
    every(
      "no mode writes to GitHub",
      (c) => c.run.github().every((call) => call.method === "GET"),
      "reads only",
    );

    const localHuman = s.cases.find((c) => c.id === "local human");
    const localGithub = s.cases.find((c) => c.id === "local github");
    const plain = `${MESSAGE}.\n` + `Hint: ${LOCAL_HINT}\n`;
    results.push(
      check(
        "local review prints exactly the two lines it always has, with no [error] prefix",
        localHuman?.run.stderr === plain && localGithub?.run.stderr === plain,
        JSON.stringify(localHuman?.run.stderr ?? "no run"),
      ),
    );
    const prHuman = s.cases.find((c) => c.id === "pull request human");
    results.push(
      check(
        "pull request review prints the error with the usual [error] prefix, after its log lines",
        runsOf(sim, STEP.pr).length === 3 &&
          prHuman?.run.stderr.includes(
            `\n[error] ${MESSAGE}.\nHint: ${LOCAL_HINT}\n`,
          ) === true,
        JSON.stringify(prHuman?.run.stderr.split("\n").slice(-3) ?? "no run"),
      ),
    );

    // The server's own answers.
    const remoteHandshakes = remoteCalls(
      sim,
      STEP.remote,
      "/api/remote/handshake",
      "POST",
    );
    const pushCalls = remoteCalls(sim, STEP.push);
    const pushHandshakes = pushCalls.filter((call) =>
      call.url.endsWith("/api/remote/handshake"),
    );
    const pushSubmits = pushCalls.filter((call) =>
      call.url.endsWith("/api/remote/reviews"),
    );
    const errorOf = (call: { response: unknown } | undefined) =>
      ((call?.response as Json | null)?.error ?? {}) as Json;
    results.push(
      check(
        "the server refuses a remote review at the handshake with 409 not_initialized, which older clients read",
        remoteHandshakes.length === 3 &&
          remoteHandshakes.every(
            (call) =>
              call.status === 409 && errorOf(call).code === "not_initialized",
          ),
        remoteHandshakes
          .map((call) => `${call.status} ${errorOf(call).code}`)
          .join(", "),
      ),
      check(
        "the server accepts a push at the handshake and refuses its submit with 409 not_initialized",
        pushHandshakes.length === 3 &&
          pushHandshakes.every((call) => call.status === 200) &&
          pushSubmits.length === 3 &&
          pushSubmits.every(
            (call) =>
              call.status === 409 && errorOf(call).code === "not_initialized",
          ),
        `handshakes ${pushHandshakes.map((c) => c.status).join(",")} · submits ${pushSubmits
          .map((c) => `${c.status} ${errorOf(c).code}`)
          .join(", ")}`,
      ),
      check(
        "a refused run starts no review job on the server",
        sim.trace.jobs.filter((job) =>
          [STEP.remote, STEP.unknown, STEP.push, STEP.hostile].includes(
            job.step as never,
          ),
        ).length === 0,
        `${sim.trace.jobs.length} jobs in the whole flow`,
      ),
    );

    // Unknown repository against no guides.
    const unknown = s.remote.get("unknown");
    const unknownError = unknown?.json?.error as Json | undefined;
    const unknownHandshake = remoteCalls(
      sim,
      STEP.unknown,
      "/api/remote/handshake",
      "POST",
    )[0];
    results.push(
      check(
        "a repository the server does not know is repo_unavailable, not not_initialized",
        unknown?.exitCode === 2 &&
          unknownError?.code === "repo_unavailable" &&
          errorOf(unknownHandshake).code === "repo_unavailable" &&
          unknownHandshake?.status === 404 &&
          String(unknownError?.message).includes(
            `does not have ${UNKNOWN} available for review.`,
          ) &&
          !String(unknownError?.hint).includes("init"),
        unknownError
          ? `${unknownError.code}: ${unknownError.message}`
          : "no error",
      ),
      check(
        "the two refusals have different codes and different messages",
        unknownError?.code !== undefined &&
          unknownError.code !== jsonError(s.remote.get("remote json")!)?.code &&
          unknownError.message !==
            (jsonError(s.remote.get("remote json")!) as Json | undefined)
              ?.message,
        `${unknownError?.code} against ${jsonError(s.remote.get("remote json")!)?.code}`,
      ),
    );

    // A push the App covers is not an error.
    const skipped = s.remote.get("skipped");
    const skippedSubmit = remoteCalls(
      sim,
      STEP.skipped,
      "/api/remote/reviews",
      "POST",
    )[0];
    results.push(
      check(
        "a push the App covers still exits 0 with not_initialized_skipped and a skipped check run",
        skipped?.exitCode === 0 &&
          skippedSubmit?.status === 409 &&
          errorOf(skippedSubmit).code === "not_initialized_skipped" &&
          skipped.stdout.includes("The commit got a skipped check run.") &&
          skipped.completions().length === 0 &&
          skipped
            .github()
            .filter((call) => call.method !== "GET")
            .every((call) => call.url.includes("/check-runs")),
        skipped
          ? `exit ${skipped.exitCode} · ${skipped.stdout.trim()}`
          : "no run",
      ),
    );

    // Control characters from the server.
    const hostileHuman = s.remote.get("hostile human");
    const hostileJson = s.remote.get("hostile json");
    results.push(
      check(
        "a server's error text reaches the terminal without control characters",
        hostileHuman?.exitCode === 2 &&
          hostileHuman.stderr === `[error] ${HOSTILE_CLEAN}\n` &&
          !hasControlChars(hostileHuman.stderr.replace(/\n$/, "")) &&
          hostileJson?.exitCode === 2 &&
          (hostileJson.json?.error as Json | undefined)?.code ===
            "remote_handshake_failed" &&
          (hostileJson.json?.error as Json | undefined)?.message ===
            HOSTILE_CLEAN,
        JSON.stringify(hostileHuman?.stderr ?? "no run"),
      ),
    );

    // Whole flow.
    results.push(
      check(
        "the whole flow made no model call",
        sim.trace.completions.length === 0 && sim.trace.ai.length === 0,
        `${sim.trace.ai.length} AI calls`,
      ),
      check(
        "the only write to GitHub is the skipped check run of the covered repository",
        sim.github.writes.length >= 1 &&
          sim.github.writes.every(
            (write) =>
              write.path.includes("/check-runs") &&
              write.path.includes(COVERED),
          ),
        `${sim.github.writes.length} writes: ${[
          ...new Set(sim.github.writes.map((w) => w.path)),
        ].join(", ")}`,
      ),
    );
    return results;
  },
});
