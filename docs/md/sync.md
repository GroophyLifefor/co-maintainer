# `sync`

Refresh repository knowledge after the default branch or pull requests move on.
`sync` re-fetches GitHub data, reuses unchanged evidence from
[cache](caching.md), and regenerates `SKILL.md` and review guides. It costs
less time and API usage than a full [`init`](init.md) when little changed.

> Earlier releases called this command `remake`. That spelling still runs the
> same job, but it is no longer shown in help.

## Before you run

| Check | Why |
| ----- | --- |
| A successful [`init`](init.md) or `sync` for this `owner/repo` | Without cached state, `sync` refuses to start |
| [GitHub auth](authentication.md) | Reads the repo through `gh` or a PAT |
| [AI provider](providers.md) | Token via `set`, `--token=`, or `--env=PATH`, and both models |
| A reason to refresh | New merges on `main`, outdated guides, or review quality drift |

If the repo was never initialized, run [`init`](init.md) (or [`probe`](probe.md)
first for limits). To change `--include-*` or limits permanently, pass flags on
`sync` or run [`init`](init.md) again with the new options.

## Usage

```sh
co-maintainer set --auth=gh --ai=openrouter --token=YOUR_KEY \
  --low-model=openai/gpt-oss-120b --high-model=openai/gpt-5.6-luna

co-maintainer sync owner/repo
co-maintainer sync owner/repo --env=./.env --log-time
```

After the first [`init`](init.md), a plain `co-maintainer sync owner/repo` is
enough: auth, models, limits, and `include-*` choices are read from
[per-repo config](configuration.md#per-repo-memory). You only need to supply the
API token again if it is not in config or env.

On the [dashboard](dashboard.md), **Sync now** runs the same job as this command.

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `owner/repo` | Repository to refresh (required) |
| `--auth=gh` | GitHub CLI (default, or from `set` / config) |
| `--auth=pat` | Personal access token (see [Authentication](authentication.md)) |
| `--github-pat=...` | PAT when not in env or config |
| `--env=PATH` | Load env vars from a file |
| `--ai=openrouter` | AI provider (`openrouter`, `openai`, `anthropic`, `opencode-zen` or `opencode-go`). Required, see [AI providers](providers.md) |
| `--token=...` | Provider API key |
| `--low-model=...` | Model for extraction steps |
| `--high-model=...` | Model for synthesis steps |
| `--include-codebase` | Include default-branch tree and files |
| `--include-pull-requests` | Include PR metadata and discussions |
| `--include-pull-request-changes` | Include PR diffs |
| `--include-commit-history` | Include commit messages on the default branch |
| `--include-how-repo-works` | Include issues / workflow signals when available |
| `--agent-instructions=REGEX` | Files to read as agent instruction files for `INSTRUCTIONS.md`. A blank value turns it off. Left out, the last run's value is kept, see [Agent instruction files](init.md#agent-instruction-files) |
| `--agent-instructions-max-chars=N` | Cap on `INSTRUCTIONS.md` in characters, `0` or below for no limit. Left out, the last run's value is kept |
| `--max-pr-months=N` | Limit how far back PR history goes |
| `--max-commits=N` | Limit commits scanned on the default branch |
| `--max-pull-request-change-lines=N` | Skip oversized PR diffs |
| `--max-comment=N` | Cap discussion comments kept per pull request |
| `--only-request-changed-pr` | Keep only pull requests with at least one `CHANGES_REQUESTED` review |
| `--pr-state=open,closed,merged` | Keep a comma-separated subset of `open`, `closed`, and `merged` |
| `--gh-concurrent=N` | Parallel GitHub fetches (default `1`) |
| `--ai-concurrent=N` | Parallel AI jobs (default `3`) |
| `--json` | One JSON document on stdout, no prompts. Same fields as [`init --json`](init.md#json-output), with `command` `sync` |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing per phase |

**Defaults on `sync`:** With no flags, auth, models, `include-*`, `max-*`,
`--only-request-changed-pr`, and `--pr-state` usually come from
[per-repo config](configuration.md#per-repo-memory) written by the last `init`
or `sync`. Omitted `--max-*` values are also filled from the cached run
state for that repo.

**Include flags:** If you pass **any** `--include-*` on the command line, only
the flags you list are enabled. With no `--include-*` flags, the saved per-repo
choices apply.

**Pull request filters:** `--only-request-changed-pr` applies inside the
`--max-pr-months` window. A dismissed review does not count. Dropped pull
requests skip comment and diff downloads. The run logs
`only request-changed pr · kept N · dropped N`. Off until a run saves it.
`--pr-state` takes `open`, `closed`, and `merged`, separated by commas.
`closed` means closed and not merged. With no flag and no saved set, every
state is kept. The listing cache is stored per state set, so a different set
is not filled from the previous listing. `--only-request-changed-pr` does not
turn itself off. To collect every state again, pass
`--pr-state=open,closed,merged`.

## A guide cut at the output limit

The review guide is written with an output limit, 16,000 tokens for the
detailed guide and 8,000 for the short one. When the answer stops at that
limit, `sync` asks once more with twice the limit. When the second answer is
cut too, nothing is written and the last guide stays, so a review never reads
a guide that ends mid-line. The run says so in one line, and `sync --json` has
`reviewGuide: "kept"`.

## What `sync` says about guide rules

Each check line of the review guides rests on the pull requests whose findings
it merges. When the guides are rewritten and an earlier `RULES.json` has guide
rules, `sync` says what changed:

    [guide] 2 rules added (#402, #407) · 1 rewritten (R12, #340 joined) · 1 dropped (#101 left the window)

or `[guide] no rule changed`. Guide rules are matched by their pull requests the
same way instruction rules are matched by their file lines, see the table below.
A dropped rule whose pull request is outside the window this `sync` read says
`left the window`. The first `sync` after upgrading to 0.7.1 rewrites both guides
once, because the guide prompt changed.

### Rule ids stay the same

A rule keeps its id across syncs, so a review that cited `R4` still points at
the same rule. A rewritten rule keeps the id of the old rule it shares the most
sources with. A new rule gets the next number ever given, and the id of a
dropped rule is never given to another rule. `RULES.json` keeps the highest
number given in `lastIds`. Instruction rules work the same way, and an
instruction line that moved down its file keeps its id when its text is the same.

### A rule that goes against an older one

The guide prompt lists the last build's rules by id and text, with no pull
request or date. When the model writes a rule that requires the opposite of an
old one, `sync` says so with its evidence:

    [guide] R4 dropped, R9 goes against it (#340, 2026-03)

The line appears only when the new rule's newest pull request merged after the
old rule's newest one. `sync --json` lists the same in `contradicted`, and the
repository page of the dashboard shows the last ten.

## References and comment links

Each pull request read since 0.7.3 keeps a link to every comment and review on
it, and a guide rule links to the review comment it came from. A pull request
cached before that keeps its old extract answer and shows its number with no
link, so a plain upgrade costs nothing extra.

After `set --repo=owner/repo --review-references=on`, the next `sync` reads the
comments of every cached pull request again once and logs
`review references are on: reading every pull request again once for comment links`.
Those pull requests are extracted again, so that one `sync` costs as much as an
`init` for the extract step. The date is saved as `referencesBackfilledAt`, so
turning the setting off and on again never repeats it. See
[References](review.md#references).

## What `sync` says about instruction rules

When the repository has agent instruction files, `sync` rebuilds
[`INSTRUCTIONS.md`](init.md#agent-instruction-files) the way `init` does, and
after the second build it says what changed. The line appears when an earlier
`RULES.json` exists:

    [instructions] 1 rule added (AGENTS.md:40) · 1 rewritten (I3, AGENTS.md:12 joined) · 1 dropped (AGENTS.md:9)

or `[instructions] no rule changed`. Rules are matched by the instruction file
lines they cite, not by their text:

| Change | Meaning |
| ------ | ------- |
| Added | The rule shares no source with any old rule |
| Rewritten | The rule shares a source with an old rule, and its sources or its text changed |
| Dropped | None of the old rule's sources is in any new rule |

The line lists at most 5 sources for added or dropped rules and at most 3
rewritten rules, then `, and N more`. Because a rule is matched by `path:line`, a line inserted at
the top of `AGENTS.md` shifts every line number, so every rule shows as dropped
and added.

A plain `sync` of a repository with no instruction file changes nothing about its
output.

## JSON output

`sync --json` prints the same document as [`init --json`](init.md#json-output),
with `command` `sync`. When the guides or the instruction files did something it
also has `ruleChanges`. It is `null` without an earlier `RULES.json`, otherwise
it lists the same three kinds of change in full, under `guide` and
`instructions`. A dropped guide rule also has `leftWindow`, the pull requests
that are outside the window this `sync` read. `previous` holds the ids of the old
rules a rewritten rule came from, `joined` the sources it gained and `left` the
sources it lost:

```json
{
  "instructions": {
    "added": [{ "id": "I4", "text": "...", "sources": ["AGENTS.md:40"] }],
    "rewritten": [{ "id": "I3", "text": "...", "previous": ["I2"], "joined": ["AGENTS.md:12"], "left": [] }],
    "dropped": [{ "id": "I2", "text": "...", "sources": ["AGENTS.md:9"] }],
    "unchanged": 11
  }
}
```

## What gets reused

- Unchanged files on the default branch (tree SHA in cache)
- Pull request listings and discussions when `updated_at` is unchanged
- Diffs when the PR head SHA is unchanged
- AI extraction and synthesis jobs when inputs and models match

Changed evidence invalidates only the facts and skill sections that depend on
it. Outputs still land under `<config dir>/repos/owner/repo/` (see
[Caching](caching.md)).

`CODEBASE.md` is rebuilt section by section, and a section keeps what it had
unless this run has a reason to change it:

- A section whose facts did not change keeps its text. A rebuilt section takes
  the new text, and one the model had nothing durable to say about is dropped.
- A section whose AI call failed after its retries keeps its old text.
- A section that has facts but is missing from the file is rebuilt, which also
  repairs a `CODEBASE.md` that an earlier version cut short.
- After a full rebuild, for a new high model or a new synthesis version, no old
  text is kept.

When the guide call fails, `sync` keeps the review guides the last run wrote,
`SKILL.md` keeps its link to them, and `--json` says `reviewGuide` `kept`, see
[`init --json`](init.md#json-output).

## Scheduled sync

A [`serve`](serve.md) instance can run `sync` for you. Open a repository in the
dashboard, go to **Settings**, and fill **Scheduled sync** with a five field
cron expression (minute, hour, day of month, month, day of week). Leave it blank
to turn it off.

| Example | Runs |
| ------- | ---- |
| `0 3 * * 1` | Every Monday at 03:00 UTC |
| `30 4 * * *` | Every day at 04:30 UTC |
| `0 */6 * * *` | Every six hours, on the hour |

- Times are UTC.
- The minute field takes a single value, so a schedule fires at most once an
  hour. A sync spends model tokens, and this keeps a typo from burning them.
- As in classic cron, a day field that starts with `*` counts as unrestricted, so
  both day fields must match. `0 0 */2 * 1` runs only on Mondays that fall on an
  odd day of the month. When neither day field has a `*`, either one matching is
  enough.
- A repository is skipped while its first setup is unfinished or while another
  setup or sync for it is queued or running.
- A minute the server was down for is not made up. The next matching minute runs.
- The scheduler lives inside `serve`, so nothing runs while `serve` is stopped.

The schedule is stored per repository as `remakeCron` in
[`config.json`](configuration.md#per-repo-memory). The key keeps its original
name so existing config files keep working.

Next: [`review`](review.md). For a one-off refresh before a local review, see
`--sync-before-review` in [local review](local-review.md).
