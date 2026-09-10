# `serve`

`serve` runs a small HTTP server: a webhook endpoint that logs every request
it receives, and a password-gated `/dashboard` for managing repos without
the terminal.

## Usage

```sh
co-maintainer serve --port=5000
co-maintainer serve --port=5000 --password=...
```

It requires the GitHub App to already be configured — run
`co-maintainer set --github-app-id=... --github-app-private-key=...` (or
`--github-app-private-key-file=path`) first; `--github-webhook-secret=` is
optional. See [`configuration`](configuration.md).

`--password` is optional. If omitted, a random password is generated and
printed once to the console at startup — copy it from there.

## Webhook endpoint

Every request to any path other than `/dashboard` is logged (method, path,
query, headers, and body — parsed as JSON when it is) and answered with a
plain `hello`. This is a placeholder for handling real GitHub App webhook
deliveries.

## Dashboard

`GET /dashboard` (and everything under it) requires HTTP Basic Auth — any
username, the `--password` value. It shows:

- The repos `init`/`remake` has already resolved settings for
  (`config.json`'s `repos` map), with a button to re-run `init`.
- A form to `init` a new `owner/repo`.
- The global config `co-maintainer set` writes — auth, AI provider, both
  models, the GitHub App credentials. Secret fields display masked and are
  left unchanged unless you type a new value.

Submitting the init form spawns `co-maintainer init owner/repo` as a
subprocess (the existing `init` command, unmodified) and streams its output
live to the page over Server-Sent Events. Only one init runs at a time; a
second request while one is in progress is rejected.
