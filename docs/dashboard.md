# Dashboard

The web UI `serve` starts next to the webhook, for managing repositories
without touching the terminal.

## Sign in

Open `http://<host>:<port>/`.

- **Password**: the one printed at startup (`--password=...`, or the random
  one `serve` generates).
- **GitHub** (if enabled): a "Continue with GitHub" button signs in the one
  allowed account. See [`serve`](serve.md#signing-in-to-the-dashboard) for
  setup.

The session is stored in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` too,
over HTTPS). `/dashboard` redirects to `/`.

## Pages

- `/` — repository list, auto-review toggles
- `/setup` — what's still missing before reviews can run (AI provider,
  GitHub access, the GitHub App)
- `/repos/new` — pick a repository the GitHub App can already access, then
  run `init` on it from the browser
- `/repos/:owner/:repo` — overview
- `/repos/:owner/:repo/pulls` — pull requests (titles aren't stored, so these
  show as `#n`). Enter any open PR number here to start a review manually
  when the webhook isn't reachable.
- `/repos/:owner/:repo/pulls/:n` — findings and cost for one pull request
- `/repos/:owner/:repo/knowledge` — generated guides (version history is
  empty until versions are stored)
- `/repos/:owner/:repo/settings` — auto-review, skip rules, review scope,
  remake, remove
- `/activity` — live jobs and recent work, refetching every 5 seconds. A
  job's own log is at `/activity/:id`.
- `/analytics` — 7, 30, or 90 day usage
- `/settings` — models, GitHub access, the GitHub App, sign-in methods,
  defaults, webhook URL

Failed requests show a toast and a Retry button; a toggle reverts if its save
fails. Saving a personal access token, `gh` access, an App key, or GitHub
OAuth credentials checks them against GitHub first — missing scopes or
permissions come back as a 422 and nothing is stored.

`--inject-500` (or `CM_INJECT_500=1`) makes every mutating `/api/*` request
except login return 500 with `The request failed.`, for exercising the
failure UI. Leave it off otherwise.

## Linux

Linux (WSL included) is the recommended platform for `serve`:

- SQLite's FFI, advisory file locks, and POSIX signals all behave more
  predictably there.
- Windows is supported but treated as unstable.
- `serve` prints a one-line warning whenever it isn't running on Linux.

## Updating

Updates are forward only: installing an older release after a newer one has
already migrated `app.db` is unsupported.

1. Stop `serve`.
2. `deno install -f -g jsr:@murat/co-maintainer`
3. Start `serve` again against the same `app.db` and `config.json`.

Don't run `deno install -f` while `serve` is still running and expect the new
binary to take over — restart after installing.
