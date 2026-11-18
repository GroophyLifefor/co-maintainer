# Cloud

The hosted service at `cloud.co-maintainer.com` runs [`serve`](serve.md) for
you, so your team gets shared repository context without operating a server.
This page explains how it relates to the CLI and the self-hosted setup.

Self-hosting stays supported. Cloud is the same binary with the same database
and the same remote review API, only managed for you.

## What cloud gives you

| Piece | Detail |
| ----- | ------ |
| Managed `serve` | The [dashboard](dashboard.md), the job worker, and the webhook receiver |
| Per-team instances | Each team gets its own instance and host name |
| Repository context | [`init`](init.md) and [`sync`](sync.md) run on the instance, not on every laptop |
| Remote review | Developers keep using `review --remote` against the instance |
| GitHub App | Created from the dashboard, the same flow as self-hosted |

## Connecting the CLI

The connection is identical to a self-hosted server: a host and a `cmr_` token.

1. Sign in to your instance and open **Settings**, **Remote review**.
2. Create a token and copy it once.
3. On the laptop:

```sh
co-maintainer set --remote-host=https://<your-instance> --remote-token=cmr_...
cd your/clone
co-maintainer review --remote
```

The CLI needs no local `init` for that repository, because the guides live on
the instance. See [Remote review](remote-review.md) for the full flag list and
the codegraph behavior, and [Authentication](authentication.md) for how the
token fits with the other credentials.

You can read the exact guides your review will use before running it:

```sh
co-maintainer view owner/repo --remote
```

## Putting a repository on the instance

Open the dashboard, choose **Add repository**, and confirm the plan. This is the
same flow as self-hosted, including the read-only probe and the cost estimate.
The dashboard needs the GitHub App installed on the repository, which the
**Create GitHub App** button sets up for you.

## Mixing cloud with local CLI

A team can keep using the CLI for local and PR review while cloud holds the
shared context. The two do not conflict:

| If you want | Run it |
| ----------- | ------ |
| Feedback on your working tree, before a push | `review` with local guides |
| Feedback using the team's shared context | `review --remote` against the instance |
| A PR reviewed automatically | The GitHub App on the instance |
| A repository onboarded once for everyone | Dashboard **Add repository** |

## Extensions are off

[Extensions](extensions.md) are always off in the cloud. The hosted service sets
`CM_EXTENSIONS_DISABLED=1` from outside the container, so nothing in your data
can turn them on.

## MCP servers are off

[MCP servers](review.md#mcp-servers) are always off in the cloud. The hosted
service sets `CM_MCP_DISABLED=1` from outside the container, so
`set --mcp-config` is refused and no review starts an MCP server.

## Versions and updates

An instance runs the image the host deployed. Each stable release publishes
`ghcr.io/groophylifefor/co-maintainer:<version>` and `:latest`.

The host sets `CM_UPDATE_URL` on the instance. With it, the dashboard reads the
latest stable release from GitHub at most once a day and keeps the answer. When
a newer one is out, admins see "co-maintainer 0.7.15 is out. This instance runs
0.7.14." in the sidebar and under **Settings**, **Server**, **Updates**, with a
link to the release notes.

**Update to 0.7.15** sends a `POST` to `CM_UPDATE_URL` with a JSON body:

```json
{"version":"0.7.15","current":"0.7.14"}
```

Any `2xx` answer means the host took the request. The host restarts the instance
on that image, and the card shows the update until the new version answers. Any
other answer, or no answer, shows that the update did not start. The button only
offers the latest stable release newer than the running one, never an older
version, and every update started is written to the [Audit log](dashboard.md#audit-log).

Without `CM_UPDATE_URL` the instance never asks for the latest release, and
Settings shows the `docker pull` and restart lines a self-hosted server uses. See
[Dashboard: Updates](dashboard.md#updates).

## Support and status

The instance list, uptime, and any incident notes are published by the
co-maintainer maintainers. For a self-hosted deployment, the same pages under
[Serve](serve.md) and the [Dashboard](dashboard.md) apply.

If a remote review fails, [Troubleshooting](troubleshooting.md) lists the token
and connectivity messages, and [Data and privacy](../privacy.html) says what the
instance stores.
