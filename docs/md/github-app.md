# GitHub App

Automatic pull request reviews, webhooks, and the dashboard repositories all run
through one GitHub App. The dashboard can create it for you, so the private key,
webhook secret, and OAuth credentials are written straight into `config.json`
instead of being copied between two screens.

[`serve`](serve.md) runs the App. The App is **not** the same as CLI `gh` auth,
which is only for reading a repository locally. See
[Authentication](authentication.md) for the full picture.

## Create it from the dashboard

1. Start [`serve`](serve.md) and open the dashboard.
2. Set a public webhook address under **Settings**, **Server**.
3. In the GitHub App card, keep or edit the suggested name and press
   **Create GitHub App**.
4. GitHub shows the permissions and events listed below and asks you to confirm.
5. GitHub redirects back, and `serve` writes the App ID, private key, webhook
   secret, and OAuth client ID and secret into `config.json`.

The suggested name is `co-maintainer-<host>`, shortened to fit GitHub's 34
character cap. App names are globally unique, so GitHub rejects a duplicate and
the field stays editable. The button is refused, with the reason, until the
webhook address looks reachable from GitHub. See
[Dashboard: Webhook reachability](dashboard.md#webhook-reachability).

The creation is secured with a single-use server-side state that expires after
ten minutes, so the callback cannot be replayed.

## Install it on repositories

Creating the App does not install it. In GitHub, install the App on the
organization or account that owns your repositories, and choose which
repositories it can reach. The dashboard's **Add repository** list shows only
repositories the App can already see.

## Permissions

The manifest requests exactly the permissions the code uses, not a superset.

| Permission | Access | Why |
| ---------- | ------ | --- |
| Contents | Read | Read a repository's files, trees, and `PR_REVIEW_GUIDE.md` |
| Pull requests | Write | Read a pull request and post reviews and review comments |
| Issues | Write | Post and read issue comments, which is how a conversation reply is delivered |
| Checks | Write | Create and update the review check run |
| Metadata | Read | Required by every GitHub App |

No `administration`, no `actions`, and no `packages` access is requested.

## Events

| Event | Why it is subscribed |
| ----- | -------------------- |
| `pull_request` | Open, synchronize, and close decide whether a review runs |
| `pull_request_review` | Tracks review state for the auto-review rules |
| `pull_request_review_comment` | Delivers a reply in an existing review comment thread |
| `issue_comment` | Delivers a reply in a pull request conversation |

`installation` and `installation_repositories` are handled too, but they are
**not** in the subscription list: GitHub delivers both to every App without a
subscription, which is why the webhook handler accepts them.

## Manual setup

If you would rather create the App by hand, use the same values:

```sh
co-maintainer set --github-app-id=... --github-app-private-key-path=./app.pem
co-maintainer set --github-webhook-secret=...
co-maintainer set --github-oauth-client-id=... --github-oauth-client-secret=...
co-maintainer set --github-oauth-allowed-user=your-github-login
```

Set the webhook URL to `https://<your-host>/github/webhook` and subscribe to the
four events above. [Configuration](configuration.md#co-maintainer-set) lists every flag and the
three ways to supply the private key. OAuth is optional and only gates the
dashboard sign-in. See [`serve`: Sign in](serve.md#sign-in-to-the-dashboard).

## Rotating and moving the key

`--github-app-private-key-file` copies the key into `config.json`, so it keeps
working if the file moves. `--github-app-private-key-path` stores only the path,
so the secret never enters `config.json` and `serve` reads it at startup. If that
file is missing, `serve` warns and continues. See
[Configuration: App private key](configuration.md#app-private-key-inline-file-contents-or-path).

If a new key is generated in GitHub, save it and run the `set` command again, or
paste it into Settings. Credentials are read on every request, so the change
applies without a restart.

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| **Create GitHub App** is refused | Set a public webhook address first |
| App created but no review arrives | Install the App on the repository, turn on auto-review in repo **Settings**, and confirm the webhook delivered |
| Settings save returns `422` | The key or token is missing a scope GitHub requires |
| Webhook works but no review is posted | Check the Activity job log, then the AI key and models under **Settings** |

Webhook reachability problems are shown on each repository's **Overview** tab.
See [Dashboard: Webhook reachability](dashboard.md#webhook-reachability).
