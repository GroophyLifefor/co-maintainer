# `review`

`review` runs an AI code review using the guides produced by `init` / `remake`.

Progress and diagnostics go to **stderr**. The final result goes to **stdout**
(human text or a single JSON object with `--json`).

## Usage

```sh
# Local branch (no PR number) — includes staged, unstaged, and untracked files
co-maintainer review

# GitHub pull request via `gh`
co-maintainer review owner/repo 123

# Machine-readable output (no prompts; errors are JSON on stdout too)
co-maintainer review --json
co-maintainer review owner/repo 123 --json
```

### Common options

| Flag | Meaning |
|------|---------|
| `--json` | Print one JSON document on stdout; no interactive prompts |
| `--disable-codegraph` | Skip codegraph tools (default is on for CLI) |
| `--allow-tool-install` | Install pinned codegraph without a prompt when missing |
| `--fresh` | Local only: ignore carry-over from the previous local review |
| `--to-branch=<name>` | Local base branch (default: remote default branch) |
| `--branch=<name>` | Branch name when HEAD is detached |
| `--repo=owner/repo` | Override GitHub remote detection |
| `--remake-before-review` | Local only: run `remake` before reviewing |

`--codegraph` is removed; use `--disable-codegraph` to turn tools off.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Review finished; no open blocking findings |
| 1 | Review finished; at least one blocking finding |
| 2 | Usage or precondition error (init missing, not a git repo, etc.) |
| 3 | Runtime failure or abort |

## JSON schema (success)

`schemaVersion` is `1`. Fields include `mode` (`local` or `pr`), `subject`,
`summary` (`new` / `open` / `closed` / `blocking`), `findings[]`, `warnings[]`,
`usage`, and `durationMs`. Local runs also include `base`, `revision`, and
`codegraph` state.

## Local carry-over

Repeated `co-maintainer review` on the same repo root and branch reuses prior
findings (closed / still open / new) via `cache.db`. If the cache cannot be read
or written, review continues with a `carry_over_unavailable` warning.

## Prerequisites

- `co-maintainer init owner/repo` (guides on disk)
- For PR review: `gh` authentication
- For local review: a GitHub `origin`/`upstream` remote (or `--repo=`)

See the implementation plan in `z_flow/7_cli_review_plan.md` for remote review
(`--remote`, PR 4) and full edge-case catalog.
