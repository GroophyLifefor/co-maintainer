# `review`

`review` checks one pull request against the generated review guides. It uses
GitHub CLI data and OpenRouter only.

## Usage

```sh
co-maintainer review owner/repo 123 --log-time --debug
```

The command reads `PR_REVIEW_GUIDE.md`, fetches the PR description, comments,
reviews, changed files, and diff, then reports actionable findings. Use
`--improve-matrix=N` for repeated review passes. Results are printed to the
terminal; AI usage is recorded in the SQLite cache.
