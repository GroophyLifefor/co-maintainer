# PR review

Review an **open GitHub pull request** by number. The CLI uses **`gh`** to read
the PR and runs the AI **on your machine** with your [AI provider](providers.md).

Overview: [`review`](review.md). This is not the same as
[remote review](remote-review.md) (`--remote` is rejected when a PR number is
present).

Pushing straight to `main` without PRs: see
[commit watch review](commit-watch-review.md).

## Before you run

| Check | Why |
| ----- | --- |
| [`init`](init.md) / [`sync`](sync.md) for `owner/repo` | Guides on disk for that repo |
| `gh auth login` | PR review supports **`--auth=gh` only** |
| Read access to the PR | Private repos need a logged-in `gh` user |

## Usage

```sh
co-maintainer review owner/repo 123
co-maintainer review owner/repo 123 --json
co-maintainer review owner/repo 123 --fresh
co-maintainer review owner/repo 123 --disable-codegraph --debug
```

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `owner/repo` | Repository (required positional) |
| `123` | Pull request number (required positional) |
| `--json` | One JSON document on stdout |
| `--fresh` | Ignore the stored run of this pull request and start over |
| `--disable-codegraph` | Skip codegraph tools (default is on for CLI) |
| `--allow-tool-install` | Install pinned codegraph without a prompt |
| `--improve-matrix=N` | Scales review depth (see CLI help) |
| `--intent-file=PATH` | What the change is for, from a file or `-` for standard input. Context only, read into the `PULL REQUEST` block, see [Intent](review.md#intent) |
| `--diagram-runtime`, `--plantuml-server`, `--plantuml-output-format` | The diagram language of the review, see [Diagrams](review.md#diagrams) |
| `--include-extension-markdowns` | With `--json`, keep each extension's Markdown, which is empty otherwise |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing per phase |

Registered [extensions](extensions.md) run in a PR review too, and their findings
join the result. The extension makes its own checkout if it needs one.

**Not supported for PR review:** `--remote`, `--to-branch`, `--branch`,
`--repo=`, `--sync-before-review`. Use
[local review](local-review.md) for working-tree changes or
[remote review](remote-review.md) for a local diff against shared server context.

PR review indexes the checked-out repository with codegraph when it is already
installed, and installs the pinned version when you pass `--allow-tool-install`.
It never prompts: a PR review runs unattended. The question and its rules are in
[local review](local-review.md#codegraph), and [Codegraph](codegraph.md) lists
the install table and the version-resolution order.

Auth and models follow [`configuration`](configuration.md) and `co-maintainer
set` like other commands (`--auth=pat` is not used for PR review).

## Carry-over

A PR review remembers its findings between runs. Each run is stored in the
[cache](caching.md), keyed by repository and pull request number. The next run
shows what the author fixed as `closed`, what is left as `open`, and only real
new findings as `new`. This is the same carry-over [local review](local-review.md#carry-over)
uses, and it shows in the terminal output, in `--json` and with `--output=github`.

- **Starts fresh** with `--fresh`, when the guide was rebuilt after the last run,
  and when the pull request head does not contain the last reviewed head. That is
  a force-push, or a case where GitHub cannot compare the two. Starting fresh
  clears the stored run, and the log says why.
- **Unchanged files** since the last run are listed to the model as unchanged
  and are not sent again. A re-run on the same head sends no file, still makes
  one model call to judge the earlier findings, and every finding comes back
  `open`. A re-run after a push sends only the changed files.
- **Exit code.** A blocking finding that is still open keeps the exit code at 1,
  also when the model reports nothing new.
- **A cache problem never fails the review.** If the stored run cannot be read or
  saved, the review runs without carry-over and the output carries a
  `carry_over_unavailable` warning.
- **`clear owner/repo --include-cache`** removes the stored runs, see
  [Caching](caching.md#clearing).

A file the model did not receive because the diff was too large is sent again in
the next run, see [Large diffs](review.md#large-diffs).

In `--json`, `summary.open` and `summary.closed` count the findings, each
`findings[].state` is `new`, `open` or `closed`, and `warnings` holds
`carry_over_unavailable` and the [large diff](review.md#where-the-result-says-it)
warnings.
