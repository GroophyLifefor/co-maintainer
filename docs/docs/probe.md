# `probe`

Read-only research on a GitHub repository. `probe` samples pull requests and
commit history, then prints a recommended `co-maintainer init` command with
sensible `--include-*` and `--max-*` flags, plus an **estimate** of what that
command will cost in time, GitHub calls and dollars, and what one pull request
review would cost. It does not call the AI and does not write guide files.

## Before you run

| Check | Why |
| ----- | --- |
| [Install](getting-started.md#install) `co-maintainer` | `probe` is a CLI command |
| [GitHub auth](authentication.md) (`gh auth login` or a PAT) | `probe` only reads the repo via the API |
| [Defaults](configuration.md) with `co-maintainer set` (optional) | Skips repeating `--auth=...` on every run |
| Read access to `owner/repo` | Private repos need a token or `gh` login that can see them |

If `probe` fails, fix GitHub access first (`gh auth status`), not co-maintainer.

## Usage

```sh
co-maintainer set --auth=gh
co-maintainer probe owner/repo
co-maintainer probe              # repo from the git remote of the current directory
co-maintainer probe owner/repo --run   # probe, then run the recommended init
```

The output has four parts: **research** (what the sample found), **init
estimate** (time, GitHub calls and cost of the recommended `init`),
**review estimate** (what one pull request review costs), and **run** (the
full `co-maintainer init ...` line to copy). When the recommended `init` would
take more than 30 minutes, a **faster** option with a shorter PR window and
fewer commits is shown next to it, with its own full command. Colors are used
on a terminal only, and are off with `NO_COLOR`, in CI and with `--json`.

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `owner/repo` | Repository to research (optional, read from the git remote when omitted) |
| `--auth=gh` | Use the GitHub CLI (default when unset: `gh`, or value from `set` / config) |
| `--auth=pat` | Use `GITHUB_TOKEN`, `GH_TOKEN`, `--github-pat=...`, or `set --github-pat=...` |
| `--github-pat=...` | PAT for `--auth=pat` when not in env or config |
| `--env=PATH` | Load env vars from a file (see [Configuration](configuration.md)) |
| `--gh-concurrent=N` | Parallel GitHub requests while sampling PR details, and for the `init` time estimate (default `1`, minimum `1`) |
| `--ai-concurrent=N` | AI jobs at once, for the `init` time estimate (default `3`) |
| `--ai=openrouter` | Needed for dollars. Other providers have no public price list |
| `--low-model=...` `--high-model=...` | The models to price. Without them each cost line says which flags to add |
| `--run` | After printing the plan, run the recommended `init` in the same process |
| `--json` | One JSON document on stdout, no prompts. Cannot be used with `--run` |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing for each probe phase |

`probe` ignores `--include-*` and `--max-*`. Those appear on the
**recommended `init` command** in the output when the analysis suggests them.
The AI flags are only used to price the estimate. The models can also come
from `LOW_MODEL` / `HIGH_MODEL` or the config, and `probe` never asks for
them.

## The estimate

The `init estimate` block gives a time range, the GitHub calls and a dollar
range for the recommended `init`. It is a **planning estimate, not a bill**:

- Pull requests are counted inside the recommended PR window
  (`--max-pr-months`), the way `init` reads them, not the whole history.
- `init` reads GitHub first and runs the AI jobs after, so the time is the
  two added together. The line says which part decides it.
- GitHub calls: about 4 per pull request (detail, comments, review comments,
  reviews), one more for its files when changes are read, the listing and
  commit pages, and the codebase files, counted from the repository tree. One call's duration is
  measured from the probe's own calls. The hourly quota comes from GitHub's
  `/rate_limit`, which costs nothing. A run that needs more than what is
  left waits for the reset, unless its calls take long enough that the
  quota refills while they run. The line says which: it fits, it stays
  under the hourly limit as it runs, or it waits about so long for it.
- AI jobs (`extract` and `synth`) come from the same inputs the real run
  uses, and run `--ai-concurrent` at a time.
- Dollars need a price for both `--low-model` and `--high-model`. They come
  from OpenRouter's public `/api/v1/models`, cached for 24 hours. With no
  price there is no dollar line rather than a guessed one.
- Time and per-job tokens come from this repository's own recorded jobs when
  four or more exist, and from the cm-dx-lab calibration otherwise. The line
  says which one it used.

Over 30 minutes, the **faster** option tries a 24, 12, 6 and then 3 month PR
window, halving `--max-commits` each step, and shows the first one that fits
in 30 minutes. It learns from less review history, and its cost line says so.

The `review estimate` block reads the files of the 10 most recently updated
pull requests a review would run on (no bots, no drafts, no empty diffs) and
prices one review of each: the diff the review would be given, summaries for
very large files, and the tool rounds a review of that size takes. It shows the median
and the highest, ordered by dollars when the models have prices. It assumes
one pass and no codebase graph. With fewer than 5 such pull requests there is
no review estimate.

`--run` runs the recommended `init` in the same process after printing the
plan, which is the "look then do" step in one command. It is the same code
path the dashboard uses, not a re-spawn.

## JSON output

With `--json`, stdout is a single JSON object (`schemaVersion` `1`) and the
progress lines go to stderr. Fields: `command` (`probe`), `repo`,
`recommended` (the `init` line), `research` (pull request and commit counts,
`pullRequestsInWindow`, the `maxPrMonths`, `maxCommits` and
`maxPullRequestChangeLines` windows, with `null` for no limit, and
`reasons[]`), `estimate` (`extract`, `synth`, and `[low, high]` ranges for
`tokensIn`, `tokensOut`, the AI `seconds` and `usd`, plus the `cost` line and
its `basis`, then `totalSeconds`, `bottleneck`, `github` with `calls`,
`seconds`, `callSeconds`, `quotaWaitSeconds` and `quota`, `faster` (the same parts for the
faster option, or `null`) and `review` (`sampled`, `median` and `highest`, or
`null`)), and `durationMs`. `usd` is `null` when no price is known. Errors
with `--json` are JSON on stdout as well.

`--run` with `--json` exits with code 2, because the probe and the `init`
would be two documents on one stdout. Run `probe --json`, then the
`recommended` line with `--json`.

## What it looks at

- Repository metadata and latest release (if any)
- Pull request list (updated time, sampling across years)
- A bounded sample of PR diffs for size and activity
- The changed files of the 10 newest reviewable pull requests, for the review
  estimate
- Default-branch commit history
- The GitHub quota left this hour

Use the printed `init` line as-is for a first run, or tighten limits if the repo
is huge and you want a cheaper `init`. Next step: [`init`](init.md).
