/** Local review: `co-maintainer review` in a checkout, with the fake AI.
 *
 * The checkout is a real clone with a branch that holds a committed, a staged,
 * an unstaged and an untracked change. The fake AI plays a reviewer that
 * reads the diff in the prompt and the carry-over hints, so what it answers
 * moves with what the product sent. Everything that follows (rounds, formats,
 * edges, a tool round) is the product's own code behind `sim.cli`.
 *
 * Feature flows reuse the exports: `LOCAL_AI`, `prepareLocalRepo`,
 * `makeCheckout`, `changeCheckout`, `runReview`, `reviewChat` and the small
 * readers below. They never edit this file. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AiCall as FakeCall, AiReply, AiRule } from "../fake_ai.ts";
import { finding } from "../fake_ai.ts";
import {
  type CheckResult,
  check,
  type CliRun,
  defineFlow,
  type Score,
  scriptedCheck,
  type Sim,
  type Step,
} from "../flow.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";
import {
  type AiCall,
  type GitCommand,
  readGitTrace,
  type Completion,
} from "../trace.ts";
import { INIT_AI } from "./init.ts";

type Json = Record<string, unknown>;
export type Files = Record<string, string>;

/** The repository local review runs on, and one with no guides. */
export const LOCAL_REPO = SAMPLE_REPO_NAME;
export const UNGUIDED_REPO = "sim/unguided";
export const LOCAL_BRANCH = "feature/average";

/** Placed first, so no review call can open an interactive question. */
export const NO_CODEGRAPH = "--disable-codegraph";

// ---------------------------------------------------------------- the change

const MEAN =
  "  return values.reduce((sum, value) => sum + value, 0) / values.length;";
const AVERAGE = [
  "",
  "export function average(values: number[]): number {",
  MEAN,
  "}",
  "",
].join("\n");

const MATH = SAMPLE_REPO["src/math.ts"]!;
/** A comment above `average` moves it one line down. */
export const MATH_MOVED = `${MATH}${AVERAGE.replace(
  "export function",
  "/** The mean of the values. */\nexport function",
)}`;
/** The flagged line is rewritten, so the finding no longer holds. */
export const MATH_FIXED = `${MATH}${AVERAGE.replace(
  MEAN,
  "  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;",
)}`;

/** What the author changes on the branch. Each key is one kind of change. */
export const LOCAL_CHANGE = {
  /** In a commit on the branch. */
  committed: {
    "src/math.ts": `${SAMPLE_REPO["src/math.ts"]}${AVERAGE}`,
  } as Files,
  /** `git add`ed and not committed. */
  staged: {
    "test/math.test.ts": `${SAMPLE_REPO["test/math.test.ts"]!.replace(
      "import { add, clamp }",
      "import { add, average, clamp }",
    )}test("average", () => assert.equal(average([2, 4]), 3));\n`,
  } as Files,
  /** Edited, neither added nor committed. */
  unstaged: {
    "src/index.ts": `${SAMPLE_REPO["src/index.ts"]!.replace(
      "{ add, clamp }",
      "{ add, average, clamp }",
    )}`,
  } as Files,
  /** A new file git does not know. */
  untracked: {
    "src/stats.ts": [
      'import { average } from "./math.ts";',
      "",
      "export function describe(values: number[]): string {",
      '  console.log("describing", values.length);',
      "  return `mean ${average(values)}`;",
      "}",
      "",
    ].join("\n"),
  } as Files,
};

/** The four files the change touches, sorted the way the product sorts them. */
export const LOCAL_CHANGED = [
  "src/index.ts",
  "src/math.ts",
  "src/stats.ts",
  "test/math.test.ts",
];

/** A line a reviewer would object to, and the finding it writes. */
export type Smell = {
  path: string;
  /** Text of the added line the finding sits on. */
  marker: string;
  finding(line: number): Json;
};

export const LOCAL_SMELLS: Smell[] = [
  {
    path: "src/math.ts",
    marker: "return values.reduce(",
    finding: (line) => ({
      ...finding({
        path: "src/math.ts",
        line,
        title: "The average of an empty list is NaN",
        body: "An empty list divides zero by zero, so callers get NaN.",
        severity: "P1",
        blocking: true,
      }),
      symbol: "average",
    }),
  },
  {
    path: "src/stats.ts",
    marker: 'console.log("describing"',
    finding: (line) => ({
      ...finding({
        path: "src/stats.ts",
        line,
        title: "Debug logging was left in describe",
        body: "The console.log writes to every caller's output.",
        severity: "P2",
        blocking: false,
      }),
      symbol: "describe",
    }),
  },
];

// ------------------------------------------------------------ the fake model

/** The numbered diff the prompt carries: path to line number to text. */
export function promptDiff(prompt: string): Map<string, Map<number, string>> {
  const files = new Map<string, Map<number, string>>();
  const start = prompt.indexOf("\nDIFF:\n");
  if (start < 0) return files;
  let body = prompt.slice(start + 7);
  const unchanged = body.indexOf("\nUNCHANGED SINCE LAST REVIEW");
  if (unchanged >= 0) body = body.slice(0, unchanged);
  let current: Map<number, string> | undefined;
  for (const line of body.split("\n")) {
    const file = /^FILE: (.+)$/.exec(line);
    if (file) {
      current = new Map();
      files.set(file[1]!, current);
      continue;
    }
    const added = /^\s*(\d+) \+(.*)$/.exec(line);
    if (added && current) current.set(Number(added[1]), added[2]!);
  }
  return files;
}

export type CarryEntry = {
  label: string;
  hint: string;
  path: string;
  from: number;
  to: number;
};

/** The VERIFY entries of the carry-over section. */
export function carryEntries(prompt: string): CarryEntry[] {
  const section = prompt.split("\nVERIFY:\n")[1];
  if (section === undefined) return [];
  const head = /^(F\d+) · (.*?) · (.+?):(\d+)(?:-(\d+))?$/gm;
  return [...section.matchAll(head)].map((match) => ({
    label: match[1]!,
    hint: match[2]!,
    path: match[3]!,
    from: Number(match[4]),
    to: Number(match[5] ?? match[4]),
  }));
}

/** The reviewer: reports each smell that is in the diff and that no carried
 * finding covers, and judges every carried finding by the hint the product
 * gave it, finding the line again in the diff when the file was sent. */
export function reviewerReply(smells: Smell[], call: FakeCall): AiReply {
  const diff = promptDiff(call.prompt);
  const entries = carryEntries(call.prompt);
  const lineOf = (smell: Smell): number | undefined => {
    for (const [line, text] of diff.get(smell.path) ?? [])
      if (text.includes(smell.marker)) return line;
    return undefined;
  };
  const previousFindings = entries.map((entry) => {
    const smell = smells.find((item) => item.path === entry.path);
    const gone = /could not locate|no longer found/.test(entry.hint);
    if (!smell || gone) return { id: entry.label, state: "closed" };
    const line = lineOf(smell) ?? entry.from;
    return {
      id: entry.label,
      state: "open",
      path: entry.path,
      lineFrom: line,
      lineTo: line + (entry.to - entry.from),
    };
  });
  const covered = new Set(entries.map((entry) => entry.path));
  const findings = smells.flatMap((smell) => {
    const line = lineOf(smell);
    return line === undefined || covered.has(smell.path)
      ? []
      : [smell.finding(line)];
  });
  return {
    json: {
      findings,
      ...(previousFindings.length ? { previousFindings } : {}),
    },
  };
}

/** A file the model answers with prose for, so the product asks again. */
export const PROSE_PATH = "src/prose.ts";

/** A file the model wants to draw: it reads the Mermaid syntax docs first. */
export const PIPELINE_PATH = "src/pipeline.ts";
export const PIPELINE_SMELL: Smell = {
  path: PIPELINE_PATH,
  marker: "await step();",
  finding: (line) => ({
    ...finding({
      path: PIPELINE_PATH,
      line,
      title: "A failing step stops the rest without a message",
      body: "The loop awaits each step and lets the first rejection escape.",
      severity: "P2",
      blocking: false,
    }),
    symbol: "run",
  }),
};
export const PIPELINE_FILE = [
  "export async function run(steps: (() => Promise<void>)[]): Promise<void> {",
  "  for (const step of steps) {",
  "    await step();",
  "  }",
  "}",
  "",
].join("\n");

/** The file the prose answer is about, reviewed by the retry. */
const PROSE_SMELL: Smell = {
  path: PROSE_PATH,
  marker: "return 1 / 0;",
  finding: (line) =>
    finding({
      path: PROSE_PATH,
      line,
      title: "The division by zero is deliberate",
      body: "The function always returns Infinity.",
      severity: "P3",
      blocking: false,
    }),
};
export const PROSE_FILE =
  "export const never = (): number => {\n  return 1 / 0;\n};\n";

/** The reviewer as a rule: it reports each of `smells` that is in the diff,
 * and judges carried findings by the hints the product gave. It answers the
 * review call and its JSON retry. Put rules of your own before it. */
export const reviewerRule = (smells: Smell[] = LOCAL_REPO_SMELLS): AiRule => ({
  name: "reviewer",
  job: /^review_(local|pull_request_retry)$/,
  reply: (call) => reviewerReply(smells, call),
});

/** A change that touches `PIPELINE_PATH` makes the model read two Mermaid
 * syntax docs, one of them unknown, before it answers. */
export const TOOL_ROUND_RULE: AiRule = {
  name: "tool round",
  job: "review_local",
  prompt: PIPELINE_PATH,
  reply: (call) =>
    call.round === 0
      ? {
          toolCalls: [
            {
              name: "read-mermaid-syntaxes",
              arguments: { tools: ["flowchart"] },
            },
            // A name the product does not know: the tool answers with an
            // error text and the review goes on.
            {
              name: "read-mermaid-syntaxes",
              arguments: { tools: ["gantt"] },
            },
          ],
        }
      : reviewerReply([PIPELINE_SMELL], call),
};

/** A change that touches `PROSE_PATH` gets prose first, JSON on the retry. */
export const PROSE_RULE: AiRule = {
  name: "prose answer",
  job: "review_local",
  prompt: PROSE_PATH,
  times: 1,
  reply: "I read the change and nothing in it needs a comment.",
};

const LOCAL_REPO_SMELLS = [...LOCAL_SMELLS, PROSE_SMELL];

/** What a feature flow needs: init, and a reviewer for `LOCAL_CHANGE`. A
 * rule of its own goes before these, because the first match answers. */
export const LOCAL_BASE_AI: AiRule[] = [...INIT_AI, reviewerRule()];

/** What this flow needs: the base, and the two special answers. */
export const LOCAL_AI: AiRule[] = [
  TOOL_ROUND_RULE,
  PROSE_RULE,
  ...LOCAL_BASE_AI,
];

// --------------------------------------------------------------- git helpers

export type Checkout = {
  name: string;
  dir: string;
  repo: string;
  branch: string;
};

const clean = (value: string | Buffer | null | undefined) =>
  String(value ?? "").trim();

/** Runs git in `dir` with the world's environment, so the clone is rewritten
 * to the sandbox's repository and every command lands in the git trace. */
export function git(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, env: process.env });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${clean(result.stderr)}`);
  }
  return String(result.stdout);
}

export function writeFiles(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export type CheckoutSpec = {
  /** The directory name under the sandbox's `work`. */
  name: string;
  repo?: string;
  branch?: string;
  committed?: Files;
  staged?: Files;
  unstaged?: Files;
  untracked?: Files;
  /** The remote's URL. The default names GitHub over SSH, which `git remote
   * get-url` returns as written. An https URL would be rewritten to a file
   * path by the world, and the product could not read it as GitHub. */
  remote?: string | null;
};

/** A clone of a simulated repository with a branch and the changes: a commit,
 * a staged edit, an unstaged edit and an untracked file. */
export function makeCheckout(sim: Sim, spec: CheckoutSpec): Checkout {
  const repo = spec.repo ?? LOCAL_REPO;
  const branch = spec.branch ?? LOCAL_BRANCH;
  const dir = join(sim.world.root, "work", spec.name);
  mkdirSync(dirname(dir), { recursive: true });
  git(dirname(dir), ["clone", "-q", `https://github.com/${repo}`, dir]);
  if (spec.remote === null) git(dir, ["remote", "remove", "origin"]);
  else {
    git(dir, [
      "remote",
      "set-url",
      "origin",
      spec.remote ?? `git@github.com:${repo}.git`,
    ]);
  }
  git(dir, ["switch", "-q", "-c", branch]);
  if (spec.committed) {
    writeFiles(dir, spec.committed);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "the change"]);
  }
  if (spec.staged) {
    writeFiles(dir, spec.staged);
    git(dir, ["add", "-A"]);
  }
  if (spec.unstaged) writeFiles(dir, spec.unstaged);
  if (spec.untracked) writeFiles(dir, spec.untracked);
  return { name: spec.name, dir, repo, branch };
}

/** The author edits files in the working tree. */
export function changeCheckout(co: Checkout, files: Files): void {
  writeFiles(co.dir, files);
}

/** The state of a checkout a review must not change. */
export function checkoutState(co: Checkout): {
  head: string;
  status: string;
  branch: string;
} {
  return {
    head: clean(git(co.dir, ["rev-parse", "HEAD"])),
    status: git(co.dir, ["status", "--porcelain"]),
    branch: clean(git(co.dir, ["branch", "--show-current"])),
  };
}

// ----------------------------------------------------------------- the setup

/** The CLI reads `config.json`: provider, key and models, the way `set`
 * writes them. */
export function configureCli(sim: Sim): void {
  const options = sim.options();
  sim.world.writeConfig({
    auth: "pat",
    githubPat: options.githubPat,
    ai: options.ai,
    token: options.aiToken,
    lowModel: options.lowModel,
    highModel: options.highModel,
  });
}

/** Opens the repository, writes the CLI config and runs the real `init`, so
 * the guides on disk are the ones the model wrote. */
export async function prepareLocalRepo(
  sim: Sim,
  repo = LOCAL_REPO,
): Promise<string> {
  sim.repo(repo);
  configureCli(sim);
  const { runInitOrRemake } = await import("../../../services/setup.ts");
  await runInitOrRemake(sim.options({ command: "init", repo }));
  return repo;
}

/** The guide files `init` wrote, as the review reads them. */
export function guideFiles(
  sim: Sim,
  repo = LOCAL_REPO,
): Record<string, string> {
  const dir = join(sim.paths.reposDir, repo);
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".md")) out[name] = readFileSync(join(dir, name), "utf8");
  }
  return out;
}

// ------------------------------------------------------------- running review

/** One `co-maintainer review`, and everything it left in the trace. */
export type ReviewRun = {
  label: string;
  args: string[];
  cli: CliRun;
  /** `stdout` parsed, when it is one JSON document. */
  json?: Json;
  /** The AI calls this run made, as the trace holds them. */
  ai: AiCall[];
  completions: Completion[];
  /** Git commands that ran during the review. */
  git: GitCommand[];
  githubCalls: number;
  githubWrites: number;
  before: ReturnType<typeof checkoutState>;
  after: ReturnType<typeof checkoutState>;
  /** The carry-over record on disk right after the run. */
  carry: ReturnType<typeof carryRecord>;
  /** The record on disk right before it. */
  carryBefore: ReturnType<typeof carryRecord>;
};

export type RunOptions = {
  /** Environment for this run only. */
  env?: Record<string, string>;
  /** Run from this directory instead of the checkout. */
  cwd?: string;
};

/** Runs `co-maintainer review <args>` from the checkout. A run never reaches
 * a real host: SSH is a failing command and git never asks a question. */
export async function runReview(
  sim: Sim,
  co: Checkout,
  label: string,
  args: string[],
  options: RunOptions = {},
): Promise<ReviewRun> {
  const before = checkoutState(co);
  const carryBefore = carryRecord(sim, co);
  const cwd = process.cwd();
  const saved: Record<string, string | undefined> = {};
  const env = {
    GIT_SSH_COMMAND: "false",
    GIT_TERMINAL_PROMPT: "0",
    ...options.env,
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const aiFrom = sim.trace.ai.length;
  const completionsFrom = sim.trace.completions.length;
  const githubFrom = sim.trace.github.length;
  const writesFrom = sim.github.writes.length;
  const startedMs = sim.trace.now();
  let cli: CliRun;
  try {
    process.chdir(options.cwd ?? co.dir);
    cli = await sim.cli(["review", ...args]);
  } finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  let json: Json | undefined;
  try {
    const parsed = JSON.parse(cli.stdout);
    if (parsed && typeof parsed === "object") json = parsed as Json;
  } catch {
    // Human and GitHub output are not JSON.
  }
  return {
    label,
    args,
    cli,
    json,
    ai: sim.trace.ai.slice(aiFrom),
    completions: sim.trace.completions.slice(completionsFrom),
    git: readGitTrace(
      sim.world.gitTracePath,
      Date.now() - sim.trace.now(),
    ).filter((command) => command.startMs >= startedMs),
    githubCalls: sim.trace.github.length - githubFrom,
    githubWrites: sim.github.writes.length - writesFrom,
    before,
    after: checkoutState(co),
    carry: carryRecord(sim, co),
    carryBefore,
  };
}

/** One AI request as a reader sees it. */
export type Chat = {
  job: string;
  system: string;
  user: string;
  /** Tool names the request offered. */
  tools: string[];
  /** Results of tools already run, in order. */
  toolResults: string[];
  /** The model's answer: text, or the tool calls it asked for. */
  answer: string;
  answerToolCalls: string[];
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join("");
  }
  return "";
}

export function chatOf(call: AiCall): Chat {
  const body = (call.request ?? {}) as {
    messages?: { role: string; content?: unknown }[];
    tools?: { function?: { name?: string } }[];
  };
  const messages = body.messages ?? [];
  const reply = (call.response ?? {}) as {
    choices?: {
      message?: {
        content?: string;
        tool_calls?: { function?: { name?: string; arguments?: string } }[];
      };
    }[];
  };
  const message = reply.choices?.[0]?.message;
  return {
    job: call.job ?? "",
    system: messages
      .filter((item) => item.role === "system")
      .map((item) => textOf(item.content))
      .join("\n"),
    user: textOf(messages.find((item) => item.role === "user")?.content),
    tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
    toolResults: messages
      .filter((item) => item.role === "tool")
      .map((item) => textOf(item.content)),
    answer: message?.content ?? "",
    answerToolCalls: (message?.tool_calls ?? []).map(
      (item) => `${item.function?.name}(${item.function?.arguments})`,
    ),
  };
}

/** The review conversation of a run: its `review_local` calls, in order. */
export function reviewChat(run: ReviewRun): Chat[] {
  return run.ai.filter((call) => call.job === "review_local").map(chatOf);
}

/** The findings the model's last `review_local` answer held. */
export function modelFindings(run: ReviewRun): Json[] {
  const last = reviewChat(run).at(-1);
  if (!last) return [];
  try {
    const parsed = JSON.parse(last.answer) as { findings?: Json[] };
    return parsed.findings ?? [];
  } catch {
    return [];
  }
}

/** What `--json` reported as findings. */
export function jsonFindings(run: ReviewRun): Json[] {
  return (run.json?.findings as Json[] | undefined) ?? [];
}

export function summaryOf(run: ReviewRun): Json {
  return (run.json?.summary as Json | undefined) ?? {};
}

/** The local carry-over record on disk for a checkout, `null` when none. */
export function carryRecord(
  sim: Sim,
  co: Checkout,
): { findings: Json[]; files: Json[]; visiblePaths: string[] } | null {
  if (!existsSync(sim.paths.cacheDb)) return null;
  const root = clean(git(co.dir, ["rev-parse", "--show-toplevel"]));
  const database = new DatabaseSync(sim.paths.cacheDb, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM cache WHERE namespace = ? AND cache_key = ?")
      .get("local-review", `${co.repo}\0${root}\0${co.branch}`) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/** The runs of one flow, by label. Steps put theirs here, checks read them. */
export function localState(sim: Sim): {
  runs: Map<string, ReviewRun>;
  checkouts: Map<string, Checkout>;
} {
  const state = sim.state as {
    local?: { runs: Map<string, ReviewRun>; checkouts: Map<string, Checkout> };
  };
  state.local ??= { runs: new Map(), checkouts: new Map() };
  return state.local;
}

/** A step that runs one review and keeps it under its label. */
export function reviewStep(
  label: string,
  checkout: string,
  args: string[],
  options: RunOptions | ((sim: Sim) => RunOptions) = {},
): Step {
  return {
    name: label,
    async run(sim) {
      const state = localState(sim);
      const run = await runReview(
        sim,
        state.checkouts.get(checkout)!,
        label,
        args,
        typeof options === "function" ? options(sim) : options,
      );
      state.runs.set(label, run);
      return `exit ${run.cli.exitCode} · ${run.ai.length} AI calls`;
    },
  };
}

/** Git subcommands a review must never run: it reads the checkout. */
export const WRITING_GIT = new Set([
  "fetch",
  "push",
  "pull",
  "clone",
  "checkout",
  "switch",
  "reset",
  "restore",
  "commit",
  "add",
  "stash",
  "merge",
  "rebase",
  "tag",
  "clean",
  "gc",
  "maintenance",
]);

export function gitSubcommand(command: GitCommand): string {
  // `-c key=value` pairs and `-C dir` come before the subcommand.
  const argv = [...command.argv].slice(1);
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]!;
    if (item === "-c" || item === "-C") {
      index++;
      continue;
    }
    if (item.startsWith("-")) continue;
    return item;
  }
  return "";
}

/** The findings a human review printed, by group, as `path:line` text. */
export function humanGroups(stdout: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of stdout.split("\n")) {
    const head = /^(Closed|Still open|New) \(\d+\)$/.exec(line);
    if (head) {
      current = groups[head[1]!] = [];
      continue;
    }
    const row = /^ {2}[•✓] (\S+)/.exec(line);
    if (row && current) current.push(row[1]!);
    else if (line === "") current = undefined;
  }
  return groups;
}

/** Files left in the lock directory: one is left behind by a review that did
 * not release it. */
export async function reviewLocks(): Promise<string[]> {
  const { locksDir } = await import("../../../config.ts");
  return existsSync(locksDir()) ? readdirSync(locksDir()) : [];
}

/** The files a unified diff sent in the prompt names, in order. */
export const sentFiles = (chat: Chat): string[] => [
  ...promptDiff(chat.user).keys(),
];

/** `changedFiles` of the WORKSPACE line of a prompt. */
export function workspaceFiles(chat: Chat): string[] {
  const match = /^WORKSPACE:\n(.+)$/m.exec(chat.user);
  try {
    return (
      (JSON.parse(match?.[1] ?? "{}") as { changedFiles?: string[] })
        .changedFiles ?? []
    );
  } catch {
    return [];
  }
}

/** Paths of the "UNCHANGED SINCE LAST REVIEW" list. */
export function unchangedFiles(chat: Chat): string[] {
  const section = chat.user.split(
    "UNCHANGED SINCE LAST REVIEW (paths only):\n",
  )[1];
  return section
    ? section
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2))
    : [];
}

// ------------------------------------------------------------------- the flow

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const keyOf = (item: Json) =>
  `${item.path}:${item.lineFrom}-${item.lineTo}:${item.severity}:${item.blocking}`;

/** The changed files with the debug line gone, for round 2. */
export const STATS_CLEAN = LOCAL_CHANGE.untracked["src/stats.ts"]!.replace(
  '  console.log("describing", values.length);\n',
  "",
);

/** A step that clones the repository into a checkout called `name`, on a
 * branch with the changes of `spec`. */
export const checkoutStep = (
  name: string,
  spec: Omit<CheckoutSpec, "name">,
): Step => ({
  name: `checkout ${name}`,
  run(sim) {
    localState(sim).checkouts.set(name, makeCheckout(sim, { ...spec, name }));
    return `${spec.repo ?? LOCAL_REPO} · ${spec.branch ?? LOCAL_BRANCH}`;
  },
});

/** A step where the author edits files in a checkout. */
export const editStep = (
  name: string,
  checkout: string,
  files: Files,
): Step => ({
  name,
  run(sim) {
    changeCheckout(localState(sim).checkouts.get(checkout)!, files);
    return Object.keys(files).join(", ");
  },
});

/** Cases that stop before the model is called, each a usage or precondition
 * error: the flag or the state, the exit code, the error code. */
const EDGES: {
  name: string;
  args: string[];
  checkout: string;
  code: string;
  match: RegExp;
  cwd?: (sim: Sim) => string;
  env?: Record<string, string>;
}[] = [
  {
    name: "unknown output format",
    args: ["--output=xml"],
    checkout: "edge",
    code: "usage",
    match: /--output must be: github/,
  },
  {
    name: "github output with json",
    args: ["--output=github", "--json"],
    checkout: "edge",
    code: "usage",
    match: /--output=github cannot be used with --json/,
  },
  {
    name: "remote flag without remote",
    args: ["--remote-host=remote.example", "--json"],
    checkout: "edge",
    code: "usage",
    match: /require --remote/,
  },
  {
    name: "range without remote",
    args: ["--range=a..b", "--json"],
    checkout: "edge",
    code: "usage",
    match: /--range requires --remote/,
  },
  {
    name: "repository override that is not owner/repo",
    args: ["--repo=nonsense", "--json"],
    checkout: "edge",
    code: "usage",
    match: /owner\/repo/,
  },
  {
    name: "base branch that does not exist",
    args: ["--to-branch=nope", "--json"],
    checkout: "edge",
    code: "base_not_found",
    match: /origin\/nope/,
  },
  {
    name: "directory outside git",
    args: ["--json"],
    checkout: "edge",
    code: "not_a_git_repo",
    match: /not inside a git repository/,
    cwd: (sim) => {
      const dir = join(sim.world.root, "not-a-repo");
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  },
  {
    name: "no remote to read the repository from",
    args: ["--json"],
    checkout: "noremote",
    code: "repo_not_detected",
    match: /Could not detect the GitHub repository/,
  },
  {
    name: "remote that is not GitHub",
    args: ["--json"],
    checkout: "gitlab",
    code: "unsupported_host",
    match: /Only github.com remotes/,
  },
  {
    name: "detached HEAD",
    args: ["--json"],
    checkout: "detached",
    code: "detached_head",
    match: /Detached HEAD/,
  },
  {
    name: "merge in progress",
    args: ["--json"],
    checkout: "merging",
    code: "git_operation_in_progress",
    match: /in-progress git operation/,
  },
];

const edgeLabel = (name: string) => `edge ${name}`;

const steps: Step[] = [
  {
    name: "repository with guides",
    async run(sim) {
      await prepareLocalRepo(sim);
      // A second repository the product has never seen: no guides.
      sim.repo(UNGUIDED_REPO);
      return `${Object.keys(guideFiles(sim)).join(", ")} written by init`;
    },
  },
  checkoutStep("main", LOCAL_CHANGE),
  reviewStep("round 1 human", "main", [NO_CODEGRAPH]),
  // Codegraph left on: `--json` never asks, and the tools are not installed.
  reviewStep("round 1 json", "main", ["--json", "--fresh"]),
  reviewStep(
    "round 1 github",
    "main",
    [NO_CODEGRAPH, "--output=github", "--fresh"],
    (sim) => ({
      env: { GITHUB_STEP_SUMMARY: join(sim.world.root, "step-summary.md") },
    }),
  ),
  editStep("author removes the debug line", "main", {
    "src/stats.ts": STATS_CLEAN,
  }),
  reviewStep("round 2 json", "main", ["--json", NO_CODEGRAPH]),
  editStep("author moves average one line down", "main", {
    "src/math.ts": MATH_MOVED,
  }),
  reviewStep("round 3 human", "main", [NO_CODEGRAPH]),
  {
    name: "carry-over cache made unreadable",
    run(sim) {
      const database = new DatabaseSync(sim.paths.cacheDb);
      try {
        const result = database
          .prepare("UPDATE cache SET value = ? WHERE namespace = ?")
          .run("{not json", "local-review");
        return `${result.changes} row`;
      } finally {
        database.close();
      }
    },
  },
  reviewStep("round 3 json, unreadable carry", "main", [
    "--json",
    NO_CODEGRAPH,
  ]),
  {
    name: "guide rebuilt",
    async run(sim) {
      const { runInitOrRemake } = await import("../../../services/setup.ts");
      await runInitOrRemake(
        sim.options({ command: "remake", repo: LOCAL_REPO }),
      );
    },
  },
  reviewStep("round 4 json, after the rebuild", "main", [
    "--json",
    NO_CODEGRAPH,
  ]),
  editStep("author fixes the average", "main", { "src/math.ts": MATH_FIXED }),
  reviewStep("round 5 human", "main", [NO_CODEGRAPH]),
  checkoutStep("clean", {}),
  reviewStep("clean tree human", "clean", [NO_CODEGRAPH]),
  reviewStep("clean tree json", "clean", ["--json", NO_CODEGRAPH]),
  checkoutStep("unguided", { repo: UNGUIDED_REPO, ...LOCAL_CHANGE }),
  reviewStep("no guides human", "unguided", [NO_CODEGRAPH]),
  reviewStep("no guides json", "unguided", ["--json", NO_CODEGRAPH]),
  {
    name: "checkouts for the edge cases",
    run(sim) {
      const state = localState(sim);
      const add = (name: string, spec: Omit<CheckoutSpec, "name"> = {}) =>
        state.checkouts.set(name, makeCheckout(sim, { ...spec, name }));
      add("edge");
      add("noremote", { remote: null });
      add("gitlab", { remote: "git@gitlab.com:sim/sample.git" });
      const detached = makeCheckout(sim, { name: "detached" });
      git(detached.dir, ["checkout", "-q", "--detach"]);
      state.checkouts.set("detached", detached);
      const merging = makeCheckout(sim, { name: "merging" });
      writeFileSync(
        join(merging.dir, ".git", "MERGE_HEAD"),
        `${git(merging.dir, ["rev-parse", "HEAD"])}`,
      );
      state.checkouts.set("merging", merging);
      return `${EDGES.length} cases`;
    },
  },
  ...EDGES.map((edge): Step => ({
    name: edgeLabel(edge.name),
    async run(sim) {
      const state = localState(sim);
      const run = await runReview(
        sim,
        state.checkouts.get(edge.checkout)!,
        edgeLabel(edge.name),
        edge.args,
        { cwd: edge.cwd?.(sim) },
      );
      state.runs.set(edgeLabel(edge.name), run);
      return `exit ${run.cli.exitCode}`;
    },
  })),
  checkoutStep("failing", LOCAL_CHANGE),
  {
    name: "the model's provider fails once",
    run(sim) {
      sim.faults.add({ target: "ai", kind: "500", job: "review_local" });
    },
  },
  reviewStep("provider failure", "failing", ["--json", NO_CODEGRAPH]),
  checkoutStep("tools", { untracked: { [PIPELINE_PATH]: PIPELINE_FILE } }),
  reviewStep("tool round", "tools", ["--json", NO_CODEGRAPH]),
  checkoutStep("prose", { untracked: { [PROSE_PATH]: PROSE_FILE } }),
  reviewStep("prose answer, then JSON", "prose", ["--json", NO_CODEGRAPH]),
];

// ------------------------------------------------------------------- checks

const L = {
  r1h: "round 1 human",
  r1j: "round 1 json",
  r1g: "round 1 github",
  r2: "round 2 json",
  r3: "round 3 human",
  r3b: "round 3 json, unreadable carry",
  r4: "round 4 json, after the rebuild",
  r5: "round 5 human",
  cleanH: "clean tree human",
  cleanJ: "clean tree json",
  noGuidesH: "no guides human",
  noGuidesJ: "no guides json",
  failure: "provider failure",
  tools: "tool round",
  prose: "prose answer, then JSON",
};

function runOf(sim: Sim, label: string): ReviewRun {
  const run = localState(sim).runs.get(label);
  if (!run) throw new Error(`no review run named "${label}"`);
  return run;
}

const firstChat = (run: ReviewRun): Chat => {
  const chat = reviewChat(run)[0];
  if (!chat) throw new Error(`"${run.label}" made no review request`);
  return chat;
};

const paths = (items: { path?: unknown }[] | undefined) =>
  (items ?? []).map((item) => String(item.path));

const carryPaths = (run: ReviewRun) => paths(run.carry?.findings as Json[]);

const fail = (problems: string[], good: string) =>
  problems.length === 0
    ? { ok: true, detail: good }
    : { ok: false, detail: problems.join("; ") };

function result(name: string, problems: string[], good: string): CheckResult {
  const { ok, detail } = fail(problems, good);
  return check(name, ok, detail);
}

/** What a live run skips: a result that holds only for the fake reviewer's
 * scripted findings, so the problems are listed only with the fake AI. */
function scriptedResult(
  sim: Sim,
  name: string,
  problems: string[],
  good: string,
  why = "the findings are the model's",
): CheckResult {
  const { ok, detail } = fail(problems, good);
  return scriptedCheck(sim, name, ok, detail, why);
}

/** The top-level fields `--json` documents (docs/md/review.md). */
const JSON_FIELDS = [
  "schemaVersion",
  "ok",
  "mode",
  "subject",
  "base",
  "revision",
  "guide",
  "codegraph",
  "summary",
  "findings",
  "warnings",
  "usage",
  "durationMs",
  "extensions",
];

function round1Checks(sim: Sim): CheckResult[] {
  const human = runOf(sim, L.r1h);
  const json = runOf(sim, L.r1j);
  const github = runOf(sim, L.r1g);
  const out = human.cli.stdout;
  const groups = humanGroups(out);
  const guides = guideFiles(sim);
  const chat = firstChat(human);
  const problems: string[] = [];

  // What the product prints around the findings, and what the findings give.
  const headerProblems: string[] = [];
  const humanProblems: string[] = [];
  if (human.cli.exitCode !== 1)
    humanProblems.push(`exit ${human.cli.exitCode}`);
  for (const text of [
    "co-maintainer review · sim/sample · feature/average → origin/main",
    "4 files · +13 −2",
    "codegraph disabled",
    "[P1 · blocking]",
    "[P2 · non-blocking]",
    "Summary: 2 new · 0 open · 0 closed · 1 blocking",
  ]) {
    if (!out.includes(text)) {
      (text.startsWith("[") || text.startsWith("Summary")
        ? humanProblems
        : headerProblems
      ).push(`missing "${text}"`);
    }
  }
  if (!same(groups.New, ["src/math.ts:10", "src/stats.ts:4"])) {
    humanProblems.push(`New group ${JSON.stringify(groups.New)}`);
  }

  // Every fresh review of the same change sends the same four files.
  const promptProblems: string[] = [];
  for (const run of [human, json, github]) {
    const sent = firstChat(run);
    if (!same(workspaceFiles(sent), LOCAL_CHANGED)) {
      promptProblems.push(
        `${run.label}: changedFiles ${JSON.stringify(workspaceFiles(sent))}`,
      );
    }
    if (!same(sentFiles(sent), LOCAL_CHANGED)) {
      promptProblems.push(
        `${run.label}: DIFF files ${JSON.stringify(sentFiles(sent))}`,
      );
    }
  }
  // One marker per kind of change: committed, staged, unstaged, untracked.
  for (const [kind, marker] of [
    ["committed", "return values.reduce("],
    ["staged", "average([2, 4])"],
    ["unstaged", "add, average, clamp"],
    ["untracked", 'console.log("describing"'],
  ] as const) {
    if (!chat.user.includes(marker))
      promptProblems.push(`${kind} change missing`);
  }

  const guideProblems: string[] = [];
  for (const name of ["SKILL.md", "CODEBASE.md"]) {
    const text = guides[name]?.trim();
    if (!text) guideProblems.push(`${name} not on disk`);
    else if (!chat.system.includes(text)) {
      guideProblems.push(`${name} is not in the system prompt`);
    } else if (chat.user.includes(text.slice(0, 80))) {
      guideProblems.push(`${name} is in the user prompt too`);
    }
  }

  const systems = new Set<string>();
  let requests = 0;
  for (const run of localState(sim).runs.values()) {
    for (const call of run.ai) {
      if (!call.job?.startsWith("review")) continue;
      systems.add(chatOf(call).system);
      requests++;
    }
  }

  const model = modelFindings(json);
  const reported = jsonFindings(json);
  const findingProblems: string[] = [];
  if (!same(model.map(keyOf).sort(), reported.map(keyOf).sort())) {
    findingProblems.push(
      `model ${JSON.stringify(model.map(keyOf))} vs output ${JSON.stringify(reported.map(keyOf))}`,
    );
  }
  if (
    !same(
      model.map((item) => item.body).sort(),
      reported.map((item) => item.body).sort(),
    )
  ) {
    findingProblems.push("a body differs from the model's");
  }
  const expected = ["src/math.ts:10-10:P1:true", "src/stats.ts:4-4:P2:false"];
  const scriptedProblems: string[] = [];
  if (!same(reported.map(keyOf), expected)) {
    scriptedProblems.push(`expected ${expected.join(", ")}`);
  }

  void problems;
  return [
    scriptedResult(
      sim,
      "round 1 human output",
      humanProblems,
      "exit code, blocking and non-blocking marks, group and summary",
    ),
    result(
      "round 1 human output names the branch, the stats and the codegraph state",
      headerProblems,
      "header, stats and codegraph state",
    ),
    result(
      "the prompt holds the diff of exactly the changed files",
      promptProblems,
      "4 files, one change of each kind, in 3 fresh reviews",
    ),
    result(
      "the system prompt holds the guide text",
      guideProblems,
      "SKILL.md and CODEBASE.md, system prompt only",
    ),
    check(
      "one system prompt in every review request",
      systems.size === 1,
      `${requests} requests, ${systems.size} distinct system prompts`,
    ),
    result(
      "findings in the output are the ones the model returned",
      findingProblems,
      `${reported.length} findings, path, lines, severity and blocking agree`,
    ),
    scriptedResult(
      sim,
      "round 1 reports the two findings the fake reviewer returns",
      scriptedProblems,
      "src/math.ts P1 blocking, src/stats.ts P2 non-blocking",
    ),
  ];
}

function jsonChecks(sim: Sim): CheckResult[] {
  const run = runOf(sim, L.r1j);
  const out = run.json ?? {};
  const problems: string[] = [];
  if (!run.json) problems.push("stdout is not one JSON document");
  if (!same(Object.keys(out), JSON_FIELDS)) {
    problems.push(`fields ${JSON.stringify(Object.keys(out))}`);
  }
  if (out.schemaVersion !== 1) problems.push("schemaVersion");
  if (out.ok !== true) problems.push("ok");
  if (out.mode !== "local") problems.push("mode");
  if (
    !same(out.subject, {
      repo: "sim/sample",
      branch: "feature/average",
      prNumber: null,
    })
  ) {
    problems.push(`subject ${JSON.stringify(out.subject)}`);
  }
  if (!same(out.base, { toBranch: "origin/main", label: "origin/main" })) {
    problems.push(`base ${JSON.stringify(out.base)}`);
  }
  if (
    !same(out.revision, {
      files: 4,
      additions: 13,
      deletions: 2,
      truncated: false,
      coverage: {
        full: 4,
        partial: [],
        summarized: [],
        dropped: [],
        withheld: [],
      },
    })
  ) {
    problems.push(`revision ${JSON.stringify(out.revision)}`);
  }
  const builtAt = (out.guide as { builtAt?: string } | undefined)?.builtAt;
  if (!builtAt || Number.isNaN(Date.parse(builtAt)))
    problems.push("guide.builtAt");
  const codegraph = out.codegraph as
    | { state?: string; reason?: string }
    | undefined;
  if (
    codegraph?.state !== "unavailable" ||
    !codegraph.reason?.includes("not installed")
  ) {
    problems.push(`codegraph ${JSON.stringify(codegraph)}`);
  }
  const summaryProblems: string[] = [];
  if (!same(out.summary, { new: 2, open: 0, closed: 0, blocking: 1 })) {
    summaryProblems.push(`summary ${JSON.stringify(out.summary)}`);
  }
  if (!same(out.warnings, [])) problems.push("warnings");
  const usage = out.usage as
    | { tokensIn?: number; tokensOut?: number }
    | undefined;
  const asked = run.completions.reduce((sum, item) => sum + item.tokensIn, 0);
  if (usage?.tokensIn !== asked || (usage?.tokensOut ?? 0) <= 0) {
    problems.push(
      `usage ${JSON.stringify(usage)} vs ${asked} tokens in the trace`,
    );
  }
  if (typeof out.durationMs !== "number") problems.push("durationMs");
  for (const item of jsonFindings(run)) {
    for (const field of [
      "id",
      "state",
      "closeReason",
      "severity",
      "blocking",
      "path",
      "lineFrom",
      "lineTo",
      "title",
      "body",
      "suggestion",
    ]) {
      if (!(field in item)) problems.push(`finding field ${field}`);
    }
  }
  return [
    result(
      "--json is one document with the documented fields",
      problems,
      "13 top-level fields, subject, base, revision, codegraph and usage",
    ),
    scriptedResult(
      sim,
      "--json summary counts the two scripted findings",
      summaryProblems,
      "2 new, 1 blocking",
    ),
  ];
}

function githubChecks(sim: Sim): CheckResult[] {
  const run = runOf(sim, L.r1g);
  const lines = run.cli.stdout.split("\n").filter(Boolean);
  const problems: string[] = [];
  const scriptedProblems: string[] = [];
  if (run.cli.exitCode !== 1) scriptedProblems.push(`exit ${run.cli.exitCode}`);
  if (lines.some((line) => !line.startsWith("::"))) {
    problems.push(`stdout is not workflow commands only: ${run.cli.stdout}`);
  }
  if (lines.length !== 2) {
    scriptedProblems.push("stdout is not two workflow commands");
  }
  if (
    !lines[0]?.startsWith(
      "::error file=src/math.ts,line=10,title=P1%3A average::",
    )
  ) {
    scriptedProblems.push(`first line ${lines[0]}`);
  }
  if (
    !lines[1]?.startsWith(
      "::warning file=src/stats.ts,line=4,title=P2%3A describe::",
    )
  ) {
    scriptedProblems.push(`second line ${lines[1]}`);
  }
  const path = join(sim.world.root, "step-summary.md");
  const summary = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const text of [
    "## co-maintainer review",
    "| P1 (blocking) | new | src/math.ts:10 |",
    "| P2 | new | src/stats.ts:4 |",
    "2 new · 0 open · 0 closed · 1 blocking",
  ]) {
    if (!summary.includes(text)) {
      (text.startsWith("##") ? problems : scriptedProblems).push(
        `job summary lacks "${text}"`,
      );
    }
  }
  for (const secret of sim.world.secretValues()) {
    if (summary.includes(secret.value))
      problems.push(`${secret.name} in the job summary`);
  }
  return [
    result(
      "--output=github prints workflow commands only, and a job summary",
      problems,
      "workflow commands only, and the job summary with its heading",
    ),
    scriptedResult(
      sim,
      "--output=github annotates the two scripted findings, error first, and sums them up",
      scriptedProblems,
      "error first, then warning, 2 commands, the summary table and exit 1",
    ),
  ];
}

function exitChecks(sim: Sim): CheckResult[] {
  const blocking = [L.r1h, L.r1j, L.r1g, L.r2, L.r3, L.r3b, L.r4];
  const wrong = blocking.filter(
    (label) => runOf(sim, label).cli.exitCode !== 1,
  );
  const tools = runOf(sim, L.tools);
  const prose = runOf(sim, L.prose);
  const r5 = runOf(sim, L.r5);
  const clean = [r5, tools, prose, runOf(sim, L.cleanH), runOf(sim, L.cleanJ)];
  const why = "which findings are blocking is the model's call";
  return [
    scriptedCheck(
      sim,
      "exit 1 while a blocking finding is open",
      wrong.length === 0,
      wrong.length
        ? `not 1: ${wrong.join(", ")}`
        : `${blocking.length} reviews`,
      why,
    ),
    scriptedCheck(
      sim,
      "exit 0 when no blocking finding is open, even with findings",
      clean.every((run) => run.cli.exitCode === 0) &&
        summaryOf(tools).blocking === 0 &&
        summaryOf(tools).new === 1,
      clean.map((run) => `${run.label} ${run.cli.exitCode}`).join(", "),
      why,
    ),
  ];
}

function carryChecks(sim: Sim): CheckResult[] {
  const r1h = runOf(sim, L.r1h);
  const r1j = runOf(sim, L.r1j);
  const r2 = runOf(sim, L.r2);
  const r3 = runOf(sim, L.r3);
  const r5 = runOf(sim, L.r5);
  const out: CheckResult[] = [];

  // From here the carry-over follows the findings: which files have a record,
  // which are asked about again, what is closed. The model decides all of it,
  // so what the scripted reviewer's findings lead to is skipped live. What the
  // product keeps whatever it found has a check of its own.
  const carryWhy = "the carry-over follows the findings the model reports";
  const round1: string[] = [];
  const round1Seen: string[] = [];
  const record = r1h.carry;
  if (!same(carryPaths(r1h), ["src/math.ts", "src/stats.ts"])) {
    round1.push(`findings ${JSON.stringify(carryPaths(r1h))}`);
  }
  const lines = (record?.findings ?? []).map(
    (item) => `${item.lineFrom}:${item.severity}`,
  );
  if (!same(lines, ["10:P1", "4:P2"]))
    round1.push(`lines ${JSON.stringify(lines)}`);
  if (!same(paths(record?.files as Json[]), LOCAL_CHANGED))
    round1Seen.push("files");
  if (!same([...(record?.visiblePaths ?? [])].sort(), LOCAL_CHANGED))
    round1Seen.push("visiblePaths");
  if (new Set((record?.findings ?? []).map((item) => item.id)).size !== 2)
    round1.push("ids");
  if (r1h.carryBefore !== null)
    round1Seen.push("a record existed before the first review");
  out.push(
    scriptedResult(
      sim,
      "carry record after round 1 holds both findings and the four files",
      [...round1, ...round1Seen],
      "2 findings with ids and lines, 4 files, 4 visible paths",
      carryWhy,
    ),
    result(
      "carry record after round 1 holds the four files it saw, and none was there before",
      round1Seen,
      "4 files, 4 visible paths, no earlier record",
    ),
  );

  const fresh: string[] = [];
  const freshSent: string[] = [];
  const chat = firstChat(r1j);
  if (r1j.carryBefore?.findings.length !== 2) fresh.push("no record to ignore");
  for (const text of ["PREVIOUS FINDINGS", "UNCHANGED SINCE LAST REVIEW"]) {
    if (chat.user.includes(text)) freshSent.push(`prompt holds "${text}"`);
  }
  if (!same(sentFiles(chat), LOCAL_CHANGED))
    freshSent.push("not the whole diff");
  if (!same(summaryOf(r1j), { new: 2, open: 0, closed: 0, blocking: 1 })) {
    fresh.push(`summary ${JSON.stringify(summaryOf(r1j))}`);
  }
  const before = new Set(
    (r1j.carryBefore?.findings ?? []).map((item) => item.id),
  );
  if (
    (r1j.carry?.findings ?? []).some((item) => before.has(item.id)) ||
    r1j.carry?.findings.length !== 2
  ) {
    fresh.push("the record was not replaced");
  }
  out.push(
    scriptedResult(
      sim,
      "--fresh ignores the record, reviews the whole diff and replaces the record",
      [...fresh, ...freshSent],
      "no carry text, 4 files, 2 new findings, 2 new ids in the record",
      carryWhy,
    ),
    result(
      "--fresh sends the whole diff and no carry text",
      freshSent,
      "no carry text, 4 files",
    ),
  );

  const two: string[] = [];
  const states = Object.fromEntries(
    jsonFindings(r2).map((item) => [
      String(item.path),
      `${item.state}:${item.closeReason}`,
    ]),
  );
  if (
    !same(states, { "src/math.ts": "open:null", "src/stats.ts": "closed:null" })
  ) {
    two.push(`states ${JSON.stringify(states)}`);
  }
  if (!same(summaryOf(r2), { new: 0, open: 1, closed: 1, blocking: 1 })) {
    two.push(`summary ${JSON.stringify(summaryOf(r2))}`);
  }
  const open = jsonFindings(r2).find((item) => item.state === "open");
  if (
    open?.lineFrom !== 10 ||
    open.severity !== "P1" ||
    open.blocking !== true
  ) {
    two.push("the open finding lost its line, severity or blocking");
  }
  out.push(
    scriptedResult(
      sim,
      "round 2 reports one closed and one open finding",
      two,
      "stats.ts closed, math.ts open, still blocking",
      carryWhy,
    ),
  );

  const prompt2: string[] = [];
  const chat2 = firstChat(r2);
  const entries = carryEntries(chat2.user);
  const hint = (path: string) =>
    entries.find((item) => item.path === path)?.hint ?? "";
  if (entries.length !== 2) prompt2.push(`${entries.length} VERIFY entries`);
  if (!hint("src/math.ts").includes("file unchanged since the last review")) {
    prompt2.push(`math.ts hint "${hint("src/math.ts")}"`);
  }
  if (!hint("src/stats.ts").includes("could not locate")) {
    prompt2.push(`stats.ts hint "${hint("src/stats.ts")}"`);
  }
  if (!same(sentFiles(chat2), ["src/stats.ts"])) {
    prompt2.push(`DIFF files ${JSON.stringify(sentFiles(chat2))}`);
  }
  if (!same(workspaceFiles(chat2), ["src/stats.ts"]))
    prompt2.push("changedFiles");
  if (
    !same(unchangedFiles(chat2), [
      "src/index.ts",
      "src/math.ts",
      "test/math.test.ts",
    ])
  ) {
    prompt2.push(`unchanged list ${JSON.stringify(unchangedFiles(chat2))}`);
  }
  out.push(
    scriptedResult(
      sim,
      "round 2 asks about the old findings and sends only the changed file",
      prompt2,
      "2 VERIFY entries, 1 file in the diff, 3 listed as unchanged",
      carryWhy,
    ),
  );

  const record2: string[] = [];
  if (!same(carryPaths(r2), ["src/math.ts"])) {
    record2.push(`findings ${JSON.stringify(carryPaths(r2))}`);
  }
  // Round 2 did not send these three, but it had seen them in round 1.
  const kept = [...(r2.carry?.visiblePaths ?? [])].sort();
  if (!same(kept, LOCAL_CHANGED))
    record2.push(`visiblePaths ${JSON.stringify(kept)}`);
  out.push(
    scriptedResult(
      sim,
      "carry record after round 2 drops the closed finding and keeps what was seen",
      record2,
      "1 finding, 4 visible paths",
      carryWhy,
    ),
  );

  const three: string[] = [];
  const chat3 = firstChat(r3);
  const groups3 = humanGroups(r3.cli.stdout);
  if (!hint3(chat3, "src/math.ts").includes("still present in changed code")) {
    three.push(`hint "${hint3(chat3, "src/math.ts")}"`);
  }
  if (!same(sentFiles(chat3), ["src/math.ts"])) three.push("DIFF files");
  if (!same(groups3["Still open"], ["src/math.ts:11"]) || groups3.New) {
    three.push(`groups ${JSON.stringify(groups3)}`);
  }
  if (
    !r3.cli.stdout.includes("Summary: 0 new · 1 open · 0 closed · 1 blocking")
  ) {
    three.push("summary line");
  }
  if (
    !same(carryPaths(r3), ["src/math.ts"]) ||
    r3.carry?.findings[0]?.lineFrom !== 11
  ) {
    three.push("record after round 3");
  }
  out.push(
    scriptedResult(
      sim,
      "round 3 re-checks a finding in a file skipped last round and follows it to its new line",
      three,
      "still open at src/math.ts:11, nothing reported twice",
      carryWhy,
    ),
  );

  const unreadable = runOf(sim, L.r3b);
  const warn: string[] = [];
  const warnScripted: string[] = [];
  if (
    !same(unreadable.json?.warnings, [
      {
        code: "carry_over_unavailable",
        message:
          "Could not read the local carry-over cache. Continuing without prior findings.",
      },
    ])
  )
    warn.push(`warnings ${JSON.stringify(unreadable.json?.warnings)}`);
  if (firstChat(unreadable).user.includes("PREVIOUS FINDINGS"))
    warn.push("carry text sent");
  if (unreadable.json?.ok !== true) warn.push("the review did not go on");
  if (unreadable.cli.exitCode !== 1 || summaryOf(unreadable).new !== 1)
    warnScripted.push("review did not go on with its one finding");
  if (unreadable.carry?.findings.length !== 1)
    warnScripted.push("the record was not rewritten");
  out.push(
    result(
      "an unreadable carry cache warns and the review goes on",
      warn,
      "carry_over_unavailable, no carry text, the review finished",
    ),
    scriptedResult(
      sim,
      "after an unreadable carry cache the review reports its finding and rewrites the record",
      warnScripted,
      "exit 1, 1 new finding, record rewritten",
      carryWhy,
    ),
  );

  const r4 = runOf(sim, L.r4);
  const rebuilt: string[] = [];
  const rebuiltScripted: string[] = [];
  if (r4.carryBefore?.findings.length !== 1)
    rebuiltScripted.push("no record to ignore");
  if (firstChat(r4).user.includes("PREVIOUS FINDINGS"))
    rebuilt.push("carry text sent");
  if (!same(summaryOf(r4), { new: 1, open: 0, closed: 0, blocking: 1 })) {
    rebuiltScripted.push(`summary ${JSON.stringify(summaryOf(r4))}`);
  }
  const was = (unreadable.json!.guide as { builtAt: string }).builtAt;
  const now = (r4.json!.guide as { builtAt: string }).builtAt;
  if (!(Date.parse(now) > Date.parse(was)))
    rebuilt.push(`guide built ${was} then ${now}`);
  out.push(
    result(
      "a guide rebuilt after the last review starts the next one fresh",
      rebuilt,
      "no carry text, new guide date",
    ),
    scriptedResult(
      sim,
      "after the rebuild the old record is ignored and the finding is new",
      rebuiltScripted,
      "record ignored, 1 new finding",
      carryWhy,
    ),
  );

  const closed: string[] = [];
  const groups5 = humanGroups(r5.cli.stdout);
  if (
    !same(groups5.Closed, ["src/math.ts:11"]) ||
    groups5.New ||
    groups5["Still open"]
  ) {
    closed.push(`groups ${JSON.stringify(groups5)}`);
  }
  if (
    !r5.cli.stdout.includes("Summary: 0 new · 0 open · 1 closed · 0 blocking")
  ) {
    closed.push("summary line");
  }
  if (r5.cli.exitCode !== 0) closed.push(`exit ${r5.cli.exitCode}`);
  if (r5.carry === null || r5.carry.findings.length !== 0)
    closed.push("the record still holds findings");
  out.push(
    scriptedResult(
      sim,
      "round 5: the fixed finding is closed, the exit code is 0 and the record is empty",
      closed,
      "1 closed, 0 blocking, no findings stored",
      carryWhy,
    ),
  );
  return out;
}

function hint3(chat: Chat, path: string): string {
  return carryEntries(chat.user).find((item) => item.path === path)?.hint ?? "";
}

function safetyChecks(sim: Sim): CheckResult[] {
  const runs = [...localState(sim).runs.values()];
  const online = runs.filter(
    (run) => run.githubCalls > 0 || run.githubWrites > 0,
  );
  const moved = runs.filter((run) => !same(run.before, run.after));
  const writers = runs.flatMap((run) =>
    run.git
      .map(gitSubcommand)
      .filter((name) => WRITING_GIT.has(name))
      .map((name) => `${run.label}: ${name}`),
  );
  const baseRun = runOf(sim, edgeLabel("base branch that does not exist"));
  const unexpected = writers.filter(
    (line) => line !== `${baseRun.label}: fetch`,
  );
  const fetched = baseRun.git.map(gitSubcommand).includes("fetch");
  return [
    check(
      "no GitHub call and no GitHub write in any local review",
      online.length === 0,
      online.length
        ? online
            .map(
              (run) =>
                `${run.label}: ${run.githubCalls} calls, ${run.githubWrites} writes`,
            )
            .join(", ")
        : `${runs.length} runs`,
    ),
    check(
      "a review leaves the branch, the commit and the working tree as they were",
      moved.length === 0,
      moved.length
        ? moved.map((run) => run.label).join(", ")
        : `${runs.length} runs`,
    ),
    check(
      "a review runs only read-only git commands, and fetches only for a base it cannot find",
      unexpected.length === 0 && fetched,
      unexpected.length
        ? unexpected.join(", ")
        : `${runs.reduce((sum, run) => sum + run.git.length, 0)} commands, fetch only for origin/nope`,
    ),
  ];
}

function stopChecks(sim: Sim): CheckResult[] {
  const cleanH = runOf(sim, L.cleanH);
  const cleanJ = runOf(sim, L.cleanJ);
  const clean: string[] = [];
  if (cleanH.cli.stdout !== "No changes to review.\n")
    clean.push(`human ${JSON.stringify(cleanH.cli.stdout)}`);
  if (
    !same(cleanJ.json, {
      schemaVersion: 1,
      ok: true,
      mode: "local",
      message: "No changes to review.",
    })
  ) {
    clean.push(`json ${cleanJ.cli.stdout}`);
  }
  for (const run of [cleanH, cleanJ]) {
    if (run.cli.exitCode !== 0)
      clean.push(`${run.label} exit ${run.cli.exitCode}`);
    if (run.ai.length)
      clean.push(`${run.label} called the model ${run.ai.length} times`);
    if (run.carry !== null) clean.push(`${run.label} wrote a record`);
  }

  const ngH = runOf(sim, L.noGuidesH);
  const ngJ = runOf(sim, L.noGuidesJ);
  const guides: string[] = [];
  if (ngH.cli.exitCode !== 2) guides.push(`human exit ${ngH.cli.exitCode}`);
  if (!ngH.cli.stderr.includes("Review guides are missing for sim/unguided."))
    guides.push("human message");
  if (!ngH.cli.stderr.includes("Hint: co-maintainer init sim/unguided"))
    guides.push("human hint");
  if (ngH.cli.stdout !== "") guides.push("human stdout is not empty");
  if (
    !same(ngJ.json, {
      schemaVersion: 1,
      ok: false,
      error: {
        code: "not_initialized",
        message: "Review guides are missing for sim/unguided.",
        hint: "co-maintainer init sim/unguided",
      },
      exitCode: 2,
    })
  )
    guides.push(`json ${ngJ.cli.stdout}`);
  for (const run of [ngH, ngJ]) {
    if (run.ai.length || run.carry !== null)
      guides.push(`${run.label} used the model or wrote a record`);
  }

  const edges: string[] = [];
  for (const edge of EDGES) {
    const run = runOf(sim, edgeLabel(edge.name));
    const text = run.json ? JSON.stringify(run.json) : run.cli.stderr;
    const code = (run.json?.error as { code?: string } | undefined)?.code;
    if (run.cli.exitCode !== 2)
      edges.push(`${edge.name}: exit ${run.cli.exitCode}`);
    if (run.json && code !== edge.code)
      edges.push(`${edge.name}: code ${code}`);
    if (!run.json && edge.args.includes("--json"))
      edges.push(`${edge.name}: no JSON error`);
    if (!edge.match.test(text))
      edges.push(`${edge.name}: message ${text.slice(0, 120)}`);
    if (run.ai.length) edges.push(`${edge.name}: called the model`);
  }
  return [
    result(
      "a clean tree says so, exits 0 and does not call the model",
      clean,
      "human and json",
    ),
    result(
      "missing guides stop with not_initialized and exit 2",
      guides,
      "human stderr and json error, no model call",
    ),
    result(
      `${EDGES.length} usage and git-state errors exit 2 with their code`,
      edges,
      EDGES.map((edge) => edge.name).join(", "),
    ),
  ];
}

async function failureChecks(sim: Sim): Promise<CheckResult[]> {
  const failed = runOf(sim, L.failure);
  const problems: string[] = [];
  const error = failed.json?.error as
    | { code?: string; message?: string }
    | undefined;
  if (failed.cli.exitCode !== 3) problems.push(`exit ${failed.cli.exitCode}`);
  if (failed.json?.ok !== false || !error?.message?.includes("500")) {
    problems.push(`stdout ${failed.cli.stdout}`);
  }
  if (failed.carry !== null) problems.push("a record was written");
  const locks = await reviewLocks();
  const all = [...localState(sim).runs.values()];
  return [
    result(
      "a provider failure exits 3 with a JSON error and no record",
      problems,
      "exit 3, openrouter 500 named",
    ),
    check(
      "no review leaves its lock file behind",
      locks.length === 0 && all.length > 0,
      locks.length
        ? locks.join(", ")
        : `${all.length} reviews, lock directory empty`,
    ),
  ];
}

async function toolChecks(sim: Sim): Promise<CheckResult[]> {
  const run = runOf(sim, L.tools);
  const chats = reviewChat(run);
  const [first, second] = chats;
  const problems: string[] = [];
  if (chats.length !== 2) problems.push(`${chats.length} requests`);
  if (!same(first?.tools, ["read-mermaid-syntaxes"]))
    problems.push(`offered ${JSON.stringify(first?.tools)}`);
  if (first?.answerToolCalls.length !== 2)
    problems.push("the first answer asked for 2 tool calls");
  const { readMermaidSyntaxes } = await import("../../../ai/mermaid.ts");
  const docs = readMermaidSyntaxes({ tools: ["flowchart"] }, 1);
  if (second?.toolResults[0] !== docs)
    problems.push("the flowchart docs were not sent back as read");
  if (
    second?.toolResults[1] !== "Tool error: unsupported Mermaid syntax: gantt"
  ) {
    problems.push(`second result ${JSON.stringify(second?.toolResults[1])}`);
  }
  if (second?.system !== first?.system || second?.user !== first?.user) {
    problems.push("system or user prompt changed between rounds");
  }
  if (!second?.tools.length) problems.push("round 2 offered no tools");
  const reported = jsonFindings(run);
  if (!same(reported.map(keyOf), ["src/pipeline.ts:3-3:P2:false"])) {
    problems.push(`findings ${JSON.stringify(reported.map(keyOf))}`);
  }
  const usage = run.json?.usage as { tokensIn?: number } | undefined;
  const sent = run.completions.reduce((sum, item) => sum + item.tokensIn, 0);
  if (usage?.tokensIn !== sent)
    problems.push(`usage ${usage?.tokensIn} vs ${sent} tokens`);
  const logged = sim.trace.logs.some(
    (line) =>
      line.phase === "review-tools" && line.message.includes("round 1/"),
  );
  if (!logged) problems.push("no review-tools log line for round 1");
  // Whatever rounds the model took, the prompt stays one and the usage adds up.
  const prompt = chats.every(
    (chat) => chat.system === first?.system && chat.user === first?.user,
  );
  const any: string[] = [];
  if (chats.length === 0) any.push("no review request");
  if (!prompt) any.push("system or user prompt changed between rounds");
  if (usage?.tokensIn !== sent)
    any.push(`usage ${usage?.tokensIn} vs ${sent} tokens`);
  return [
    scriptedResult(
      sim,
      "a tool round: the product runs the tools, answers the model and keeps one prompt",
      problems,
      "2 requests, flowchart docs and a tool error sent back, 1 finding",
      "a real model may answer without calling the tools",
    ),
    result(
      "the tool step keeps one prompt across its requests and its usage adds up",
      any,
      `${chats.length} requests, one system prompt and one first message`,
    ),
  ];
}

function proseChecks(sim: Sim): CheckResult[] {
  const run = runOf(sim, L.prose);
  const problems: string[] = [];
  const jobs = run.ai.map((call) => call.job);
  if (
    jobs.length !== 2 ||
    jobs[0] !== "review_local" ||
    !String(jobs[1]).endsWith("_retry")
  ) {
    problems.push(`jobs ${JSON.stringify(jobs)}`);
  }
  const retry = run.ai[1] ? chatOf(run.ai[1]) : undefined;
  if (
    !retry?.user.endsWith(
      "The previous answer was not valid JSON. Return only the JSON object described above, with no prose and no code fence.",
    )
  ) {
    problems.push("the retry does not carry the reminder");
  }
  if (!same(jsonFindings(run).map(keyOf), ["src/prose.ts:2-2:P3:false"])) {
    problems.push(`findings ${JSON.stringify(jsonFindings(run).map(keyOf))}`);
  }
  return [
    scriptedResult(
      sim,
      "an answer that is not JSON is asked for again once",
      problems,
      "prose, then one retry with the reminder, 1 finding",
      "a real model answers in JSON, so there is no retry to see",
    ),
  ];
}

async function costChecks(sim: Sim): Promise<CheckResult[]> {
  const rows = existsSync(sim.paths.cacheDb)
    ? (() => {
        const database = new DatabaseSync(sim.paths.cacheDb, {
          readOnly: true,
        });
        try {
          return (
            database
              .prepare(
                "SELECT cache_key, value FROM cache WHERE namespace = 'cost'",
              )
              .all() as { cache_key: string; value: string }[]
          )
            .filter((row) => row.cache_key.startsWith(`${LOCAL_REPO}:`))
            .map(
              (row) =>
                JSON.parse(row.value) as { job: string; tokensIn: number },
            );
        } finally {
          database.close();
        }
      })()
    : [];
  const mine = rows.filter((row) => row.job === "review_local");
  // One usage record per conversation: tool rounds are merged into one.
  const conversations = [...localState(sim).runs.values()].reduce(
    (sum, run) =>
      sum +
      run.completions.filter(
        (item) =>
          item.ok && item.toolCalls === 0 && item.job.startsWith("review"),
      ).length,
    0,
  );
  return [
    check(
      "every answered review conversation has one review_local cost record",
      mine.length === conversations,
      `${mine.length} records, ${conversations} conversations`,
    ),
  ];
}

async function localChecks(sim: Sim): Promise<CheckResult[]> {
  return [
    ...round1Checks(sim),
    ...jsonChecks(sim),
    ...githubChecks(sim),
    ...exitChecks(sim),
    ...carryChecks(sim),
    ...safetyChecks(sim),
    ...stopChecks(sim),
    ...(await failureChecks(sim)),
    ...(await toolChecks(sim)),
    ...proseChecks(sim),
    ...(await costChecks(sim)),
  ];
}

// -------------------------------------------------------------------- scores

/** What would move with a real model. Not a measurement on the fake AI. */
function localScores(sim: Sim): Score[] {
  const fakeAi = sim.mode === "fake";
  const r1 = runOf(sim, L.r1j);
  const r2 = runOf(sim, L.r2);
  const r3 = runOf(sim, L.r3);
  const r5 = runOf(sim, L.r5);
  const stateOf = (run: ReviewRun, path: string): string => {
    const found = jsonFindings(run).find((item) => item.path === path);
    if (found) return String(found.state);
    const groups = humanGroups(run.cli.stdout);
    return (
      Object.entries(groups).find(([, list]) =>
        list.some((item) => item.startsWith(`${path}:`)),
      )?.[0] ?? "none"
    );
  };
  const verdicts: [string, string, string][] = [
    ["round 2 math.ts", stateOf(r2, "src/math.ts"), "open"],
    ["round 2 stats.ts", stateOf(r2, "src/stats.ts"), "closed"],
    ["round 3 math.ts", stateOf(r3, "src/math.ts"), "Still open"],
    ["round 5 math.ts", stateOf(r5, "src/math.ts"), "Closed"],
  ];
  const right = verdicts.filter(([, got, want]) => got === want).length;
  // The diff section only: the carry section adds text, the unchanged files
  // leave it, and only the second is the saving carry-over exists for.
  const diffChars = (run: ReviewRun) =>
    (firstChat(run).user.split("\nDIFF:\n")[1] ?? "").length;
  const full = diffChars(r1);
  const part = diffChars(r2);
  const prompts = [r1, r2, r3].map(diffChars);
  return [
    {
      name: "carry-over verdicts as expected",
      value: right / verdicts.length,
      detail: `${right} of ${verdicts.length}: ${verdicts.map(([name, got]) => `${name} ${got}`).join(", ")}`,
      fakeAi,
    },
    {
      name: "round 2 diff sent against round 1",
      value: part / full,
      detail: `${part} chars against ${full}, rounds 1 to 3: ${prompts.join(", ")}`,
      fakeAi,
    },
    {
      name: "findings per review",
      value: jsonFindings(r1).length,
      detail: `round 1 reported ${jsonFindings(r1).length}`,
      fakeAi,
    },
  ];
}

export default defineFlow({
  name: "local",
  description:
    "local review in a checkout: two rounds with carry-over, three outputs, edges and a tool round",
  ai: LOCAL_AI,
  steps,
  checks: localChecks,
  scores: localScores,
});
