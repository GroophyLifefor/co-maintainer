# `serve`

Runs the GitHub App webhook and the dashboard, side by side. Linux (WSL
included) is the recommended platform — see the
[Linux section of the dashboard doc](dashboard.md#linux) for why.

## Usage

```sh
co-maintainer serve --port=5000
co-maintainer serve --port=5000 --password=...
co-maintainer serve --port=5000 --webhook-url=https://example.com/github/webhook
```

Requirements before `serve` will start:

- The GitHub App must already be configured: `co-maintainer set --github-app-id=... --github-app-private-key=...` (or `--github-app-private-key-file=path`). See [`configuration`](configuration.md).
- `--github-webhook-secret=` is optional but recommended.
- On a non-Linux host, `serve` prints a warning and continues anyway.

## Signing in to the dashboard

**Password (default).** If you don't pass `--password=...`, `serve` generates
a random one and prints it once to the console at startup — copy it from
there.

**GitHub sign-in (optional).** Lets one specific GitHub account sign in
instead of, or alongside, the password. Reuses the GitHub App's own OAuth
client, so no separate OAuth App is needed.

1. On the App's GitHub settings page, under "Identifying and authorizing
   users", set the **Redirect URL** (sometimes called the callback URL) to
   `http://<host>:<port>/auth/github/callback` — the same host and port
   `serve` runs on. Without this, GitHub refuses with "This GitHub App must
   be configured with a callback URL."
2. Copy the App's client ID and client secret from the same page.
3. Save them, plus the one GitHub username allowed to sign in:
   ```sh
   co-maintainer set --github-oauth-client-id=... --github-oauth-client-secret=... --github-oauth-allowed-user=your-github-username
   ```
4. Turn methods on or off per `serve` run with `--disable-auth=password` and
   `--enable-auth=github`. A flag here always overrides what was saved with
   `set`; without a flag, `serve` falls back to the saved setting. At least
   one method must stay enabled, or `serve` refuses to start.

```sh
co-maintainer serve --port=5000                                    # password only (default)
co-maintainer serve --port=5000 --enable-auth=github                # password + GitHub
co-maintainer serve --port=5000 --disable-auth=password --enable-auth=github  # GitHub only
```

All of this — the OAuth fields and both toggles — can also be changed later
from the dashboard's Settings page.

## Memory

One-shot check on Windows, `CM_FAKE_AI=1`, dashboard pages plus one review job:

- idle 77 MB, average 79 MB, peak 81 MB (process working set)
- the model runs remotely in production, so local RAM stays in this band
- Linux was not measured

## Webhook endpoint

`POST /github/webhook`:

- Unauthenticated at the HTTP layer. When a webhook secret is configured, the
  raw body is checked against `x-hub-signature-256` — a bad signature is 401,
  unparseable JSON is 400, everything else answers 200 in well under a
  second.
- A delivery id already seen returns `{outcome:"duplicate"}`.
- New `pull_request` events (`opened`, `reopened`, `synchronize`,
  `ready_for_review`) and `pull_request_review` /
  `pull_request_review_comment` events enqueue a review job, or record why
  one wasn't queued: `repo-not-active`, `auto-review-off`, `draft`,
  `bot-author`, `no-knowledge-yet`, `diff-too-large`, `no-code-changes`,
  `nothing-new-since-last-round`, `own-comment`.
- Installation events update `app.db`; everything else is recorded as
  ignored.
- A queued review job posts through the GitHub App: `REQUEST_CHANGES` when
  there are findings, `COMMENT` when there are none. If GitHub rejects the
  inline comments, it falls back to one issue comment.
- A human reply to a co-maintainer inline comment, or an `@co-maintainer`
  mention elsewhere in the PR conversation, enqueues a separate reply job.
- Re-reviews only look at the commits since the last round when the
  repository's review setting is incremental.

Point the GitHub App's webhook URL at `http://<host>:<port>/github/webhook`
(the dashboard shows the same address). Set a public address with the
editable Webhook address field in Settings, `--webhook-url=...`, or
`CM_WEBHOOK_URL`; the default is the local development address
`http://localhost:<port>/github/webhook`. Enable the GitHub App's `Issue
comments` webhook event and grant `Issues: write` if you want conversation
replies.

## Dashboard

Open `http://<host>:<port>/` and sign in. Pages, the failure UI, credential
checks, and the Linux note all live in [`dashboard`](dashboard.md).

## Updating

Updates are forward only — installing an older release after a newer one has
already migrated the database is unsupported.

1. Stop `serve`.
2. `deno install -f -g jsr:@murat/co-maintainer`
3. Start `serve` again against the same `app.db` and `config.json`.

Don't run `deno install -f` while `serve` is still running and expect the new
binary to take over — restart after installing.

## Live e2e

```sh
E2E_REPO=owner/repo deno task e2e
```

`scripts/e2e.ts` opens a pull request with a seeded defect on a private test
repo, POSTs the `opened` webhook to a running `serve`, and asserts the App
posted a review with at least one finding.

- It refuses `CM_FAKE_AI=1`.
- `CM_REPOS_DIR` must match `serve`.
- If that directory has no review guide yet, the script writes a short
  fixture guide that the seeded defect violates.
