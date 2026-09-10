# `probe`

`probe` researches a repository and recommends an `init` configuration. It does
not create or modify a skill.

## Usage

```sh
co-maintainer probe owner/repo --auth=gh
```

The command inspects pull-request activity, sampled diffs, releases, and the
default branch commit history. It recommends whether to include each source and
suggests limits such as `--max-pr-months`, `--max-commits`, and
`--max-pull-request-change-lines`.

Use `--env=PATH` when credentials or defaults are stored in an env file. The
output includes a ready-to-run `co-maintainer init` command with the recommended
flags and limits. Use `--gh-concurrent=N` to sample PR details with bounded
concurrency; the default is `1`. The same flag bounds GitHub fetches in `init`
and `remake`.
