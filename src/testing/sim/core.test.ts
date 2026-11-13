/** The simulation core end to end, through throwaway flows that live only
 * here: an App review driven by a signed webhook, a CLI review over the `gh`
 * stand-in, the remote server answered in process, faults, and how the
 * runner treats steps and inherited checks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { finding } from "./fake_ai.ts";
import {
  type Flow,
  type FlowResult,
  type Printer,
  type RunSettings,
  runFlow,
  type Sim,
} from "./flow.ts";
import { INIT_AI } from "./flows/init.ts";
import { SAMPLE_REPO_NAME } from "./sample_repo.ts";

const quiet: Printer = { step() {}, check() {}, score() {} };

function settings(): RunSettings {
  return {
    mode: "fake",
    provider: "openrouter",
    lowModel: "simulate/low",
    highModel: "simulate/high",
    origin: performance.now(),
  };
}

const run = (flow: Flow) => runFlow(flow, settings(), quiet);

function checkNamed(result: FlowResult, name: string) {
  const found = result.checks.find((check) => check.name === name);
  assert.ok(found, `no check named ${name}`);
  return found;
}

function failures(result: FlowResult): string {
  return JSON.stringify(
    {
      steps: result.steps.filter((step) => !step.ok),
      checks: result.checks.filter((check) => !check.ok),
    },
    null,
    2,
  );
}

const initStep = {
  name: "init",
  async run(sim: Sim) {
    sim.repo(SAMPLE_REPO_NAME);
    const { runInitOrRemake } = await import("../../services/setup.ts");
    await runInitOrRemake(
      sim.options({ command: "init", repo: SAMPLE_REPO_NAME }),
    );
  },
};

const REVIEW_FINDING = finding({
  path: "src/math.ts",
  line: 2,
  title: "The sum ignores its second argument",
  severity: "P1",
  blocking: true,
});

test("an opened pull request reaches the App review through a signed webhook", async () => {
  const flow: Flow = {
    name: "app-review-fixture",
    description: "test fixture",
    ai: [
      ...INIT_AI,
      {
        name: "review",
        job: "review_pull_request",
        reply: [
          {
            toolCalls: [
              {
                name: "read-mermaid-syntaxes",
                arguments: { tools: ["flowchart"] },
              },
            ],
          },
          { findings: [REVIEW_FINDING] },
        ],
      },
    ],
    steps: [
      initStep,
      {
        name: "serve",
        async run(sim) {
          await sim.server.start();
          const { updateRepoSettings } = await import("../../store/repos.ts");
          updateRepoSettings(SAMPLE_REPO_NAME, { auto_review: 1 });
        },
      },
      {
        name: "pull request opened",
        async run(sim) {
          const pull = sim.github.openPull(SAMPLE_REPO_NAME, {
            title: "Change add",
            files: {
              "src/math.ts":
                "export function add(a: number, b: number): number {\n  return a;\n}\n",
            },
          });
          sim.state.pull = pull;
          const delivery = await sim.server.deliver(
            "pull_request",
            sim.server.payloads.pullRequest(pull, "opened"),
          );
          sim.state.delivery = delivery;
          const jobs = await sim.server.runJobs();
          sim.state.jobs = jobs;
        },
      },
    ],
    checks(sim) {
      const writes = sim.github.writes.map(
        (write) => `${write.method} ${write.path}`,
      );
      return [
        {
          name: "webhook queued a review",
          ok:
            (sim.state.delivery as { body: { outcome: string } }).body
              .outcome === "enqueued",
          detail: JSON.stringify(sim.state.delivery),
        },
        {
          name: "review job done",
          ok: (sim.state.jobs as { status: string }[]).some(
            (job) => job.status === "done",
          ),
          detail: JSON.stringify(sim.trace.jobs),
        },
        {
          name: "check run created and finished",
          ok:
            writes.includes("POST repos/sim/sample/check-runs") &&
            sim.github.checkRuns.every((run) => run.status === "completed"),
          detail: writes.join(", "),
        },
        {
          name: "finding posted on the line",
          ok: sim.github.comments.some(
            (comment) =>
              comment.kind === "review" &&
              comment.path === "src/math.ts" &&
              comment.user.type === "Bot",
          ),
          detail: writes.join(", "),
        },
      ];
    },
  };
  const result = await run(flow);
  assert.ok(result.passed, failures(result));
  const trace = result.trace as {
    webhooks: unknown[];
    completions: { job: string; toolCalls: number }[];
  };
  assert.equal(trace.webhooks.length, 1);
  const review = trace.completions.filter(
    (call) => call.job === "review_pull_request",
  );
  assert.equal(review.length, 2, "one tool round, then the answer");
  assert.equal(review[0]!.toolCalls, 1);
  const rounds = result.scores.find(
    (score) => score.name === "tool rounds per job",
  );
  assert.equal(rounds?.value, 1);
});

test("CLI review of a pull request reads GitHub through the gh stand-in", async () => {
  const flow: Flow = {
    name: "cli-review-fixture",
    description: "test fixture",
    ai: [
      ...INIT_AI,
      {
        name: "review",
        job: "review_pull_request",
        reply: { findings: [REVIEW_FINDING] },
      },
    ],
    steps: [
      initStep,
      {
        name: "review",
        async run(sim) {
          sim.github.openPull(SAMPLE_REPO_NAME, {
            title: "Change add",
            files: { "src/math.ts": "export const add = (a: number) => a;\n" },
          });
          const cli = await sim.cli([
            "review",
            SAMPLE_REPO_NAME,
            "1",
            "--auth=gh",
            "--ai=openrouter",
            `--token=${sim.world.secrets.aiKey}`,
            "--low-model=simulate/low",
            "--high-model=simulate/high",
            "--disable-codegraph",
            "--json",
          ]);
          sim.state.cli = cli;
          // A blocking finding exits 1, which is what this review found.
          if (cli.exitCode !== 1) {
            throw new Error(`exit ${cli.exitCode}: ${cli.stderr}${cli.stdout}`);
          }
        },
      },
    ],
    checks(sim) {
      const viaGh = sim.trace.github.filter((call) => call.via === "gh");
      const cli = sim.state.cli as { stdout: string };
      return [
        {
          name: "GitHub reached through gh",
          ok: viaGh.length > 0,
          detail: `${viaGh.length} calls`,
        },
        {
          name: "review JSON printed",
          ok: cli.stdout.includes("The sum ignores its second argument"),
          detail: cli.stdout.slice(0, 300),
        },
      ];
    },
  };
  const result = await run(flow);
  assert.ok(result.passed, failures(result));
});

test("the remote server's routes answer at REMOTE_URL, traced on their own", async () => {
  const flow: Flow = {
    name: "remote-fixture",
    description: "test fixture",
    steps: [
      {
        name: "handshake",
        async run(sim) {
          await sim.server.start();
          const token = await sim.server.remoteToken();
          const url = `${sim.server.remoteUrl}/api/remote/guides?repo=sim/none`;
          const without = await fetch(url);
          const withToken = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
          });
          sim.state.statuses = [without.status, withToken.status];
        },
      },
    ],
    checks(sim) {
      const statuses = sim.state.statuses as number[];
      return [
        {
          // Past the token, the repository is unknown: the real route's 404.
          name: "no token is refused, a token is let in",
          ok: statuses[0] === 401 && statuses[1] === 404,
          detail: statuses.join(", "),
        },
        {
          name: "both calls traced as remote calls",
          ok: sim.trace.remote.length === 2,
          detail: `${sim.trace.remote.length}`,
        },
      ];
    },
  };
  const result = await run(flow);
  assert.ok(result.passed, failures(result));
  // The token is a secret now, and it was sent only in a header.
  assert.equal(
    checkNamed(result, "no secret in the trace, logs, files or GitHub").ok,
    true,
  );
});

test("a GitHub fault fails the next matching call once, then GitHub answers", async () => {
  const flow: Flow = {
    name: "fault-fixture",
    description: "test fixture",
    steps: [
      {
        name: "read",
        async run(sim) {
          sim.repo(SAMPLE_REPO_NAME);
          const { PatClient } = await import("../../github/pat.ts");
          const client = new PatClient(sim.world.secrets.pat);
          sim.faults.add({ target: "github", kind: "500", path: "/git/trees" });
          sim.faults.add({
            target: "github",
            kind: "rate-limit",
            path: "/contents/",
          });
          sim.faults.add({
            target: "github",
            kind: "slow",
            ms: 20,
            path: "/commits",
          });
          const statuses: string[] = [];
          for (const endpoint of [
            "repos/sim/sample/git/trees/main",
            "repos/sim/sample/git/trees/main",
            "repos/sim/sample/contents/README.md",
            "repos/sim/sample/commits",
          ]) {
            statuses.push(
              await client.request(endpoint).then(
                () => "ok",
                (error: Error) => error.message.slice(0, 14),
              ),
            );
          }
          sim.state.statuses = statuses;
        },
      },
    ],
    checks: (sim) => [
      {
        name: "500 once, rate limit retried, slow answered",
        ok:
          JSON.stringify(sim.state.statuses) ===
          JSON.stringify(["GitHub API 500", "ok", "ok", "ok"]),
        detail: JSON.stringify(sim.state.statuses),
      },
      {
        name: "the rate limited call was sent twice",
        ok:
          sim.trace.github.filter((call) => call.url.includes("/contents/"))
            .length === 2,
        detail: "",
      },
    ],
  };
  const result = await run(flow);
  assert.ok(result.passed, failures(result));
});

test("a fault that never happened fails the flow", async () => {
  const result = await run({
    name: "unused-fault-fixture",
    description: "test fixture",
    steps: [
      {
        name: "plan",
        run(sim) {
          sim.faults.add({ target: "ai", kind: "timeout", job: "never" });
        },
      },
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(checkNamed(result, "every planned fault happened").ok, false);
});

test("AI faults and scripted errors reach the product as its own errors", async () => {
  const result = await run({
    name: "ai-fault-fixture",
    description: "test fixture",
    ai: [
      { name: "cut", job: "cut", reply: { cutOff: "half an ans" } },
      { name: "limit", job: "limit", reply: { outputLimit: "" } },
      { name: "refused", job: "refused", reply: { error: 401 } },
      { name: "fine", job: "fine", reply: "fine" },
    ],
    steps: [
      {
        name: "calls",
        async run(sim) {
          const { OpenRouterProvider } = await import("../../ai/openrouter.ts");
          const provider = new OpenRouterProvider(
            sim.world.secrets.aiKey,
            "simulate/low",
          );
          sim.faults.add({ target: "ai", kind: "timeout", job: "fine" });
          const outcomes: string[] = [];
          for (const job of ["cut", "limit", "refused", "fine", "fine"]) {
            outcomes.push(
              await provider
                .complete({ job, prompt: "hi", maxTokens: 10 })
                .then(
                  (response) => `ok ${response.text}`,
                  (error: Error & { code?: string }) =>
                    error.code ?? error.message.split(" reached")[0]!,
                ),
            );
          }
          sim.state.outcomes = outcomes;
        },
      },
    ],
    checks: (sim) => [
      {
        name: "outcomes",
        ok:
          JSON.stringify(sim.state.outcomes) ===
          JSON.stringify([
            "connection_cut",
            "openrouter model simulate/low",
            "openrouter_unauthorized",
            "network_failed",
            "ok fine",
          ]),
        detail: JSON.stringify(sim.state.outcomes),
      },
    ],
    // The calls here are made by the test, not a product job that records
    // its cost.
    skipInherited: { "cost recorded for every AI call": "direct calls" },
  });
  assert.ok(result.passed, failures(result));
});

test("an AI call no rule answers fails the flow", async () => {
  const result = await run({
    name: "unscripted-fixture",
    description: "test fixture",
    steps: [
      {
        name: "call",
        expectError: true,
        async run(sim) {
          const { OpenRouterProvider } = await import("../../ai/openrouter.ts");
          await new OpenRouterProvider(sim.world.secrets.aiKey, "m").complete({
            job: "nobody_scripted_me",
            prompt: "hi",
            maxTokens: 10,
          });
        },
      },
    ],
  });
  const scripted = checkNamed(result, "every AI call scripted");
  assert.equal(scripted.ok, false);
  assert.match(scripted.detail, /nobody_scripted_me/);
  assert.equal(result.passed, false);
});

test("steps stop after an unexpected failure, and a skipped inherited check says why", async () => {
  const ran: string[] = [];
  const result = await run({
    name: "steps-fixture",
    description: "test fixture",
    steps: [
      {
        name: "meant to fail",
        expectError: true,
        run() {
          ran.push("first");
          throw new Error("on purpose");
        },
      },
      {
        name: "fails",
        run() {
          ran.push("second");
          throw new Error("not on purpose");
        },
      },
      {
        name: "never runs",
        run() {
          ran.push("third");
        },
      },
    ],
    skipInherited: { "every GitHub call answered": "not this flow's concern" },
  });
  assert.deepEqual(ran, ["first", "second"]);
  assert.deepEqual(
    result.steps.map((step) => `${step.name} ${step.ok}`),
    [
      "steps-fixture: sandbox ready true",
      "steps-fixture: meant to fail true",
      "steps-fixture: fails false",
      "steps-fixture: scores true",
    ],
  );
  const skipped = checkNamed(result, "every GitHub call answered");
  assert.equal(skipped.skipped, "not this flow's concern");
  assert.equal(result.passed, false);
});

test("a webhook signed with the wrong secret is refused by the real handler", async () => {
  const result = await run({
    name: "signature-fixture",
    description: "test fixture",
    steps: [
      {
        name: "deliver",
        async run(sim) {
          sim.repo(SAMPLE_REPO_NAME);
          await sim.server.start();
          const pull = sim.github.openPull(SAMPLE_REPO_NAME, {
            title: "t",
            files: { "x.txt": "x\n" },
          });
          const payload = sim.server.payloads.pullRequest(pull, "opened");
          await sim.server.deliver("pull_request", payload, {
            secret: "not-the-secret",
          });
          await sim.server.deliver("pull_request", payload);
        },
      },
    ],
  });
  assert.ok(result.passed, failures(result));
  const trace = result.trace as {
    webhooks: { status: number; response: { outcome?: string } }[];
  };
  assert.deepEqual(
    trace.webhooks.map((delivery) => delivery.status),
    [401, 200],
  );
  // No repository is active on this server, so the review is skipped.
  assert.equal(trace.webhooks[1]!.response.outcome, "skipped");
});

test("a GitHub route the simulation does not know fails the flow", async () => {
  const result = await run({
    name: "unknown-route-fixture",
    description: "test fixture",
    steps: [
      {
        name: "call",
        async run(sim) {
          sim.repo(SAMPLE_REPO_NAME);
          const response = await fetch(
            "https://api.github.com/repos/sim/sample/deployments",
          );
          return String(response.status);
        },
      },
    ],
  });
  assert.equal(result.steps[1]!.detail, "404");
  assert.equal(checkNamed(result, "every GitHub call answered").ok, false);
  assert.equal(result.passed, false);
});
