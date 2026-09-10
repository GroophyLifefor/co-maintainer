# `init`

`init` performs the first repository analysis and writes generated files under
`repos/owner/repo/`.

## Usage

```sh
co-maintainer init owner/repo --auth=gh --ai=openrouter --token=...
```

Without explicit AI settings, the terminal asks for provider, API key, and
models. Values supplied through CLI arguments, `--env=PATH`, or user config are
not asked again.

Use `--max-pr-months`, `--max-commits`, `--max-pull-request-change-lines`, and
`--max-comment` (caps discussion comments kept per pull request) to limit
historical input. Use `--concurrent=N` to fetch listing pages, codebase
files, and pull-request details in parallel (default: `1`). Use
`--extract-concurrent=N` to run `extract_unit` AI jobs in parallel (default:
`3`).
