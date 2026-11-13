# Contributing

## A feature brings its e2e:simulate checks

A pull request that adds or changes a feature also adds that feature's flow
and checks to `npm run e2e:simulate`, in the same pull request.

- **Deterministic checks** are what the feature must always do. A failing one
  fails the run.
- **Scores** are what moves with the AI's answer. They measure co-maintainer,
  not the model's writing, and are only reported.

The simulation lives in `src/testing/sim/`, the entry point is
`scripts/e2e_simulate.ts`. CI runs it with the fake AI. With a real AI it costs
money:

```sh
npm run e2e:simulate
npm run e2e:simulate -- --flow=init
npm run e2e:simulate -- --ai=openrouter --ai-key=... --low-model=... --high-model=... --output=<dir>
```

`--flow=<name>` runs one flow. Repeat it or comma separate names for more.
A live run is paid, so run only the flow you changed.

### Adding a flow

A flow is one file in `src/testing/sim/flows/` and one line in
`src/testing/sim/flows/index.ts`. Each flow runs in its own sandbox with its
own simulated GitHub, so it never sees another flow's files.

```ts
import { finding } from "../fake_ai.ts";
import { check, defineFlow } from "../flow.ts";
import { INIT_AI } from "./init.ts";

export default defineFlow({
  name: "my-feature",
  description: "what the flow proves, in one sentence",
  ai: [
    ...INIT_AI,
    {
      job: "review_pull_request",
      reply: {
        findings: [finding({ path: "src/a.ts", line: 1, title: "Bug" })],
      },
    },
  ],
  steps: [
    {
      name: "init",
      async run(sim) {
        sim.repo("sim/sample");
        const { runInitOrRemake } = await import("../../../services/setup.ts");
        await runInitOrRemake(
          sim.options({ command: "init", repo: "sim/sample" }),
        );
      },
    },
    {
      name: "review on open",
      async run(sim) {
        await sim.server.start();
        const { updateRepoSettings } = await import("../../../store/repos.ts");
        updateRepoSettings("sim/sample", { auto_review: 1 });
        const pull = sim.github.openPull("sim/sample", {
          title: "Change add",
          files: { "src/a.ts": "export const a = 1;\n" },
        });
        await sim.server.deliver(
          "pull_request",
          sim.server.payloads.pullRequest(pull, "opened"),
        );
        await sim.server.runJobs();
      },
    },
  ],
  checks: (sim) => [
    check(
      "a review was posted",
      sim.github.writesTo(/\/reviews$/, "POST").length === 1,
    ),
  ],
});
```

- Import product code inside a step with `await import(...)`, never at the top
  of the file. The sandbox sets the environment first.
- `sim.github` is GitHub: open, push, force-push, merge and close pull
  requests, and read every write the product made in `sim.github.writes`.
- `sim.server` is `serve` without a port: `start()`, `deliver()` a signed
  webhook, `runJobs()`, and `remoteToken()` for the remote server at
  `sim.server.remoteUrl`.
- `sim.cli([...])` runs the CLI in this process. `gh` calls reach the same
  simulated GitHub.
- `ai` scripts the fake AI by job name or prompt text. A call no rule answers
  fails the run.
- `sim.faults.add(...)` makes the next matching GitHub, AI or remote call fail
  with a 404, a 500, a rate limit, a timeout or a slow answer.

Every flow also gets the inherited checks: no call left the simulation, every
GitHub and AI call was expected, no secret in the trace, logs, files or GitHub,
cost recorded for every AI call, one system prompt per conversation and every
planned fault happened. It also gets scores for AI calls, tokens, cost and tool
rounds per job. A flow can turn an inherited check off with `skipInherited`
and a reason, which the report shows.
