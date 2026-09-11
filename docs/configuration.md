# Configuration

Configuration is read from the platform user config path:

- Linux: `~/.config/co-maintainer/config.json`
- macOS: `~/Library/Application Support/co-maintainer/config.json`
- Windows: `%APPDATA%\co-maintainer\config.json`

CLI arguments take precedence over `--env=PATH`, then a per-repo remembered
setting, then global user config, then interactive prompts and built-in
defaults. An env file is loaded only when `--env=PATH` is passed.

## `co-maintainer set`

```sh
co-maintainer set --token=... --ai=openrouter --low-model=... --high-model=...
co-maintainer set --unset=token
```

Writes global defaults — provider, both models, auth method, and (deliberately)
the API token — to config.json, so every command can skip both the flag and the
interactive prompt from then on. `--unset=name` removes one entry (`token`,
`ai`, `lowModel`/`low-model`, `highModel`/ `high-model`, `auth`).

This is a conscious tradeoff: the token is written to disk in plain text.
config.json is created with `0600` permissions where the platform supports it
(not on Windows), but it is still a file, not a secret store — prefer
`--env=PATH` or `--token=` per-invocation on a shared machine or CI. `set` is
for a personal dev machine where typing `--token=...` on every run is the actual
friction being removed.

## Per-repo memory

Every successful `init` or `remake` writes what it resolved — provider, models,
auth method, the `max-*` limits, and the `include-*` flags — under
`repos["owner/repo"]` in that same config.json, except the API token, which
`init`/`remake` never write (only `set` does, and only globally). This is what
lets a later `co-maintainer remake owner/repo` run with no flags and no
interactive prompts: everything but the token comes back from what `init` was
told the first time, and the token itself comes from `--env`, `--token=`, or a
`set --token=...` you ran once.

Generated skills (`SKILL.md`, `CODEBASE.md`, the review guides) are written
under a `repos/owner/repo/` subdirectory of that same config directory — never
relative to the current directory, since the CLI can be run from anywhere,
including a directory it has no permission to write into.
