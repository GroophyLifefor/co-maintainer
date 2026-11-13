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

A flow is one file in `src/testing/sim/flows/` whose default export is a flow.
The registry loads every such file in name order, so a new flow needs no line
anywhere else. A helper file without a default flow is skipped. Flow names must
be unique. Each flow runs in its own sandbox with its own simulated GitHub, so
it never sees another flow's files.

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

Import the types with `import type { Sim, Step } from "../flow.ts"`. Import
product code inside a step with `await import(...)`, never at the top of the
file. The sandbox sets the environment first.

#### Steps

- Steps run in order. A step that throws fails, and the steps after it do not
  run. `expectError: true` makes a step pass only when it throws. What a step
  threw is in `sim.errors`, by step name.
- `sim.state` keeps a flow's own values from one step to the next.
- A step fails as timed out after 120 seconds. `timeoutMs` changes that.
- `--keep` keeps each flow's sandbox directory after the run.

#### GitHub

- `sim.repo(name, files)` creates a repository. `sim.world.checkout(name)`
  makes a working copy under the sandbox with an SSH `origin` the product reads
  as GitHub. No git process can reach a real host.
- `sim.github.openPull`, `push`, `forcePush`, `merge`, `close` and `reopen`
  drive a pull request. Each takes an `at` time (`daysAgo(700)`), and the
  commits are dated to match.
- `sim.github.comment`, `reviewComment`, `review` (with a verdict such as
  `CHANGES_REQUESTED`) and `editComment` are what people do. A bot passes
  `type: "Bot"`, and `openPull` takes `authorType: "Bot"`. Every one of them
  moves the pull request's `updated_at`, as GitHub does.
- `sim.github.writes` lists every write the product made, in order, with its
  path, body, status and actor. `sim.github.writesTo(/\/reviews$/, "POST")`
  filters it.

#### Server, CLI and remote

- `sim.server` is `serve` without a port: `start()`, `deliver()` a signed
  webhook built with `sim.server.payloads`, `runJobs()`, and `remoteToken()`
  for the remote server at `sim.server.remoteUrl`.
- `sim.cli(args, { cwd, env })` runs the CLI in this process, the way a
  terminal does: stderr holds the log lines and the run summary. It returns a
  record with the run's arguments, step, output and exit code, and its
  `github()`, `ai()`, `completions()`, `logs()` and `git()`. Every run is also
  in `sim.cliRuns`. `gh` calls reach the same simulated GitHub.
- `sim.world.useStepSummary()` points `GITHUB_STEP_SUMMARY` at a file in the
  sandbox for a flow that checks `--output=github`.

#### Fake AI and faults

- `ai` scripts the fake AI by job name or prompt text. Within one list the
  first matching rule wins. `sim.ai.use(...)` in a step puts its rules ahead
  of the flow's, so a later rule wins. A call no rule answers fails the run.
  A rule that answers nothing fails it too, unless it says `optional: true`.
- `sim.faults.add(...)` makes the next matching GitHub, AI or remote call fail
  with `"404"`, `"500"`, `"rate-limit"`, `"timeout"`, `"slow"` or any HTTP
  status such as `422`. After an AI rate limit the product's backoff wait is
  skipped, so the flow does not sit through it.

#### Inherited checks and scores

Every flow gets these checks:

- no call left the simulation
- every GitHub call answered
- every AI call scripted
- no secret in the trace, logs, files or GitHub
- cost recorded for every AI call
- one system prompt per conversation
- every planned fault happened
- every AI rule answered

It also gets scores for AI calls, tokens, cost and tool rounds per job. A flow
turns an inherited check off with `skipInherited` and a reason, which the
report shows. A flow check with an inherited check's name is an error.

The secret check holds the GitHub token, the AI key, the webhook secret, the
App private key, minted installation tokens, remote tokens and the judge key.
`sim.world.addSecret(name, value, hosts)` adds another. It searches each one
as is, URL encoded and base64 encoded, in every file of the sandbox except
`config.json`, the simulated GitHub's own repositories, the database files and
git's object store, and also in both databases, the trace, what `sim.cli`
printed and everything posted to GitHub. A secret sent in a request header to
a host it does not belong to fails it too.

The cost check compares totals, not single calls: the tokens the provider
billed against the product's cost rows and its reviews table.

#### What each flow starts with

The world clears every environment variable the product reads, such as
`OPENROUTER_API_KEY`, `GH_TOKEN` and `GITHUB_STEP_SUMMARY`, sets `CI=1`, and
puts the shell's environment back after the flow. After each flow the runner
clears the product's BYOK keys and watch status cache and turns CLI prompts
back on. Each world has its own App installation id, so a cached
installation token never reaches another flow. Some product state stays in the
process and is safe only because its key is new in every world: remote
review sessions and finished results, the tool bridge and the job maps (keyed
by job id), clone locks and clones in progress (keyed by sandbox path). Two
more clear themselves or need care: GitHub's rate limit gate (`github/client.ts`)
lasts until the wait it started ends, and the dashboard's failed login count
(`server/auth.ts`) is kept per address, so a flow that tests sign-in should use
its own address.

#### Where the simulated GitHub differs

- No `Link` headers. The product pages until a short page.
- No ETag, no 304 and no rate-limit headers on a success.
- `since` on `commits` is ignored, and `search/issues` always finds nothing.
- `contents` on a directory answers as a file. Base64 content has no line
  breaks. A tree's `sha` is the commit's.
- A diff is withheld (no `patch`) above 3000 lines, a guess at GitHub's
  undocumented limit.
- `synchronize` payloads have no `before` and `after`.
- `sim.server.start()` does not start the remote watchdog, so a remote flow
  cannot test a client timeout.
- Reactions, labels and issues are kept, but only as far as the product uses
  them today.
