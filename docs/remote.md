# Remote review (beta)

Run `co-maintainer review` on your laptop while the AI and repository knowledge stay on your co-maintainer server.

## Setup

1. On the server: add the repository in the dashboard, run **init** / **remake** so review guides exist.
2. In **Settings → Remote review**, create a bearer token (shown once).
3. On your machine:

```bash
co-maintainer set --remote-host=https://your-server --remote-token=cmr_...
```

## Run

```bash
co-maintainer review --remote
```

Same flags as local review where applicable (`--branch`, `--to-branch`, `--fresh`, `--json`, `--disable-codegraph`).

The CLI sends your git diff to the server, polls `/sync`, and runs **codegraph** tools locally when enabled (results flow back through the tool bridge).

## Limits

- Submit body size is capped (see handshake `limits.maxBodyBytes`).
- The server can limit concurrent remote reviews per token and job-queue concurrency in Settings.
- If sync stops for longer than `remoteSyncTimeoutSeconds`, the server cancels the job.

## Security

- Tokens are hashed at rest; treat `cmr_…` like a password.
- Deactivating or deleting a token cancels in-flight remote reviews for that token.
- Unpublished code leaves your machine only as the diff you submit; the CLI shows a one-time notice per host.
