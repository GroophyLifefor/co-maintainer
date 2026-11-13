/** Large diff coverage (issue 76): a change too large for one prompt is
 * planned, not cut. Every file ends in one state, the prompt stays inside the
 * budget, the outputs say what was not reviewed, later rounds send what an
 * earlier one dropped, and a big file is read in pages.
 *
 * The large changes are generated files, so the flow needs no fixture. It
 * runs local review, CLI pull request review, remote review and the App, and
 * reuses the base flows' exports for each. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AiRule } from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  type CliRun,
  defineFlow,
  type Score,
  type Sim,
  type Step,
} from "../flow.ts";
import type { FileChanges, GithubWrite, SimPull } from "../github.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";
import {
  chatOf,
  type Chat,
  checkoutStep,
  type Files,
  LOCAL_CHANGE,
  LOCAL_REPO,
  localState,
  NO_CODEGRAPH,
  prepareLocalRepo,
  type ReviewRun,
  reviewStep,
  runReview,
} from "./local.ts";
import { parseJsonOutput, reviewCli } from "./cli_pr.ts";
import { openPull, pushRound, serveRepo, writesIn } from "./app.ts";
import {
  clientChange,
  promptsOf,
  runRemoteReview,
  startRemoteServer,
} from "./remote.ts";
import type { Checkout as RemoteCheckout } from "./remote_support.ts";

type Json = Record<string, unknown>;

/** The product's limits, written here rather than imported, so a change to
 * them shows as a failing check instead of agreeing with itself. */
const BUDGET = 240_000;
const LISTED = 200;

const REMOTE_REPO = "sim/remote-large";
const APP_REPO = "sim/app-large";

// ------------------------------------------------------------- the changes

/** `count` files of `lines` lines of about `width` characters, under `dir`. */
function generated(
  dir: string,
  count: number,
  lines: number,
  width = 50,
): Files {
  const files: Files = {};
  for (let i = 0; i < count; i++) {
    const id = String(i).padStart(4, "0");
    const body = Array.from({ length: lines }, (_, n) => {
      const head = `export const v${id}_${n} = "`;
      return `${head}${"x".repeat(Math.max(1, width - head.length - 2))}";`;
    });
    files[`${dir}/f${id}.ts`] = `${body.join("\n")}\n`;
  }
  return files;
}

/** 1,000 small files: about twice the budget, so round 1 drops about half
 * and round 2 still cannot send all of it. */
const LARGE = generated("src/gen", 1000, 8);
/** 400 files of about 1,500 characters: each saves too little to summarize. */
const MEDIUM = generated("src/medium", 400, 30);
/** One file over 500 changed lines and 12,000 characters, read in pages. */
const BIG_PATH = "src/big/table.ts";
const BIG_LINES = Array.from(
  { length: 700 },
  (_, n) => `export const row${n} = ${n * 7}; // generated`,
);
const BIG = `${BIG_LINES.join("\n")}\n`;
/** Pages of the big file the model asks for: offsets and the limit. */
const PAGE = 300;
const OFFSETS = [0, 300, 600];
/** 500 small files for the remote review. */
const REMOTE_FILES = generated("src/remote", 500, 8);
/** 170 files of about 3,000 characters for the App: round 1 shows about
 * 70, and the 100 it drops are still over the budget in round 2. */
const APP_FILES = generated("src/a", 170, 50, 60);
/** A dropped file whose name tries to inject Markdown and a mention into the
 * review body. It sorts last, so the plan drops it. */
const HOSTILE_LINK =
  // Windows refuses a ":" in a path, and git on Windows refuses to index one,
  // so there the link has no scheme separator. The name keeps the backticks,
  // the mention and the link brackets the check is about.
  process.platform === "win32" ? "](javascript-alert)" : "](javascript:alert)";
const HOSTILE = `src/zz\`x @octo-org see [here${HOSTILE_LINK}\`.ts`;
/** What the product puts after an `@` in a posted path. Built from its code,
 * because an escape in a string literal is rewritten by the formatter into
 * the invisible character itself. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/** The numbered big-file patch `read-full-diff` serves, line by line:
 * computed here from the file, not by the product. */
const BIG_NUMBERED = [
  `@@ -0,0 +1,${BIG_LINES.length} @@`,
  ...BIG_LINES.map((text, n) => `${String(n + 1).padStart(6)} +${text}`),
];

// ------------------------------------------------------------ the fake AI

const AI: AiRule[] = [
  {
    // The big file is summarized, so the model reads it in three pages
    // before it answers.
    name: "reads the big file in pages",
    job: "review_local",
    prompt: BIG_PATH,
    reply: ({ round }) =>
      round < OFFSETS.length
        ? {
            toolCalls: [
              {
                name: "read-full-diff",
                arguments: {
                  path: BIG_PATH,
                  offset: OFFSETS[round],
                  limit: PAGE,
                },
              },
            ],
          }
        : { findings: [] },
  },
  {
    name: "summary",
    job: "summarize_large_diff",
    reply: "It adds generated constants, one per line.",
  },
  {
    name: "reviewer",
    job: /^review_(local|pull_request)$/,
    reply: { findings: [] },
  },
  ...INIT_AI,
];

// ----------------------------------------------------------------- readers

/** The DIFF section of a review prompt, up to the lists that follow it. */
function diffSection(prompt: string): string {
  const start = prompt.indexOf("\nDIFF:\n");
  if (start < 0) return "";
  const body = prompt.slice(start + 7);
  const end = body.search(/\nUNCHANGED SINCE LAST REVIEW|\n\nUPSTREAM CONTEXT/);
  return end < 0 ? body : body.slice(0, end);
}

/** The files a prompt sent with a block of their own. */
function filesSent(prompt: string): string[] {
  return [...diffSection(prompt).matchAll(/^FILE: (.+)$/gm)].map((m) => m[1]!);
}

/** The NOT SHOWN list's rows, or undefined when the prompt has none. */
function notShownRows(prompt: string): string[] | undefined {
  const at = prompt.indexOf("NOT SHOWN (diff budget)");
  if (at < 0) return undefined;
  const rows: string[] = [];
  for (const line of prompt.slice(at).split("\n").slice(2)) {
    if (!line.startsWith("- ")) break;
    rows.push(line);
  }
  return rows;
}

type Coverage = {
  full: number;
  partial: string[];
  summarized: string[];
  dropped: string[];
  withheld: string[];
};

function coverageOf(json: Json | undefined): Coverage | undefined {
  return (json?.revision as { coverage?: Coverage } | undefined)?.coverage;
}

function stateCount(c: Coverage | undefined): number {
  return c
    ? c.full +
        c.partial.length +
        c.summarized.length +
        c.dropped.length +
        c.withheld.length
    : -1;
}

function warningCodes(json: Json | undefined): string[] {
  return ((json?.warnings as { code: string }[] | undefined) ?? []).map(
    (warning) => warning.code,
  );
}

function truncated(json: Json | undefined): unknown {
  return (json?.revision as { truncated?: unknown } | undefined)?.truncated;
}

/** The first prompt of each review conversation of a local run. */
function reviewPrompts(run: ReviewRun | undefined): string[] {
  return (run?.completions ?? [])
    .filter((call) => call.job === "review_local")
    .map((call) => call.firstUser);
}

/** The review requests of a local run, as chats. */
function reviewChats(run: ReviewRun | undefined): Chat[] {
  return (run?.ai ?? [])
    .filter((call) => call.job === "review_local")
    .map(chatOf);
}

/** The posted review body of a step: the first POST to `/reviews`. */
function postedBody(sim: Sim, step: string): string {
  const write = writesIn(sim, step).find(
    (item: GithubWrite) =>
      item.method === "POST" && item.path.endsWith("/reviews"),
  );
  return String((write?.body as { body?: unknown } | undefined)?.body ?? "");
}

// ----------------------------------------------------------------- state

type State = {
  githubSummary: string;
  githubStdout: string;
  cliPr: Map<string, CliRun>;
  pulls: Map<string, SimPull>;
  remote?: RemoteCheckout;
  remoteToken: string;
  remoteRuns: Map<string, CliRun & { json?: Json }>;
  oldShapeRewrites: number;
};

function state(sim: Sim): State {
  return (sim.state.largeDiff ??= {
    githubSummary: "",
    githubStdout: "",
    cliPr: new Map(),
    pulls: new Map(),
    remoteRuns: new Map(),
    remoteToken: "",
    oldShapeRewrites: 0,
  }) as State;
}

const run = (sim: Sim, label: string): ReviewRun | undefined =>
  localState(sim).runs.get(label);

// ------------------------------------------------------------------ steps

const STEP = {
  guides: "repository with guides",
  human: "large: human output",
  github: "large: --output=github",
  round1: "large: round 1",
  round2: "large: round 2",
  round3: "large: round 3",
  medium: "many medium files",
  big: "big file read in pages",
  small: "small change",
  smallHuman: "small change: human output",
  renameOnly: "pull request: a pure rename",
  mixed: "pull request: rename, binary and code",
  remoteServer: "remote: server with guides",
  remoteJson: "remote: large change",
  remoteHuman: "remote: human output",
  remoteOld: "remote: an older server's result",
  appServe: "app: served repository",
  appWhole: "app: large pull request, whole-pr",
  appIncremental: "app: incremental round",
  appNoLow: "app: no low model configured",
  appHostile: "app: a hostile file name",
} as const;

const githubStep: Step = {
  name: STEP.github,
  async run(sim) {
    const path = sim.world.useStepSummary();
    rmSync(path, { force: true });
    const review = await runReview(
      sim,
      localState(sim).checkouts.get("large")!,
      STEP.github,
      ["--output=github", NO_CODEGRAPH, "--fresh"],
    );
    localState(sim).runs.set(STEP.github, review);
    const s = state(sim);
    s.githubStdout = review.cli.stdout;
    s.githubSummary = existsSync(path) ? readFileSync(path, "utf8") : "";
    return `exit ${review.cli.exitCode}`;
  },
};

function cliPrStep(name: string, files: FileChanges, extra: string[]): Step {
  return {
    name,
    async run(sim) {
      const pull = sim.github.openPull(LOCAL_REPO, { title: name, files });
      state(sim).pulls.set(name, pull);
      const json = await reviewCli(sim, pull.number, ["--json"]);
      state(sim).cliPr.set(`${name} json`, json);
      const human = await reviewCli(sim, pull.number, ["--fresh", ...extra]);
      state(sim).cliPr.set(`${name} human`, human);
      return `#${pull.number} · exit ${json.exitCode}, ${human.exitCode}`;
    },
  };
}

/** Makes the client see what a server from before coverage sends: the sync
 * result without `revision.coverage`, `revision.truncated` and `warnings`.
 * Returns the function that takes the rewrite away again. */
function serveOldShape(sim: Sim): () => void {
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await inner(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!/\/api\/remote\/reviews\/[^/]+\/sync$/.test(url.pathname)) {
      return response;
    }
    const body = (await response.json()) as Json;
    const result = body.result as Json | null | undefined;
    if (result && typeof result === "object") {
      const {
        coverage: _coverage,
        truncated: _truncated,
        ...revision
      } = (result.revision ?? {}) as Json;
      const { warnings: _warnings, ...rest } = result;
      body.result = { ...rest, revision: { ...revision, truncated: false } };
      state(sim).oldShapeRewrites++;
    }
    return Response.json(body, { status: response.status });
  };
  return () => {
    globalThis.fetch = inner;
  };
}

function remoteStep(name: string, args: string[], oldShape = false): Step {
  return {
    name,
    async run(sim) {
      const restore = oldShape ? serveOldShape(sim) : () => {};
      try {
        const result = await runRemoteReview(sim, state(sim).remote!, [
          `--remote-token=${state(sim).remoteToken}`,
          ...args,
        ]);
        state(sim).remoteRuns.set(name, result);
        const why = result.stderr.trim().split("\n").at(-1) ?? "";
        return `exit ${result.exitCode}${result.exitCode ? ` · ${why}` : ""}`;
      } finally {
        restore();
      }
    },
  };
}

const steps: Step[] = [
  { name: STEP.guides, run: (sim) => prepareLocalRepo(sim) },
  // Local review of a change over the budget, in the three outputs, then
  // three rounds of the same change.
  checkoutStep("large", { committed: LARGE }),
  reviewStep(STEP.human, "large", [NO_CODEGRAPH]),
  githubStep,
  reviewStep(STEP.round1, "large", ["--json", NO_CODEGRAPH, "--fresh"]),
  reviewStep(STEP.round2, "large", ["--json", NO_CODEGRAPH]),
  reviewStep(STEP.round3, "large", ["--json", NO_CODEGRAPH]),
  checkoutStep("medium", { committed: MEDIUM }),
  reviewStep(STEP.medium, "medium", ["--json", NO_CODEGRAPH]),
  checkoutStep("big", {
    committed: { [BIG_PATH]: BIG, "src/big/note.ts": "export const n = 1;\n" },
  }),
  reviewStep(STEP.big, "big", ["--json", NO_CODEGRAPH]),
  checkoutStep("small", LOCAL_CHANGE),
  reviewStep(STEP.small, "small", ["--json", NO_CODEGRAPH]),
  reviewStep(STEP.smallHuman, "small", [NO_CODEGRAPH, "--fresh"]),
  // CLI pull request review of what GitHub sends without a patch.
  cliPrStep(
    STEP.renameOnly,
    {
      "src/format.ts": null,
      "src/formatting.ts": SAMPLE_REPO["src/format.ts"]!,
    },
    [],
  ),
  cliPrStep(
    STEP.mixed,
    {
      "src/index.ts": null,
      "src/entry.ts": SAMPLE_REPO["src/index.ts"]!,
      "assets/logo.png": "\u0000\u0001\u0002PNG\u0000binary\u0000",
      "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}\nexport const two = 2;\n`,
    },
    [],
  ),
  // Remote review: the server plans the diff, the client shows it.
  {
    name: STEP.remoteServer,
    async run(sim) {
      state(sim).remoteToken = await startRemoteServer(sim, {}, REMOTE_REPO);
      state(sim).remote = clientChange(
        sim,
        "remote-large",
        "sim/large",
        REMOTE_FILES,
        REMOTE_REPO,
      );
      return `${REMOTE_REPO} · ${Object.keys(REMOTE_FILES).length} files`;
    },
  },
  remoteStep(STEP.remoteJson, ["--json"]),
  remoteStep(STEP.remoteHuman, ["--fresh"]),
  remoteStep(STEP.remoteOld, ["--fresh"], true),
  // The App: a large pull request, whole-pr then incremental, and a server
  // with no low model.
  {
    name: STEP.appServe,
    async run(sim) {
      await serveRepo(sim, APP_REPO);
      return APP_REPO;
    },
  },
  {
    name: STEP.appWhole,
    async run(sim) {
      const round = await openPull(
        sim,
        { title: "Generated tables", files: APP_FILES },
        APP_REPO,
      );
      state(sim).pulls.set(STEP.appWhole, round.pull);
      return `#${round.pull.number}`;
    },
  },
  {
    // Just over the budget, so the plan drops only the last few files in
    // path order: the hostile one is among them and inside the list's 20
    // rows. It is a little larger than the rest, so the room left after
    // dropping never brings it back.
    name: STEP.appHostile,
    async run(sim) {
      const files = Object.fromEntries(Object.entries(APP_FILES).slice(0, 72));
      const round = await openPull(
        sim,
        {
          title: "A file with a hostile name",
          files: {
            ...files,
            [HOSTILE]: Object.values(generated("x", 1, 52, 60))[0]!,
          },
        },
        APP_REPO,
      );
      return `#${round.pull.number}`;
    },
  },
  {
    name: STEP.appIncremental,
    async run(sim) {
      const { updateRepoSettings } = await import("../../../store/repos.ts");
      updateRepoSettings(APP_REPO, { review_scope: "incremental" });
      const pull = state(sim).pulls.get(STEP.appWhole)!;
      const first = "src/a/f0000.ts";
      await pushRound(sim, pull, {
        [first]: `${APP_FILES[first]}export const touched = 1;\n`,
      });
      updateRepoSettings(APP_REPO, { review_scope: "whole-pr" });
      return `#${pull.number}`;
    },
  },
  {
    name: STEP.appNoLow,
    async run(sim) {
      const low = sim.options().lowModel;
      sim.world.writeConfig({ lowModel: undefined });
      try {
        const round = await openPull(
          sim,
          { title: "One big table", files: { [BIG_PATH]: BIG } },
          APP_REPO,
        );
        return `#${round.pull.number} · ${round.jobs.map((job) => job.status).join(", ")}`;
      } finally {
        sim.world.writeConfig({ lowModel: low });
      }
    },
  },
];

// ----------------------------------------------------------------- checks

function localChecks(sim: Sim): CheckResult[] {
  const rounds = [STEP.round1, STEP.round2, STEP.round3].map((label) =>
    run(sim, label),
  );
  const [one, two, three] = rounds;
  const prompt1 = reviewPrompts(one)[0] ?? "";
  const rows = notShownRows(prompt1);
  const cov1 = coverageOf(one?.json);
  const sent = rounds.map((item) => filesSent(reviewPrompts(item)[0] ?? ""));
  const overlap = sent[1]!
    .filter((path) => sent[0]!.includes(path))
    .concat(
      sent[2]!.filter(
        (path) => sent[0]!.includes(path) || sent[1]!.includes(path),
      ),
    );
  const allSent = new Set(sent.flat());
  const human = run(sim, STEP.human)?.cli.stdout ?? "";
  const s = state(sim);
  const plainWarnings = s.githubStdout
    .split("\n")
    .filter((line) => line.startsWith("::warning") && !line.includes("file="));
  const largest = Math.max(
    ...rounds.map((item) => diffSection(reviewPrompts(item)[0] ?? "").length),
  );
  return [
    check(
      "each large round's DIFF section stays within the budget",
      largest > 0 && largest <= BUDGET,
      `largest ${largest} of ${BUDGET} chars`,
    ),
    check(
      "round 1 puts every file in exactly one state",
      stateCount(cov1) === Object.keys(LARGE).length &&
        (cov1?.dropped.length ?? 0) > 0 &&
        sent[0]!.length + (cov1?.dropped.length ?? 0) ===
          Object.keys(LARGE).length,
      `states ${stateCount(cov1)} of ${Object.keys(LARGE).length} · ${sent[0]!.length} sent · ${cov1?.dropped.length} dropped`,
    ),
    check(
      "the NOT SHOWN list is there and names at most 200 files",
      rows !== undefined &&
        rows.length === LISTED + 1 &&
        rows.at(-1) === `- and ${(cov1?.dropped.length ?? 0) - LISTED} more`,
      rows ? `${rows.length} rows · last ${rows.at(-1)}` : "no NOT SHOWN list",
    ),
    check(
      "--json says truncated and names the dropped files in a warning",
      truncated(one?.json) === true &&
        warningCodes(one?.json).includes("diff_dropped"),
      `truncated ${String(truncated(one?.json))} · ${warningCodes(one?.json).join(", ")}`,
    ),
    check(
      "human output has the coverage line and the files-reviewed wording",
      /^Coverage: \d+ full · 0 partial · 0 summarized · \d+ dropped$/m.test(
        human,
      ) &&
        human.includes("No actionable findings in the files reviewed.") &&
        human.includes("Run review again to cover them."),
      human
        .split("\n")
        .filter((line) => /Coverage|findings|again/.test(line))
        .join(" | "),
    ),
    check(
      "--output=github has the summary lines and one plain warning",
      plainWarnings.length === 1 &&
        plainWarnings[0]!.includes(
          "not reviewed because the diff is too large",
        ) &&
        /^Coverage: \d+ full · 0 partial · 0 summarized · \d+ dropped$/m.test(
          s.githubSummary,
        ) &&
        /^Not reviewed \(\d+\)$/m.test(s.githubSummary) &&
        /^- and \d+ more$/m.test(s.githubSummary),
      `${plainWarnings.length} plain warnings · summary ${s.githubSummary.length} chars`,
    ),
    check(
      "rounds 2 and 3 send what earlier rounds dropped, nothing twice",
      sent[1]!.length > 0 &&
        sent[2]!.length > 0 &&
        overlap.length === 0 &&
        allSent.size === Object.keys(LARGE).length,
      `${sent.map((list) => list.length).join(" + ")} sent · ${overlap.length} twice · ${allSent.size} distinct`,
    ),
    check(
      "round 3 finishes with every file covered",
      truncated(three?.json) === false &&
        coverageOf(three?.json)?.full === Object.keys(LARGE).length &&
        !warningCodes(three?.json).includes("diff_dropped") &&
        (coverageOf(two?.json)?.dropped.length ?? 0) > 0,
      `round 2 dropped ${coverageOf(two?.json)?.dropped.length} · round 3 ${JSON.stringify(coverageOf(three?.json))?.slice(0, 120)}`,
    ),
  ];
}

function mediumAndBigChecks(sim: Sim): CheckResult[] {
  const medium = run(sim, STEP.medium);
  const mcov = coverageOf(medium?.json);
  const mediumSummaries = (medium?.ai ?? []).filter(
    (call) => call.job === "summarize_large_diff",
  ).length;
  const big = run(sim, STEP.big);
  const bcov = coverageOf(big?.json);
  const summary = (big?.ai ?? []).find(
    (call) => call.job === "summarize_large_diff",
  );
  const summaryModel = (summary?.request as { model?: string } | undefined)
    ?.model;
  const chats = reviewChats(big);
  const asked = chats.flatMap((chat) => chat.answerToolCalls);
  const pages = chats.at(-1)?.toolResults ?? [];
  const bodies = pages.map((page) =>
    page.replace(/\n\[more: call again with offset=\d+\]$/, ""),
  );
  // The patch ends with a line break, so its last line is empty: no text.
  const joined = bodies.join("\n").replace(/\n$/, "").split("\n");
  return [
    check(
      "many medium files: no summary, files in full up to the budget",
      mediumSummaries === 0 &&
        (mcov?.summarized.length ?? -1) === 0 &&
        (mcov?.full ?? 0) >= 125 &&
        (mcov?.full ?? 0) + (mcov?.dropped.length ?? 0) ===
          Object.keys(MEDIUM).length,
      `${mediumSummaries} summary calls · ${mcov?.full} full · ${mcov?.dropped.length} dropped`,
    ),
    check(
      "the big file is summarized on the low model",
      JSON.stringify(bcov?.summarized) === JSON.stringify([BIG_PATH]) &&
        summaryModel === sim.options().lowModel,
      `summarized ${JSON.stringify(bcov?.summarized)} · summary on ${summaryModel}`,
    ),
    check(
      "the model reads the big file with offset and limit, and a second page is served",
      asked.length === OFFSETS.length &&
        asked.every((call) => call.includes(`"limit":${PAGE}`)) &&
        asked[1]?.includes('"offset":300') === true &&
        pages[0]?.endsWith("[more: call again with offset=300]") === true &&
        bodies[1]?.startsWith(`   300 +${BIG_LINES[299]}`) === true,
      `${asked.length} reads · page 2 starts ${JSON.stringify(bodies[1]?.slice(0, 30))}`,
    ),
    check(
      "the pages join to the real patch",
      JSON.stringify(joined) === JSON.stringify(BIG_NUMBERED),
      `${joined.length} lines read · ${BIG_NUMBERED.length} in the patch`,
    ),
  ];
}

function smallChecks(sim: Sim): CheckResult[] {
  const json = run(sim, STEP.small)?.json;
  const human = run(sim, STEP.smallHuman)?.cli.stdout ?? "";
  return [
    check(
      "a small ordinary change: truncated false, all full, no coverage line",
      truncated(json) === false &&
        coverageOf(json)?.full === 4 &&
        warningCodes(json).length === 0 &&
        !human.includes("Coverage:") &&
        human.includes("No actionable findings.") &&
        !human.includes("in the files reviewed"),
      `truncated ${String(truncated(json))} · ${JSON.stringify(coverageOf(json))}`,
    ),
  ];
}

function cliPrChecks(sim: Sim): CheckResult[] {
  const s = state(sim);
  const rename = parseJsonOutput(
    s.cliPr.get(`${STEP.renameOnly} json`)?.stdout ?? "",
  );
  const renameHuman = s.cliPr.get(`${STEP.renameOnly} human`)?.stdout ?? "";
  const mixed = parseJsonOutput(
    s.cliPr.get(`${STEP.mixed} json`)?.stdout ?? "",
  );
  const mixedHuman = s.cliPr.get(`${STEP.mixed} human`)?.stdout ?? "";
  const mixedPrompt =
    s.cliPr
      .get(`${STEP.mixed} json`)
      ?.completions()
      .find((call) => call.job === "review_pull_request")?.firstUser ?? "";
  return [
    check(
      "a pull request that only renames is not truncated and lists nothing",
      truncated(rename) === false &&
        coverageOf(rename)?.full === 1 &&
        warningCodes(rename).length === 0 &&
        !renameHuman.includes("Coverage:"),
      `truncated ${String(truncated(rename))} · ${JSON.stringify(coverageOf(rename))}`,
    ),
    check(
      "rename, binary and code: the binary is withheld, the rename is full",
      truncated(mixed) === true &&
        JSON.stringify(coverageOf(mixed)?.withheld) ===
          JSON.stringify(["assets/logo.png"]) &&
        coverageOf(mixed)?.full === 2 &&
        warningCodes(mixed).includes("diff_withheld") &&
        /renamed without changes from src\/index\.ts/.test(mixedPrompt) &&
        mixedHuman.includes("· 1 withheld"),
      `${JSON.stringify(coverageOf(mixed))} · ${warningCodes(mixed).join(", ")}`,
    ),
  ];
}

function remoteChecks(sim: Sim): CheckResult[] {
  const s = state(sim);
  const json = s.remoteRuns.get(STEP.remoteJson)?.json;
  const cov = coverageOf(json);
  const prompt = promptsOf(sim, STEP.remoteJson, "review_local")[0] ?? "";
  const human = s.remoteRuns.get(STEP.remoteHuman)?.stdout ?? "";
  const old = s.remoteRuns.get(STEP.remoteOld);
  return [
    check(
      "remote: the server plans the diff inside the budget",
      diffSection(prompt).length > 0 &&
        diffSection(prompt).length <= BUDGET &&
        notShownRows(prompt) !== undefined,
      `${diffSection(prompt).length} chars · NOT SHOWN ${notShownRows(prompt)?.length ?? "missing"}`,
    ),
    check(
      "remote: the client's --json has the server's coverage",
      truncated(json) === true &&
        (cov?.dropped.length ?? 0) > 0 &&
        stateCount(cov) === Object.keys(REMOTE_FILES).length &&
        warningCodes(json).includes("diff_dropped"),
      `truncated ${String(truncated(json))} · states ${stateCount(cov)}`,
    ),
    check(
      "remote: the client prints the coverage line",
      /^Coverage: \d+ full · 0 partial · 0 summarized · \d+ dropped$/m.test(
        human,
      ) && human.includes("in the files reviewed"),
      human
        .split("\n")
        .filter((line) => line.startsWith("Coverage"))
        .join(""),
    ),
    check(
      "remote: a result without coverage, as an older server sends it, prints without one",
      s.oldShapeRewrites > 0 &&
        old?.exitCode === 0 &&
        !old.stdout.includes("Coverage:") &&
        old.stdout.includes("No actionable findings."),
      `${s.oldShapeRewrites} rewritten · exit ${old?.exitCode}`,
    ),
  ];
}

function rows<T>(path: string, sql: string): T[] {
  if (!existsSync(path)) return [];
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all() as T[];
  } finally {
    database.close();
  }
}

/** Every billed token is recorded once: CLI, init and remote calls in the
 * cost rows (`recordAiCost`), App reviews in their reviews row. A remote
 * review has a reviews row too, but it already is in the cost rows. */
function costCheck(sim: Sim): CheckResult {
  const billed = sim.trace.completions.reduce(
    (sum, call) => ({
      in: sum.in + call.billedIn,
      out: sum.out + call.billedOut,
    }),
    { in: 0, out: 0 },
  );
  const cost = rows<{ value: string }>(
    sim.paths.cacheDb,
    "SELECT value FROM cache WHERE namespace = 'cost'",
  )
    .map(
      (row) => JSON.parse(row.value) as { tokensIn: number; tokensOut: number },
    )
    .reduce(
      (sum, row) => ({
        in: sum.in + row.tokensIn,
        out: sum.out + row.tokensOut,
      }),
      { in: 0, out: 0 },
    );
  const app = rows<{ tokens_in: number; tokens_out: number }>(
    sim.paths.appDb,
    "SELECT tokens_in, tokens_out FROM reviews WHERE scope <> 'remote'",
  ).reduce(
    (sum, row) => ({
      in: sum.in + row.tokens_in,
      out: sum.out + row.tokens_out,
    }),
    { in: 0, out: 0 },
  );
  return check(
    "cost recorded once for every AI call, App reviews in their review row",
    billed.in > 0 &&
      billed.in === cost.in + app.in &&
      billed.out === cost.out + app.out,
    `billed ${billed.in} in, ${billed.out} out · cost rows ${cost.in} in, ${cost.out} out · App reviews ${app.in} in, ${app.out} out`,
  );
}

function appChecks(sim: Sim): CheckResult[] {
  const whole = postedBody(sim, STEP.appWhole);
  const incremental = postedBody(sim, STEP.appIncremental);
  const noLow = postedBody(sim, STEP.appNoLow);
  const hostile = postedBody(sim, STEP.appHostile);
  const hostileRow =
    hostile.split("\n").find((line) => line.includes("octo-org")) ?? "";

  const incrementalPrompt =
    sim.trace.completions.find(
      (call) =>
        call.step === STEP.appIncremental && call.job === "review_pull_request",
    )?.firstUser ?? "";
  const wholePrompt =
    sim.trace.completions.find(
      (call) =>
        call.step === STEP.appWhole && call.job === "review_pull_request",
    )?.firstUser ?? "";
  const resent = filesSent(incrementalPrompt).filter(
    (path) =>
      !filesSent(wholePrompt).includes(path) && path !== "src/a/f0000.ts",
  );
  const summary = sim.trace.ai.find(
    (call) =>
      call.step === STEP.appNoLow && call.job === "summarize_large_diff",
  );
  const summaryModel = (summary?.request as { model?: string } | undefined)
    ?.model;
  return [
    check(
      "app: the review lists what it did not review, and the Metadata coverage",
      /^Not reviewed \(\d+\)$/m.test(whole) &&
        /^- and \d+ more$/m.test(whole) &&
        /\n- Coverage: \d+ full · 0 partial · 0 summarized · \d+ dropped\n<\/details>$/.test(
          whole,
        ),
      whole
        .split("\n")
        .filter((line) => /Not reviewed|Coverage/.test(line))
        .join(" | "),
    ),
    check(
      "app: a hostile file name is one inert code span",
      hostileRow.startsWith("- `") &&
        (hostileRow.match(/`/g) ?? []).length === 2 &&
        !/@octo-org/.test(hostile) &&
        hostileRow.includes(`@${ZERO_WIDTH_SPACE}octo-org`) &&
        hostileRow.includes(HOSTILE_LINK) &&
        !/^#/m.test(hostile),
      JSON.stringify(hostileRow),
    ),
    check(
      "app: whole-pr says the files are not reviewed in this mode",
      whole.includes("the diff was too large, not reviewed in this mode") &&
        !whole.includes("for this round"),
      whole
        .split("\n")
        .find(
          (line) => line.startsWith("- src/") || line.startsWith("- `src"),
        ) ?? "",
    ),
    check(
      "app: an incremental round sends the dropped files and promises a later round",
      resent.length > 0 &&
        incremental.includes("the diff was too large for this round"),
      `${resent.length} files sent again · ${incremental.includes("for this round") ? "promises" : "no promise"}`,
    ),
    check(
      "app: with no low model the summary uses the review model and the review posts",
      summaryModel === sim.options().highModel &&
        /\n- Coverage: 0 full · 0 partial · 1 summarized · 0 dropped\n/.test(
          noLow,
        ),
      `summary on ${summaryModel} · ${noLow.split("\n").find((line) => line.includes("Coverage")) ?? "no review"}`,
    ),
  ];
}

// ----------------------------------------------------------------- scores

function scores(sim: Sim): Score[] {
  const fakeAi = sim.mode === "fake";
  const one = coverageOf(run(sim, STEP.round1)?.json);
  const lines = (path: string) => (LARGE[path] ?? "").split("\n").length - 1;
  const total = Object.keys(LARGE).reduce((sum, path) => sum + lines(path), 0);
  const fullLines = filesSent(reviewPrompts(run(sim, STEP.round1))[0] ?? "")
    .filter(
      (path) => !one?.summarized.includes(path) && !one?.partial.includes(path),
    )
    .reduce((sum, path) => sum + lines(path), 0);
  const big = run(sim, STEP.big);
  const reads = reviewChats(big)
    .flatMap((chat) => chat.answerToolCalls)
    .filter((call) => call.startsWith("read-full-diff")).length;
  const summarized = coverageOf(big?.json)?.summarized.length ?? 0;
  const reviewCalls = sim.trace.completions.filter(
    (call) => call.job === "review_local" || call.job === "review_pull_request",
  );
  const reviews = new Set(
    reviewCalls.map((call) => `${call.step}\0${call.firstUser.length}`),
  ).size;
  const summaries = sim.trace.ai.filter(
    (call) => call.job === "summarize_large_diff",
  ).length;
  return [
    {
      name: "share of changed lines seen in full",
      value: total ? fullLines / total : null,
      detail: `round 1 of the large local change: ${fullLines} of ${total} lines`,
      fakeAi,
    },
    {
      name: "read-full-diff calls per summarized file",
      value: summarized ? reads / summarized : null,
      detail: `${reads} reads for ${summarized} summarized file`,
      fakeAi,
    },
    {
      name: "summary calls per review",
      value: reviews ? summaries / reviews : null,
      detail: `${summaries} summary calls over ${reviews} reviews`,
      fakeAi,
    },
  ];
}

export default defineFlow({
  name: "large-diff",
  description:
    "a change over the diff budget is planned, reported, read in pages and covered over rounds in local, CLI PR, remote and App review",
  ai: AI,
  steps,
  checks: (sim) => [
    ...localChecks(sim),
    ...mediumAndBigChecks(sim),
    ...smallChecks(sim),
    ...cliPrChecks(sim),
    ...remoteChecks(sim),
    ...appChecks(sim),
    costCheck(sim),
  ],
  scores,
  skipInherited: {
    "cost recorded for every AI call":
      "this flow runs remote and App reviews in one world: a remote review is in both the cost rows and the reviews table, an App review only in the reviews table, so neither total the inherited check compares can match. The flow's own cost check counts each call once",
  },
});
