/** `review --with=PATH[@BRANCH]` (issue 81): a review reads the changes of a
 * companion checkout as context. The reviewed change renames `clamp` to
 * `limit`, and the companion `sim/client` still calls `clamp`.
 *
 * The flow runs local review, CLI pull request review and remote review with
 * companions, reads what the model was sent from the trace, and checks the
 * output, the carry record and the remote wire. It reuses the base flows'
 * exports for the checkouts, the runs and the remote server. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AiCall as FakeCall,
  type AiReply,
  type AiRule,
  finding,
} from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  type CliRun,
  defineFlow,
  type Score,
  scriptedCheck,
  type Sim,
  type Step,
} from "../flow.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import type { Completion } from "../trace.ts";
import { INIT_AI } from "./init.ts";
import { reviewCli } from "./cli_pr.ts";
import {
  carryEntries,
  type Checkout,
  chatOf,
  checkoutState,
  git,
  LOCAL_REPO,
  localState,
  makeCheckout,
  NO_CODEGRAPH,
  prepareLocalRepo,
  promptDiff,
  type ReviewRun,
  runReview,
  unchangedFiles,
  writeFiles,
} from "./local.ts";
import {
  clientChange,
  remoteCalls,
  runRemoteReview,
  startRemoteServer,
  type RemoteRun,
} from "./remote.ts";
import type { Checkout as RemoteCheckout } from "./remote_support.ts";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- fixtures

const CLIENT_REPO = "sim/client";
const DOCS_REPO = "sim/docs";
/** A repository the simulated GitHub does not have: its visibility cannot be
 * read, so it counts as private. */
const PRIVATE_REPO = "sim/private-notes";
const REMOTE_REPO = "sim/remote-companions";
const BRANCH = "feature/limit";
const DOCS_BRANCH = "docs-main";

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

/** The reviewed change: `clamp` is renamed to `limit`, so it is gone. */
const APP_CHANGE: Record<string, string> = {
  "src/math.ts": SAMPLE_REPO["src/math.ts"]!.replace(
    "export function clamp(",
    "export function limit(",
  ),
  "src/index.ts": SAMPLE_REPO["src/index.ts"]!.replace(
    "{ add, clamp }",
    "{ add, limit }",
  ),
  "src/format.ts": SAMPLE_REPO["src/format.ts"]!.replaceAll("clamp", "limit"),
};
const LIMIT_MARKER = "export function limit(";

const CLIENT_FILES = {
  "README.md": lines(
    "# client",
    "",
    "Calls clamp and add from the sample helpers.",
  ),
};
/** The companion's branch: a new file that still calls `clamp`. */
const CLIENT_CHANGE = {
  // punctuation: code, a fixture line of source code that the test writes or reads
  "src/session.ts": lines(
    'import { clamp } from "sample";',
    "",
    "export function progress(done: number, total: number): number {",
    "  return clamp(done / total, 0, 1);",
    "}",
  ),
};
const DOCS_FILES = {
  "README.md": lines("# docs", "", "Guides for the sample helpers."),
};
/** A sentence only the private companion holds. */
const SECRET =
  "The billing partner settles every invoice on the third working day after the close";

/** The prompt sentence and the blocks, written here rather than imported, so
 * a change to them fails a check. */
const PROMPT_SENTENCE =
  "COMPANION blocks list changes in other repositories that belong to this change. They are context. Report findings only on this repository's files, and name the companion file in the body when it is the reason.";
const CLIENT_BLOCK = [
  `COMPANION ${CLIENT_REPO} · branch ${BRANCH} · 1 file changed`,
  `${CLIENT_REPO}:src/session.ts   added     +5 -0`,
].join("\n");
const DOCS_BLOCK = `COMPANION ${DOCS_REPO} · branch ${DOCS_BRANCH} · no changes on this branch`;
const HUMAN_LINE = `Companions: ${CLIENT_REPO}@${BRANCH} (1 file) · ${DOCS_REPO}@${DOCS_BRANCH} (no changes)`;

const ERRORS = {
  notRepo: "--with: ../plain is not a git repository",
  noBranch: `--with: no branch nope in ${CLIENT_REPO}`,
  same: "--with: . is the repository under review",
  many: "--with: at most 5 companions",
};

// ------------------------------------------------------------------ the fake AI

/** The line of the renamed function in a prompt's diff. */
function limitLine(prompt: string): number | undefined {
  for (const [line, text] of promptDiff(prompt).get("src/math.ts") ?? []) {
    if (text.includes(LIMIT_MARKER)) return line;
  }
  return undefined;
}

const REMOVED = (line: number) =>
  finding({
    path: "src/math.ts",
    line,
    title: "clamp is removed while a companion still calls it",
    body: `This renames clamp to limit, but the companion branch ${CLIENT_REPO}@${BRANCH} still calls clamp in src/session.ts.`,
    severity: "P1",
    blocking: true,
  });

/** The reviewer. With the client companion in the prompt it first reads the
 * companion file and searches the companion, then reports the removed
 * function on the reviewed file and judges each carried finding. */
function reviewer(call: FakeCall): AiReply {
  if (call.round === 0 && call.prompt.includes(`COMPANION ${CLIENT_REPO} `)) {
    return {
      toolCalls: [
        {
          name: "read-full-diff",
          arguments: { path: `${CLIENT_REPO}:src/session.ts` },
        },
        {
          name: "search-non-code",
          arguments: { pattern: "clamp", repo: CLIENT_REPO },
        },
      ],
    };
  }
  const entries = carryEntries(call.prompt);
  const line = limitLine(call.prompt) ?? entries[0]?.from ?? 5;
  return {
    json: {
      findings: entries.length ? [] : [REMOVED(line)],
      ...(entries.length
        ? {
            previousFindings: entries.map((entry) => ({
              id: entry.label,
              state: "open",
              path: entry.path,
              lineFrom: line,
              lineTo: line,
            })),
          }
        : {}),
    },
  };
}

const AI: AiRule[] = [
  {
    name: "reviewer that copies the private companion",
    job: "review_local",
    prompt: `COMPANION ${PRIVATE_REPO} `,
    reply: (call) => ({
      findings: [
        finding({
          path: "src/math.ts",
          line: limitLine(call.prompt) ?? 5,
          title: "The rename breaks a private caller",
          body: `The notes say: ${SECRET}. So the rename needs a note.`,
          severity: "P2",
        }),
      ],
    }),
  },
  {
    name: "reviewer",
    job: /^review_(local|pull_request)$/,
    reply: reviewer,
  },
  ...INIT_AI,
];

/** A rule put ahead of the others for one run: the finding sits on the
 * companion's file. */
const ON_COMPANION: AiRule = {
  name: "reviewer that places a finding on a companion file",
  job: "review_local",
  prompt: `COMPANION ${CLIENT_REPO} `,
  times: 1,
  reply: {
    findings: [
      finding({
        path: `${CLIENT_REPO}:src/session.ts`,
        line: 4,
        title: "The companion still calls clamp",
        body: "progress calls clamp, which this change renames.",
        severity: "P2",
      }),
    ],
  },
};

// ----------------------------------------------------------------------- state

type State = {
  checkouts: Map<string, Checkout>;
  client?: {
    before: ReturnType<typeof checkoutState>;
    after?: ReturnType<typeof checkoutState>;
  };
  summary: string;
  pr: { number: number; run?: CliRun };
  token: string;
  remoteApp?: RemoteCheckout;
  remote: Map<string, RemoteRun>;
  older: number;
};

function state(sim: Sim): State {
  return (sim.state.companions ??= {
    checkouts: new Map(),
    summary: "",
    pr: { number: 0 },
    token: "",
    remote: new Map(),
    older: 0,
  }) as State;
}

const dirOf = (sim: Sim, name: string) => state(sim).checkouts.get(name)!.dir;

const STEP = {
  guides: "repository with guides",
  repos: "companion repositories and checkouts",
  plain: "local: without --with",
  first: "local: a companion that still calls the removed function",
  same: "local: second round, nothing changed",
  edit: "the companion changes, the reviewed repository does not",
  recheck: "local: third round, only the companion changed",
  onCompanion: "local: a finding placed on a companion file",
  move: "the companion checkout moves to main and edits a file",
  atBranch: "local: --with=PATH@BRANCH reads the branch without a checkout",
  human: "local: human output",
  github: "local: --output=github",
  privacy: "local: a private companion",
  notRepo: "local: --with on a folder that is not a git repository",
  noBranch: "local: --with on a branch that does not exist",
  same2: "local: --with on the repository under review",
  many: "local: six --with flags",
  prOpen: "pull request opened",
  pr: "pull request: --with",
  remoteServer: "remote: server with guides",
  remote: "remote: a companion at a branch",
  remoteBig: "remote: companion patches over the server's limit",
  remoteOld: "remote: a server that predates companions",
} as const;

// ------------------------------------------------------------------------ steps

function localStep(
  label: string,
  args: (sim: Sim) => string[],
  before?: (sim: Sim) => void,
): Step {
  return {
    name: label,
    async run(sim) {
      before?.(sim);
      const run = await runReview(
        sim,
        state(sim).checkouts.get("app")!,
        label,
        args(sim),
      );
      localState(sim).runs.set(label, run);
      return `exit ${run.cli.exitCode} · ${run.ai.length} AI calls`;
    },
  };
}

const COMPANION_ARGS = ["--with=../client", "--with=../docs"];

function setupCompanions(sim: Sim): string {
  const s = state(sim);
  sim.repo(CLIENT_REPO, CLIENT_FILES);
  sim.repo(DOCS_REPO, DOCS_FILES);
  const add = (checkout: Checkout) => s.checkouts.set(checkout.name, checkout);
  add(
    makeCheckout(sim, { name: "app", branch: BRANCH, committed: APP_CHANGE }),
  );
  add(
    makeCheckout(sim, {
      name: "client",
      repo: CLIENT_REPO,
      branch: BRANCH,
      committed: CLIENT_CHANGE,
    }),
  );
  add(
    makeCheckout(sim, { name: "docs", repo: DOCS_REPO, branch: DOCS_BRANCH }),
  );
  add(
    makeCheckout(sim, {
      name: "notes",
      repo: DOCS_REPO,
      branch: "notes",
      committed: { "NOTES.md": `${SECRET}.\n` },
      remote: `git@github.com:${PRIVATE_REPO}.git`,
    }),
  );
  // Over 500,000 characters of patch, for the server's limit.
  const big = Array.from({ length: 6000 }, (_, i) =>
    `Line ${i} of a long guide, written to pass the server limit.`.padEnd(
      99,
      ".",
    ),
  ).join("\n");
  add(
    makeCheckout(sim, {
      name: "big",
      repo: DOCS_REPO,
      branch: "big",
      committed: { "docs/big.md": `${big}\n` },
    }),
  );
  mkdirSync(join(sim.world.root, "work", "plain"), { recursive: true });
  return [...s.checkouts.keys()].join(", ");
}

function summaryPath(sim: Sim): string {
  return sim.world.useStepSummary();
}

/** Makes the client see a server from before companions: a handshake with no
 * `companions` among its features. */
function serveOlderServer(sim: Sim): () => void {
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await inner(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== "/api/remote/handshake" || !response.ok) {
      return response;
    }
    const body = (await response.json()) as Json;
    const features = ((body.features as string[] | undefined) ?? []).filter(
      (feature) => feature !== "companions",
    );
    state(sim).older++;
    return Response.json({ ...body, features }, { status: response.status });
  };
  return () => {
    globalThis.fetch = inner;
  };
}

function remoteStep(
  label: string,
  args: (sim: Sim) => string[],
  older = false,
): Step {
  return {
    name: label,
    async run(sim) {
      const s = state(sim);
      const restore = older ? serveOlderServer(sim) : () => {};
      try {
        const run = await runRemoteReview(sim, s.remoteApp!, [
          `--remote-token=${s.token}`,
          ...args(sim),
        ]);
        s.remote.set(label, run);
        return `exit ${run.exitCode}`;
      } finally {
        restore();
      }
    },
  };
}

const steps: Step[] = [
  { name: STEP.guides, run: (sim) => prepareLocalRepo(sim) },
  { name: STEP.repos, run: (sim) => setupCompanions(sim) },
  localStep(STEP.plain, () => ["--json", NO_CODEGRAPH, "--fresh"]),
  localStep(STEP.first, () => [
    "--json",
    NO_CODEGRAPH,
    "--fresh",
    ...COMPANION_ARGS,
  ]),
  localStep(STEP.same, () => ["--json", NO_CODEGRAPH, ...COMPANION_ARGS]),
  {
    name: STEP.edit,
    run(sim) {
      writeFiles(dirOf(sim, "client"), {
        "src/session.ts": `${CLIENT_CHANGE["src/session.ts"]}export const done = 1\n`,
      });
      return "src/session.ts in the client's working tree";
    },
  },
  localStep(STEP.recheck, () => ["--json", NO_CODEGRAPH, ...COMPANION_ARGS]),
  localStep(
    STEP.onCompanion,
    () => ["--json", NO_CODEGRAPH, "--fresh", "--with=../client"],
    (sim) => sim.ai.use(ON_COMPANION),
  ),
  {
    name: STEP.move,
    run(sim) {
      const dir = dirOf(sim, "client");
      git(dir, ["checkout", "-q", "--", "."]);
      git(dir, ["switch", "-q", "main"]);
      writeFiles(dir, { "README.md": `${CLIENT_FILES["README.md"]}Edited.\n` });
      state(sim).client = {
        before: checkoutState(state(sim).checkouts.get("client")!),
      };
      return "main, README.md edited";
    },
  },
  localStep(STEP.atBranch, () => [
    "--json",
    NO_CODEGRAPH,
    "--fresh",
    `--with=../client@${BRANCH}`,
    "--with=../docs",
  ]),
  {
    name: "the companion checkout after the review",
    run(sim) {
      state(sim).client!.after = checkoutState(
        state(sim).checkouts.get("client")!,
      );
      return state(sim).client!.after!.branch;
    },
  },
  localStep(STEP.human, () => [
    NO_CODEGRAPH,
    "--fresh",
    `--with=../client@${BRANCH}`,
    "--with=../docs",
  ]),
  {
    name: STEP.github,
    async run(sim) {
      const path = summaryPath(sim);
      const run = await runReview(
        sim,
        state(sim).checkouts.get("app")!,
        STEP.github,
        [
          "--output=github",
          NO_CODEGRAPH,
          "--fresh",
          `--with=../client@${BRANCH}`,
          "--with=../docs",
        ],
      );
      localState(sim).runs.set(STEP.github, run);
      const { existsSync, readFileSync } = await import("node:fs");
      state(sim).summary = existsSync(path) ? readFileSync(path, "utf8") : "";
      return `exit ${run.cli.exitCode}`;
    },
  },
  localStep(STEP.privacy, () => [
    "--json",
    NO_CODEGRAPH,
    "--fresh",
    "--with=../notes",
  ]),
  localStep(STEP.notRepo, () => [NO_CODEGRAPH, "--with=../plain"]),
  localStep(STEP.noBranch, () => [NO_CODEGRAPH, "--with=../client@nope"]),
  localStep(STEP.same2, () => [NO_CODEGRAPH, "--with=."]),
  localStep(STEP.many, () => [
    NO_CODEGRAPH,
    ...Array.from({ length: 6 }, () => "--with=../client"),
  ]),
  {
    name: STEP.prOpen,
    run(sim) {
      const pull = sim.github.openPull(LOCAL_REPO, {
        title: "Rename clamp to limit",
        body: "limit says what it does.",
        files: APP_CHANGE,
      });
      state(sim).pr.number = pull.number;
      return `#${pull.number}`;
    },
  },
  {
    name: STEP.pr,
    async run(sim) {
      const s = state(sim);
      s.pr.run = await reviewCli(sim, s.pr.number, [
        "--json",
        "--fresh",
        `--with=${dirOf(sim, "client")}@${BRANCH}`,
      ]);
      return `exit ${s.pr.run.exitCode}`;
    },
  },
  {
    name: STEP.remoteServer,
    async run(sim) {
      const s = state(sim);
      s.token = await startRemoteServer(sim, {}, REMOTE_REPO);
      // One more line than the local change, so no remote request repeats
      // a local one's prompt.
      s.remoteApp = clientChange(
        sim,
        "remote-app",
        BRANCH,
        { ...APP_CHANGE, "README.md": `${SAMPLE_REPO["README.md"]}Remote.\n` },
        REMOTE_REPO,
      );
      return REMOTE_REPO;
    },
  },
  remoteStep(STEP.remote, (sim) => [
    "--json",
    "--fresh",
    `--with=${dirOf(sim, "client")}@${BRANCH}`,
  ]),
  remoteStep(STEP.remoteBig, (sim) => [
    "--json",
    "--fresh",
    `--with=${dirOf(sim, "big")}@big`,
  ]),
  remoteStep(
    STEP.remoteOld,
    (sim) => ["--json", "--fresh", `--with=${dirOf(sim, "client")}@${BRANCH}`],
    true,
  ),
];

// ----------------------------------------------------------------------- readers

const localRun = (sim: Sim, label: string): ReviewRun | undefined =>
  localState(sim).runs.get(label);

/** The review requests of a local run: the conversation's first request
 * and every later round. */
const reviewCalls = (run: ReviewRun | undefined, job = "review_local") =>
  (run?.completions ?? []).filter((call) => call.job === job);

const firstUser = (run: ReviewRun | undefined) =>
  reviewCalls(run)[0]?.firstUser ?? "";

/** The part of a prompt between WORKSPACE or PULL REQUEST and DIFF. */
function companionPart(prompt: string): string {
  const start = prompt.indexOf(`\n\n${PROMPT_SENTENCE}`);
  const end = prompt.indexOf("\n\nDIFF:\n");
  if (start < 0 || end < start) return "";
  return prompt
    .slice(start + 2, end)
    .replace(/\n\nPREVIOUS FINDINGS[\s\S]*$/, "");
}

const findingsOf = (json: Json | undefined): Json[] =>
  (json?.findings as Json[] | undefined) ?? [];

const warningsOf = (json: Json | undefined) =>
  (json?.warnings as { code: string; message: string }[] | undefined) ?? [];

const ran = (code: number | undefined) => code === 0 || code === 1;

/** Tool results the model received in a run's review conversation. */
function toolResults(run: ReviewRun | undefined): string[] {
  return (run?.ai ?? [])
    .filter((call) => call.job === "review_local")
    .flatMap((call) => chatOf(call).toolResults);
}

/** Tool names a run's first review request offered, with their schemas. */
function offered(run: ReviewRun | undefined): Json[] {
  const call = run?.ai.find((item) => item.job === "review_local");
  return ((call?.request as { tools?: Json[] } | undefined)?.tools ??
    []) as Json[];
}

const toolNamed = (tools: Json[], name: string) =>
  tools.find((tool) => (tool.function as Json | undefined)?.name === name);

const expectedCompanions = (docs: boolean) => [
  {
    repo: CLIENT_REPO,
    branch: BRANCH,
    source: "flag",
    pr: null,
    files: 1,
    status: "read",
  },
  ...(docs
    ? [
        {
          repo: DOCS_REPO,
          branch: DOCS_BRANCH,
          source: "flag",
          pr: null,
          files: 0,
          status: "empty",
        },
      ]
    : []),
];

type CarryRecord = {
  companions?: { repo: string; branch: string; hash: string }[];
};

const companionHashOf = (run: ReviewRun | undefined) =>
  (run?.carry as CarryRecord | null)?.companions?.find(
    (item) => item.repo === CLIENT_REPO,
  )?.hash;

// ----------------------------------------------------------------------- checks

function promptChecks(sim: Sim): CheckResult[] {
  const plain = localRun(sim, STEP.plain);
  const first = localRun(sim, STEP.first);
  const prompt = firstUser(first);
  const part = companionPart(prompt);
  const plainCalls = reviewCalls(plain);
  const firstCalls = reviewCalls(first);
  const systems = new Set(
    [...plainCalls, ...firstCalls].map((call) => call.system),
  );
  const tools = offered(first);
  const search = JSON.stringify(toolNamed(tools, "search-non-code") ?? {});
  const read = JSON.stringify(toolNamed(tools, "read-full-diff") ?? {});
  return [
    check(
      "local: the COMPANION block lists the companion's file with its status and line counts, after the prompt sentence",
      part === `${PROMPT_SENTENCE}\n\n${CLIENT_BLOCK}\n\n${DOCS_BLOCK}`,
      part.slice(0, 600) || prompt.slice(0, 300),
    ),
    check(
      "local: an empty companion branch says no changes on this branch",
      prompt.includes(`\n${DOCS_BLOCK}\n`),
      part.split("\n").at(-1) ?? "",
    ),
    check(
      "local: the system prompt is the same bytes with and without --with",
      plainCalls.length > 0 && firstCalls.length > 0 && systems.size === 1,
      `${systems.size} system prompts over ${plainCalls.length + firstCalls.length} requests`,
    ),
    check(
      "local: only the COMPANION blocks differ in the user prompt",
      prompt !== "" && prompt.replace(`\n\n${part}`, "") === firstUser(plain),
      `${prompt.length} against ${firstUser(plain).length} characters`,
    ),
    check(
      "local: a review without --with mentions no companion",
      firstUser(plain) !== "" && !firstUser(plain).includes("COMPANION"),
      "",
    ),
    check(
      "local: read-full-diff takes companion paths and search-non-code takes a repo",
      read.includes("owner/repo:path from a COMPANION block") &&
        search.includes('"repo"') &&
        search.includes(CLIENT_REPO),
      `${read.slice(0, 120)} · ${search.slice(0, 120)}`,
    ),
    check(
      "local: the companion patch is not in the prompt, only its file list",
      prompt !== "" && !prompt.includes("return clamp(done / total"),
      "",
    ),
  ];
}

function findingChecks(sim: Sim): CheckResult[] {
  const first = localRun(sim, STEP.first);
  const json = first?.json;
  const located = findingsOf(json).filter((item) => item.path !== null);
  const results = toolResults(first);
  const moved = localRun(sim, STEP.onCompanion);
  const movedFindings = findingsOf(moved?.json);
  const companionRow = movedFindings.find((item) =>
    String(item.title).includes(CLIENT_REPO),
  );
  return [
    scriptedCheck(
      sim,
      "local: the finding about the removed function is anchored on the reviewed repository's file",
      located.length === 1 &&
        located[0]!.path === "src/math.ts" &&
        located[0]!.lineFrom === limitLine(firstUser(first)),
      JSON.stringify(located.map((item) => [item.path, item.lineFrom])),
      "the finding is the model's",
    ),
    scriptedCheck(
      sim,
      "local: read-full-diff reads the companion file and search-non-code searches the companion checkout",
      results.some((text) =>
        text.includes("return clamp(done / total, 0, 1)"),
      ) &&
        results.some((text) =>
          text.startsWith("README.md:3: Calls clamp and add"),
        ),
      results.map((text) => text.slice(0, 60)).join(" | "),
      "the tool calls are the model's",
    ),
    check(
      "local: --json lists each companion, its source, file count and status",
      JSON.stringify(json?.companions) ===
        JSON.stringify(expectedCompanions(true)),
      JSON.stringify(json?.companions),
    ),
    check(
      "local: a finding on a companion file never keeps a location",
      ran(moved?.cli.exitCode) &&
        movedFindings.every(
          (item) =>
            !String(item.path ?? "").startsWith(`${CLIENT_REPO}:`) &&
            !String(item.path ?? "").includes("session.ts"),
        ),
      movedFindings.map((item) => String(item.path)).join(", "),
    ),
    scriptedCheck(
      sim,
      "local: a finding placed on a companion file is in the summary without a location, labeled with the companion",
      companionRow !== undefined &&
        companionRow.path === null &&
        companionRow.lineFrom === null &&
        companionRow.lineTo === null &&
        String(companionRow.title).includes("session.ts") &&
        Number((moved?.json?.summary as Json | undefined)?.new) ===
          movedFindings.filter((item) => item.state === "new").length,
      JSON.stringify(companionRow),
      "the finding's place is the model's",
    ),
  ];
}

function carryChecks(sim: Sim): CheckResult[] {
  const first = localRun(sim, STEP.first);
  const same = localRun(sim, STEP.same);
  const recheck = localRun(sim, STEP.recheck);
  const samePrompt = firstUser(same);
  const recheckPrompt = firstUser(recheck);
  const sameEntries = carryEntries(samePrompt);
  const recheckEntries = carryEntries(recheckPrompt);
  const unchanged = (prompt: string) =>
    unchangedFiles({ user: prompt } as Parameters<typeof unchangedFiles>[0]);
  const records = (first?.carry as CarryRecord | null)?.companions ?? [];
  return [
    check(
      "local: the carry record keeps each companion's repository, branch and hash",
      records.length === 2 &&
        records.some(
          (item) =>
            item.repo === CLIENT_REPO &&
            item.branch === BRANCH &&
            /^[0-9a-f]{64}$/.test(item.hash),
        ) &&
        records.some((item) => item.repo === DOCS_REPO),
      JSON.stringify(records),
    ),
    scriptedCheck(
      sim,
      "local: a round where nothing changed carries the finding as unchanged and sends no file again",
      sameEntries.length === 1 &&
        sameEntries[0]!.hint ===
          "file unchanged since the last review, the fix may be in another file" &&
        unchanged(samePrompt).includes("src/math.ts") &&
        !promptDiff(samePrompt).has("src/math.ts"),
      JSON.stringify(sameEntries),
      "the carried finding is the model's",
    ),
    scriptedCheck(
      sim,
      "local: a round where only the companion changed rechecks the carried finding with the file sent again",
      recheckEntries.length === 1 &&
        recheckEntries[0]!.hint ===
          "file unchanged since the last review, but a companion repository changed" &&
        unchanged(recheckPrompt).length === 0 &&
        promptDiff(recheckPrompt).has("src/math.ts"),
      JSON.stringify(recheckEntries),
      "the carried finding is the model's",
    ),
    check(
      "local: the companion's hash in the carry record moves with the companion only",
      companionHashOf(first) !== undefined &&
        companionHashOf(first) === companionHashOf(same) &&
        companionHashOf(recheck) !== companionHashOf(same) &&
        same?.before.head === recheck?.before.head &&
        same?.before.status === recheck?.before.status,
      `${companionHashOf(same)?.slice(0, 8)} then ${companionHashOf(recheck)?.slice(0, 8)}`,
    ),
    check(
      "local: a round where only the companion changed lists the companion's new line counts",
      firstUser(recheck).includes(
        `${CLIENT_REPO}:src/session.ts   added     +6 -0`,
      ),
      companionPart(firstUser(recheck)).slice(0, 400),
    ),
  ];
}

function branchChecks(sim: Sim): CheckResult[] {
  const run = localRun(sim, STEP.atBranch);
  const s = state(sim);
  const human = localRun(sim, STEP.human);
  const githubRun = localRun(sim, STEP.github);
  const humanLines = (human?.cli.stdout ?? "").split("\n");
  const title = humanLines.findIndex((line) =>
    line.startsWith("co-maintainer review"),
  );
  return [
    check(
      "local: @BRANCH reads that branch, never the checked-out branch or its working tree",
      companionPart(firstUser(run)) ===
        `${PROMPT_SENTENCE}\n\n${CLIENT_BLOCK}\n\n${DOCS_BLOCK}`,
      companionPart(firstUser(run)).slice(0, 400),
    ),
    check(
      "local: @BRANCH leaves the companion's branch, commit and working tree as they were",
      s.client?.after !== undefined &&
        JSON.stringify(s.client.after) === JSON.stringify(s.client.before) &&
        s.client.after.branch === "main" &&
        s.client.after.status.includes("README.md"),
      JSON.stringify(s.client),
    ),
    check(
      "local: the human output prints the companions line under the header",
      title >= 0 && humanLines[title + 2] === HUMAN_LINE,
      humanLines.slice(Math.max(0, title), title + 4).join(" | "),
    ),
    check(
      "local: --output=github prints the companions line in the job summary",
      ran(githubRun?.cli.exitCode) && s.summary.includes(`\n${HUMAN_LINE}\n`),
      s.summary.slice(0, 300),
    ),
  ];
}

function privacyChecks(sim: Sim): CheckResult[] {
  const run = localRun(sim, STEP.privacy);
  const reads = sim.trace.github
    .filter((call) => call.step === STEP.privacy && call.method === "GET")
    .map((call) => `${new URL(call.url).pathname.slice(1)} ${call.status}`);
  const output = `${run?.cli.stdout ?? ""}${run?.cli.stderr ?? ""}`;
  const flat = (text: string) => text.replace(/\s+/g, " ");
  return [
    check(
      "local: the visibility of the reviewed repository and of the companion is read from GitHub",
      reads.includes(`repos/${LOCAL_REPO} 200`) &&
        reads.includes(`repos/${PRIVATE_REPO} 404`),
      reads.join(", "),
    ),
    check(
      "local: a private companion's passage never reaches the output",
      ran(run?.cli.exitCode) && !flat(output).includes(SECRET),
      `${output.length} characters`,
    ),
    check(
      "local: the private companion's patch is not in the prompt",
      firstUser(run) !== "" && !firstUser(run).includes(SECRET),
      "",
    ),
    scriptedCheck(
      sim,
      "local: a passage copied from a private companion is removed, and the warning says so",
      warningsOf(run?.json).some(
        (w) =>
          w.code === "private_text_removed" &&
          w.message.includes("from a private companion"),
      ) && JSON.stringify(run?.json).includes("[private context removed]"),
      JSON.stringify(warningsOf(run?.json)),
      "the copied passage is the model's",
    ),
  ];
}

function errorChecks(sim: Sim): CheckResult[] {
  const cases: [string, string][] = [
    [STEP.notRepo, ERRORS.notRepo],
    [STEP.noBranch, ERRORS.noBranch],
    [STEP.same2, ERRORS.same],
    [STEP.many, ERRORS.many],
  ];
  return cases.map(([label, message]) => {
    const run = localRun(sim, label);
    const output = `${run?.cli.stdout ?? ""}${run?.cli.stderr ?? ""}`;
    return check(
      `local: ${message}, exit 2 before any model call`,
      run?.cli.exitCode === 2 &&
        output.includes(message) &&
        run.ai.length === 0,
      `exit ${run?.cli.exitCode} · ${output.trim().split("\n").at(-1)}`,
    );
  });
}

function prChecks(sim: Sim): CheckResult[] {
  const run = state(sim).pr.run;
  const calls = (run?.completions() ?? []).filter(
    (call: Completion) => call.job === "review_pull_request",
  );
  const prompt = calls[0]?.firstUser ?? "";
  let json: Json | undefined;
  try {
    json = JSON.parse(run?.stdout ?? "") as Json;
  } catch {
    json = undefined;
  }
  return [
    check(
      "pull request: the COMPANION block follows the PULL REQUEST block",
      prompt.includes(
        `"existingReviews":[]}\n\n${PROMPT_SENTENCE}\n\n${CLIENT_BLOCK}\n\n`,
      ),
      companionPart(prompt).slice(0, 300) || prompt.slice(0, 200),
    ),
    check(
      "pull request: --json lists the companion",
      ran(run?.exitCode) &&
        JSON.stringify(json?.companions) ===
          JSON.stringify(expectedCompanions(false)),
      JSON.stringify(json?.companions),
    ),
  ];
}

function remoteChecks(sim: Sim): CheckResult[] {
  const s = state(sim);
  const run = s.remote.get(STEP.remote);
  const big = s.remote.get(STEP.remoteBig);
  const old = s.remote.get(STEP.remoteOld);
  const handshake = remoteCalls(sim, STEP.remote, "/api/remote/handshake")[0];
  const features = ((handshake?.response as Json | undefined)?.features ??
    []) as string[];
  const submitOf = (step: string) =>
    remoteCalls(sim, step, "/api/remote/reviews", "POST")[0]?.request as
      | Json
      | undefined;
  const sent = (submitOf(STEP.remote)?.companions ?? []) as Json[];
  const serverPrompt = (step: string) =>
    sim.trace.completions.find(
      (call) => call.step === step && call.job === "review_local",
    )?.firstUser ?? "";
  const searchResults = sim.trace.ai
    .filter((call) => call.step === STEP.remote && call.job === "review_local")
    .flatMap((call) => chatOf(call).toolResults);
  const serverCall = sim.trace.ai.find(
    (call) => call.step === STEP.remote && call.job === "review_local",
  );
  const serverSearch = JSON.stringify(
    toolNamed(
      ((serverCall?.request as { tools?: Json[] } | undefined)?.tools ??
        []) as Json[],
      "search-non-code",
    ) ?? {},
  );
  const bigSent = (submitOf(STEP.remoteBig)?.companions ?? []) as Json[];
  const bigPatch = ((bigSent[0]?.files as Json[] | undefined) ?? [])
    .map((file) => String(file.patch ?? ""))
    .join("").length;
  return [
    check(
      "remote: the handshake lists the companions feature",
      features.includes("companions"),
      features.join(", "),
    ),
    check(
      "remote: the client sends each companion with its repository, branch and files",
      sent.length === 1 &&
        sent[0]!.repo === CLIENT_REPO &&
        sent[0]!.branch === BRANCH &&
        JSON.stringify(
          ((sent[0]!.files as Json[]) ?? []).map((file) => file.path),
        ) === '["src/session.ts"]',
      JSON.stringify(sent.map((item) => [item.repo, item.branch])),
    ),
    check(
      "remote: the server's prompt carries the COMPANION block",
      companionPart(serverPrompt(STEP.remote)) ===
        `${PROMPT_SENTENCE}\n\n${CLIENT_BLOCK}`,
      companionPart(serverPrompt(STEP.remote)).slice(0, 300),
    ),
    check(
      "remote: the server offers search-non-code with a repo naming the companion",
      serverSearch.includes('"repo"') && serverSearch.includes(CLIENT_REPO),
      serverSearch.slice(0, 160),
    ),
    scriptedCheck(
      sim,
      "remote: a companion search runs on the client, in the companion checkout, through the tool bridge",
      searchResults.some((text) =>
        text.startsWith("README.md:3: Calls clamp and add"),
      ),
      searchResults.map((text) => text.slice(0, 60)).join(" | "),
      "the tool calls are the model's",
    ),
    check(
      "remote: --json lists the companion",
      ran(run?.exitCode) &&
        JSON.stringify(run?.json?.companions) ===
          JSON.stringify(expectedCompanions(false)),
      JSON.stringify(run?.json?.companions),
    ),
    check(
      "remote: companion patches over 500,000 characters keep the file list, drop the patches and warn companion_list_cut",
      ran(big?.exitCode) &&
        bigPatch > 500_000 &&
        warningsOf(big?.json).some((w) => w.code === "companion_list_cut") &&
        serverPrompt(STEP.remoteBig).includes(
          `${DOCS_REPO}:docs/big.md   added     +6000 -0`,
        ),
      `${bigPatch} characters sent · ${warningsOf(big?.json)
        .map((w) => w.code)
        .join(", ")}`,
    ),
    check(
      "remote: a server without the feature is sent no companion, warns companions_unsupported and still reviews",
      s.older > 0 &&
        ran(old?.exitCode) &&
        submitOf(STEP.remoteOld) !== undefined &&
        !("companions" in (submitOf(STEP.remoteOld) ?? {})) &&
        !serverPrompt(STEP.remoteOld).includes("COMPANION") &&
        warningsOf(old?.json).some(
          (w) => w.code === "companions_unsupported",
        ) &&
        old?.json?.companions === undefined,
      `exit ${old?.exitCode} · ${warningsOf(old?.json)
        .map((w) => w.code)
        .join(", ")}`,
    ),
  ];
}

function scores(sim: Sim): Score[] {
  const first = localRun(sim, STEP.first);
  const prompt = firstUser(first);
  const part = companionPart(prompt);
  return [
    {
      name: "share of the review prompt that is the COMPANION blocks",
      value: prompt ? part.length / prompt.length : null,
      detail: `${part.length} of ${prompt.length} characters in the first local request`,
      fakeAi: sim.mode === "fake",
    },
    {
      name: "companion reads per review",
      value: toolResults(first).length,
      detail:
        "read-full-diff and search-non-code results in the first local review",
      fakeAi: sim.mode === "fake",
    },
  ];
}

export default defineFlow({
  name: "companions",
  description:
    "review --with reads companion checkouts as context in local, CLI pull request and remote review: the COMPANION blocks, companion tools, findings on companion files, carry-over, errors, privacy and the remote feature",
  ai: AI,
  steps,
  checks: (sim) => [
    ...promptChecks(sim),
    ...findingChecks(sim),
    ...carryChecks(sim),
    ...branchChecks(sim),
    ...privacyChecks(sim),
    ...errorChecks(sim),
    ...prChecks(sim),
    ...remoteChecks(sim),
  ],
  scores,
});
