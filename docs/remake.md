# `remake`

`remake` refreshes an existing skill using cached repository evidence.

## Usage

```sh
co-maintainer remake owner/repo --env=./.env --log-time
```

It requires a previous `init` or `remake`. Unchanged codebase files, PR
discussions, diffs, and AI jobs are reused. Changed evidence invalidates only
affected facts and skill sections. Use `--concurrent=N` to fetch new GitHub data
in parallel (default: `1`). Use `--extract-concurrent=N` to run `extract_unit`
AI jobs in parallel (default: `3`).
