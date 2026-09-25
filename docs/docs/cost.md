# Cost

`init` and `sync` spend model tokens, and so does every review. `probe` is
read-only and costs nothing. This page explains what a run costs and how to
estimate it before you start.

## What costs money

| Step | Spends tokens | Why |
| ---- | ------------- | --- |
| `probe` | No | Reads the repository through `gh` only |
| `init` | Yes | Extraction and synthesis jobs over code, pull requests, and history |
| `sync` | Yes, but less | Reuses unchanged evidence from [cache](caching.md), so only changed inputs rebuild |
| Large-file diff summary | Yes, small | A diff over 500 changed lines is summarized with the low model instead of being sent whole |
| Local and PR `review` | Yes | Runs on your OpenRouter key |
| Remote `review` | On the server | The server's key pays, not the laptop's |
| GitHub App auto-review | On the server | Same as remote |

`gh` reads cost nothing beyond the API rate limit. Codegraph runs locally and is
free.

## Estimate before you init

Run [`probe`](probe.md) first. Its `estimate` block names the job count, a token
range, a time range, and a dollar range, and says which basis it used:

- **This repository's own recorded jobs**, when at least four prior jobs exist
  for it. This is the closest to what the run will do.
- **The calibration**, otherwise, taken from the maintainers' reference runs.

If the provider's price list cannot be reached, the dollar line is omitted and
the estimate says it is unavailable, rather than printing a made-up number. The
line always ends with `an estimate, not a bill`.

The dashboard shows the same estimate when you add a repository, and nothing
starts until you confirm.

## Where to watch the real number

Every run prints one summary line to stderr when it finishes:

```
Done in 21.0s · 3,125 in, 1,308 out tokens · $0.0016
```

The same numbers appear in `--json` under `usage`, and the dashboard records
cost per job on the Activity page and per repository on Usage. When a price list
is unavailable the line reads `cost unknown` rather than a false zero.

## Keeping the cost down

| Lever | Effect |
| ----- | ------ |
| `--max-pr-months`, `--max-commits`, `--max-pull-request-change-lines` | Fewer inputs means fewer extraction jobs |
| `--only-request-changed-pr` | Keeps only pull requests with a `CHANGES_REQUESTED` review |
| `--improve-matrix=1` | The default. A higher value adds improvement passes, each another full call |
| `sync` instead of `init` | Reuses unchanged rows, so a moving default branch costs less |
| Low model for extraction | `--low-model` does the history work. The high model handles synthesis and review |
| `--disable-codegraph` | Does not change token cost, but shortens the run |

`--log-time` prints the time each phase took, which is useful when a run feels
slower than its estimate. See [`sync`](sync.md) and [`init`](init.md) for the
full flag list.

## What is not metered

- Local `gh` and `git` reads.
- Codegraph indexing and tool calls.
- Serving the dashboard and the webhook receiver.
- Reading guides with [`view`](configuration.md) or `view --remote`.

Next: [Data and privacy](privacy.md) for where the keys and the generated files
live.
