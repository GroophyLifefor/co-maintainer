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
# Or by environment, which keeps the token off the command line:
CM_REMOTE_HOST=https://your-server CM_REMOTE_TOKEN=cmr_... co-maintainer review --remote
```

To run it on every pull request from a workflow, see [CI](ci.md).

## Parameters

Same as [local review](local-review.md) for diff and output flags:

| Flag | Meaning |
| ------ | ----- |
| `--json` | JSON on stdout |
| `--disable-codegraph` | Skip local codegraph |
| `--allow-tool-install` | Allow codegraph install without a prompt |
| `--fresh` | No carry-over from a prior remote run |
| `--to-branch=<name>` | Diff base branch |
| `--branch=<name>` | Branch when HEAD is detached |
| `--repo=owner/repo` | Override remote detection |
| `--remote-host=<url>` | Override the configured host for this run (needs `--remote`) |
| `--remote-token=<token>` | Override the configured token for this run (needs `--remote`) |
| `--remote-byok` | Send your own AI key with this review, see [your own key](#your-own-ai-key) |
| `--no-remote-byok` | Do not send it, even when `remote-byok-default` is on |
| `--output=github` | Print GitHub annotations and write the job summary, see [CI](ci.md). Cannot be used with `--json` |
| `--debug` | Verbose stderr |
| `--log-time` | Phase timings |

The codegraph question, and the conditions under which co-maintainer skips it,
are the same as [local review](local-review.md#codegraph).

Not supported with `--remote`: `--sync-before-review` (run
[`sync`](sync.md) on the server instead).

## Reading the server's guides

The same token that authorizes a review also reads the guides the server holds,
so you can inspect what your review will be judged against without downloading
anything:

```sh
co-maintainer view owner/repo --remote            # every guide, with headers
co-maintainer view owner/repo review-guide --remote   # one guide, raw
co-maintainer view owner/repo --list --remote     # file, size, build date
```

The output is the same format as a local `co-maintainer view`, with the same
`--list`, single-guide and header behavior. Only the source differs. `--path`
is local-only and is refused with `--remote`, because the directory belongs to
the machine you are on. A rejected token prints the same Settings hint
`review --remote` prints.

## Your own AI key

By default the server's provider and key pay for a remote review. A server can
also let you bring your own key (BYOK), so the review is billed to you and not to
the server. The server still chooses the provider and the models, only the key is
yours. See [AI providers](providers.md).

### From the command line

```sh
co-maintainer config set remote-byok YOUR_KEY          # save the key once
co-maintainer review --remote --remote-byok            # send it with this review
co-maintainer config set remote-byok-default on        # send it every time
co-maintainer review --remote --no-remote-byok         # but not this time
CM_REMOTE_BYOK=YOUR_KEY co-maintainer review --remote --remote-byok
```

`--remote-byok` only works with `--remote`. The key comes from `CM_REMOTE_BYOK`
first, then from the `remote-byok` config value. With `remote-byok-default on` the
flag is not needed, and `--no-remote-byok` turns it off for one run. Before it
sends anything, the CLI prints `Using your own key with the server's provider:`
followed by the provider's name.

The CLI never falls back to the server's key when you asked for your own. Each of
these stops the run with exit code 2 before the diff is sent:

| Message | Why | What to do |
| ------- | --- | ---------- |
| `No BYOK key is set.` | `--remote-byok` with no key anywhere | `co-maintainer config set remote-byok <key>`, or set `CM_REMOTE_BYOK` |
| `This server (version X) does not support your own key.` | The server predates the feature and would ignore the key, so the CLI refuses to rely on it | Upgrade the server, or run without `--remote-byok` |
| `This server does not accept your own key.` | The server's policy is `off` | Run without `--remote-byok` |
| `This server requires your own key.` | The server's policy is `require` and the run did not send one | `co-maintainer review --remote --remote-byok` |

If the host starts with `http://` and is not `localhost`, `127.0.0.1` or `::1`,
the CLI warns on stderr that anyone on the network path can read the key, then
carries on. Use `https://`. Both stderr lines are
left out with `--json`.

### On the server

The policy is a server setting, `off`, `allow` or `require`:

| Policy | A review without a key | A review with a key |
| ------ | ---------------------- | ------------------- |
| `off` (the default) | Uses the server's key | Refused with 403: `This server does not accept your own key.` |
| `allow` | Uses the server's key | Uses your key |
| `require` | Refused with 403: `This server requires your own key. Run with --remote-byok.` | Uses your key |

Set it under **Settings**, **Remote review**, **Client key policy (BYOK)**, with
`co-maintainer set --remote-byok-policy=allow`, or with the `CM_REMOTE_BYOK_POLICY`
environment variable. The variable wins over the saved value, so a hosted server
keeps its policy. The handshake tells the CLI which policy is in force and which
provider the server uses. It never includes a key or a model.

### What happens to the key

- It is kept in the server's memory for that one review. It is removed when the
  review finishes, is canceled, or is replaced by a newer submit.
- It is never written to `app.db`, to the cache, to the config, or to a log or a
  job log. A test searches the raw database file and every log for a known key
  after a full review.
- If the server restarts while your review is waiting, the key is gone with it.
  The review ends with `Your key was not kept across a server restart. Submit the
  review again.` and the server's own key is never used instead.
- If the provider refuses the key, the error says so and names your key:
  `The AI provider rejected your own key.` Other provider failures are reported
  as what they are.

### Cost

A review sent with a key is recorded as billed to the key's owner. The dashboard
keeps it out of the server's own spend. A total reads `$1.23 + $0.40 BYOK`, the
server's cost first and what clients paid with their own keys after the plus
sign. See [Cost](cost.md).

## Limits

- Submit body size is capped (handshake `limits.maxBodyBytes`).
- Concurrent remote reviews per token and job queue limits in dashboard Settings.
- If sync stops longer than `remoteSyncTimeoutSeconds`, the server cancels the job.

## Security

- Tokens are hashed at rest. Treat `cmr_…` like a password.
- A key you send travels with the request. Use an `https://` host, and see
  [What happens to the key](#what-happens-to-the-key).
- Deactivating or deleting a token cancels in-flight remote reviews for that token.
- Only your **diff** leaves the machine. The CLI shows a one-time notice per host.
