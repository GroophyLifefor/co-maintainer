/** The GitHub App review, the way `serve` runs it.
 *
 * A signed webhook reaches the real handler, the job it queues runs with the
 * real job runner, and the review, its inline comments and the check run land
 * on the simulated GitHub. The author then fixes one finding (a whole-pr
 * round), pushes once more (an incremental round), and a maintainer asks a
 * question in a finding's thread (a reply job). Skips, a forged signature, a
 * redelivered webhook and a failed AI call show what must not be posted.
 *
 * Feature flows build on the exports: `serveRepo`, `openPull`,
 * `deliverOpened`, `pushRound`, the AI groups and the read helpers. */
import { DatabaseSync } from "node:sqlite";
import { finding } from "../fake_ai.ts";
import type { AiRule } from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  defineFlow,
  type Score,
  type Sim,
} from "../flow.ts";
import type {
  FileChanges,
  GithubWrite,
  OpenPullInput,
  SimComment,
  SimPull,
} from "../github.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";
import type { Delivery } from "../server.ts";
import { INIT_AI } from "./init.ts";

type Json = Record<string, unknown>;

export const APP_REPO = SAMPLE_REPO_NAME;

const MATH = SAMPLE_REPO["src/math.ts"]!;

/** Lines 9 to 15 are new: `divide` (line 10 divides) and `average` (line 14
 * reduces). */
export const OPENED_MATH = `${MATH}
export function divide(a: number, b: number): number {
  return a / b;
}

export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value) / values.length;
}
`;

/** The author fixes the divide finding: one line in, so `average`'s reduce
 * moves from line 14 to 15. */
export const FIXED_MATH = OPENED_MATH.replace(
  "  return a / b;\n",
  '  if (b === 0) throw new RangeError("b is zero");\n  return a / b;\n',
);

/** One more commit: `median` at lines 18 to 20. */
export const MEDIAN_MATH = `${FIXED_MATH}
export function median(values: number[]): number {
  return values.sort()[Math.floor(values.length / 2)]!;
}
`;

/** A token shaped like a GitHub PAT that the model quotes back. It is not a
 * world secret: the check is that the product redacts the shape. */
const QUOTED_TOKEN = `ghp_${"Zx9".repeat(12)}`;

const ZERO_DIVISOR = "A zero divisor returns Infinity instead of failing.";
const EMPTY_LIST = "reduce without a start value throws on an empty array.";
const OUT_OF_DIFF = "The ratio is rounded where the caller already rounded.";
const SORTS_TEXT = "sort() without a compare function orders numbers as text.";
const REPLY_TEXT =
  "An empty list reaches `reduce` with no start value, so it throws.";
const QUESTION = "Why does an empty list throw here?";

/** The VERIFY entries of a carry-over prompt, each answered by `decide`. */
export function verdicts(
  prompt: string,
  decide: (entry: string) => Json,
): Json[] {
  return prompt
    .split(/\n(?=F\d+ · )/)
    .slice(1)
    .map((entry) => ({ id: /^F\d+/.exec(entry)![0], ...decide(entry) }));
}

// Each review rule matches one round only, so the rules answer the same
// whatever order they are added in.

/** Round 3 on `MEDIAN_MATH`: every earlier finding still open, one new P2
 * on line 19. */
export const INCREMENTAL_ROUND_AI: AiRule[] = [
  {
    name: "review round 3",
    job: "review_pull_request",
    prompt: "export function median",
    reply: ({ prompt }) => ({
      json: {
        findings: [
          finding({
            path: "src/math.ts",
            line: 19,
            title: "median sorts numbers as text",
            body: SORTS_TEXT,
          }),
        ],
        previousFindings: verdicts(prompt, () => ({
          state: "open",
          path: "src/math.ts",
          lineFrom: 15,
        })),
      },
    }),
  },
];

/** Round 2 on `FIXED_MATH`: the divide finding is closed, the reduce one is
 * still open at its new line 15, nothing new. */
export const WHOLE_ROUND_AI: AiRule[] = [
  {
    name: "review round 2",
    job: "review_pull_request",
    prompt: /^(?![\s\S]*export function median)[\s\S]*PREVIOUS FINDINGS/,
    reply: ({ prompt }) => ({
      json: {
        findings: [],
        previousFindings: verdicts(prompt, (entry) =>
          entry.includes(ZERO_DIVISOR)
            ? { state: "closed" }
            : { state: "open", path: "src/math.ts", lineFrom: 15 },
        ),
      },
    }),
  },
];

/** Round 1 on `OPENED_MATH`: a blocking P1 on line 10, a P2 on line 14 that
 * quotes a token, and a P2 on a file outside the diff. */
export const OPENED_AI: AiRule[] = [
  {
    name: "review round 1",
    job: "review_pull_request",
    prompt: /^(?![\s\S]*PREVIOUS FINDINGS)[\s\S]*export function average/,
    reply: {
      findings: [
        finding({
          path: "src/math.ts",
          line: 10,
          severity: "P1",
          blocking: true,
          title: "divide does not guard a zero divisor",
          body: ZERO_DIVISOR,
        }),
        finding({
          path: "src/math.ts",
          line: 14,
          title: "average throws on an empty list",
          body: `${EMPTY_LIST} The test fixture logs ${QUOTED_TOKEN} too.`,
        }),
        finding({
          path: "src/format.ts",
          line: 4,
          title: "formatPercent rounds twice",
          body: OUT_OF_DIFF,
        }),
      ],
    },
  },
];

/** A pull request that adds `src/strings.ts`: the model first answers in
 * prose, not JSON, so the product asks once more and gets a clean review. */
export const RETRY_AI: AiRule[] = [
  {
    name: "slugify, prose answer",
    job: "review_pull_request",
    prompt: "src/strings.ts",
    reply: "The change looks fine, nothing to report.",
  },
  {
    name: "slugify, JSON retry",
    job: "review_pull_request_retry",
    prompt: "src/strings.ts",
    reply: { findings: [] },
  },
];

/** The answer in a finding's thread. */
export const REPLY_AI: AiRule[] = [
  { name: "reply", job: "reply_to_github_comment", reply: REPLY_TEXT },
];

/** Everything this flow's model answers. A feature flow takes only the
 * groups it uses, `INIT_AI` first for `serveRepo`, since a rule that never
 * answers is reported. */
export const APP_AI: AiRule[] = [
  ...INIT_AI,
  ...OPENED_AI,
  ...WHOLE_ROUND_AI,
  ...INCREMENTAL_ROUND_AI,
  ...REPLY_AI,
  ...RETRY_AI,
];

/** A repository with guides built by `init`, served by the App with
 * automatic review on. `serve` is started once per world. */
export async function serveRepo(
  sim: Sim,
  repo = APP_REPO,
  files: Record<string, string> = SAMPLE_REPO,
): Promise<void> {
  sim.repo(repo, files);
  const { runInitOrRemake } = await import("../../../services/setup.ts");
  await runInitOrRemake(sim.options({ command: "init", repo }));
  if (!sim.server.running) await sim.server.start();
  const { updateRepoSettings } = await import("../../../store/repos.ts");
  updateRepoSettings(repo, { auto_review: 1 });
}

export type Round = {
  pull: SimPull;
  delivery: Delivery;
  jobs: { id: string; type: string; status: string }[];
};

/** Delivers `opened` for a pull request already on GitHub and runs the
 * jobs it queued. */
export async function deliverOpened(
  sim: Sim,
  pull: SimPull,
  deliveryId?: string,
): Promise<Round> {
  const delivery = await sim.server.deliver(
    "pull_request",
    sim.server.payloads.pullRequest(pull, "opened"),
    deliveryId ? { deliveryId } : {},
  );
  const jobs = await sim.server.runJobs();
  return { pull, delivery, jobs };
}

/** Opens a pull request, delivers `opened` and runs the jobs it queued. */
export async function openPull(
  sim: Sim,
  input: OpenPullInput,
  repo = APP_REPO,
): Promise<Round> {
  return deliverOpened(sim, sim.github.openPull(repo, input));
}

/** Pushes a commit onto the pull request, delivers `synchronize` and runs
 * the jobs it queued: the next review round. */
export async function pushRound(
  sim: Sim,
  pull: SimPull,
  files: FileChanges,
  message = "update",
): Promise<Round> {
  sim.github.push(pull, files, message);
  const delivery = await sim.server.deliver(
    "pull_request",
    sim.server.payloads.pullRequest(pull, "synchronize"),
  );
  const jobs = await sim.server.runJobs();
  return { pull, delivery, jobs };
}

/** One step line for a round. */
export function roundLine(round: Round): string {
  const { outcome, reason } = round.delivery.body;
  const jobs = round.jobs.map((job) => `${job.type} ${job.status}`);
  return `#${round.pull.number} · ${String(outcome)}${reason ? ` ${String(reason)}` : ""} · ${jobs.join(", ") || "no job"}`;
}

/** Rows from app.db, read-only. */
export function appRows<T = Json>(
  sim: Sim,
  sql: string,
  ...params: (string | number)[]
): T[] {
  const database = new DatabaseSync(sim.paths.appDb, { readOnly: true });
  try {
    return database.prepare(sql).all(...params) as T[];
  } finally {
    database.close();
  }
}

/** GitHub writes made while `step` ran. */
export function writesIn(sim: Sim, step: string): GithubWrite[] {
  return sim.github.writes.filter((write) => write.step === step);
}

/** Each write as `METHOD path`, with ids shown as `:id`, for comparing the
 * order of writes. */
export function writeShape(writes: GithubWrite[]): string[] {
  return writes.map(
    (write) => `${write.method} ${write.path.replace(/\/\d+$/, "/:id")}`,
  );
}

/** The prompt of every product AI call of `job` made while `step` ran. */
export function promptsIn(sim: Sim, step: string, job: string): string[] {
  return sim.trace.completions
    .filter((call) => call.step === step && call.job === job)
    .map((call) => `${call.system}\n${call.firstUser}`);
}

/** New-file line numbers a patch shows on its right side. Written here, not
 * imported, so a bug in the product's own hunk reader cannot agree with
 * itself. */
export function diffLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) next = Number(hunk[1]);
    else if (next && (text.startsWith("+") || text.startsWith(" "))) {
      lines.add(next++);
    }
  }
  return lines;
}

/** The pull request's files as GitHub listed them at `commit`. */
export function pullFilesAt(
  sim: Sim,
  pull: SimPull,
  commit: string,
): { filename: string; patch: string }[] {
  const repo = sim.world.repos.get(pull.repo)!;
  const base = sim.world
    .git(repo, ["merge-base", repo.defaultBranch, commit])
    .toString()
    .trim();
  return sim.github.files(repo, base, commit);
}

const METADATA =
  /\n\n<details>\n<summary>Metadata<\/summary>\n\n- Activity: (\S+)\n- co-maintainer version: (\S+)\n- Model: (.+)\n- Duration: (\d+s|\d+m \d+s|\d+h \d+m \d+s)\n<\/details>$/;

/** The review's Metadata block, or undefined when it is missing or out of
 * shape. */
export function metadataOf(
  body: string,
): { activity: string; version: string; model: string } | undefined {
  const match = METADATA.exec(body);
  return match
    ? { activity: match[1]!, version: match[2]!, model: match[3]! }
    : undefined;
}

/** The step names of this flow, so a check names what it reads. */
const STEP = {
  served: "served repository",
  forged: "forged signature refused",
  opened: "review on open",
  redelivered: "redelivered webhook",
  whole: "whole-pr round",
  incremental: "incremental round",
  reply: "reply in the thread",
  skips: "skips",
  failed: "failed AI call",
  retry: "retry after the failure",
} as const;

const REVIEW_STEPS: string[] = [STEP.opened, STEP.whole, STEP.incremental];

/** The four writes of one review, in order. */
const REVIEW_WRITES = (number: number) => [
  `POST repos/${APP_REPO}/check-runs`,
  `PATCH repos/${APP_REPO}/check-runs/:id`,
  `POST repos/${APP_REPO}/pulls/${number}/reviews`,
  `PATCH repos/${APP_REPO}/check-runs/:id`,
];

type ReviewRow = {
  id: string;
  job_id: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  scope: string;
  round: number;
  status: string;
  posted_review_id: string | null;
  check_run_id: string | null;
  note_comment_id: string | null;
  cost_status: string;
  cost_note: string | null;
  cost: number | null;
  tokens_in: number;
};

type FindingRow = {
  id: string;
  review_id: string;
  severity: string;
  path: string | null;
  line_from: number | null;
  line_to: number | null;
  body_md: string;
  state: string;
  anchor_text: string | null;
  posted_comment_id: string | null;
  close_reason: string | null;
};

function reviewRows(sim: Sim, prNumber: number, repo = APP_REPO): ReviewRow[] {
  return appRows<ReviewRow>(
    sim,
    "SELECT * FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY round, created_at",
    repo,
    prNumber,
  );
}

function findingRows(sim: Sim, reviewId: string): FindingRow[] {
  return appRows<FindingRow>(
    sim,
    "SELECT * FROM findings WHERE review_id = ? ORDER BY rowid",
    reviewId,
  );
}

const pullOf = (sim: Sim) => sim.state.pull as SimPull;

/** The review a GitHub review id belongs to. */
function reviewForWrite(sim: Sim, write: GithubWrite): ReviewRow | undefined {
  return appRows<ReviewRow>(
    sim,
    "SELECT * FROM reviews WHERE posted_review_id = ?",
    String(write.id ?? ""),
  )[0];
}

function reviewPosts(sim: Sim, steps = REVIEW_STEPS): GithubWrite[] {
  return sim.github
    .writesTo(/\/pulls\/\d+\/reviews$/, "POST")
    .filter((write) => steps.includes(write.step));
}

const bodyOf = (write: GithubWrite) => (write.body ?? {}) as Json;

function writesInOrder(sim: Sim): CheckResult {
  const pull = pullOf(sim);
  const wrong = REVIEW_STEPS.flatMap((step) => {
    const writes = writesIn(sim, step);
    const shape = writeShape(writes);
    const want = REVIEW_WRITES(pull.number);
    const bot = writes.every((write) => write.actor === sim.github.bot.login);
    return JSON.stringify(shape) === JSON.stringify(want) && bot
      ? []
      : [`${step}: ${shape.join(", ") || "none"}`];
  });
  return check(
    "one review writes check run, review, check run, in order",
    wrong.length === 0,
    wrong.length
      ? wrong.join(" · ")
      : `${REVIEW_STEPS.length} rounds, 4 writes each, as the App`,
  );
}

function inlineOnDiff(sim: Sim): CheckResult {
  const pull = pullOf(sim);
  const bad: string[] = [];
  let count = 0;
  for (const write of reviewPosts(sim)) {
    const body = bodyOf(write);
    const files = pullFilesAt(sim, pull, String(body.commit_id));
    for (const comment of (body.comments ?? []) as Json[]) {
      count++;
      const file = files.find((item) => item.filename === comment.path);
      const lines = diffLines(file?.patch ?? "");
      const wanted = [comment.line, comment.start_line].filter(
        (line) => line !== undefined,
      );
      if (!wanted.every((line) => lines.has(Number(line)))) {
        bad.push(`${String(comment.path)}:${String(comment.line)}`);
      }
    }
  }
  // The finding outside the diff is told in the summary, never inline.
  const first = reviewPosts(sim, [STEP.opened])[0];
  const outside = first
    ? ((bodyOf(first).comments ?? []) as Json[]).some(
        (comment) => comment.path === "src/format.ts",
      ) || !String(bodyOf(first).body).includes(OUT_OF_DIFF)
    : true;
  return check(
    "inline comments only on lines in the diff",
    count > 0 && bad.length === 0 && !outside,
    bad.length
      ? `off the diff: ${bad.join(", ")}`
      : outside
        ? "the finding outside the diff is inline or missing from the summary"
        : `${count} inline comments, all on diff lines · the one outside the diff is in the summary only`,
  );
}

function firstRound(sim: Sim): CheckResult {
  const pull = pullOf(sim);
  const opened = sim.state.opened as Round | undefined;
  const review = reviewRows(sim, pull.number)[0];
  const write = reviewPosts(sim, [STEP.opened])[0];
  const comments = (write ? (bodyOf(write).comments ?? []) : []) as Json[];
  const rows = review ? findingRows(sim, review.id) : [];
  const posted = sim.github.comments.filter(
    (comment) => comment.reviewId === write?.id,
  );
  const linked = rows
    .filter((row) => row.path === "src/math.ts")
    .every((row) =>
      posted.some(
        (comment) =>
          String(comment.id) === row.posted_comment_id &&
          comment.line === row.line_from,
      ),
    );
  const problems = [
    opened?.delivery.body.outcome === "enqueued" ? "" : "not enqueued",
    opened?.jobs.length === 1 && opened.jobs[0]!.status === "done"
      ? ""
      : `jobs ${JSON.stringify(opened?.jobs ?? [])}`,
    review?.job_id === opened?.delivery.body.jobId
      ? ""
      : "review row not tied to the job",
    review?.status === "posted" && review.posted_review_id === String(write?.id)
      ? ""
      : `review row ${review?.status}`,
    rows.length === 3 ? "" : `${rows.length} finding rows`,
    comments.length === 2 && linked
      ? ""
      : `${comments.length} inline, linked ${linked}`,
  ].filter(Boolean);
  return check(
    "opened: one job, one review, findings stored and linked",
    problems.length === 0,
    problems.length
      ? problems.join(", ")
      : `job ${String(opened?.delivery.body.jobId).slice(0, 8)} · 3 findings · 2 inline, each row knows its comment`,
  );
}

/** The documented rule (docs/md/review.md): no open finding approves.
 * With open findings `model` requests changes, `severity` requests changes
 * for a P0 or P1 and comments otherwise. */
function expectedEvent(rows: FindingRow[], mode: string): string {
  const open = rows.filter((row) => row.state !== "closed");
  if (open.length === 0) return "APPROVE";
  if (mode !== "severity") return "REQUEST_CHANGES";
  return open.some((row) => row.severity === "P0" || row.severity === "P1")
    ? "REQUEST_CHANGES"
    : "COMMENT";
}

function eventRule(sim: Sim): CheckResult {
  const modes = (sim.state.modes ?? {}) as Record<string, string>;
  const steps = [...REVIEW_STEPS, STEP.retry];
  const seen: string[] = [];
  const wrong: string[] = [];
  for (const write of reviewPosts(sim, steps)) {
    const review = reviewForWrite(sim, write);
    const mode = modes[write.step] ?? "model";
    const want = review
      ? expectedEvent(findingRows(sim, review.id), mode)
      : "?";
    const got = String(bodyOf(write).event);
    seen.push(`${got} (${mode})`);
    if (got !== want) wrong.push(`${write.step}: ${got}, rule says ${want}`);
  }
  const all = new Set(seen.map((item) => item.split(" ")[0]));
  return check(
    "review event follows the blocking rule",
    wrong.length === 0 && seen.length === steps.length && all.size === 3,
    wrong.length ? wrong.join(" · ") : seen.join(", "),
  );
}

async function metadataBlock(sim: Sim): Promise<CheckResult> {
  const { VERSION } = await import("../../../version.ts");
  const model = String(sim.world.readConfig().highModel ?? "");
  const wrong: string[] = [];
  const posts = reviewPosts(sim, [...REVIEW_STEPS, STEP.retry]);
  for (const write of posts) {
    const meta = metadataOf(String(bodyOf(write).body));
    const review = reviewForWrite(sim, write);
    if (!meta) wrong.push(`${write.step}: no Metadata block`);
    else if (meta.activity !== review?.job_id) {
      wrong.push(`${write.step}: activity ${meta.activity}`);
    } else if (meta.version !== VERSION) {
      wrong.push(`${write.step}: version ${meta.version}`);
    } else if (meta.model !== model) {
      wrong.push(`${write.step}: model ${meta.model}`);
    }
  }
  return check(
    "Metadata block names the job, version and model",
    posts.length > 0 && wrong.length === 0,
    wrong.length
      ? wrong.join(" · ")
      : `${posts.length} reviews · ${VERSION} · ${model}`,
  );
}

function checkRuns(sim: Sim): CheckResult {
  const pull = pullOf(sim);
  const wrong: string[] = [];
  const rows = reviewRows(sim, pull.number);
  for (const review of rows) {
    const run = sim.github.checkRuns.find(
      (item) => String(item.id) === review.check_run_id,
    );
    const open = findingRows(sim, review.id).filter(
      (row) => row.state !== "closed",
    ).length;
    const statuses = run?.updates.map((update) => update.status);
    const output = run?.output ?? {};
    const want = open === 0 ? "success" : "neutral";
    if (!run) wrong.push(`round ${review.round}: no check run`);
    else if (run.headSha !== review.head_sha) {
      wrong.push(`round ${review.round}: head ${run.headSha}`);
    } else if (
      JSON.stringify(statuses) !==
      JSON.stringify(["queued", "in_progress", "completed"])
    ) {
      wrong.push(`round ${review.round}: ${JSON.stringify(statuses)}`);
    } else if (run.conclusion !== want) {
      wrong.push(`round ${review.round}: ${run.conclusion}, want ${want}`);
    } else if (
      (output.annotations as unknown[] | undefined)?.length !== open ||
      !String(output.summary).startsWith(
        open ? `${open} finding` : "No actionable",
      )
    ) {
      wrong.push(
        `round ${review.round}: output ${JSON.stringify(output.summary)}`,
      );
    }
  }
  return check(
    "each round's check run is created, started and concluded on its head",
    rows.length === 3 && wrong.length === 0,
    wrong.length
      ? wrong.join(" · ")
      : `${rows.length} check runs, each queued, in progress, completed`,
  );
}

function secondRound(sim: Sim): CheckResult {
  const pull = pullOf(sim);
  const [first, second] = reviewRows(sim, pull.number);
  const write = reviewPosts(sim, [STEP.whole])[0];
  const prompt = promptsIn(sim, STEP.whole, "review_pull_request")[0] ?? "";
  const rows = second ? findingRows(sim, second.id) : [];
  const fixed = rows.find((row) => row.body_md === ZERO_DIVISOR);
  const open = rows.find((row) => row.body_md.startsWith(EMPTY_LIST));
  const body = String(write ? bodyOf(write).body : "");
  const problems = [
    second?.round === 2 && second.scope === "whole-pr"
      ? ""
      : `round ${second?.round} ${second?.scope}`,
    prompt.includes(ZERO_DIVISOR) && prompt.includes(EMPTY_LIST)
      ? ""
      : "the prompt does not list both earlier findings",
    fixed?.state === "closed" ? "" : `fixed finding ${fixed?.state}`,
    open?.state === "open" && open.line_from === 15
      ? ""
      : `open finding ${open?.state} at ${open?.line_from}`,
    body.includes("Still open (1)") &&
    body.includes(`first found in ${first?.head_sha.slice(0, 7)}`) &&
    !body.includes(ZERO_DIVISOR)
      ? ""
      : "summary does not say what is still open",
    ((write ? bodyOf(write).comments : []) as unknown[]).length === 0
      ? ""
      : "a still-open finding was posted again",
  ].filter(Boolean);
  return check(
    "second round carries findings over and posts nothing twice",
    problems.length === 0,
    problems.length
      ? problems.join(", ")
      : "fixed one closed · other still open at its new line 15 · no inline comment repeated",
  );
}

function incrementalRound(sim: Sim): CheckResult {
  const pull = pullOf(sim);
  const [, second, third] = reviewRows(sim, pull.number);
  const prompt =
    promptsIn(sim, STEP.incremental, "review_pull_request")[0] ?? "";
  const diff = prompt.slice(prompt.lastIndexOf("\nDIFF:\n"));
  const compare = sim.trace.github.some(
    (call) =>
      call.step === STEP.incremental &&
      call.url.includes(`/compare/${second?.head_sha}...${third?.head_sha}`),
  );
  const write = reviewPosts(sim, [STEP.incremental])[0];
  const inline = ((write ? bodyOf(write).comments : []) as Json[]).map(
    (comment) => comment.line,
  );
  const problems = [
    third?.scope === "incremental" && third.base_sha === second?.head_sha
      ? ""
      : `scope ${third?.scope} base ${third?.base_sha?.slice(0, 7)}`,
    compare ? "" : "no compare from the last reviewed head",
    diff.includes("+export function median") &&
    !diff.includes("+export function divide")
      ? ""
      : "the diff sent is not only the new commit",
    JSON.stringify(inline) === "[19]"
      ? ""
      : `inline at ${JSON.stringify(inline)}`,
  ].filter(Boolean);
  return check(
    "incremental round reviews only the new commit",
    problems.length === 0,
    problems.length
      ? problems.join(", ")
      : `compare ${second?.head_sha.slice(0, 7)}...${third?.head_sha.slice(0, 7)} · only median sent · new finding inline at 19`,
  );
}

function anchors(sim: Sim): CheckResult {
  const pull = pullOf(sim);
  const first = reviewRows(sim, pull.number)[0];
  const wrong = (first ? findingRows(sim, first.id) : [])
    .filter((row) => row.path === "src/math.ts")
    .flatMap((row) => {
      const want = OPENED_MATH.split("\n")[(row.line_from ?? 0) - 1];
      return row.anchor_text === want
        ? []
        : [`line ${row.line_from}: ${JSON.stringify(row.anchor_text)}`];
    });
  return check(
    "first-round findings keep the line they point at",
    first !== undefined && wrong.length === 0,
    wrong.length
      ? wrong.join(", ")
      : "each diff finding stores its line's text for the next round",
  );
}

function redelivery(sim: Sim): CheckResult {
  const delivery = sim.state.redelivered as Delivery | undefined;
  const pull = pullOf(sim);
  const jobs = appRows(
    sim,
    "SELECT id FROM jobs WHERE repo = ? AND pr_number = ? AND type = 'review'",
    APP_REPO,
    pull.number,
  );
  const ok =
    delivery?.body.outcome === "duplicate" &&
    writesIn(sim, STEP.redelivered).length === 0 &&
    jobs.length === 3;
  return check(
    "a redelivered webhook is not reviewed twice",
    ok,
    `outcome ${String(delivery?.body.outcome)} · ${writesIn(sim, STEP.redelivered).length} writes · ${jobs.length} review jobs for 3 rounds`,
  );
}

function forged(sim: Sim): CheckResult {
  const delivery = sim.state.forged as Delivery | undefined;
  const id =
    sim.trace.webhooks.find((hook) => hook.step === STEP.forged)?.deliveryId ??
    "";
  const stored = appRows(
    sim,
    "SELECT * FROM deliveries WHERE delivery_id = ?",
    id,
  );
  const jobs = sim.trace.jobs.filter((job) => job.step === STEP.forged);
  return check(
    "a forged signature is refused",
    delivery?.status === 401 && stored.length === 0 && jobs.length === 0,
    `status ${delivery?.status} · ${stored.length} delivery rows · ${jobs.length} jobs`,
  );
}

const SKIPS: [string, string][] = [
  ["draft", "draft"],
  ["bot author", "bot-author"],
  ["auto review off", "auto-review-off"],
  ["no guides", "no-knowledge-yet"],
];

function skips(sim: Sim): CheckResult {
  const results = (sim.state.skips ?? {}) as Record<string, Delivery>;
  const wrong: string[] = [];
  for (const [name, reason] of SKIPS) {
    const delivery = results[name];
    const row = appRows<{ outcome: string; reason: string }>(
      sim,
      "SELECT outcome, reason FROM deliveries WHERE delivery_id = ?",
      sim.trace.webhooks.find(
        (hook) => hook.step === STEP.skips && hook.response === delivery?.body,
      )?.deliveryId ?? "",
    )[0];
    if (
      delivery?.body.outcome !== "skipped" ||
      delivery.body.reason !== reason ||
      row?.reason !== reason
    ) {
      wrong.push(
        `${name}: ${String(delivery?.body.reason)} / stored ${row?.reason}`,
      );
    }
  }
  const jobs = sim.trace.jobs.filter((job) => job.step === STEP.skips);
  const writes = writesIn(sim, STEP.skips);
  return check(
    "skips queue no job and post nothing",
    wrong.length === 0 && jobs.length === 0 && writes.length === 0,
    wrong.length
      ? wrong.join(" · ")
      : `${SKIPS.map(([, reason]) => reason).join(", ")} · ${jobs.length} jobs · ${writes.length} writes`,
  );
}

function reply(sim: Sim): CheckResult {
  const question = sim.state.question as SimComment | undefined;
  const request = appRows<{
    id: string;
    status: string;
    posted_comment_id: string | null;
    target_comment_id: string;
  }>(
    sim,
    "SELECT * FROM reply_requests WHERE source_comment_id = ?",
    String(question?.id ?? ""),
  )[0];
  const writes = writesIn(sim, STEP.reply);
  const write = writes[0];
  const body = write ? bodyOf(write) : {};
  const prompt = promptsIn(sim, STEP.reply, "reply_to_github_comment")[0] ?? "";
  const root = question?.inReplyTo;
  const problems = [
    writes.length === 1 &&
    write!.path === `repos/${APP_REPO}/pulls/${pullOf(sim).number}/comments`
      ? ""
      : `writes ${writeShape(writes).join(", ")}`,
    body.in_reply_to === root && request?.target_comment_id === String(root)
      ? ""
      : `in_reply_to ${String(body.in_reply_to)}, thread ${root}`,
    String(body.body).startsWith(
      `<!-- co-maintainer:reply:${request?.id} -->\n`,
    ) && String(body.body).includes(REPLY_TEXT)
      ? ""
      : "body lacks the marker or the answer",
    request?.status === "posted" &&
    request.posted_comment_id === String(write?.id)
      ? ""
      : `request ${request?.status}`,
    prompt.includes(QUESTION) && prompt.includes(EMPTY_LIST)
      ? ""
      : "the prompt lacks the question or its finding",
  ].filter(Boolean);
  return check(
    "a reply in a finding's thread is answered in that thread",
    problems.length === 0,
    problems.length
      ? problems.join(", ")
      : `one reply to comment ${root} · request posted · prompt has the question and the finding`,
  );
}

function ownReply(sim: Sim): CheckResult {
  const delivery = sim.state.ownReply as Delivery | undefined;
  const jobs = sim.trace.jobs.filter(
    (job) => job.step === STEP.reply && job.type === "reply",
  );
  return check(
    "the App's own reply is not answered",
    delivery?.body.outcome === "skipped" &&
      delivery.body.reason === "own-comment" &&
      jobs.length === 1,
    `outcome ${String(delivery?.body.outcome)} ${String(delivery?.body.reason ?? "")} · ${jobs.length} reply jobs`,
  );
}

async function failure(sim: Sim): Promise<CheckResult> {
  const { REVIEW_FAILED_NOTE_START } =
    await import("../../../services/review.ts");
  const pull = sim.state.failedPull as SimPull | undefined;
  const review = pull ? reviewRows(sim, pull.number)[0] : undefined;
  const job = sim.trace.jobs.find((item) => item.step === STEP.failed);
  const writes = writesIn(sim, STEP.failed);
  const note = writes.find((write) =>
    write.path.endsWith(`/issues/${pull?.number}/comments`),
  );
  const noteBody = String(note ? bodyOf(note).body : "");
  const run = sim.github.checkRuns.find(
    (item) => String(item.id) === review?.check_run_id,
  );
  const want = [
    `POST repos/${APP_REPO}/check-runs`,
    `PATCH repos/${APP_REPO}/check-runs/:id`,
    `POST repos/${APP_REPO}/issues/${pull?.number}/comments`,
    `PATCH repos/${APP_REPO}/check-runs/:id`,
  ];
  const problems = [
    job?.status === "failed" && job.error ? "" : `job ${job?.status}`,
    JSON.stringify(writeShape(writes)) === JSON.stringify(want)
      ? ""
      : `writes ${writeShape(writes).join(", ")}`,
    noteBody.startsWith(REVIEW_FAILED_NOTE_START) &&
    noteBody.endsWith(`/activity/${job?.id}`)
      ? ""
      : `note ${JSON.stringify(noteBody)}`,
    job?.error && !noteBody.includes(job.error) && !noteBody.includes("500")
      ? ""
      : "the note carries the provider error",
    run?.conclusion === "failure" && run.output?.title === "Review job failed."
      ? ""
      : `check run ${run?.conclusion}`,
    review?.status === "failed" && review.note_comment_id === String(note?.id)
      ? ""
      : `review row ${review?.status} note ${review?.note_comment_id}`,
  ].filter(Boolean);
  return check(
    "a failed AI call fails the job, leaves one note and fails the check run",
    problems.length === 0,
    problems.length
      ? problems.join(", ")
      : `job failed: ${job?.error} · one note to the dashboard · check run failure`,
  );
}

async function retry(sim: Sim): Promise<CheckResult> {
  const { REVIEWED_NOTE } = await import("../../../services/review.ts");
  const pull = sim.state.failedPull as SimPull | undefined;
  const notes = sim.github.comments.filter(
    (comment) =>
      comment.kind === "issue" &&
      comment.number === pull?.number &&
      comment.user.type === "Bot",
  );
  const reviews = reviewRows(sim, pull?.number ?? 0);
  const posted = reviewPosts(sim, [STEP.retry]);
  const problems = [
    notes.length === 1 && notes[0]!.body === REVIEWED_NOTE
      ? ""
      : `notes ${JSON.stringify(notes.map((note) => note.body))}`,
    reviews.length === 2 && reviews[1]!.status === "posted"
      ? ""
      : `reviews ${reviews.map((row) => row.status).join(", ")}`,
    posted.length === 1 &&
    String(bodyOf(posted[0]!).body).startsWith("No actionable findings.")
      ? ""
      : "no clean review posted",
  ].filter(Boolean);
  return check(
    "a retry posts the review and rewrites the same note",
    problems.length === 0,
    problems.length
      ? problems.join(", ")
      : "one note, now saying the review is below · second attempt posted",
  );
}

function jobStates(sim: Sim): CheckResult {
  const jobs = appRows<{ type: string; status: string; error: string | null }>(
    sim,
    "SELECT type, status, error FROM jobs ORDER BY created_at",
  );
  const got = jobs.map((job) => `${job.type} ${job.status}`);
  const want = [
    "review done",
    "review done",
    "review done",
    "reply done",
    "review failed",
    "review done",
  ];
  return check(
    "job states in app.db",
    JSON.stringify(got) === JSON.stringify(want),
    got.join(", "),
  );
}

function costPerReview(sim: Sim): CheckResult {
  const rows = appRows<ReviewRow>(
    sim,
    "SELECT * FROM reviews ORDER BY created_at",
  );
  // A posted review has a known cost and its tokens. The failed attempt made
  // no AI call that answered, so its cost is unknown with that reason, never
  // a known zero.
  const wrong = rows.filter((row) =>
    row.status === "failed"
      ? row.cost_status !== "unknown" || row.cost_note !== "not_recorded"
      : row.cost_status !== "known" || row.cost === null || row.tokens_in <= 0,
  );
  return check(
    "cost recorded per review",
    rows.length === 5 && wrong.length === 0,
    wrong.length
      ? wrong
          .map(
            (row) =>
              `round ${row.round} ${row.status}: ${row.cost_status} ${row.cost}`,
          )
          .join(", ")
      : rows.length === 5
        ? "5 reviews · 4 posted with a known cost · the failed one unknown, not recorded"
        : `${rows.length} reviews, 5 expected`,
  );
}

function noTokens(sim: Sim): CheckResult {
  const minted = sim.trace.github
    .filter(
      (call) => call.url.endsWith("/access_tokens") && call.status === 201,
    )
    .map((call) => String((call.response as Json).token));
  const posted = JSON.stringify(sim.github.writes.map((write) => write.body));
  const shaped =
    posted.match(
      /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}/g,
    ) ?? [];
  const places: [string, string][] = [
    ["GitHub writes", posted],
    ["logs", JSON.stringify(sim.trace.logs)],
    ["job logs", JSON.stringify(appRows(sim, "SELECT message FROM job_logs"))],
    ["AI requests", JSON.stringify(sim.trace.ai.map((call) => call.request))],
  ];
  const leaked = minted.flatMap((token) =>
    places.filter(([, text]) => text.includes(token)).map(([place]) => place),
  );
  const first = reviewPosts(sim, [STEP.opened])[0];
  const redacted = String(first ? bodyOf(first).body : "").includes(
    "[redacted]",
  );
  return check(
    "no token in anything posted",
    minted.length > 0 && shaped.length === 0 && leaked.length === 0 && redacted,
    shaped.length || leaked.length || !redacted
      ? `token shapes ${shaped.length} · installation token in ${leaked.join(", ") || "nothing"} · quoted token redacted ${redacted}`
      : `${minted.length} installation tokens kept out of 4 places · the quoted token posted as [redacted]`,
  );
}

function appChecks(sim: Sim): Promise<CheckResult[]> | CheckResult[] {
  return (async () => [
    forged(sim),
    firstRound(sim),
    writesInOrder(sim),
    inlineOnDiff(sim),
    eventRule(sim),
    await metadataBlock(sim),
    checkRuns(sim),
    anchors(sim),
    redelivery(sim),
    secondRound(sim),
    incrementalRound(sim),
    reply(sim),
    ownReply(sim),
    skips(sim),
    await failure(sim),
    await retry(sim),
    jobStates(sim),
    costPerReview(sim),
    noTokens(sim),
  ])();
}

function appScores(sim: Sim): Score[] {
  const fakeAi = sim.mode === "fake";
  const pull = pullOf(sim);
  const rows = pull ? reviewRows(sim, pull.number) : [];
  const findings = rows.map((row) => findingRows(sim, row.id));
  const diffFindings = (findings[0] ?? []).filter(
    (row) =>
      row.path &&
      diffLines(
        pullFilesAt(sim, pull, rows[0]!.head_sha).find(
          (file) => file.filename === row.path,
        )?.patch ?? "",
      ).has(row.line_from ?? 0),
  ).length;
  const inline = reviewPosts(sim, [STEP.opened]).flatMap(
    (write) => (bodyOf(write).comments ?? []) as unknown[],
  ).length;
  const tokens = REVIEW_STEPS.map((step) =>
    sim.trace.completions
      .filter((call) => call.step === step)
      .reduce((sum, call) => sum + call.tokensIn, 0),
  );
  return [
    {
      name: "findings per round",
      value: findings.length
        ? findings.flat().filter((row) => row.state !== "closed").length /
          findings.length
        : null,
      detail: findings
        .map(
          (list, index) =>
            `round ${index + 1}: ${list.filter((row) => row.state !== "closed").length} open, ${list.filter((row) => row.state === "closed").length} closed`,
        )
        .join(" · "),
      fakeAi,
    },
    {
      name: "diff findings posted inline",
      value: diffFindings ? inline / diffFindings : null,
      detail: `${inline} of ${diffFindings} findings on diff lines went inline in round 1`,
      fakeAi,
    },
    {
      name: "review prompt tokens per round",
      value: tokens[0] ?? null,
      detail: REVIEW_STEPS.map(
        (step, index) => `${step} ${tokens[index]}`,
      ).join(" · "),
      fakeAi,
      data: { tokens },
    },
    {
      name: "incremental prompt against whole-pr",
      value: tokens[1] ? tokens[2]! / tokens[1] : null,
      detail: `${tokens[2]} tokens for the incremental round, ${tokens[1]} for the whole-pr round before it`,
      fakeAi,
    },
  ];
}

export default defineFlow({
  name: "app",
  description:
    "App review from a signed webhook: two more rounds, a reply, skips and a failed AI call",
  ai: APP_AI,
  steps: [
    {
      name: STEP.served,
      async run(sim) {
        await serveRepo(sim);
        return `${APP_REPO} · guides built · auto review on`;
      },
    },
    {
      name: STEP.forged,
      async run(sim) {
        const pull = sim.github.openPull(APP_REPO, {
          title: "Add divide and average",
          files: { "src/math.ts": OPENED_MATH },
        });
        sim.state.pull = pull;
        const delivery = await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
          { secret: "not-the-webhook-secret" },
        );
        await sim.server.runJobs();
        sim.state.forged = delivery;
        return `status ${delivery.status}`;
      },
    },
    {
      name: STEP.opened,
      async run(sim) {
        const round = await deliverOpened(sim, pullOf(sim));
        sim.state.opened = round;
        return roundLine(round);
      },
    },
    {
      name: STEP.redelivered,
      async run(sim) {
        const first = sim.trace.webhooks.find(
          (hook) => hook.step === STEP.opened,
        );
        const round = await deliverOpened(sim, pullOf(sim), first?.deliveryId);
        sim.state.redelivered = round.delivery;
        return roundLine(round);
      },
    },
    {
      name: STEP.whole,
      async run(sim) {
        return roundLine(
          await pushRound(
            sim,
            pullOf(sim),
            { "src/math.ts": FIXED_MATH },
            "Guard a zero divisor",
          ),
        );
      },
    },
    {
      name: STEP.incremental,
      async run(sim) {
        const { updateRepoSettings } = await import("../../../store/repos.ts");
        updateRepoSettings(APP_REPO, { review_scope: "incremental" });
        sim.world.writeConfig({ reviewBlocking: "severity" });
        sim.state.modes = {
          [STEP.incremental]: "severity",
          [STEP.retry]: "severity",
        };
        return roundLine(
          await pushRound(
            sim,
            pullOf(sim),
            { "src/math.ts": MEDIAN_MATH },
            "Add median",
          ),
        );
      },
    },
    {
      name: STEP.reply,
      async run(sim) {
        const pull = pullOf(sim);
        const first = appRows<{ posted_comment_id: string }>(
          sim,
          "SELECT posted_comment_id FROM findings WHERE body_md LIKE ? AND posted_comment_id IS NOT NULL",
          `${EMPTY_LIST}%`,
        )[0];
        const question = sim.github.reviewComment(pull, {
          body: QUESTION,
          inReplyTo: Number(first?.posted_comment_id),
        });
        sim.state.question = question;
        await sim.server.deliver(
          "pull_request_review_comment",
          sim.server.payloads.reviewComment(pull, question),
        );
        const jobs = await sim.server.runJobs();
        // GitHub sends the App's own reply back as a webhook too.
        const answer = sim.github.comments.at(-1)!;
        sim.state.ownReply = await sim.server.deliver(
          "pull_request_review_comment",
          sim.server.payloads.reviewComment(pull, answer),
        );
        await sim.server.runJobs();
        return jobs.map((job) => `${job.type} ${job.status}`).join(", ");
      },
    },
    {
      name: STEP.skips,
      async run(sim) {
        const results: Record<string, Delivery> = {};
        const open = async (
          name: string,
          input: Partial<OpenPullInput>,
          repo = APP_REPO,
        ) => {
          const pull = sim.github.openPull(repo, {
            title: `Skipped: ${name}`,
            files: { "src/math.ts": OPENED_MATH },
            ...input,
          });
          results[name] = (await deliverOpened(sim, pull)).delivery;
        };
        await open("draft", { draft: true });
        await open("bot author", { author: "renovate[bot]" });
        const { activateRepo, updateRepoSettings } =
          await import("../../../store/repos.ts");
        updateRepoSettings(APP_REPO, { auto_review: 0 });
        await open("auto review off", {});
        updateRepoSettings(APP_REPO, { auto_review: 1 });
        // Added from the dashboard, no init yet.
        sim.repo("sim/fresh");
        activateRepo("sim/fresh", sim.github.installation.id);
        await open("no guides", {}, "sim/fresh");
        sim.state.skips = results;
        return Object.values(results)
          .map((result) => String(result.body.reason))
          .join(", ");
      },
    },
    {
      name: STEP.failed,
      async run(sim) {
        sim.faults.add({
          target: "ai",
          kind: "500",
          job: "review_pull_request",
        });
        const round = await openPull(sim, {
          title: "Add slugify",
          files: {
            "src/strings.ts":
              'export function slugify(text: string): string {\n  return text.toLowerCase().replaceAll(" ", "-");\n}\n',
          },
        });
        sim.state.failedPull = round.pull;
        return roundLine(round);
      },
    },
    {
      name: STEP.retry,
      async run(sim) {
        const { enqueueManualReview } =
          await import("../../../services/review.ts");
        const pull = sim.state.failedPull as SimPull;
        enqueueManualReview(APP_REPO, pull.number);
        const jobs = await sim.server.runJobs();
        return jobs.map((job) => `${job.type} ${job.status}`).join(", ");
      },
    },
  ],
  checks: appChecks,
  scores: appScores,
});
