# `serve`

`serve` runs the GitHub App webhook and a password-gated dashboard for managing
repos without the terminal. Linux (WSL included) is the recommended platform.
See [Decision 5](../PLAN.md) and [`dashboard`](dashboard.md).

## Usage

```sh
co-maintainer serve --port=5000
co-maintainer serve --port=5000 --password=...
co-maintainer serve --port=5000 --webhook-url=https://example.com/github/webhook
```

It requires the GitHub App to already be configured. Run
`co-maintainer set --github-app-id=... --github-app-private-key=...` (or
`--github-app-private-key-file=path`) first. `--github-webhook-secret=` is
optional. See [`configuration`](configuration.md).

`--password` is optional. If omitted, a random password is generated and printed
once to the console at startup. Copy it from there.

On a non-Linux host, `serve` prints a warning naming Linux as the recommended
platform, then continues.

## Memory

One-shot check on Windows, `CM_FAKE_AI=1`, dashboard pages plus one review job:
idle 77 MB, average 79 MB, peak 81 MB (process working set). The model runs
remotely in production, so local RAM stays in this band. Linux was not measured.

## Webhook endpoint

`POST /github/webhook` is unauthenticated. When a webhook secret is configured,
the raw body is checked against `x-hub-signature-256`. A bad signature is 401.
Unparseable JSON is 400. Everything else answers 200 in well under a second.

A delivery id already seen returns `{outcome:"duplicate"}`. New `pull_request`
events (`opened`, `reopened`, `synchronize`, `ready_for_review`) and
`pull_request_review` / `pull_request_review_comment` enqueue a review job, or
record why not (`repo-not-active`, `auto-review-off`, `draft`, `bot-author`,
`no-knowledge-yet`, `diff-too-large`, `no-code-changes`,
`nothing-new-since-last-round`, `own-comment`). Installation events update
`app.db`. Other events are recorded as ignored. A queued review job posts
through the GitHub App: `REQUEST_CHANGES` when there are findings, `COMMENT`
when there are none. If GitHub rejects the inline comments, it falls back to one
issue comment. Re-reviews can look at only the commits since the last round when
the repository's review setting is incremental.

Point the GitHub App's webhook URL at `http://<host>:<port>/github/webhook`. The
dashboard shows the same address. Set a public address with the editable Webhook
address field in Settings, `--webhook-url=...`, or `CM_WEBHOOK_URL`; the default
is the local development address `http://localhost:<port>/github/webhook`.

## Dashboard

Open `http://<host>:<port>/` and sign in with the dashboard password. Pages,
failure UI, credential checks, and the Linux note live in
[`dashboard`](dashboard.md).

## Updating

Stop `serve`, then install the new release, then start it again against the same
`app.db` and `config.json`:

```sh
deno install -f -g jsr:@murat/co-maintainer
```

Updates are forward only. Installing an older release after a newer one already
migrated the database is unsupported.

## Live e2e

`scripts/e2e.ts` opens a pull request with a seeded defect on a private test
repo, POSTs the `opened` webhook to a running `serve`, and asserts the App
posted a review with at least one finding. It refuses `CM_FAKE_AI=1`.
`CM_REPOS_DIR` must match `serve`. If that directory has no review guide yet,
the script writes a short fixture guide that the seeded defect violates.

```sh
E2E_REPO=owner/repo deno task e2e
```
