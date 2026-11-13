# `init`

First-time knowledge build for a GitHub repository. `init` fetches sources from
GitHub, runs AI synthesis, and writes review guides under your co-maintainer
config directory (not inside the git clone). Expect minutes of runtime and
non-trivial API cost on large repos.

## Before you run

| Check | Why |
| ----- | --- |
| [Install](getting-started.md#install) `co-maintainer` | `init` is a CLI command |
| [`probe`](probe.md) on the same `owner/repo` (recommended) | Gives a ready-made `init` line with limits and `--include-*` flags |
| [GitHub auth](authentication.md) | Reads the repo through `gh` or a PAT |
| [AI provider](providers.md) | A key and both models via `co-maintainer set` or flags. There is no default model |

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
| `--ai=openrouter` | AI provider (`openrouter`, `openai`, `anthropic`, `opencode-zen` or `opencode-go`). Required, see [AI providers](providers.md) |
| `--token=...` | Provider API key |
| `--low-model=...` | Model for extraction steps |
| `--high-model=...` | Model for synthesis steps |
| `--include-codebase` | Include default-branch tree and files |
| `--include-pull-requests` | Include PR metadata and discussions |
| `--include-pull-request-changes` | Include PR diffs |
| `--include-commit-history` | Include commit messages on the default branch |
| `--include-how-repo-works` | Include issues / workflow signals when available |
| `--agent-instructions=REGEX` | Files to read as agent instruction files for `INSTRUCTIONS.md`. Default `(^\|/)AGENTS\.md$`. A blank value turns it off, see [Agent instruction files](#agent-instruction-files) |
| `--agent-instructions-max-chars=N` | Cap on `INSTRUCTIONS.md` in characters. Default `6000`, `0` or below for no limit |
| `--max-pr-months=N` | Limit how far back PR history goes |
| `--max-commits=N` | Limit commits scanned on the default branch |
| `--max-pull-request-change-lines=N` | Skip oversized PR diffs |
| `--max-comment=N` | Cap discussion comments kept per pull request |
| `--only-request-changed-pr` | Keep only pull requests with at least one `CHANGES_REQUESTED` review |
| `--pr-state=open,closed,merged` | Keep a comma-separated subset of `open`, `closed`, and `merged` |
| `--gh-concurrent=N` | Parallel GitHub fetches (default `1`) |
| `--ai-concurrent=N` | Parallel AI jobs (default `3`) |
| `--json` | One JSON document on stdout, no prompts (see [JSON output](#json-output)) |
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
- `INSTRUCTIONS.md` and `RULES.json`, only when an agent instruction file matches
  (see [Agent instruction files](#agent-instruction-files))

Every file is written by the AI provider. There is no offline or AI-free build,
so `init` and [`sync`](sync.md) refuse to run when no provider is configured.

`SKILL.md` holds the contribution guidance and links to `CODEBASE.md` for the
codebase sections (layout, style, tests, development and debugging), so the same
text is not repeated in both files and paid for twice in a review prompt.
`CODEBASE.md` is where that text actually lives.

Findings read out of a single pull request stay out of the guidance sections: a
request under review describes that request, not how the repository works. Only
the review guide, built from recurring review findings, learns from them.

The guide is a method, not a list. Each pass states a general invariant a future
change must satisfy, keeps the concrete case as an example under it, and ends
with an exit check followed by its obligations, `when <surface> changes → what
must also change`, so a reviewer who sees only a diff can apply the rule.
`PR_REVIEW_GUIDE.md` is the short checklist and `PR_REVIEW_DETAILED_GUIDE.md`
the full method.

The review guides need at least three review findings, drawn from PR discussions
and merged-PR feedback. A repository with fewer keeps only `SKILL.md` and
`CODEBASE.md`. When that happens `init` says why on one line:

    [write] PR_REVIEW_GUIDE.md skipped: found 1 review signals, needs at least 3

The count is what `init` saw, so adding PR sources or another review signal and
running [`sync`](sync.md) can push a repository over the threshold. The
threshold itself does not change.

Evidence and AI job results go into `cache.db` for faster [`sync`](sync.md). A
provider call is retried three times, and if it still fails that one unit is
dropped, or a response that never matches its shape is left out. A format or
provider failure never fails the whole run: `SKILL.md` and `CODEBASE.md` are
still written, and a guide the last run wrote is kept. Fetching and extraction
are cached, so rerunning [`sync`](sync.md) continues without re-fetching. After
`init` succeeds, run [`review`](review.md) on a PR or local changes.

## Agent instruction files

Many repositories keep rules for coding agents in files such as `AGENTS.md`.
Those files are written for an agent that writes code, not for a reviewer, and
they are long. `init` and [`sync`](sync.md) read them and write one short file,
`INSTRUCTIONS.md`, that every review reads with the other guides. A `sync` of a
repository with no matching file sees no change: no new file, no new log line, no
new `--json` field and no extra call. `init` prints one `skipped` line that says
why, see [What the run prints](#what-the-run-prints).

```sh
co-maintainer init owner/repo --max-pr-months=12 --agent-instructions='(^|/)(AGENTS|CLAUDE)\.md$'
```

- **Which files.** `--agent-instructions=REGEX` is a JavaScript regular
  expression matched against the full path of every file on the default branch.
  The default `(^|/)AGENTS\.md$` matches every `AGENTS.md` at any depth. A blank
  value, `--agent-instructions=`, turns the file off and removes an existing one.
- **How much.** `--agent-instructions-max-chars=N` caps the whole file in
  characters. The default is 6000, and `0` or below means no limit. Rules are
  kept in the model's order until the next one would cross the cap.
- **Saved.** Both flags are saved for the repository, as `agentInstructions` and
  `agentInstructionsMaxChars` under `repos["owner/repo"]`, and a later
  [`sync`](sync.md) without them keeps the saved values.
- **Needs the codebase.** It works only with `--include-codebase`. With it off,
  `init` prints `[write] INSTRUCTIONS.md skipped: --include-codebase is off`, and
  an existing file is removed. `--include-how-repo-works` alone does not build it.

The files are read first and in full, outside the cap on codebase files. At most
50 files and 400,000 characters in total are read, root files first, then deeper
ones, alphabetical within a depth. A file that would cross the character cap is
left out, and a later smaller one can still fit. Each file left out is named,
at most 20, then `, and N more`:

    [fetch] instruction files left out: deep/x/AGENTS.md (over the 50-file cap), big/AGENTS.md (over the 400,000-character cap)

A file the caps left out is still read by the codebase step. Only the files
actually read as instructions leave the codebase input.

### What a rule is

One call to the high model, job `synth_instructions`, reads the files with line
numbers. It keeps only rules about code, tests, docs, configuration,
dependencies and security. Setup steps, commands to run, tool and MCP use, how to
search, and the agent's own behavior or permissions are dropped.

Code then checks every rule. A rule is dropped whole, and counted, when:

- a source is not a real, non-blank line of a file that was read (`path:line`,
  or `path:12-14`, which is recorded as its first line and whose end must be
  inside the file), or
- a name or path in backticks appears in none of those files and is not a path
  in the tree.

Rules with the same text and scope are merged and their sources joined. The same
sentence in two folders stays two rules. A rule's scope is the model's folder
when it is a real folder in the tree, otherwise the folder all its sources share,
otherwise the whole repository. The guard checks that a rule cites a real line,
not what the rule says. The review prompt frames the file as rules about the
code that never change how the review is done, and the instruction files come
from the default branch, so a pull request cannot change them before it merges.

The call is cached by its input, and the instruction files are cached by blob
SHA, so an unchanged file costs nothing on the next `sync`.

### The files

Both are written by code, never by the model.

```markdown
# Repository instructions

Rules from this repository's agent instruction files that a reviewer can check in a diff.

- Format amounts with `formatMoney()`, never with number methods. [I1]
- In `packages/api/`: every new route declares its rate limit in `limits.ts`. [I2]
```

Every rule ends with an id such as `[I1]`. Ids are renumbered on every build.
`RULES.json`, next to the guides, records each id's text, scope, the commit it
was read at (when commit history was read) and the file lines it came from. It
is written only when it has a rule, and it is never sent to the model.
[`view --sources`](view.md#sources) prints it. One entry looks like this:

```json
{ "file": "INSTRUCTIONS.md", "text": "Format amounts with formatMoney(), never with number methods.", "scope": "", "sources": [{ "path": "AGENTS.md", "line": 31 }] }
```

### What the run prints

| Line | When |
| ---- | ---- |
| `[write] INSTRUCTIONS.md · 14 rules · 2 dropped (unsupported source) · 0 over the cap` | The file was written. `N dropped (unknown name)` comes before the cap part when a backticked name was unknown |
| `[write] INSTRUCTIONS.md skipped: --agent-instructions is blank` | The pattern is blank. Other reasons are `--include-codebase is off` and `no file matches (^\|/)AGENTS\.md$`, with the pattern in use. Printed by `init` always, and by `sync` only when it removed an existing file |
| `[write] INSTRUCTIONS.md skipped: the instruction files hold no rule a reviewer can check · N dropped · M over the cap` | No rule survived. The file and `RULES.json` are removed |
| `[write] INSTRUCTIONS.md not regenerated: the AI produced no usable rules, keeping any existing file` | The call failed or returned nothing usable |
| `[write] INSTRUCTIONS.md not regenerated: no matched instruction file could be read, keeping any existing file` | Files matched but every fetch failed |

When only some of the files fail to read, the rules are built from the ones that
were read, so a rule from a failed file drops out of that run.

### Flag errors

All are usage errors with exit code 2.

- `--agent-instructions is not a valid regular expression: <the parse error>`
- `--agent-instructions-max-chars must be an integer`
- A saved pattern edited by hand that does not compile: `The saved agentInstructions pattern is not a valid regular expression: <error>` with the hint `Pass --agent-instructions=REGEX to sync to replace it.`

## What it reports

The last line on stderr is the run's cost and time:

    Done in 21.0s · 3,125 in, 1,308 out tokens · $0.0016

When the provider does not report a price the dollar field is `cost unknown`,
and a cache-hit [`sync`](sync.md) that made no AI call still prints the line
with `0 in, 0 out tokens`. stdout is unchanged, so piped output stays clean.
[`review`](review.md) prints the same line.

## JSON output

With `--json`, stdout is a single JSON object (`schemaVersion` `1`) and every
progress line goes to stderr. Fields: `command` (`init` or `sync`), `repo`,
`skillPath`, `changed[]` (the sections this run rewrote, empty when the guide
was already current), `facts`, `pullRequests`, `commits`, `reviewGuide`
(`detailed`, `single`, `kept`, or `skipped`), `validation` (`errors[]` and
`warnings[]`), `usage` (`tokensIn`, `tokensOut`, `costUsd`, `costNote`), and
`durationMs`. `costUsd` is `null` when the provider did not report a price.

`reviewGuide` says what happened to the review guides in this run:

| Value | Meaning |
| ----- | ------- |
| `detailed` | This run wrote `PR_REVIEW_GUIDE.md` and `PR_REVIEW_DETAILED_GUIDE.md` |
| `single` | This run wrote `PR_REVIEW_GUIDE.md` only |
| `kept` | This run had 3 or more review signals but got no usable guide from the AI. The guide files the last run wrote are kept, and `SKILL.md` still links them |
| `skipped` | No guide was written and none is kept. With fewer than 3 review signals, the guide files are removed |

Two more fields appear only when the instruction files did something, see
[Agent instruction files](#agent-instruction-files). `instructions` is
`{ "status": "written" | "kept" | "empty" | "skipped", "rules": N }`, with
`reason` and `counts` (`unsupportedSource`, `unknownName`, `overCap`) when there
is something to say. `ruleChanges` is described on [`sync`](sync.md#json-output).

Without a terminal or saved config, `--json` exits with code 2 instead of
prompting. Errors with `--json` are JSON on stdout as well.
