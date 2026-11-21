/** `search-non-code` and the review tool gate (issue 79).
 *
 * A change renames nothing in the docs, so only a search of the docs can show
 * the paragraph it makes false. The flow runs local review, CLI pull request
 * review, an App review and remote review of the same change, with an
 * untracked `.env` beside it, and reads what the model was offered and what
 * each search answered from the trace. A last local review runs under a tool
 * budget of 10 characters.
 *
 * The checks hold whatever a model does: what the product offered and said,
 * what a search answered when the model asked for one, and `usage.tools`
 * against the tool calls in the trace. What the scripted model does, a
 * search in every mode and two in the budget review, is checked with
 * `scriptedCheck`. */
import { finding } from "../fake_ai.ts";
import type { AiRule } from "../fake_ai.ts";
import {
  check,
  type CheckResult,
  type CliRun,
  defineFlow,
  scriptedCheck,
  type Sim,
  type Step,
} from "../flow.ts";
import type { AiCall } from "../trace.ts";
import { SAMPLE_REPO } from "../sample_repo.ts";
import { INIT_AI } from "./init.ts";
import { aiFlags } from "./cli_pr.ts";
import {
  chatOf,
  checkoutStep,
  configureCli,
  localState,
  NO_CODEGRAPH,
  type ReviewRun,
  runReview,
} from "./local.ts";
import { clientChange, runRemoteReview } from "./remote.ts";
import {
  type Checkout as RemoteCheckout,
  installCodegraphStandIn,
  remoteWire,
} from "./remote_support.ts";

type Json = Record<string, unknown>;

const REPO = "sim/search";
const TOOL = "search-non-code";
/** The sentence the review prompt carries next to codegraph, written here
 * rather than imported, so a change to it fails a check. */
const GUIDANCE =
  "Use search-non-code for docs, configuration and other files codegraph does not index. Use codegraph for code.";
const DOC_LINE = "Routes without an entry in RATE_LIMIT are not limited.";
/** Text only the untracked file holds. No search may ever answer it. */
const UNTRACKED = "RATE_LIMIT_UNTRACKED_VALUE";
/** Text only a code file holds. Codegraph covers code, so search never
 * answers it. */
const CODE_ONLY = "RATE_LIMIT_CODE_VALUE";

const FILES: Record<string, string> = {
  ...SAMPLE_REPO,
  "docs/operations.md": `# Operations\n\n${DOC_LINE}\n`,
  "deploy/compose.yml":
    'services:\n  api:\n    environment:\n      RATE_LIMIT: "60"\n',
  // punctuation: code, a fixture line of TypeScript source written to disk by the test
  "src/limits.ts": `export const RATE_LIMIT = 60; // ${CODE_ONLY}\n`,
};

/** The change: every route now has a limit, which the docs paragraph no
 * longer says. */
const CHANGE = {
  // punctuation: code, a fixture line of TypeScript source written to disk by the test
  "src/limits.ts": `export const RATE_LIMIT = 60; // ${CODE_ONLY}\nexport const LIMIT_ALL_ROUTES = true;\n`,
};

const STEP = {
  guides: "repository with guides",
  local: "local review",
  pr: "pull request review",
  app: "App review",
  remote: "remote review without codegraph",
  budget: "local review under a tool budget",
} as const;

const REVIEW_JOB = /^review_(local|pull_request)$/;

/** The reviewer searches the docs once, then answers. */
const SEARCH_RULE: AiRule = {
  name: "reviewer searches the docs for RATE_LIMIT",
  job: REVIEW_JOB,
  prompt: "LIMIT_ALL_ROUTES",
  reply: ({ round }) =>
    round === 0
      ? { toolCalls: [{ name: TOOL, arguments: { pattern: "RATE_LIMIT" } }] }
      : {
          findings: [
            finding({
              path: "src/limits.ts",
              line: 2,
              title: "The docs still say some routes are not limited",
              body: "docs/operations.md says routes without a RATE_LIMIT entry are not limited, which this change makes false.",
              severity: "P3",
            }),
          ],
        },
};

/** The budget review: two searches in one round, then an answer. */
const BUDGET_RULE: AiRule = {
  name: "reviewer searches twice under a small budget",
  job: "review_local",
  prompt: "LIMIT_ALL_ROUTES",
  times: 2,
  reply: ({ round }) =>
    round === 0
      ? {
          toolCalls: [
            { name: TOOL, arguments: { pattern: "RATE_LIMIT" } },
            { name: TOOL, arguments: { pattern: "services" } },
          ],
        }
      : { findings: [] },
};

type State = {
  runs: Map<string, CliRun | ReviewRun>;
  json: Map<string, Json | undefined>;
  remote?: RemoteCheckout;
  token?: string;
};

function state(sim: Sim): State {
  return (sim.state.search ??= {
    runs: new Map(),
    json: new Map(),
  }) as State;
}

function lastJson(stdout: string): Json | undefined {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    return JSON.parse(line) as Json;
  } catch {
    return undefined;
  }
}

const steps: Step[] = [
  {
    name: STEP.guides,
    async run(sim) {
      sim.repo(REPO, FILES);
      configureCli(sim);
      const { runInitOrRemake } = await import("../../../services/setup.ts");
      await runInitOrRemake(sim.options({ command: "init", repo: REPO }));
      return `${REPO} · guides written by init`;
    },
  },
  checkoutStep("local", {
    repo: REPO,
    branch: "feature/limits",
    committed: CHANGE,
    untracked: { ".env": `RATE_LIMIT=${UNTRACKED}\n` },
  }),
  {
    name: STEP.local,
    async run(sim) {
      const run = await runReview(
        sim,
        localState(sim).checkouts.get("local")!,
        STEP.local,
        ["--json", NO_CODEGRAPH, "--fresh"],
      );
      state(sim).runs.set(STEP.local, run);
      state(sim).json.set(STEP.local, run.json);
      return `exit ${run.cli.exitCode}`;
    },
  },
  {
    name: STEP.pr,
    async run(sim) {
      const pull = sim.github.openPull(REPO, {
        title: "Limit every route",
        body: "Every route gets a rate limit.",
        files: CHANGE,
      });
      const run = await sim.cli([
        "review",
        REPO,
        String(pull.number),
        ...aiFlags(sim),
        "--json",
        NO_CODEGRAPH,
        "--fresh",
      ]);
      state(sim).runs.set(STEP.pr, run);
      state(sim).json.set(STEP.pr, lastJson(run.stdout));
      return `#${pull.number} · exit ${run.exitCode}`;
    },
  },
  {
    name: STEP.app,
    async run(sim) {
      await sim.server.start();
      const { updateRepoSettings } = await import("../../../store/repos.ts");
      updateRepoSettings(REPO, { auto_review: 1 });
      const pull = sim.github.openPull(REPO, {
        title: "Limit every route again",
        body: "Every route gets a rate limit.",
        files: CHANGE,
      });
      await sim.server.deliver(
        "pull_request",
        sim.server.payloads.pullRequest(pull, "opened"),
      );
      await sim.server.runJobs();
      return `#${pull.number}`;
    },
  },
  {
    name: STEP.remote,
    async run(sim) {
      const s = state(sim);
      s.token = await sim.server.remoteToken("client");
      await installCodegraphStandIn(sim);
      remoteWire(sim);
      s.remote = clientChange(
        sim,
        "search",
        "feature/remote-limits",
        CHANGE,
        REPO,
      );
      s.remote.write({ ".env": `RATE_LIMIT=${UNTRACKED}\n` });
      // Codegraph off on the client: it offers search alone.
      const run = await runRemoteReview(sim, s.remote, [
        `--remote-token=${s.token}`,
        "--json",
        "--fresh",
        NO_CODEGRAPH,
      ]);
      s.runs.set(STEP.remote, run);
      s.json.set(STEP.remote, run.json);
      return `exit ${run.exitCode}`;
    },
  },
  {
    name: STEP.budget,
    async run(sim) {
      sim.ai.use(BUDGET_RULE);
      await sim.cli(["set", `--repo=${REPO}`, "--review-tool-budget-chars=10"]);
      try {
        const run = await runReview(
          sim,
          localState(sim).checkouts.get("local")!,
          STEP.budget,
          ["--json", NO_CODEGRAPH, "--fresh"],
        );
        state(sim).runs.set(STEP.budget, run);
        state(sim).json.set(STEP.budget, run.json);
        return `exit ${run.cli.exitCode}`;
      } finally {
        await sim.cli([
          "set",
          `--repo=${REPO}`,
          "--unset=review-tool-budget-chars",
        ]);
      }
    },
  },
];

// ----------------------------------------------------------------------- checks

/** The review requests a step made, server side ones included. */
function reviewCalls(sim: Sim, step: string): AiCall[] {
  return sim.trace.ai.filter(
    (call) => call.step === step && REVIEW_JOB.test(call.job ?? ""),
  );
}

type Message = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id?: string; function?: { name?: string } }[];
};

/** Every search answer the model received in a step, from the requests:
 * each tool message tied to the call that asked for it. */
function searchAnswers(sim: Sim, step: string): string[] {
  const out = new Set<string>();
  for (const call of reviewCalls(sim, step)) {
    const messages = ((call.request as Json | null)?.messages ??
      []) as Message[];
    const names = new Map<string, string>();
    for (const message of messages) {
      for (const tool of message.tool_calls ?? []) {
        if (tool.id) names.set(tool.id, tool.function?.name ?? "");
      }
    }
    for (const message of messages) {
      if (message.role !== "tool") continue;
      if (names.get(message.tool_call_id ?? "") !== TOOL) continue;
      out.add(`${message.tool_call_id}\0${String(message.content ?? "")}`);
    }
  }
  return [...out].map((item) => item.slice(item.indexOf("\0") + 1));
}

/** Tool calls the model asked for in a step. */
const askedCalls = (sim: Sim, step: string): number =>
  reviewCalls(sim, step).reduce(
    (sum, call) => sum + chatOf(call).answerToolCalls.length,
    0,
  );

/** The offered search tool's parameter names, per review request. */
function offeredParameters(call: AiCall): string[] | undefined {
  const tools = ((call.request as Json | null)?.tools ?? []) as {
    function?: { name?: string; parameters?: { properties?: Json } };
  }[];
  const tool = tools.find((item) => item.function?.name === TOOL);
  return tool
    ? Object.keys(tool.function?.parameters?.properties ?? {}).sort()
    : undefined;
}

/** True for the request that asks for an answer once the tool rounds are
 * spent: its last message says no more tool calls are available. */
function afterBudget(call: AiCall): boolean {
  const messages = ((call.request as Json | null)?.messages ?? []) as {
    role?: string;
    content?: unknown;
  }[];
  const last = messages.at(-1);
  return (
    last?.role === "user" &&
    typeof last.content === "string" &&
    last.content.startsWith("No more tool calls are available.")
  );
}

const MODES = [STEP.local, STEP.pr, STEP.app, STEP.remote] as const;
const JSON_MODES = [STEP.local, STEP.pr, STEP.remote] as const;

function offerChecks(sim: Sim): CheckResult[] {
  const missing: string[] = [];
  const unsaid: string[] = [];
  for (const step of MODES) {
    const calls = reviewCalls(sim, step);
    if (calls.length === 0) missing.push(`${step}: no review request`);
    for (const call of calls) {
      // The answer asked for after the tool round budget is spent offers no
      // tools on purpose. Only a live model runs out of rounds.
      if (afterBudget(call)) continue;
      const params = offeredParameters(call);
      if (JSON.stringify(params) !== '["context","path","pattern","regex"]') {
        missing.push(`${step}: ${JSON.stringify(params)}`);
      }
      if (!chatOf(call).user.includes(GUIDANCE)) unsaid.push(step);
    }
  }
  return [
    check(
      "every mode offers search-non-code with its four parameters",
      missing.length === 0,
      missing.join(" · ") ||
        "local, CLI pull request, App and remote: pattern, regex, path, context",
    ),
    check(
      "the review prompt names search-non-code next to codegraph",
      unsaid.length === 0,
      unsaid.length
        ? `missing in ${[...new Set(unsaid)].join(", ")}`
        : GUIDANCE,
    ),
  ];
}

function answerChecks(sim: Sim): CheckResult[] {
  const leaked: string[] = [];
  const reached: string[] = [];
  for (const step of [...MODES, STEP.budget]) {
    for (const answer of searchAnswers(sim, step)) {
      if (answer.includes(UNTRACKED))
        leaked.push(`${step}: the untracked .env`);
      if (answer.includes(CODE_ONLY) || /\.ts[:-]\d/.test(answer)) {
        leaked.push(`${step}: a code file`);
      }
      if (answer.includes(DOC_LINE)) reached.push(step);
    }
  }
  const searched = MODES.filter((step) => searchAnswers(sim, step).length > 0);
  return [
    check(
      "no search answer holds an untracked file or a code file",
      leaked.length === 0,
      leaked.join(" · ") ||
        `${MODES.map((step) => searchAnswers(sim, step).length).join("+")} answers, none from .env or src/*.ts`,
    ),
    scriptedCheck(
      sim,
      "the search reached the model with the docs line in every mode",
      MODES.every((step) => reached.includes(step)),
      `searched in ${searched.join(", ") || "no mode"}, docs line in ${[...new Set(reached)].join(", ") || "none"}`,
      "whether and what the model searches is the model's",
    ),
  ];
}

function usageChecks(sim: Sim): CheckResult[] {
  const wrong: string[] = [];
  for (const step of [...JSON_MODES, STEP.budget]) {
    const tools = ((state(sim).json.get(step)?.usage as Json | undefined)
      ?.tools ?? undefined) as Json | undefined;
    if (!tools) {
      wrong.push(`${step}: no usage.tools`);
      continue;
    }
    const asked = askedCalls(sim, step);
    if (tools.calls !== asked) {
      wrong.push(
        `${step}: calls ${String(tools.calls)}, the model asked ${asked}`,
      );
    }
    const byTool = (tools.byTool ?? {}) as Record<string, number>;
    const sum = Object.values(byTool).reduce((a, b) => a + b, 0);
    if (
      sum !== asked ||
      typeof tools.rounds !== "number" ||
      typeof tools.resultChars !== "number" ||
      typeof tools.budgetSpent !== "boolean"
    ) {
      wrong.push(`${step}: ${JSON.stringify(tools)}`);
    }
  }
  const codegraph = JSON_MODES.map(
    (step) =>
      `${step}: ${String(((state(sim).json.get(step)?.codegraph ?? {}) as Json).state)}`,
  );
  return [
    check(
      "usage.tools in every mode's JSON counts the tool calls the model made",
      wrong.length === 0,
      wrong.join(" · ") || "local, CLI pull request, remote and the budget run",
    ),
    check(
      "search alone never turns codegraph on",
      codegraph.every((line) => line.endsWith(": disabled")),
      codegraph.join(", "),
    ),
  ];
}

function budgetChecks(sim: Sim): CheckResult[] {
  const json = state(sim).json.get(STEP.budget);
  const warnings = ((json?.warnings ?? []) as Json[]).map((w) => w.code);
  const answers = searchAnswers(sim, STEP.budget);
  const tools = (json?.usage as Json | undefined)?.tools as Json | undefined;
  return [
    scriptedCheck(
      sim,
      "a spent tool budget answers the next call with the fixed text and warns",
      // Ten characters leave no room for the cut notice: the first answer
      // is only cut to the budget.
      (answers[0]?.length ?? Infinity) <= 10 &&
        answers.includes("Tool budget spent. Answer with what you found.") &&
        warnings.includes("tool_budget_spent") &&
        tools?.budgetSpent === true,
      `answers ${JSON.stringify(answers)} · warnings ${warnings.join(", ") || "none"}`,
      "the two searches are the model's",
    ),
  ];
}

export default defineFlow({
  name: "search-non-code",
  description:
    "search-non-code in local, CLI pull request, App and remote review, never an untracked or code file, and the tool budget",
  ai: [...INIT_AI, SEARCH_RULE],
  skipInherited: {
    "cost recorded for every AI call":
      "this flow runs an App review, whose tokens only the reviews table holds, and a remote review, whose tokens both the cost rows and the reviews table hold, so neither total the check compares can match. The app and remote flows keep the check",
  },
  steps,
  checks: (sim) => [
    ...offerChecks(sim),
    ...answerChecks(sim),
    ...usageChecks(sim),
    ...budgetChecks(sim),
  ],
});
