# `remake`

`remake` refreshes an existing skill using cached repository evidence.

## Usage

```sh
co-maintainer remake owner/repo --env=./.env --log-time
```

It requires a previous `init` or `remake`. Unchanged codebase files, PR
discussions, diffs, and AI jobs are reused. Changed evidence invalidates only
affected facts and skill sections. Use `--gh-concurrent=N` to fetch new GitHub
data in parallel (default: `1`). Use `--ai-concurrent=N` to run `extract_unit`
and `synth_section` AI jobs in parallel (default: `3`).

`init` remembers everything it resolved for that repo (provider, models, auth,
limits, `include-*` flags) except the API token — see
[`configuration`](configuration.md). So a plain
`co-maintainer remake owner/repo --env=./.env` with no other flags reuses all of
it; only the token still needs to come from `--token` or the env file.
