# co-maintainer

`co-maintainer` analyzes a GitHub repository and writes repository-specific
`SKILL.md` guidance that helps developers contribute changes more reliably.

It collects current code and workflows, selected pull requests and diffs, and
default-branch commits. A low-cost model extracts evidence-bound observations; a
higher-reasoning model turns them into concise contribution guidance for
implementation, testing, review, and release decisions.

This is a local Deno CLI. It writes generated skills to `repos/owner/repo/` and
keeps configuration and cache data in platform-specific user directories.

## Installation

```sh
deno install -g -A --name co-maintainer jsr:@murat/co-maintainer
```

```sh
deno task probe owner/repo --auth=gh

deno task init owner/repo --auth=gh --ai=openrouter --token=... \
  --low-model=openai/gpt-oss-120b \
  --high-model=openai/gpt-5.6-luna \
  --include-codebase --include-pull-requests \
  --include-pull-request-changes --include-commit-history \
  --include-how-repo-works

deno task review owner/repo 123 --improve-matrix=2 --debug
```

`probe` recommends source limits without writing a skill. `remake` refreshes
changed repository evidence and reuses cached analysis when possible. `review`
checks a pull request against the generated review guides using OpenRouter and
GitHub CLI data. `--improve-matrix=N` performs repeated review passes with a
`24,000 × N` token budget per pass; `--debug` prints each pass for comparison.
Review results are printed to the terminal and costs are recorded in the SQLite
cache.

Use `--env=PATH` to load credentials and defaults from an env file. CLI values
take precedence over the env file, user config, interactive prompts, and
built-in defaults. See the command documentation: [`probe`](docs/probe.md),
[`init`](docs/init.md), [`remake`](docs/remake.md), [`review`](docs/review.md),
[`configuration`](docs/configuration.md),
[`authentication`](docs/authentication.md), and [`caching`](docs/caching.md).

Add `--log-time` to any command to print core operation durations and AI
token/cost totals. Use `co-maintainer help`, `co-maintainer -h`, or
`co-maintainer --help` for the full CLI help.
