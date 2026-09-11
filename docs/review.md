# `review`

`review` checks one pull request against the generated review guides. It uses
GitHub CLI data and OpenRouter only.

## Usage

```sh
co-maintainer review owner/repo 123 --log-time --debug
```

The command reads `PR_REVIEW_GUIDE.md` and, when `init` generated one,
`CODEBASE.md` (the repository's own code layout, style, and test conventions),
fetches the PR description, comments, reviews, changed files, and diff, then
reports actionable findings — including a departure from the codebase's own
conventions even when no review-bar rule covers it. Use `--improve-matrix=N` for
repeated review passes. Results are printed to the terminal; AI usage is
recorded in the SQLite cache.
