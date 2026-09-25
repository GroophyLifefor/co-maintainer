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
| [`init`](init.md) / [`sync`](sync.md) for that `owner/repo` | `SKILL.md` and review guides on disk |
| OpenRouter key in `set`, `--token=`, or `--env=PATH` | Local review uses your provider |
| Clean enough git state | Conflicts or broken git state can fail collection |

## Usage

```sh
cd your/clone
co-maintainer review
co-maintainer review --json
co-maintainer review --fresh
co-maintainer review --to-branch=main --sync-before-review
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
| `--sync-before-review` | Run [`sync`](sync.md) before reviewing (requires `gh`) |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing per phase |

Do not pass `owner/repo` or a PR number. That selects [PR review](local-pr-review.md)
instead.

## Codegraph

Local review uses codegraph to follow calls between files. On the first run the
pinned build is usually missing, and co-maintainer asks before installing it (see
[Caching](caching.md) for the per-version tools directory). The question names
the package, where it comes from, what it is for, the approximate download size,
and the exact install directory:

```
co-maintainer uses codegraph 1.6.0 (@colbymchenry/codegraph from npm, ~250 MB) to follow calls between files while reviewing.
Install it into <tools dir>/codegraph/1.6.0 (your global PATH is not touched)? [y/N]
```

The question is only asked when **both** stdin and stdout are a terminal and
`CI` is unset. With a closed stdin (`</dev/null`), a piped output, or `CI=1`, it
is skipped and review continues without codegraph, printing one line:

```
[codegraph] codegraph 1.6.0 is not installed, reviewing without it. Pass --allow-tool-install to install it, or --disable-codegraph to skip this notice.
```

Pass `--allow-tool-install` to install without a prompt, or
`--disable-codegraph` to skip the check entirely. Neither CI jobs nor pipelines
can hang on the question.

## Carry-over

Repeated `co-maintainer review` on the same repo root and branch reuses prior
findings (closed / still open / new) via [cache](caching.md). Use `--fresh` to
start clean. If the cache cannot be read or written, review continues with a
`carry_over_unavailable` warning.

Carry-over never replaces the review. Every run scans the whole diff for new
violations **and** re-checks the previous findings. A finding that is still open
is reported as such rather than suppressing a new one nearby.

When a guide is rebuilt (`init` / `sync`) after your last review on this branch,
that review's verdicts were made against rules that no longer exist. The next
review therefore starts fresh on its own (no `--fresh` needed), so a stale
finding cannot hide a violation the new guide would catch.

## Developers

```sh
npm run review-local-e2e
```

Temporary worktree, `CM_FAKE_AI=1`, optional `CM_FAKE_REVIEW_FILE`.
