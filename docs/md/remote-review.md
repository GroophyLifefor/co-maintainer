# Remote review

Same **local git diff** as [local review](local-review.md), but **review guides
come from the server**. The team runs [`init`](init.md) / [`sync`](sync.md)
once on [`serve`](serve.md). Developers clone, set host and token, and run
`review --remote` without maintaining their own guide cache.

The model runs on the server as part of that path. Codegraph tools (when enabled)
still run on the laptop and return results through the tool bridge.

Overview: [`review`](review.md). Requires [`serve`](serve.md) and the
[dashboard](dashboard.md).

## Before you run

| Check | Why |
| ----- | --- |
| Server running `co-maintainer serve` | Hosts remote review API and shared repo context |
| Repo added on the dashboard with **init** / **sync** | Guides live on the server for everyone |
| **Settings → Remote review** token (`cmr_…`) | Bearer auth for the CLI |
| `co-maintainer set --remote-host=... --remote-token=...` on the laptop | CLI knows where to connect (or pass `--remote-host=` / `--remote-token=` for one run) |
| Git clone with the same diff you would use for local review | Command is still `review --remote` with no PR number |

You do **not** need a local `init` / `sync` for that repo if the server
already has it.

PR review (`owner/repo` + number) **cannot** use `--remote`.

## Usage

```sh
co-maintainer set --remote-host=https://your-server --remote-token=cmr_...
cd your/clone
co-maintainer review --remote
co-maintainer review --remote --json --disable-codegraph
# One-off, without saving host and token to the config:
co-maintainer review --remote --remote-host=https://your-server --remote-token=cmr_...
```

## Parameters

Same as [local review](local-review.md) for diff and output flags:

| Flag | Meaning |
| ------ | ----- |
| `--json` | JSON on stdout |
| `--disable-codegraph` | Skip local codegraph |
| `--allow-tool-install` | Allow codegraph install without a prompt |

The codegraph question, and the conditions under which co-maintainer skips it,
are the same as [local review](local-review.md#codegraph).
| `--fresh` | No carry-over from a prior remote run |
| `--to-branch=<name>` | Diff base branch |
| `--branch=<name>` | Branch when HEAD is detached |
| `--repo=owner/repo` | Override remote detection |
| `--remote-host=<url>` | Override the configured host for this run (needs `--remote`) |
| `--remote-token=<token>` | Override the configured token for this run (needs `--remote`) |
| `--debug` | Verbose stderr |
| `--log-time` | Phase timings |

Not supported with `--remote`: `--sync-before-review` (run
[`sync`](sync.md) on the server instead).

## Limits

- Submit body size is capped (handshake `limits.maxBodyBytes`).
- Concurrent remote reviews per token and job queue limits in dashboard Settings.
- If sync stops longer than `remoteSyncTimeoutSeconds`, the server cancels the job.

## Security

- Tokens are hashed at rest. Treat `cmr_…` like a password.
- Deactivating or deleting a token cancels in-flight remote reviews for that token.
- Only your **diff** leaves the machine. The CLI shows a one-time notice per host.
