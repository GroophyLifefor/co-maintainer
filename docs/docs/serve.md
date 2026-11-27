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
| Dashboard at `/` | Per-repo init/sync, settings, activity, credentials |
| Job worker | Auto PR reviews, setup jobs, conversation replies |
| Remote review | Shared repo context for laptops without local init |

Team flow: configure the App once, run `serve`, add repos on the dashboard,
then either webhooks review PRs or developers use [`review --remote`](remote-review.md).
CLI-only users can ignore `serve` until they need shared context or automation.

## Before you run

| Check | Why |
| ----- | --- |
| [Install](getting-started.md#install) `co-maintainer` | `serve` is a CLI command |
| GitHub App (optional at startup) | Add it later in the dashboard **Settings**, or with `co-maintainer set` ([Configuration](configuration.md)). Changes apply without a restart. The dashboard can also create it for you (see [Create the App from the dashboard](#create-the-app-from-the-dashboard)) |
| `--github-webhook-secret=` (recommended) | Verifies webhook payloads |
| AI and GitHub access via dashboard **Get started** (`/setup`) or **Settings** | Reviews need models and repo access (can finish after first boot) |
| Public URL for webhooks (production) | GitHub must reach `POST .../github/webhook` |
| Linux or WSL for production | Other platforms log a warning and continue |

## Usage

```sh
co-maintainer set --github-app-id=... --github-app-private-key-file=./app.pem
co-maintainer set --github-app-id=... --github-app-private-key-path=./app.pem
co-maintainer set --github-webhook-secret=...
co-maintainer serve --port=5000

co-maintainer serve --port=5000 --password=your-dashboard-secret
co-maintainer serve --port=5000 --webhook-url=https://example.com/github/webhook
```

`--github-app-private-key-file` copies the key into `config.json`.
`--github-app-private-key-path` stores only the path, so the key stays on disk
and is read at startup. If that file is missing, `serve` warns and continues.
See [Configuration: App private key](configuration.md#app-private-key-inline-file-contents-or-path).

With the App configured, **Add repository** and the init, sync and remake jobs
read the repository as the App, on the installation the repository belongs to.
The server needs no `gh` login and no personal access token for them. A
repository the App is not installed on still uses the saved `gh` or token login.

On non-Linux platforms, `serve` logs a one-line warning that Linux (WSL
included) is recommended, with a link to
[docs](https://co-maintainer.com/docs/troubleshooting.html). Nothing is blocked.

At startup, `serve` prints `app.db` path, dashboard URL, and webhook URL. On the
first start with password auth on it also generates a dashboard password and
prints it once. The password is stored in `config.json` as a hash, so later
starts keep it.

## Parameters

| Flag | Meaning |
| ------ | ----- |
| `--port=N` | HTTP port (required, 1 to 65535) |
| `--password=...` | Replace the stored dashboard password on every start, which signs every session out. A random one is generated on the first start if none exists. Leave it out of a service file and change the password in Settings |
| `--webhook-url=...` | Public webhook URL GitHub should use (also `CM_WEBHOOK_URL` or saved in Settings) |
| `--disable-auth=password` | Turn off password sign-in for this run |
| `--enable-auth=github` | Turn on GitHub OAuth sign-in for this run |
| `--trust-proxy` | Trust `x-forwarded-for` and `x-forwarded-proto` from a reverse proxy in front (also `CM_TRUST_PROXY=1`, see [Behind a reverse proxy](#behind-a-reverse-proxy)) |
| `--inject-500` | Every mutating `/api/*` call returns 500 (failure UI testing, also `CM_INJECT_500=1`) |
| `CM_REMOTE_BYOK_POLICY` | Whether a remote review may bring its own AI key: `off` (the default), `allow` or `require`, see [your own key](remote-review.md#your-own-ai-key) |
| `CM_REMOTE_CLIENT_TOOLS_POLICY` | Whether a remote review offers the model the tools a client declares, such as its own MCP servers: `off` (the default) or `on`, see [client tools](remote-review.md#your-own-mcp-servers-as-client-tools) |
| `CM_EXTENSIONS_DISABLED` | `1` turns [extensions](extensions.md) off: `register` refuses and no review runs one. The Cloud image sets it from outside the container |
| `CM_MCP_DISABLED` | `1` turns [MCP servers](review.md#mcp-servers) off: `set --mcp-config` refuses and no review starts one. The Cloud image sets it from outside the container |
| `CM_UPDATE_URL` | The host's update address. Turns on the daily check for a newer stable release and the dashboard's **Update** button, which POSTs the target version there. Unset, nothing calls out, see [Dashboard: Updates](dashboard.md#updates) |
| `CM_LOGIN_HINT` | Text shown on the sign-in page instead of the default "printed when `serve` started" line. Useful when a deployment hands out its own password, as the Cloud image does. Escaped as plain text |

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

**A one-time link (from the server).** Anyone with a shell on the server, a
script or an agent among them, can sign in without the password:

```bash
co-maintainer login-link
```

It prints one address, such as `https://review.example.com/login/link#...`.
Open it, then press **Sign in**. The link works once, for 5 minutes, and only on
that address. A new link replaces the old one, and a password change ends it.
Opening the link only shows the button, so a chat or mail preview cannot use it
up. The part after `#` never reaches the server or a proxy log. Making and
using a link are in the audit log, the link itself never is. It works with
password sign-in turned off too. The address comes from `CM_WEBHOOK_URL` or the
saved webhook URL. `serve --webhook-url` is not visible to another command, so
pass `--origin=https://your-address` then, or `--origin=http://localhost:PORT`
on a local server. `serve` must be running, with the same version.

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

The sign-in page says "Use the dashboard password printed when serve started."
Set `CM_LOGIN_HINT` to replace that line with your own text, for example a
pointer to the password your deployment already gave the user. It is shown as
plain text and escaped, so it cannot inject markup.

## Create the App from the dashboard

Creating an App by hand means copying a private key, a webhook secret, and OAuth
credentials between GitHub and the dashboard, and the webhook secret is easy to
mismatch. The GitHub App card in **Settings** can create the App for you instead:

1. Set a public **Webhook address** first. On `http://localhost:<port>...` the
   button explains that GitHub cannot reach it, so nothing silent happens.
2. Pick an **App name**. It defaults to `co-maintainer-<host>` and must be unique
   on GitHub, which the field lets you change.
3. Click **Create GitHub App**. The dashboard opens GitHub's manifest page, which
   asks you to confirm the permissions and events listed there.

GitHub then redirects back, and `serve` writes the App ID, private key, webhook
secret, and OAuth client ID and secret straight into `config.json`, the same keys
the manual fields use. The browser lands on the App's install page, where you
choose the repositories the App can see. The manual fields stay available for an
App you created yourself.

The manifest requests only what the code calls:

| Permission | Why |
| ---------- | --- |
| `contents: read` | Read the review guide, file contents, and git trees |
| `pull_requests: write` | Read a pull request, post reviews and review comments |
| `issues: write` | Post and read issue comments |
| `checks: write` | Create and update the review check run |
| `metadata: read` | Required by every App |

Events: `pull_request`, `pull_request_review`, `pull_request_review_comment`,
`issue_comment`. GitHub delivers `installation` and `installation_repositories`
without a subscription, so the manifest does not list them.

## Webhook URL

Point the GitHub App webhook at:

`http://<host>:<port>/github/webhook`

The dashboard **Settings** field, `--webhook-url=...`, `CM_WEBHOOK_URL`, or
saved config override the default `http://localhost:<port>/github/webhook`.

When a secret is configured, `serve` checks `x-hub-signature-256`. Duplicate
delivery IDs are ignored. `pull_request` and review-comment events enqueue jobs
when the repo is active and rules allow it. Enable **Issue comments** and
**Issues: write** on the App if you want `@co-maintainer` conversation replies.
A reply on a finding's thread knows the rules the finding rests on, with
their text and links, so it can say which rule a finding follows.
When a reply on a finding's thread agrees that the finding was wrong, the
finding closes at once. A later round does not raise it again while its lines
are unchanged.

Manual PR review from the UI when GitHub cannot reach your host:
[Dashboard: Pull requests](dashboard.md#routes).

## Behind a reverse proxy

Put `serve` behind nginx, Traefik, Caddy, or a load balancer and start it with
`--trust-proxy` (or `CM_TRUST_PROXY=1`). Two things change:

- **Client address.** Sign-in lockout counts failed attempts per address. Without
  the flag every visitor arrives from the proxy's address, so five wrong guesses
  from anyone lock the owner out. With it, `serve` uses the last address in
  `x-forwarded-for`, the one your proxy appended, and ignores anything a visitor
  put to its left. A value that is not an IP address is ignored.
- **Secure cookies.** When the last `x-forwarded-proto` is `https`, the session
  cookie is sent with the `Secure` flag.

Only turn this on when a proxy you control sits in front and sets both headers.
Without one, a visitor could send the headers themselves.

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

To run a command inside the container that is already running, call Node on the
built program. `co-maintainer` is not on the container's `PATH`, so this form is
the one that works:

```sh
docker exec co-maintainer node /app/dist/main.js login-link --origin=https://example.com
docker exec co-maintainer node /app/dist/main.js config
```

`login-link` prints a one-time dashboard sign-in link, valid for 5 minutes. Run
it where the server runs, so on a Docker server this is the way to get it. Give
the address you open the dashboard on with `--origin`, because a command started
with `docker exec` does not see the `CM_WEBHOOK_URL` the server was started with.

- **Inline, file, and path.** `set` writes the App private key three ways:
  inline, as file contents, or as a path. The path form keeps the key out of
  `config.json`, and a missing file is warned about at startup. See
  [Configuration: App private key](configuration.md#app-private-key-inline-file-contents-or-path).

## Extensions

`serve` runs the [extensions](extensions.md) registered in its own `config.json`
in the reviews it posts as the GitHub App and in remote reviews. Register them on
the `serve` host with `co-maintainer extension register`. The command runs as the
user that runs `serve` and can read that user's files, `config.json` included.
`CM_EXTENSIONS_DISABLED=1` turns them off. On start, `serve` removes the run
folders of extensions that are no longer running, and nothing else.

## MCP servers

`serve` starts a repository's [MCP servers](review.md#mcp-servers) in the
reviews it posts as the GitHub App and in remote reviews, from its own
`config.json`. Set them on the `serve` host with
`co-maintainer set --repo=owner/repo --mcp-config=./mcp.json`. The servers run
as the user that runs `serve`, with only their own `env`, `PATH` and `HOME`.

A pull request from a fork gets no MCP tools, because anyone can open one and
its diff could try to steer the model toward the private context. Turn them on
for one repository with:

```sh
co-maintainer set --repo=owner/repo --mcp-allow-forks=true
```

`CM_MCP_DISABLED=1` turns MCP off on the host.

## Updating

Forward-only migrations: do not install an older CLI after a newer one has
opened `app.db`.

1. Stop `serve`.
2. `npm install -g co-maintainer@latest`
3. Start `serve` again with the same data directory.

Restart after upgrading. Do not reinstall while the old process is still
running. Same steps are listed on [Dashboard: Updating](dashboard.md#updating).

A review that was running when `serve` stopped is picked up on the next start,
before the server listens. One still reading the pull request is reviewed again.
One GitHub already took is kept, with no second review. One GitHub never got is
marked failed, its check run says the commit was not reviewed, and **Retry** on
the dashboard runs it again.

GitHub does not send a webhook again when the server missed it. So on start,
`serve` also looks at the pull requests it reviewed in the last 14 days, at
most 50. When its review still asks for changes and the author pushed while it
was down, the new commit is queued for review under the same rules as a push.
When a blocking finding was closed but the approval never reached GitHub, the
approval is posted once. A pull request closed while it was down is left alone.

A Docker server pulls the new image and starts the container again on the same
volume, with the options it started with. **Settings**, **Server**, **Updates**
shows those lines. When the host sets `CM_UPDATE_URL`, the dashboard also says
when a newer release is out and offers an **Update** button, see
[Dashboard: Updates](dashboard.md#updates).
