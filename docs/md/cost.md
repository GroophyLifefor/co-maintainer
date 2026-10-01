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
| Local and PR `review` | Yes | Runs on your OpenRouter key, see [AI providers](providers.md) |
| Remote `review` | On the server | The server's key pays, not the laptop's, unless you [send your own key](remote-review.md#your-own-ai-key) |
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
the estimate says it is unavailable, rather than printing a made-up number. For
OpenAI and Anthropic, which publish no price list this way, it reads `estimate
unavailable for this provider`. The line always ends with `an estimate, not a
bill`.

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

## What "unknown" means

A missing cost is never shown as `$0.00`. Zero is what a free model actually
costs, unknown is a cost that was never learned, and the two are kept apart
everywhere the dashboard shows money. A single review's unknown cost is a
dotted underline you can hover, or tab to, for the reason:

| Reason | What happened |
| ------ | ------------- |
| The provider did not report the cost | The AI call finished but its response carried no price. |
| Some AI calls in this review did not report a cost | Part of a multi-call review priced itself, part did not |
| Recorded before 0.5.1, the cost was not saved | The review predates this page's own cost tracking |
| The review ended before its cost was recorded | It failed, was canceled, or the process stopped before an AI call returned |

A total adds up only the reviews with a known cost and names how many are
missing one, for example `$1.23 · 4 reviews with unknown cost`, rather than
quietly rounding them to zero.

OpenAI and Anthropic never report a cost, so every review on them reads
`unknown`. OpenRouter reports one. See [AI providers](providers.md#what-differs-between-providers).

## Who pays

A remote review is paid by the server's key unless the client sends its own (see
[your own key](remote-review.md#your-own-ai-key)). A review paid with a client's
key is kept out of the server's own spend and shown after a plus sign, so a total
reads `$1.23 + $0.40 BYOK`. If the cost of those reviews is unknown, it reads
`4 reviews with unknown cost BYOK` in the same place.

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
