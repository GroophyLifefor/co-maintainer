# `probe`

Read-only research on a GitHub repository. `probe` samples pull requests and
commit history, then prints a recommended `co-maintainer init` command with
sensible `--include-*` and `--max-*` flags. It does not call the AI and does
not write skill files.

## Before you run

| Check | Why |
| ----- | --- |
| [Install](getting-started.md#1-install) `co-maintainer` | `probe` is a CLI command |
| [GitHub auth](authentication.md) (`gh auth login` or a PAT) | `probe` only reads the repo via the API |
| [Defaults](configuration.md) with `co-maintainer set` (optional) | Skips repeating `--auth=...` on every run |
| Read access to `owner/repo` | Private repos need a token or `gh` login that can see them |

If `probe` fails, fix GitHub access first (`gh auth status`), not co-maintainer.

## Usage

```sh
co-maintainer set --auth=gh
co-maintainer probe owner/repo
```

Output is a **recommended** block: a full `co-maintainer init ...` line
you can copy. 

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `owner/repo` | Repository to research (required) |
| `--auth=gh` | Use the GitHub CLI (default when unset: `gh`, or value from `set` / config) |
| `--auth=pat` | Use `GITHUB_TOKEN`, `GH_TOKEN`, `--github-pat=...`, or `set --github-pat=...` |
| `--github-pat=...` | PAT for `--auth=pat` when not in env or config |
| `--env=PATH` | Load env vars from a file (see [Configuration](configuration.md)) |
| `--gh-concurrent=N` | Parallel GitHub requests while sampling PR details (default `1`, minimum `1`) |
| `--debug` | Verbose logs on stderr |
| `--log-time` | Print timing for each probe phase |

`probe` ignores `--include-*`, `--max-*`, and AI flags. Those appear on the
**recommended `init` command** in the output when the analysis suggests them.

## What it looks at

- Repository metadata and latest release (if any)
- Pull request list (updated time, sampling across years)
- A bounded sample of PR diffs for size and activity
- Default-branch commit history

Use the printed `init` line as-is for a first run, or tighten limits if the repo
is huge and you want a cheaper `init`. Next step: [`init`](init.md).
