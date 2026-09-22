# `init`

First-time knowledge build for a GitHub repository. `init` fetches sources from
GitHub, runs AI synthesis, and writes review guides under your co-maintainer
config directory (not inside the git clone). Expect minutes of runtime and
non-trivial API cost on large repos.

## Before you run

| Check | Why |
| ----- | --- |
| [Install](getting-started.md#1-install) `co-maintainer` | `init` is a CLI command |
| [`probe`](probe.md) on the same `owner/repo` (recommended) | Gives a ready-made `init` line with limits and `--include-*` flags |
| [GitHub auth](authentication.md) | Reads the repo through `gh` or a PAT |
| [AI provider](configuration.md) | OpenRouter or Hetzner key and models via `co-maintainer set` or flags |

Run [`probe`](probe.md) first when you are unsure which `--max-*` limits to use.

## Usage

```sh
co-maintainer set --auth=gh --ai=openrouter --token=YOUR_KEY \
  --low-model=openai/gpt-oss-120b --high-model=openai/gpt-5.6-luna

co-maintainer probe owner/repo
# copy the recommended init line from probe output, for example:
co-maintainer init owner/repo --include-codebase --include-pull-requests \
  --max-pr-months=12 --max-commits=500
```

If AI settings are missing, the CLI prompts for provider, API key, and models.
Values from `set`, `--env=PATH`, or flags are not asked again.

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `owner/repo` | Repository to analyze (required) |
| `--auth=gh` | GitHub CLI (default, or from `set` / config) |
| `--auth=pat` | Personal access token (see [Authentication](authentication.md)) |
| `--github-pat=...` | PAT when not in env or config |
| `--env=PATH` | Load env vars from a file |
| `--ai=openrouter` | AI provider (`openrouter`, `hetzner`, or `none`) |
| `--token=...` | Provider API key |
| `--low-model=...` | Model for extraction steps |
| `--high-model=...` | Model for synthesis steps |
| `--include-codebase` | Include default-branch tree and files |
| `--include-pull-requests` | Include PR metadata and discussions |
| `--include-pull-request-changes` | Include PR diffs |
| `--include-commit-history` | Include commit messages on the default branch |
| `--include-how-repo-works` | Include issues / workflow signals when available |
| `--max-pr-months=N` | Limit how far back PR history goes |
| `--max-commits=N` | Limit commits scanned on the default branch |
| `--max-pull-request-change-lines=N` | Skip oversized PR diffs |
| `--max-comment=N` | Cap discussion comments kept per pull request |
| `--only-request-changed-pr` | Keep only pull requests with at least one `CHANGES_REQUESTED` review |
| `--pr-state=open,closed,merged` | Keep a comma-separated subset of `open`, `closed`, and `merged` |
| `--gh-concurrent=N` | Parallel GitHub fetches (default `1`) |
| `--ai-concurrent=N` | Parallel AI jobs (default `3`) |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing per phase |

**Include flags:** If you pass **any** `--include-*` on the command line, only
the flags you list are enabled. With no `--include-*` flags, all sources default
to on (unless a prior `init` stored different choices in config for this repo).

**Pull request filters:** `--only-request-changed-pr` applies inside the
`--max-pr-months` window. A dismissed review does not count. Dropped pull
requests skip comment and diff downloads. The run logs
`only request-changed pr · kept N · dropped N`. Off by default.
`--pr-state` takes `open`, `closed`, and `merged`, separated by commas.
`closed` means closed and not merged. Omit it to keep every state. The listing
cache is stored per state set, so a different set is not filled from the
previous listing.

Both are saved for the repo. A later [`sync`](sync.md) without the flag
keeps the saved choice. `--only-request-changed-pr` does not turn itself off.
To collect every state again, pass `--pr-state=open,closed,merged`.

Limits and include defaults can also come from [per-repo config](configuration.md#per-repo-memory) after the first successful run.

## What it writes

Under `<config dir>/repos/owner/repo/` (see [Caching](caching.md)):

- `SKILL.md` and `CODEBASE.md`
- `PR_REVIEW_GUIDE.md` and related review guides when PR sources were included

Evidence and AI job results go into `cache.db` for faster [`sync`](sync.md).
After `init` succeeds, run [`review`](review.md) on a PR or local changes.
