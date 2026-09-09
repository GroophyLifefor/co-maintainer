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

Use `--max-pr-months`, `--max-commits`, and `--max-pull-request-change-lines` to
limit historical input.
