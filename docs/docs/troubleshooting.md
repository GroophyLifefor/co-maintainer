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
| `OpenRouter rejected the API key` | The provider refused the key with `401` | Replace it with `co-maintainer set --token=...` |
| `does not know the model <name>` | The provider refused the model with `400` | Check the name at [openrouter.ai/models](https://openrouter.ai/models) |
| `rejected the remote review token` | The server refused a `cmr_` token | Create a new one under Settings, Remote review, or the token was deactivated |
| `Nothing to set` | `set` was called with no values | Pass at least one flag, for example `--token=...` |
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
| `AI response was not valid JSON` | The model ignored the JSON request twice | The older Markdown parser runs as a fallback. Retry if the result looks off |
| `git diff failed` / `git <command> failed` | A git operation did not complete | Make sure the clone is healthy and no rebase or merge is in progress |
| `app.db is not open` | A command that needs the server database did not open it | Report it: `init` and `sync` open it for the run, `serve` keeps it open |

## Platform notes

`serve` recommends Linux, WSL included. [Dashboard: Linux](dashboard.md#linux)
explains why. Windows is supported but treated as less predictable, and `serve`
logs a one-line warning that links to this page when it starts on another
platform.

For the GitHub App, [Authentication](authentication.md) covers how server access
differs from CLI access. For cost questions, see [Cost](cost.md).