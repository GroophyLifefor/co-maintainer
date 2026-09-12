# Dashboard

The dashboard is the password-gated UI `serve` starts next to the webhook.

## Sign in

Open `http://<host>:<port>/` and enter the password printed at startup
(`--password=...`, or the random one `serve` generates). The session is a cookie
(`HttpOnly`, `SameSite=Lax`). On HTTPS the cookie also gets `Secure`.
`/dashboard` redirects to `/`.

## Pages

- `/` repository list, auto-review toggles
- `/setup` what is still missing (AI, GitHub, App)
- `/repos/new` pick a repository the GitHub App can already access, then init
- `/repos/:owner/:repo` overview
- `/repos/:owner/:repo/pulls` pull requests (titles are not stored, so the list
  shows `#n`). Enter any open PR number on this page to start a review manually
  when the webhook is unavailable
- `/repos/:owner/:repo/pulls/:n` findings and cost for that pull request
- `/repos/:owner/:repo/knowledge` generated guides (version history is empty
  until versions are stored)
- `/repos/:owner/:repo/settings` auto-review, skip rules, review scope, remake,
  remove
- `/activity` live jobs and recent work. The page refetches every 5 seconds. A
  job log is `/activity/:id`
- `/analytics` 7, 30, or 90 day usage
- `/settings` models, GitHub, App, defaults, webhook URL

Failed requests toast and show Retry. Toggles revert if the save fails. Saving a
PAT, `gh` access, or App key asks GitHub first. Missing scopes or App
permissions come back as 422 and the value is not stored.

`--inject-500` (or `CM_INJECT_500=1`) makes every mutating `/api/*` request
except login return 500 with `The request failed.` Leave it off otherwise.

## Linux

Linux (WSL included) is the recommended platform for `serve`. SQLite's FFI,
advisory file locks, and POSIX signals behave more predictably there. Windows is
supported but treated as unstable. `serve` prints a one-line warning when it is
not running on Linux.

## Updating

Updates are forward only. An older release after a newer one already migrated
`app.db` is unsupported.

1. Stop `serve`.
2. `deno install -f -g jsr:@murat/co-maintainer`
3. Start `serve` again against the same `app.db` and `config.json`.

Do not run `deno install -f` while `serve` is still running and expect the new
binary to take over. Restart after the install.
