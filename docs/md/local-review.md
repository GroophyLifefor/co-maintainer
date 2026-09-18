# Local review

Review **staged, unstaged, and untracked** files in your git clone against a
base branch. AI and guides run on **your machine** (OpenRouter via
[configuration](configuration.md)).

Overview: [`review`](review.md).

## Before you run

| Check | Why |
| ----- | --- |
| Run from the repo root (or a subdirectory with a git root) | Review needs a working tree |
| `origin` or `upstream` points at GitHub (or use `--repo=owner/repo`) | Maps the clone to guides for that repo |
| [`init`](init.md) / [`remake`](remake.md) for that `owner/repo` | `SKILL.md` and review guides on disk |
| OpenRouter key in `set`, `--token=`, or `--env=PATH` | Local review uses your provider |
| Clean enough git state | Conflicts or broken git state can fail collection |

## Usage

```sh
cd your/clone
co-maintainer review
co-maintainer review --json
co-maintainer review --fresh
co-maintainer review --to-branch=main --remake-before-review
```

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `--json` | One JSON document on stdout, no prompts |
| `--disable-codegraph` | Skip codegraph tools (default is on) |
| `--allow-tool-install` | Install pinned codegraph without a prompt when missing |
| `--fresh` | Ignore carry-over from the previous local review on this branch |
| `--to-branch=<name>` | Base branch for the diff (default: remote default branch) |
| `--branch=<name>` | Branch name when HEAD is detached |
| `--repo=owner/repo` | Override GitHub remote detection |
| `--remake-before-review` | Run [`remake`](remake.md) before reviewing (requires `gh`) |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing per phase |

Do not pass `owner/repo` or a PR number. That selects [PR review](local-pr-review.md)
instead.

## Carry-over

Repeated `co-maintainer review` on the same repo root and branch reuses prior
findings (closed / still open / new) via [cache](caching.md). Use `--fresh` to
start clean. If the cache cannot be read or written, review continues with a
`carry_over_unavailable` warning.

## Developers

```sh
npm run review-local-e2e
```

Temporary worktree, `CM_FAKE_AI=1`, optional `CM_FAKE_REVIEW_FILE`.
