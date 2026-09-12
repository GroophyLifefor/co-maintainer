# co-maintainer

`co-maintainer` analyzes a GitHub repository and writes repository-specific
`SKILL.md` guidance that helps developers contribute changes more reliably.

It collects current code and workflows, selected pull requests and diffs, and
default-branch commits. A low-cost model extracts evidence-bound observations; a
higher-reasoning model turns them into concise contribution guidance for
implementation, testing, review, and release decisions.

This is a local Deno CLI. It writes generated skills, configuration, and cache
data to platform-specific user directories — generated skills live under
`<config dir>/co-maintainer/repos/owner/repo/` (e.g.
`%APPDATA%\co-maintainer\repos` on Windows,
`~/Library/Application
Support/co-maintainer/repos` on macOS,
`~/.config/co-maintainer/repos` elsewhere) — never relative to the current
directory, since the CLI can be invoked from anywhere.

## Installation

```sh
deno install -g -A --name co-maintainer jsr:@murat/co-maintainer
```

If fails to install, try:

```sh
deno install -f -g -A --min-dep-age=0 --name co-maintainer jsr:@murat/co-maintainer
```

On a Linux VPS, persist Deno's PATH entry if the installer prints
`Add ~/.deno/bin to PATH`:

```sh
grep -qxF 'export PATH="$HOME/.deno/bin:$PATH"' ~/.bashrc || printf '\nexport PATH="$HOME/.deno/bin:$PATH"\n' >> ~/.bashrc
source ~/.bashrc
```

## Usage

```sh
co-maintainer probe owner/repo --auth=gh
```

```sh
co-maintainer probe owner/repo --auth=gh

co-maintainer init owner/repo --auth=gh --ai=openrouter --token=... \
  --low-model=openai/gpt-oss-120b \
  --high-model=openai/gpt-5.6-luna \
  --include-codebase --include-pull-requests \
  --include-pull-request-changes --include-commit-history \
  --include-how-repo-works

co-maintainer review owner/repo 123 --improve-matrix=2 --debug
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
[`serve`](docs/serve.md), [`dashboard`](docs/dashboard.md),
[`configuration`](docs/configuration.md),
[`authentication`](docs/authentication.md), and [`caching`](docs/caching.md).

Add `--log-time` to any command to print core operation durations and AI
token/cost totals. Use `--gh-concurrent=N` to bound GitHub listing pages and
detail fetches in `probe`, `init`, and `remake` (default: `1`). Use
`--ai-concurrent=N` to bound `extract_unit` and `synth_section` AI jobs in
`init` and `remake` (default: `3`). Use `co-maintainer help`,
`co-maintainer -h`, or `co-maintainer --help` for the full CLI help.
