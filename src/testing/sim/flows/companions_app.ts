/** Companion pull requests (issue 81) in App review and CLI pull request
 * review. The repository's `companions` setting lists the repositories a
 * review may read. A `Companion: owner/repo#N` body line names a companion
 * pull request, and a listed repository with no line is matched by an open
 * pull request with the same head branch name.
 *
 * The reviewed change renames `clamp` to `limit`. The flow serves the
 * sample repository, opens companion pull requests in `sim/client` (merged
 * before the review) and `sim/docs` (open, same branch name), and names a
 * repository that is not listed and one the App cannot read. It reads what
 * the model was sent, what GitHub was asked and what was posted. A second
 * round where only the docs pull request changed checks the carry-over, and
 * two CLI pull request reviews check the body line and `--with`. It reuses
 * the App flow's exports for serve and the base flows' for the checkout. */
import { finding, type AiCall as FakeCall, type AiRule } from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  type CliRun,
  defineFlow,
  scriptedCheck,
  type Sim,
  type Step,
} from "../flow.ts";
import type { SimPull } from "../github.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";
import { reviewCli } from "./cli_pr.ts";
import {
  APP_REPO,
  appRows,
  deliverOpened,
  roundLine,
  serveRepo,
  writesIn,
} from "./app.ts";
import { carryEntries, chatOf, type Checkout, makeCheckout } from "./local.ts";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- fixtures

const CLIENT = "sim/client";
const DOCS = "sim/docs";
const NOTES = "sim/notes";
/** Listed, but GitHub has no such repository, so no installation can read
 * it. */
const MISSING = "sim/missing";
/** On GitHub and in the App's installation, but not listed. */
const OTHER = "sim/other";
const BRANCH = "feature/limit";
const CLIENT_BRANCH = "feature/limit-client";

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

/** The reviewed change: `clamp` is renamed to `limit` on line 5. */
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
const LIMIT_LINE = 5;

const CLIENT_FILES = {
  "README.md": lines("# client", "", "Calls clamp from the sample helpers."),
};
/** The client pull request's first commit. */
const CLIENT_FIRST = {
  // punctuation: code, a fixture line of source code that the test writes or reads
  "src/session.ts": lines(
    'import { clamp } from "sample";',
    "",
    "export const progress = (done: number) => clamp(done, 0, 1);",
  ),
};
/** Its second commit, before the merge: the final diff holds both. */
const CLIENT_SECOND = {
  "docs/limit.md": lines("# limit", "", "The client still calls clamp."),
};
const DOCS_FILES = {
  "README.md": lines("# docs", "", "Guides for the sample helpers."),
};
const DOCS_CHANGE = {
  "guide/clamp.md": lines("# clamp", "", "clamp keeps a value in range."),
};
/** The docs pull request after a second push. */
const DOCS_PUSH = {
  "guide/clamp.md": lines(
    "# limit",
    "",
    "limit keeps a value in range.",
    "It was called clamp.",
  ),
};

/** Written here rather than imported, so a change to the product's text
 * fails a check. */
const PROMPT_SENTENCE =
  "COMPANION blocks list changes in other repositories that belong to this change. They are context. Report findings only on this repository's files, and name the companion file in the body when it is the reason.";
const CLIENT_BLOCK = [
  `COMPANION ${CLIENT} · branch ${CLIENT_BRANCH} · 2 files changed`,
  `${CLIENT}:docs/limit.md    added     +3 -0`,
  `${CLIENT}:src/session.ts   added     +3 -0`,
].join("\n");
const DOCS_BLOCK = (added: number) =>
  [
    `COMPANION ${DOCS} · branch ${BRANCH} · 1 file changed`,
    `${DOCS}:guide/clamp.md   added     +${added} -0`,
  ].join("\n");
const NOTES_BLOCK = `COMPANION ${NOTES} · branch ${BRANCH} · no changes on this branch`;
const RECHECK_HINT =
  "file unchanged since the last review, but a companion repository changed";

// ------------------------------------------------------------------ the fake AI

const REMOVED = finding({
  path: "src/math.ts",
  line: LIMIT_LINE,
  title: "clamp is removed while a companion still calls it",
  body: `This renames clamp to limit, but the companion ${CLIENT} still calls clamp in src/session.ts.`,
  severity: "P1",
  blocking: true,
});

/** With companions in the prompt the reviewer first searches the client
 * companion, then reports the removed function on the reviewed file and
 * keeps each carried finding open. */
function reviewer(call: FakeCall): unknown {
  if (call.round === 0 && call.prompt.includes(`COMPANION ${CLIENT} `)) {
    return {
      toolCalls: [
        {
          name: "search-non-code",
          arguments: { pattern: "clamp", repo: CLIENT },
        },
      ],
    };
  }
  const entries = carryEntries(call.prompt);
  return {
    json: entries.length
      ? {
          findings: [],
          previousFindings: entries.map((entry) => ({
            id: entry.label,
            state: "open",
            path: entry.path,
            lineFrom: LIMIT_LINE,
            lineTo: LIMIT_LINE,
          })),
        }
      : { findings: [REMOVED] },
  };
}

/** Put ahead of the others for one round: the model places a finding on the
 * client companion's file and keeps the carried one open. */
const ON_COMPANION: AiRule = {
  name: "reviewer that places a finding on a companion file",
  job: "review_pull_request",
  times: 1,
  reply: (call) => ({
    json: {
      findings: [
        finding({
          path: `${CLIENT}:src/session.ts`,
          line: 3,
          title: "The client still calls clamp",
          body: "progress calls clamp, which this change renames.",
        }),
      ],
      previousFindings: carryEntries(call.prompt).map((entry) => ({
        id: entry.label,
        state: "open",
        path: entry.path,
        lineFrom: LIMIT_LINE,
        lineTo: LIMIT_LINE,
      })),
    },
  }),
};

const AI: AiRule[] = [
  ...INIT_AI,
  {
    name: "reviewer with companions",
    job: "review_pull_request",
    reply: (call) => reviewer(call) as never,
  },
];

// ----------------------------------------------------------------------- state

type State = {
  client?: SimPull;
  docs?: SimPull;
  app?: SimPull;
  set?: CliRun;
  checkout?: Checkout;
  /** `companions_json` after each App round. */
  stored: Map<string, string | null>;
  heads: Map<string, string>;
  cli: Map<string, CliRun>;
};

function state(sim: Sim): State {
  return (sim.state.companionsApp ??= {
    stored: new Map(),
    heads: new Map(),
    cli: new Map(),
  }) as State;
}

const STEP = {
  served: "served repository with the companions setting",
  companions: "companion pull requests",
  first: "App: review with companion pull requests",
  push: "the docs pull request gets a second push",
  second: "App: second round, only the docs pull request changed",
  onCompanion: "App: a finding placed on a companion file",
  after: "App: the round after it",
  cliBody: "CLI pull request review: a body line",
  cliWith: "CLI pull request review: --with for the same repository",
} as const;

function storedCompanions(sim: Sim, prNumber: number): string | null {
  const [row] = appRows<{ companions_json: string | null }>(
    sim,
    `SELECT r.companions_json FROM subject_revisions r JOIN subjects s ON s.id = r.subject_id
     WHERE s.kind = 'pr' AND s.repo = ? AND s.pr_number = ?`,
    APP_REPO,
    prNumber,
  );
  return row?.companions_json ?? null;
}

/** A review of the App pull request that a maintainer asked for. */
async function manualRound(sim: Sim): Promise<string> {
  const { enqueueManualReview } = await import("../../../services/review.ts");
  enqueueManualReview(APP_REPO, state(sim).app!.number);
  const jobs = await sim.server.runJobs();
  return jobs.map((job) => `${job.type} ${job.status}`).join(", ");
}

const steps: Step[] = [
  {
    name: STEP.served,
    async run(sim) {
      await serveRepo(sim);
      sim.repo(CLIENT, CLIENT_FILES);
      sim.repo(DOCS, DOCS_FILES);
      sim.repo(NOTES, DOCS_FILES);
      sim.repo(OTHER, DOCS_FILES);
      const s = state(sim);
      s.set = await sim.cli([
        "set",
        `--repo=${APP_REPO}`,
        `--companions=${CLIENT},${DOCS},${NOTES},${MISSING}`,
      ]);
      // A checkout of the client for `--with`, made while its pull request
      // is still open.
      s.checkout = makeCheckout(sim, {
        name: "client",
        repo: CLIENT,
        branch: CLIENT_BRANCH,
        committed: { ...CLIENT_FIRST, ...CLIENT_SECOND },
      });
      return `exit ${s.set.exitCode}`;
    },
  },
  {
    name: STEP.companions,
    run(sim) {
      const s = state(sim);
      s.client = sim.github.openPull(CLIENT, {
        title: "Show progress",
        branch: CLIENT_BRANCH,
        files: CLIENT_FIRST,
      });
      sim.github.push(s.client, CLIENT_SECOND, "docs");
      sim.github.merge(s.client);
      s.docs = sim.github.openPull(DOCS, {
        title: "Document clamp",
        branch: BRANCH,
        files: DOCS_CHANGE,
      });
      sim.github.openPull(OTHER, { title: "Other", files: DOCS_CHANGE });
      return `${CLIENT}#${s.client.number} merged · ${DOCS}#${s.docs.number} open`;
    },
  },
  {
    name: STEP.first,
    async run(sim) {
      const s = state(sim);
      const pull = sim.github.openPull(APP_REPO, {
        title: "Rename clamp to limit",
        branch: BRANCH,
        body: [
          "limit says what it does.",
          "",
          `Companion: ${CLIENT}#${s.client!.number}`,
          `Companion: ${OTHER}#1`,
          `companion: ${MISSING}#3`,
        ].join("\n"),
        files: APP_CHANGE,
      });
      s.app = pull;
      const round = await deliverOpened(sim, pull);
      s.stored.set(STEP.first, storedCompanions(sim, pull.number));
      s.heads.set(STEP.first, pull.headSha);
      return roundLine(round);
    },
  },
  {
    name: STEP.push,
    run(sim) {
      sim.github.push(state(sim).docs!, DOCS_PUSH, "rename in the docs");
      return `${DOCS}#${state(sim).docs!.number}`;
    },
  },
  {
    name: STEP.second,
    async run(sim) {
      const s = state(sim);
      const line = await manualRound(sim);
      s.stored.set(STEP.second, storedCompanions(sim, s.app!.number));
      s.heads.set(STEP.second, s.app!.headSha);
      return line;
    },
  },
  {
    name: STEP.onCompanion,
    async run(sim) {
      sim.ai.use(ON_COMPANION);
      return await manualRound(sim);
    },
  },
  { name: STEP.after, run: (sim) => manualRound(sim) },
  {
    name: STEP.cliBody,
    async run(sim) {
      const s = state(sim);
      const run = await reviewCli(
        sim,
        s.app!.number,
        ["--json", "--fresh"],
        APP_REPO,
      );
      s.cli.set(STEP.cliBody, run);
      return `exit ${run.exitCode}`;
    },
  },
  {
    name: STEP.cliWith,
    async run(sim) {
      const s = state(sim);
      const run = await reviewCli(
        sim,
        s.app!.number,
        ["--json", "--fresh", `--with=${s.checkout!.dir}@${CLIENT_BRANCH}`],
        APP_REPO,
      );
      s.cli.set(STEP.cliWith, run);
      return `exit ${run.exitCode}`;
    },
  },
];

// ----------------------------------------------------------------------- readers

/** The first request of each review conversation a step made. */
function firstPrompts(sim: Sim, step: string): string[] {
  return sim.trace.completions
    .filter((call) => call.step === step && call.job === "review_pull_request")
    .map((call) => call.firstUser);
}

/** The part of a prompt between the PULL REQUEST block and DIFF. */
function companionPart(prompt: string): string {
  const start = prompt.indexOf(`\n\n${PROMPT_SENTENCE}`);
  const end = prompt.indexOf("\n\nDIFF:\n");
  if (start < 0 || end < start) return "";
  return prompt
    .slice(start + 2, end)
    .replace(/\n\nPREVIOUS FINDINGS[\s\S]*$/, "");
}

/** `GET path status` of every GitHub call a step made. */
function githubReads(sim: Sim, step: string): string[] {
  return sim.trace.github
    .filter((call) => call.step === step && call.method === "GET")
    .map((call) => {
      const url = new URL(call.url);
      return `${decodeURIComponent(url.pathname.slice(1))}${url.search} ${call.status}`;
    });
}

function postedReview(sim: Sim, step: string): string {
  const write = writesIn(sim, step).find(
    (item) =>
      item.method === "POST" &&
      item.path === `repos/${APP_REPO}/pulls/${state(sim).app?.number}/reviews`,
  );
  return String((write?.body as Json | undefined)?.body ?? "");
}

function jobLogs(sim: Sim, step: string): string[] {
  const ids = sim.trace.jobs
    .filter((job) => job.step === step && job.type === "review")
    .map((job) => job.id);
  return ids.flatMap((id) =>
    appRows<{ level: string; message: string }>(
      sim,
      "SELECT level, message FROM job_logs WHERE job_id = ? ORDER BY seq",
      id,
    ).map((row) => `${row.level} ${row.message}`),
  );
}

function cliJson(run: CliRun | undefined): Json | undefined {
  try {
    return JSON.parse(run?.stdout ?? "") as Json;
  } catch {
    return undefined;
  }
}

type StoredRecord = { repo: string; branch: string; hash: string };
const hashOf = (stored: string | null | undefined, repo: string) =>
  ((stored ? JSON.parse(stored) : []) as StoredRecord[]).find(
    (item) => item.repo === repo,
  )?.hash;

const ran = (code: number | undefined) => code === 0 || code === 1;

// ----------------------------------------------------------------------- checks

function appChecks(sim: Sim): CheckResult[] {
  const s = state(sim);
  const prompt = firstPrompts(sim, STEP.first)[0] ?? "";
  const part = companionPart(prompt);
  const body = postedReview(sim, STEP.first);
  const reads = githubReads(sim, STEP.first);
  const client = s.client?.number;
  const docs = s.docs?.number;
  const metadata = `- Companions: ${CLIENT}#${client}, ${MISSING}#3 (unreachable), ${DOCS}#${docs}, ${NOTES} (no matching pull request)\n</details>`;
  const logs = jobLogs(sim, STEP.first);
  const results = sim.trace.ai
    .filter(
      (call) => call.step === STEP.first && call.job === "review_pull_request",
    )
    .flatMap((call) => chatOf(call).toolResults);
  return [
    check(
      "set --repo --companions stores the list and prints it",
      s.set?.exitCode === 0 &&
        s.set.stdout.includes(
          `[set] updated ${APP_REPO}: companions=${CLIENT},${DOCS},${NOTES},${MISSING}`,
        ),
      (s.set?.stdout ?? "").trim().split("\n")[0] ?? "",
    ),
    check(
      "App: a Companion body line for a listed repository gives its COMPANION block after the prompt sentence",
      part.startsWith(`${PROMPT_SENTENCE}\n\n${CLIENT_BLOCK}\n\n`),
      part.slice(0, 400) || prompt.slice(0, 200),
    ),
    check(
      "App: the Metadata block names each companion, body lines first, then the branch name lookups",
      body.endsWith(metadata),
      body.slice(body.indexOf("<details>")),
    ),
    check(
      "App: a body line for a repository not in companions is ignored, never read",
      part !== "" &&
        !part.includes(OTHER) &&
        !reads.some((line) => line.startsWith(`repos/${OTHER}`)),
      reads.filter((line) => line.includes(OTHER)).join(", ") || "no read",
    ),
    check(
      "App: the branch name lookup finds the open pull request with the same head branch",
      reads.some((line) =>
        line.startsWith(
          `repos/${DOCS}/pulls?state=open&per_page=100&page=1 200`,
        ),
      ) && part.includes(`\n\n${DOCS_BLOCK(3)}\n\n`),
      reads.filter((line) => line.startsWith(`repos/${DOCS}`)).join(", "),
    ),
    check(
      "App: a listed repository with no matching pull request is an empty COMPANION block",
      part.endsWith(`\n\n${NOTES_BLOCK}`),
      part.split("\n\n").at(-1) ?? "",
    ),
    check(
      "App: a merged companion pull request is read with its final diff",
      s.client?.mergedAt !== null &&
        reads.some((line) =>
          line.startsWith(`repos/${CLIENT}/pulls/${client}/files?`),
        ) &&
        part.includes(`${CLIENT}:docs/limit.md    added     +3 -0`),
      `merged ${s.client?.mergedAt ?? "no"} · ${reads.filter((line) => line.startsWith(`repos/${CLIENT}/pulls`)).join(", ")}`,
    ),
    check(
      "App: an unreachable companion warns companion_unreachable, stays out of the prompt, and the review still posts",
      logs.includes(
        `warn companion_unreachable: The companion ${MISSING}#3 could not be read, so the review ran without it.`,
      ) &&
        part !== "" &&
        !part.includes(MISSING) &&
        body !== "",
      logs.filter((line) => line.includes("companion")).join(" | "),
    ),
    scriptedCheck(
      sim,
      "App: search-non-code with repo searches a worktree of the companion pull request",
      results.some((text) => text.startsWith("README.md:3: Calls clamp")),
      results.map((text) => text.slice(0, 80)).join(" | "),
      "the tool call is the model's",
    ),
  ];
}

function carryChecks(sim: Sim): CheckResult[] {
  const s = state(sim);
  const prompt = firstPrompts(sim, STEP.second)[0] ?? "";
  const entries = carryEntries(prompt);
  const before = s.stored.get(STEP.first);
  const after = s.stored.get(STEP.second);
  return [
    scriptedCheck(
      sim,
      "App: a second round where only the companion pull request changed rechecks the carried finding",
      s.heads.get(STEP.first) === s.heads.get(STEP.second) &&
        entries.length === 1 &&
        entries[0]!.hint === RECHECK_HINT &&
        companionPart(prompt).includes(DOCS_BLOCK(4)),
      JSON.stringify(entries),
      "the carried finding is the model's",
    ),
    check(
      "App: companions_json holds each companion's hash, and the new one after the companion changed",
      /^[0-9a-f]{64}$/.test(hashOf(before, DOCS) ?? "") &&
        hashOf(before, DOCS) !== hashOf(after, DOCS) &&
        hashOf(before, CLIENT) === hashOf(after, CLIENT) &&
        hashOf(after, MISSING) === undefined,
      `${hashOf(before, DOCS)?.slice(0, 8)} then ${hashOf(after, DOCS)?.slice(0, 8)}`,
    ),
  ];
}

function companionFindingChecks(sim: Sim): CheckResult[] {
  const body = postedReview(sim, STEP.onCompanion);
  const write = writesIn(sim, STEP.onCompanion).find((item) =>
    item.path.endsWith("/reviews"),
  );
  const inline = ((write?.body as Json | undefined)?.comments ?? []) as Json[];
  const rowsOf = (step: string) =>
    appRows<{ path: string | null; title: string; state: string }>(
      sim,
      `SELECT f.path, f.title, f.state FROM findings f JOIN reviews r ON r.id = f.review_id
       WHERE r.job_id = ?`,
      sim.trace.jobs.find((job) => job.step === step && job.type === "review")
        ?.id ?? "",
    );
  const rows = rowsOf(STEP.onCompanion);
  const after = rowsOf(STEP.after);
  const label = `\`${CLIENT}\`: \`src/session.ts`;
  const next = carryEntries(firstPrompts(sim, STEP.after)[0] ?? "");
  return [
    scriptedCheck(
      sim,
      "App: a finding placed on a companion file is in the review summary, labeled with the companion, with no inline comment",
      body.includes(label) &&
        !inline.some((comment) => String(comment.path).includes("session")) &&
        rows.some((row) => row.path === null && row.title.includes(label)),
      `${rows.map((row) => `${row.path} ${row.title}`).join(" | ")} · ${inline.length} inline`,
      "the finding's place is the model's",
    ),
    scriptedCheck(
      sim,
      "App: a finding on a companion file is not carried to the next round",
      next.length === 1 &&
        next[0]!.path === "src/math.ts" &&
        after.length > 0 &&
        after.every((row) => row.path === "src/math.ts"),
      `${JSON.stringify(next)} · ${after.map((row) => `${row.state} ${row.path}`).join(", ")}`,
      "the carried findings are the model's",
    ),
  ];
}

function cliChecks(sim: Sim): CheckResult[] {
  const s = state(sim);
  const body = s.cli.get(STEP.cliBody);
  const withRun = s.cli.get(STEP.cliWith);
  const bodyJson = cliJson(body);
  const withJson = cliJson(withRun);
  const entries = (json: Json | undefined) =>
    (json?.companions as Json[] | undefined) ?? [];
  const clientOf = (json: Json | undefined) =>
    entries(json).filter((item) => item.repo === CLIENT);
  const withReads = githubReads(sim, STEP.cliWith).filter((line) =>
    line.startsWith(`repos/${CLIENT}/pulls`),
  );
  const prompt = firstPrompts(sim, STEP.cliBody)[0] ?? "";
  return [
    check(
      "CLI pull request review reads a Companion body line: source pr-body, the pull request number, and the COMPANION block",
      ran(body?.exitCode) &&
        JSON.stringify(clientOf(bodyJson)) ===
          JSON.stringify([
            {
              repo: CLIENT,
              branch: CLIENT_BRANCH,
              source: "pr-body",
              pr: s.client?.number,
              files: 2,
              status: "read",
            },
          ]) &&
        companionPart(prompt).includes(CLIENT_BLOCK),
      JSON.stringify(entries(bodyJson)),
    ),
    check(
      "CLI pull request review: --with for the same repository wins and the pull request is not read",
      ran(withRun?.exitCode) &&
        JSON.stringify(clientOf(withJson)) ===
          JSON.stringify([
            {
              repo: CLIENT,
              branch: CLIENT_BRANCH,
              source: "flag",
              pr: null,
              files: 2,
              status: "read",
            },
          ]) &&
        withReads.length === 0 &&
        entries(withJson).some(
          (item) => item.repo === DOCS && item.source === "branch-name",
        ),
      `${JSON.stringify(entries(withJson))} · ${withReads.join(", ")}`,
    ),
  ];
}

export default defineFlow({
  name: "companions-app",
  description:
    "companion pull requests in App review and CLI pull request review: the companions setting, Companion body lines, the branch name lookup, a merged companion, an unreachable one, the Metadata line, carry-over through companions_json, and --with winning over a body line",
  ai: AI,
  steps,
  checks: (sim) => [
    ...appChecks(sim),
    ...carryChecks(sim),
    ...companionFindingChecks(sim),
    ...cliChecks(sim),
  ],
});
