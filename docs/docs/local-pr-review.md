# PR review

Review an **open GitHub pull request** by number. The CLI uses **`gh`** to read
the PR and runs the AI **on your machine** (OpenRouter).

Overview: [`review`](review.md). This is not the same as
[remote review](remote-review.md) (`--remote` is rejected when a PR number is
present).

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
co-maintainer review owner/repo 123 --disable-codegraph --debug
```

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `owner/repo` | Repository (required positional) |
| `123` | Pull request number (required positional) |
| `--json` | One JSON document on stdout |
| `--disable-codegraph` | Skip codegraph tools (default is on for CLI) |
| `--allow-tool-install` | Install pinned codegraph without a prompt |
| `--improve-matrix=N` | Scales review depth (see CLI help) |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing per phase |

**Not supported for PR review:** `--remote`, `--fresh`, `--to-branch`,
`--branch`, `--repo=`, `--sync-before-review`. Use
[local review](local-review.md) for working-tree changes or
[remote review](remote-review.md) for a local diff against shared server context.

PR review indexes the checked-out repository with codegraph when it is already
installed, but it never prompts to install it: a PR review runs unattended. The
question and its rules are in [local review](local-review.md#codegraph).

Auth and models follow [`configuration`](configuration.md) and `co-maintainer
set` like other commands (`--auth=pat` is not used for PR review).
