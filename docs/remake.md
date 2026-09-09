# `remake`

`remake` refreshes an existing skill using cached repository evidence.

## Usage

```sh
co-maintainer remake owner/repo --env=./.env --log-time
```

It requires a previous `init` or `remake`. Unchanged codebase files, PR
discussions, diffs, and AI jobs are reused. Changed evidence invalidates only
affected facts and skill sections.
