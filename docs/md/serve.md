# `serve`

Long-running process for **self-hosted** co-maintainer: GitHub App webhooks,
background review jobs, the [dashboard](dashboard.md), and the API used by
[remote review](remote-review.md). One binary, one `app.db`, one config dir.

Linux (WSL included) is the recommended platform. See
[dashboard: Linux](dashboard.md#linux) for why.

## What it does

```mermaid
flowchart LR
  gh[GitHub App]
  gh -->|POST webhook| serve[co-maintainer serve]
  serve --> jobs[Review and reply jobs]
  serve --> dash[Dashboard UI]
  serve --> remote[Remote review API]
  jobs -->|App token| gh
  browser[Browser] --> dash
  cli[CLI review --remote] --> remote
```

| Piece | Role |
| ----- | ---- |
| `POST /github/webhook` | PR and conversation events enqueue work |
| Dashboard at `/` | Per-repo init/remake, settings, activity, credentials |
| Job worker | Auto PR reviews, setup jobs, conversation replies |
| Remote review | Shared repo context for laptops without local init |

Team flow: configure the App once, run `serve`, add repos on the dashboard,
then either webhooks review PRs or developers use [`review --remote`](remote-review.md).
CLI-only users can ignore `serve` until they need shared context or automation.

## Before you run

| Check | Why |
| ----- | --- |
| [Install](getting-started.md#1-install) `co-maintainer` | `serve` is a CLI command |
| GitHub App (optional at startup) | Add it later in the dashboard **Settings**, or with `co-maintainer set` ([Configuration](configuration.md)). Changes apply without a restart |
| `--github-webhook-secret=` (recommended) | Verifies webhook payloads |
| AI and GitHub access via dashboard **Get started** (`/setup`) or **Settings** | Reviews need models and repo access (can finish after first boot) |
| Public URL for webhooks (production) | GitHub must reach `POST .../github/webhook` |
| Linux or WSL for production | Other platforms log a warning and continue |

## Usage

```sh
co-maintainer set --github-app-id=... --github-app-private-key-file=./app.pem
co-maintainer set --github-webhook-secret=...
co-maintainer serve --port=5000

co-maintainer serve --port=5000 --password=your-dashboard-secret
co-maintainer serve --port=5000 --webhook-url=https://example.com/github/webhook
```

At startup, `serve` prints `app.db` path, dashboard URL, and webhook URL. On the
first start with password auth on it also generates a dashboard password and
prints it once. The password is stored in `config.json` as a hash, so later
starts keep it.

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `--port=N` | HTTP port (required, 1 to 65535) |
| `--password=...` | Replace the stored dashboard password (a random one is generated on the first start if none exists) |
| `--webhook-url=...` | Public webhook URL GitHub should use (also `CM_WEBHOOK_URL` or saved in Settings) |
| `--disable-auth=password` | Turn off password sign-in for this run |
| `--enable-auth=github` | Turn on GitHub OAuth sign-in for this run |
| `--inject-500` | Every mutating `/api/*` call returns 500 (failure UI testing, also `CM_INJECT_500=1`) |

Per-run `--disable-auth` / `--enable-auth` override values from `co-maintainer
set`. At least one sign-in method must stay enabled.

Persistent App, webhook, OAuth, and webhook URL fields: [Configuration](configuration.md)
and dashboard **Settings**.

## Sign in to the dashboard

**Password (default).** Copy the password from the `serve` console on first start,
or set it with `--password=...` or `co-maintainer set --password=...`. Change it
any time from **Settings**, which also signs out the other browser sessions.

**GitHub sign-in (optional).** One allowed GitHub user can sign in with the App's
OAuth client (no separate OAuth App).

1. On the GitHub App settings page, set **Redirect URL** to
   `http://<host>:<port>/auth/github/callback` (same host and port as `serve`).
2. Copy client ID and client secret from that page.
3. Save credentials and the allowed username:
   ```sh
   co-maintainer set --github-oauth-client-id=... \
     --github-oauth-client-secret=... \
     --github-oauth-allowed-user=your-github-username
   ```
4. Enable on the command line when needed:
   ```sh
   co-maintainer serve --port=5000 --enable-auth=github
   co-maintainer serve --port=5000 --disable-auth=password --enable-auth=github
   ```

OAuth and auth toggles can also be changed later in dashboard **Settings**. UI
routes and failure behavior: [Dashboard](dashboard.md).

## Webhook URL

Point the GitHub App webhook at:

`http://<host>:<port>/github/webhook`

The dashboard **Settings** field, `--webhook-url=...`, `CM_WEBHOOK_URL`, or
saved config override the default `http://localhost:<port>/github/webhook`.

When a secret is configured, `serve` checks `x-hub-signature-256`. Duplicate
delivery IDs are ignored. `pull_request` and review-comment events enqueue jobs
when the repo is active and rules allow it. Enable **Issue comments** and
**Issues: write** on the App if you want `@co-maintainer` conversation replies.

Manual PR review from the UI when GitHub cannot reach your host:
[Dashboard: Pull requests](dashboard.md#routes).

## Run with Docker

Each release is also published as an image at
`ghcr.io/groophylifefor/co-maintainer`, tagged with the version and, for stable
releases, `latest`. It bundles Node.js, `git`, and the codegraph binary that
reviews use.

```sh
docker run -d --name co-maintainer -p 5000:5000 \
  -v co-maintainer-data:/data \
  -e CM_WEBHOOK_URL=https://example.com/github/webhook \
  ghcr.io/groophylifefor/co-maintainer:latest

docker logs co-maintainer
```

The first start prints the dashboard password in the logs. To choose it yourself,
set it on the volume before the first start:

```sh
docker run --rm -v co-maintainer-data:/data \
  ghcr.io/groophylifefor/co-maintainer:latest set --password=your-dashboard-secret
```

- Everything lives in the `/data` volume: `config.json`, `app.db`, generated
  guides, and repository clones. Keep it to survive upgrades.
- The container listens on port `5000` and runs as the non-root `node` user
  (uid 1000). A bind mounted host folder must be writable by that user.
- The image runs `serve --port=5000` by default. Any other command works too,
  for example `... set --token=...`. The health check assumes port `5000`.
- Run one container per volume. Only one `serve` may write to an `app.db`.
- Upgrade by pulling the new tag and recreating the container with the same
  volume. Queued jobs that were interrupted are picked up again on start.

## Updating

Forward-only migrations: do not install an older CLI after a newer one has
opened `app.db`.

1. Stop `serve`.
2. `npm install -g co-maintainer@latest`
3. Start `serve` again with the same data directory.

Restart after upgrading. Do not reinstall while the old process is still
running. Same steps are listed on [Dashboard: Updating](dashboard.md#updating).
