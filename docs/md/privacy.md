# Data and privacy

co-maintainer runs on your machine or your own server. This page says exactly
what it stores, where, and what leaves the machine.

## What leaves your machine

| Surface | Sent to | What |
| ------- | ------- | ---- |
| `probe`, `init`, `sync` | GitHub | API reads through `gh` or a PAT |
| `init`, `sync`, `review` | Your AI provider (OpenRouter) | The prompts: sampled code, pull request text, diffs, and guides |
| Remote `review` | Your `serve` instance | The git diff, plus codegraph tool requests and results |
| GitHub App review | GitHub | The review comment, the check run, and the inline comments |

Nothing is sent to the co-maintainer maintainers. There is no telemetry, no
analytics endpoint, and no call home. The only outbound hosts are the ones you
configured, plus the provider's price list when `probe` prices an estimate.

`review --remote` prints a one-time notice per host the first time it connects,
so it is clear where the diff is going.

## What is stored, and where

Everything lives under the config and cache directories. Nothing is written into
your git clone. [Caching](caching.md) has the full layout and the OS paths.

| Item | Location | Contains secrets |
| ---- | -------- | ---------------- |
| `config.json` | Config directory | Yes. Tokens, PATs, App private key, webhook and OAuth secrets, a scrypt password hash. Plain text, chmod `0600` where supported |
| `repos/<slug>/` | Config directory | No. The generated guides: `SKILL.md`, `CODEBASE.md`, review guides |
| `cache.db` | Cache directory | No. Evidence and AI job cache. It does hold sampled code and PR text from your repository |
| `app.db` | Cache directory | No. Server state: repos, jobs, reviews, token hashes, webhook dedup |
| `clones/`, `wt/` | Cache directory | No. Disposable bare clones and per-PR worktrees on a `serve` host |
| `tools/` | Cache directory | No. Pinned helper binaries such as codegraph |

Remote review tokens (`cmr_`) are stored as hashes in `app.db`, never in plain
text. The dashboard shows a new token once, at creation, and cannot show it
again.

## Secret handling

- `config.json` is the one file that holds plain-text secrets. On a shared or CI
  machine, prefer `--env=PATH` or command-line flags and keep the file out of
  version control. See [Configuration: Secrets on disk](configuration.md#secrets-on-disk).
- `--github-app-private-key-path` stores only the **path** to the App key, so the
  secret stays on disk and never enters `config.json`. See
  [Configuration: App private key](configuration.md#app-private-key-inline-file-contents-or-path).
- `co-maintainer config list` masks secrets. `config get` prints the real value,
  so treat its output as a secret.
- A review never prints a token. The CLI redacts known secret shapes from provider
  text before it is shown.

## What a review sends to the model

The prompt contains the diff, the review guides, the codebase conventions, the
pull request title and body, and any existing review comments. It does not
contain your API keys, your `config.json`, or your GitHub credentials. Codegraph
results, when a tool is used, are added as text.

## Deleting data

| Goal | Action |
| ---- | ------ |
| Remove generated guides | Delete `repos/<slug>/` under the config directory |
| Remove the CLI evidence cache | Delete `cache.db`. Guides may remain |
| Wipe the server | Stop `serve`, back up, then remove `app.db` (destructive) |
| Stop all data at rest | Uninstall the package and remove the config and cache directories |

Back up `app.db` and `config.json` before a major upgrade. See
[Dashboard: Updating](dashboard.md#updating).

Next: [Cloud](cloud.md) for running this on a shared host.
