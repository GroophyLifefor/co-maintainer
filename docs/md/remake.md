# `remake`

Refresh repository knowledge after the default branch or pull requests move on.
`remake` re-fetches GitHub data, reuses unchanged evidence from
[cache](caching.md), and regenerates `SKILL.md` and review guides. It costs
less time and API usage than a full [`init`](init.md) when little changed.

## Before you run

| Check | Why |
| ----- | --- |
| A successful [`init`](init.md) or `remake` for this `owner/repo` | Without cached state, `remake` refuses to start |
| [GitHub auth](authentication.md) | Reads the repo through `gh` or a PAT |
| [AI provider](configuration.md) | Token via `set`, `--token=`, or `--env=PATH` |
| A reason to refresh | New merges on `main`, outdated guides, or review quality drift |

If the repo was never initialized, run [`init`](init.md) (or [`probe`](probe.md)
first for limits). To change `--include-*` or limits permanently, pass flags on
`remake` or run [`init`](init.md) again with the new options.

## Usage

```sh
co-maintainer set --auth=gh --ai=openrouter --token=YOUR_KEY \
  --low-model=openai/gpt-oss-120b --high-model=openai/gpt-5.6-luna

co-maintainer remake owner/repo
co-maintainer remake owner/repo --env=./.env --log-time
```

After the first [`init`](init.md), a plain `co-maintainer remake owner/repo` is
enough: auth, models, limits, and `include-*` choices are read from
[per-repo config](configuration.md#per-repo-memory). You only need to supply the
API token again if it is not in config or env.

On the [dashboard](dashboard.md), **Remake** runs the same job as this command.

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `owner/repo` | Repository to refresh (required) |
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
| `--gh-concurrent=N` | Parallel GitHub fetches (default `1`) |
| `--ai-concurrent=N` | Parallel AI jobs (default `3`) |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing per phase |

**Defaults on `remake`:** With no flags, auth, models, `include-*`, and `max-*`
usually come from [per-repo config](configuration.md#per-repo-memory) written
by the last `init` or `remake`. Omitted `--max-*` values are also filled from
the cached run state for that repo.

**Include flags:** If you pass **any** `--include-*` on the command line, only
the flags you list are enabled. With no `--include-*` flags, the saved per-repo
choices apply.

## What gets reused

- Unchanged files on the default branch (tree SHA in cache)
- Pull request listings and discussions when `updated_at` is unchanged
- Diffs when the PR head SHA is unchanged
- AI extraction and synthesis jobs when inputs and models match

Changed evidence invalidates only the facts and skill sections that depend on
it. Outputs still land under `<config dir>/repos/owner/repo/` (see
[Caching](caching.md)).

## Scheduled remake

A [`serve`](serve.md) instance can run `remake` for you. Open a repository in the
dashboard, go to **Settings**, and fill **Scheduled remake** with a five field
cron expression (minute, hour, day of month, month, day of week). Leave it blank
to turn it off.

| Example | Runs |
| ------- | ---- |
| `0 3 * * 1` | Every Monday at 03:00 UTC |
| `30 4 * * *` | Every day at 04:30 UTC |
| `0 */6 * * *` | Every six hours, on the hour |

- Times are UTC.
- The minute field takes a single value, so a schedule fires at most once an
  hour. A remake spends model tokens, and this keeps a typo from burning them.
- A repository is skipped while its first setup is unfinished or while another
  setup or remake for it is queued or running.
- A minute the server was down for is not made up. The next matching minute runs.
- The scheduler lives inside `serve`, so nothing runs while `serve` is stopped.

The schedule is stored per repository as `remakeCron` in
[`config.json`](configuration.md#per-repo-memory).

Next: [`review`](review.md). For a one-off refresh before a local review, see
`--remake-before-review` in [local review](local-review.md).
