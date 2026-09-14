# co-maintainer

`co-maintainer` analyzes a GitHub repository and writes repository-specific
`SKILL.md` guidance that helps developers contribute changes more reliably.

It collects current code and workflows, selected pull requests and diffs, and
default-branch commits. A low-cost model extracts evidence-bound observations; a
higher-reasoning model turns them into concise contribution guidance for
implementation, testing, review, and release decisions.

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

See the command documentation: [`probe`](docs/probe.md), [`init`](docs/init.md),
[`remake`](docs/remake.md), [`review`](docs/review.md),
[`serve`](docs/serve.md), [`dashboard`](docs/dashboard.md),
[`configuration`](docs/configuration.md),
[`authentication`](docs/authentication.md), and [`caching`](docs/caching.md).

Use `co-maintainer help`, `co-maintainer -h`, or `co-maintainer --help` for the
full CLI help.

## Compared to other tools

co-maintainer is a newly tool so not compared a lot of other tools. But did
benchmarks with [OCR](https://open-codereview.ai/). Although I cannot offer any
guarantees because I am working with very small datasets, but it shows promise.

In core_v2 benchmarks:
- **2-3x better results** than OCR
- **2-8x faster** than OCR
- **70-200x fewer tokens** than OCR
- **60-270x cheaper** than OCR

## Benchmarks

We recommend consider core_v3 benchmark results because of more suits for co-maintainer use cases. It is a much more meaningful metric than other benchmarks. core_v3 is co-maintainer only benchmark.

Unlike the OCR comparison above (real human review comments as gold, see
`benchmark/swe-prbench`), `bench core v3` scores against deliberately seeded,
hand-verified defects in a dedicated target repo, half of the PRs kept as
defect-free controls so precision is measurable too, not just recall. Full
breakdown, per-PR results, and methodology:
[`benchmark/core_v3/README.md`](benchmark/core_v3/README.md).

| metric                                 | value                         |
| -------------------------------------- | ----------------------------- |
| PRs reviewed                           | 30 (14 defective, 16 control) |
| F1                                     | 0.750                         |
| Precision                              | 0.667                         |
| Recall                                 | 0.857                         |
| Avg cost / PR                          | $0.0045                       |
| Avg time / PR                          | 28.9s                         |
