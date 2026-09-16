# Configuration

Configuration is read from the platform user config path:

- Linux: `~/.config/co-maintainer/config.json`
- macOS: `~/Library/Application Support/co-maintainer/config.json`
- Windows: `%APPDATA%\co-maintainer\config.json`

CLI arguments take precedence over `--env=PATH`, then a per-repo remembered
setting, then global user config, then interactive prompts and built-in
defaults. An env file is loaded only when `--env=PATH` is passed.

## `co-maintainer set`

Writes global defaults to `config.json`, so every command can skip both the
flag and the interactive prompt from then on. This is the same file `serve`
reads its GitHub App and dashboard settings from.

### AI provider, models, Git auth

```sh
co-maintainer set --ai=openrouter --low-model=... --high-model=... --token=...
co-maintainer set --auth=pat --github-pat=...
```

### GitHub App (webhooks, posting reviews)

```sh
co-maintainer set --github-app-id=... --github-app-private-key=...
co-maintainer set --github-app-private-key-file=./app-key.pem
co-maintainer set --github-webhook-secret=...
```

### GitHub sign-in for the dashboard

Reuses the App's own OAuth client — see
[`serve`](serve.md#signing-in-to-the-dashboard) for the full picture.

```sh
co-maintainer set --github-oauth-client-id=... --github-oauth-client-secret=... --github-oauth-allowed-user=your-github-username
co-maintainer set --disable-auth=password --enable-auth=github
```

### Unsetting a value

```sh
co-maintainer set --unset=token
co-maintainer set --unset=github-webhook-secret
co-maintainer set --unset=disable-auth   # turns the dashboard password back on
```

### Secrets on disk

This is a conscious tradeoff:

- The API token, the GitHub PAT, the App's private key, and the webhook and
  OAuth secrets are all written to `config.json` in plain text.
- `config.json` is created with `0600` permissions where the platform
  supports it (not on Windows) — but it's still a file, not a secret store.
- Prefer `--env=PATH` or a per-invocation flag on a shared machine or CI.
- `set` is meant for a personal dev machine or a `serve` host you control,
  where retyping these on every run is the actual friction being removed.

## Per-repo memory

Every successful `init` or `remake` writes what it resolved under
`repos["owner/repo"]` in that same `config.json`:

- provider, models, auth method
- the `max-*` limits
- the `include-*` flags
- **not** the API token — only `set` writes that, and only globally

This is what lets a later `co-maintainer remake owner/repo` run with no flags
and no interactive prompts: everything but the token comes back from what
`init` was told the first time, and the token itself comes from `--env`,
`--token=`, or a `set --token=...` you ran once.

Generated skills (`SKILL.md`, `CODEBASE.md`, the review guides) are written
under a `repos/owner/repo/` subdirectory of that same config directory —
never relative to the current directory, since the CLI can be run from
anywhere, including a directory it has no permission to write into.
