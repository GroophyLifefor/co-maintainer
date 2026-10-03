# Troubleshooting

Every CLI failure exits with one of three codes and prints a message, and often
a `Hint:` line, that says what broke and what to do next. This page lists the
codes and the messages you are likely to see.

See [Exit codes](review.md#exit-codes) for how a review's own findings choose
between 0 and 1.

## Exit codes

| Code | Meaning | Typical cause |
| ---- | ------- | ------------- |
| 0 | Success. A review found no blocking finding. | |
| 1 | Success, but a review found at least one blocking finding. | The `blocking` decision is [configurable](review.md#what-counts-as-blocking) |
| 2 | Usage or precondition error. Nothing was started. | A bad flag, a missing prerequisite, a rejected token |
| 3 | Runtime failure. The run started and could not finish. | A network or provider failure, an unexpected error |

Anything the CLI does not classify is reported as a runtime failure (3), which
is the safe default.

## Usage and precondition errors (exit 2)

| Message starts with | What happened | Fix |
| ------------------- | ------------- | --- |
| `GitHub CLI (gh) was not found` | `--auth=gh` needs the `gh` binary on `PATH` | Install it from [cli.github.com](https://cli.github.com/), or use `--auth=pat` |
| `owner/repo was not found, or your GitHub account cannot read it` | The repository does not exist, or your identity cannot see it | Check the spelling, then `gh auth login` or a PAT with repo scope |
| `--auth=pat requires a GitHub token` | `--auth=pat` with no token anywhere | Pass `--github-pat=...`, set `GITHUB_TOKEN` or `GH_TOKEN`, or `co-maintainer set --github-pat=...` |
| `repos/owner/repo/PR_REVIEW_GUIDE.md was not found` | Review without guides | Run [`init`](init.md) for that repo, or [`sync`](sync.md) if it was inited before |
| `Unknown command` / `Unknown option` | A typo in the command or flag | The message names the closest match. `co-maintainer help` lists every command |
| `OpenRouter rejected the API key`, `OpenAI rejected the API key`, `Anthropic rejected the API key` | The provider refused the key | Replace it with `co-maintainer set --token=...`. See [AI providers](providers.md#keys) |
| `does not know the model <name>` | The provider refused the model, for OpenRouter with `400` | Check the name on the provider's model list: [OpenRouter](https://openrouter.ai/models), [OpenAI](https://platform.openai.com/docs/models), [Anthropic](https://docs.anthropic.com/en/docs/about-claude/models) |
| `Missing low model` or `Missing high model` | No model is saved or passed, and there is no terminal to ask on | co-maintainer never picks a model. Pass `--low-model=` and `--high-model=`, or save them once with `co-maintainer set` |
| `No low model is configured.` or `No high model is configured.` | A review reached a model that was never set | Run `co-maintainer set --low-model=...`, or pass `--low-model=...` on the command |
| `review needs an AI provider` | `review --ai=none` | Pass a provider, or leave `--ai` out to use the saved one. See [AI providers](providers.md#where-each-provider-works) |
| `GitHub refused <METHOD> <endpoint>` | The token or the App lacks a permission for that call | The message names the missing permission, for example `Pull requests: Read and write`. See [Authentication](authentication.md) and [GitHub App](github-app.md) |
| `GitHub returned 404 for` | The repository does not exist, or the token or App cannot see it | The message repeats the permission the call needs |
| `--output must be: github` or `--output=github cannot be used with --json` | A bad `--output` value, or both output modes at once | Use `--output=github` alone. See [CI](ci.md) |
| `rejected the remote review token` | The server refused a `cmr_` token | Create a new one under Settings, Remote review, or the token was deactivated |
| `No BYOK key is set.` | `--remote-byok` with no key | `co-maintainer config set remote-byok <key>`, or set `CM_REMOTE_BYOK` |
| `This server (version X) does not support your own key.` | The server is too old to accept a key | Upgrade the server, or run without `--remote-byok` |
| `This server does not accept your own key.` | The server's BYOK policy is `off` | Run without `--remote-byok`, or ask the server's owner to allow it |
| `This server requires your own key.` | The server's BYOK policy is `require` | `co-maintainer review --remote --remote-byok` |
| `Your key was not kept across a server restart.` | The server restarted while your review was waiting | Run the review again. The server's own key is never used instead |
| `The AI provider rejected your own key.` | The provider refused the key you sent | Check the key. See [your own key](remote-review.md#your-own-ai-key) |
| `remote-token is empty` | The GitHub Action had no token, which is what a fork pull request gets | See [CI](ci.md#pull-requests-from-forks) |
| `Nothing to set` | `set` was called with no values | Pass at least one flag, for example `--token=...` |
| `There is no backup to roll back to` | `rollback` found no backup, or it is incomplete | A backup exists only after an upgrade migrated the database. See [Going back after an upgrade](#going-back-after-an-upgrade) |
| `The backup was taken when upgrading to` | The installed version is not the one that made the backup | Install that version and run `rollback` again |
| `Rollback needs your confirmation` | `rollback` has no terminal to ask on | Run it in a terminal, or pass `--yes` |
| `serve is already running` | Two `serve` processes share one `app.db` | Stop the other one, or point `CM_APP_DB` elsewhere |

`init`, `sync`, and `review` also refuse to start when a required value is still
missing and there is no terminal to prompt on. `--json` never prompts, so a
missing value with no default becomes a `2` with a message naming the flag.

## Runtime failures (exit 3)

| Message starts with | What happened | Fix |
| ------------------- | ------------- | --- |
| `Could not reach <host>` | The network failed. The cause code follows the host | Check connectivity, proxy, or the host name. `ENOTFOUND` means DNS |
| `OpenRouter returned an empty review` | The model produced no text | Usually a reasoning budget or a provider hiccup. Retry, or use a different high model |
| `OpenRouter request failed` | The provider returned an unclassified error | The raw body is never printed. Retry, then check `--debug` for the call |
| `OpenAI failed with` or `Anthropic failed with` | The provider returned an error that is not about the key or the model | The message carries the status. Retry, then check the provider's status page |
| `OpenAI refused to answer` or `Anthropic refused to answer` | The model declined the request | The message says why when the provider did. Change the model or the diff |
| `AI response was not valid JSON` | The model ignored the JSON request twice | The older Markdown parser runs as a fallback. Retry if the result looks off |
| `git diff failed` / `git <command> failed` | A git operation did not complete | Make sure the clone is healthy and no rebase or merge is in progress |
| `Could not back up the data before upgrading it` | The backup taken before a migration failed, so the migration did not run | Free disk space or fix the permissions of the data directory, then start again. Nothing was changed |
| `app.db is not open` | A command that needs the server database did not open it | Report it: `init` and `sync` open it for the run, `serve` keeps it open |

## Dashboard messages

These come back from the dashboard's API and show as a message next to the form.

| Message | What happened | Fix |
| ------- | ------------- | --- |
| `policy_in_use` (409) | `This repository uses a review policy, so the auto review, drafts and bots switches do not apply.` | Change the [review policy](review-policy.md) instead, or pick **Simple switches** first |
| `invalid_policy` (422) | The review policy cannot be read. The message says what is wrong | Fix the field it names. Nothing is saved |

## Going back after an upgrade

A release refuses a database newer than it knows, so you cannot install the old
version and open the new database. Instead, the first time an upgrade migrates
`app.db`, co-maintainer copies `app.db`, `cache.db` and `config.json` into a
`backups/previous` folder next to the database. There is one slot, and it holds
the version you upgraded from.

To go back, with the new version still installed and `serve` stopped:

```sh
co-maintainer rollback
npm i -g co-maintainer@<the version it prints>
```

`rollback` restores the backup and prints the version to install. It asks first,
because everything written after the upgrade is lost: reviews, settings and
cache. Pass `--yes` to skip the question. The files it replaced are kept in
`backups/rolled-back`, so a rollback made by mistake can be undone by hand.

It refuses when there is no backup, when `serve` is running, and when the
installed version is not the one that took the backup. If the copy cannot be
made, the migration does not run and nothing is changed.

## Platform notes

`serve` recommends Linux, WSL included. [Dashboard: Linux](dashboard.md#linux)
explains why. Windows is supported but treated as less predictable, and `serve`
logs a one-line warning that links to this page when it starts on another
platform.

For the GitHub App, [Authentication](authentication.md) covers how server access
differs from CLI access. For cost questions, see [Cost](cost.md).