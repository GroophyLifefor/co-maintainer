# Commands

Reference for every visible command. This page is generated from the command
registry in the source, so it always matches `co-maintainer help` and
`co-maintainer help <command>`.

## `co-maintainer probe`

Inspect a repository and recommend the init flags for it.

```
co-maintainer probe owner/repo [options]
```

### GitHub access

| Flag | Default | Description |
|---|---|---|
| `--auth=gh\|pat` | gh | Use the gh CLI or a personal access token. |
| `--github-pat=TOKEN` |  | The token when --auth=pat. |

### Limits

| Flag | Default | Description |
|---|---|---|
| `--max-pull-request-change-lines=N` |  | Cap the diff size sampled. |
| `--max-pr-months=N` |  | Cap how far back pull requests are read. |
| `--max-commits=N` |  | Cap how many commits are read. |

### After the plan

| Flag | Default | Description |
|---|---|---|
| `--run` |  | Run the recommended init in this same process. |

### Output and diagnostics

| Flag | Default | Description |
|---|---|---|
| `--json` |  | Print machine-readable JSON instead of prose. |
| `--debug` |  | Print the underlying gh and HTTP calls. |
| `--log-time` |  | Print how long each phase took. |

## `co-maintainer init`

Build the review guides for a repository for the first time.

```
co-maintainer init owner/repo [options]
```

### Sources

| Flag | Default | Description |
|---|---|---|
| `--include-codebase` |  | Read the source tree. |
| `--include-pull-requests` |  | Read pull request history. |
| `--include-pull-request-changes` |  | Read the diffs of those pull requests. |
| `--include-commit-history` |  | Read commit history. |
| `--include-how-repo-works` |  | Read the docs and layout. |

### Limits

| Flag | Default | Description |
|---|---|---|
| `--max-commits=N` | all | Cap how many commits are read. |
| `--max-pr-months=N` | all | Cap how far back pull requests are read. |
| `--max-pull-request-change-lines=N` | all | Cap the diff size read. |
| `--max-comment=N` |  | Cap the comments read per pull request. |

### Pull request filter

| Flag | Default | Description |
|---|---|---|
| `--pr-state=open,closed,merged` |  | Which pull request states to read. |
| `--only-request-changed-pr` |  | Read only the pull requests that changed the requested files. |

### AI

| Flag | Default | Description |
|---|---|---|
| `--ai=none\|openrouter\|hetzner` | none | Which provider writes the review. |
| `--token=KEY` |  | The provider API key. |
| `--ai-key=KEY` |  | The same key as --token, named for what it is. |
| `--low-model=ID` | openai/gpt-oss-120b | Model for extraction work. |
| `--high-model=ID` | openai/gpt-5.6-luna | Model for the review itself. |

### GitHub access

| Flag | Default | Description |
|---|---|---|
| `--auth=gh\|pat` | gh | Use the gh CLI or a personal access token. |
| `--github-pat=TOKEN` |  | The token when --auth=pat. |

### Output and diagnostics

| Flag | Default | Description |
|---|---|---|
| `--json` |  | Print machine-readable JSON instead of prose. |
| `--debug` |  | Print the underlying gh and HTTP calls. |
| `--log-time` |  | Print how long each phase took. |

### Performance

| Flag | Default | Description |
|---|---|---|
| `--gh-concurrent=N` | 1 | Concurrent gh calls. |
| `--ai-concurrent=N` | 3 | Concurrent AI calls. |
| `--improve-matrix=N` | 1 | How many improvement passes to run. Capped at 4, and each pass costs more. |

## `co-maintainer sync`

Rebuild the review guides for a repository that already has them.

```
co-maintainer sync owner/repo [options]
```

### Sources

| Flag | Default | Description |
|---|---|---|
| `--include-codebase` |  | Read the source tree. |
| `--include-pull-requests` |  | Read pull request history. |
| `--include-pull-request-changes` |  | Read the diffs of those pull requests. |
| `--include-commit-history` |  | Read commit history. |
| `--include-how-repo-works` |  | Read the docs and layout. |

### Limits

| Flag | Default | Description |
|---|---|---|
| `--max-commits=N` |  | Cap how many commits are read. |
| `--max-pr-months=N` |  | Cap how far back pull requests are read. |
| `--max-pull-request-change-lines=N` |  | Cap the diff size read. |
| `--max-comment=N` |  | Cap the comments read per pull request. |

### AI

| Flag | Default | Description |
|---|---|---|
| `--ai=none\|openrouter\|hetzner` | none | Which provider writes the review. |
| `--token=KEY` |  | The provider API key. |
| `--ai-key=KEY` |  | The same key as --token, named for what it is. |
| `--low-model=ID` | openai/gpt-oss-120b | Model for extraction work. |
| `--high-model=ID` | openai/gpt-5.6-luna | Model for the review itself. |

### GitHub access

| Flag | Default | Description |
|---|---|---|
| `--auth=gh\|pat` | gh | Use the gh CLI or a personal access token. |
| `--github-pat=TOKEN` |  | The token when --auth=pat. |

### Output and diagnostics

| Flag | Default | Description |
|---|---|---|
| `--json` |  | Print machine-readable JSON instead of prose. |
| `--debug` |  | Print the underlying gh and HTTP calls. |
| `--log-time` |  | Print how long each phase took. |

## `co-maintainer review`

Review a pull request, or the local changes in this workspace.

```
co-maintainer review owner/repo PR_NUMBER [options]
co-maintainer review [options]
```

### Target

| Flag | Default | Description |
|---|---|---|
| `--repo=owner/repo` |  | The repository the local changes belong to. |
| `--branch=NAME` |  | The branch the local changes are on. |
| `--to-branch=NAME` |  | Compare the local changes against this branch. |
| `--fresh` |  | Ignore the previous review and start over. |

### Local only

| Flag | Default | Description |
|---|---|---|
| `--remote` |  | Send the diff to the configured remote server instead of reviewing locally. |
| `--remote-host=URL` |  | Override the configured remote host for this run (needs --remote). |
| `--remote-token=TOKEN` |  | Override the configured remote token for this run (needs --remote). |
| `--sync-before-review` |  | Rebuild the guides before reviewing. |

### Codegraph

| Flag | Default | Description |
|---|---|---|
| `--disable-codegraph` |  | Skip the codegraph index. |
| `--allow-tool-install` |  | Install codegraph if it is missing. |

### AI

| Flag | Default | Description |
|---|---|---|
| `--ai=none\|openrouter\|hetzner` | none | Which provider writes the review. |
| `--token=KEY` |  | The provider API key. |
| `--ai-key=KEY` |  | The same key as --token, named for what it is. |
| `--low-model=ID` | openai/gpt-oss-120b | Model for extraction work. |
| `--high-model=ID` | openai/gpt-5.6-luna | Model for the review itself. |

### GitHub access

| Flag | Default | Description |
|---|---|---|
| `--auth=gh\|pat` | gh | Use the gh CLI or a personal access token. |
| `--github-pat=TOKEN` |  | The token when --auth=pat. |

### Output and diagnostics

| Flag | Default | Description |
|---|---|---|
| `--json` |  | Print machine-readable JSON instead of prose. |
| `--debug` |  | Print the underlying gh and HTTP calls. |
| `--log-time` |  | Print how long each phase took. |

## `co-maintainer config`

Read and edit the user config without opening the file.

```
co-maintainer config list
co-maintainer config get <key>
co-maintainer config set <key> <value>
co-maintainer config unset <key>
co-maintainer config path [--all]
```

### Subcommands

| Flag | Default | Description |
|---|---|---|
| `--all` |  | With `path`, also print the repos and cache directories. |

## `co-maintainer view`

Print the guides co-maintainer generated for a repository.

```
co-maintainer view [owner/repo] [guide]
co-maintainer view [owner/repo] --list
co-maintainer view [owner/repo] --path
```

### Guides

| Flag | Default | Description |
|---|---|---|
| `--list` |  | List the guide files with their size and build date. |
| `--path` |  | Print the directory the guides live in. |
| `--remote` |  | Read the guides from the configured remote review server instead. |

## `co-maintainer set`

Persist defaults and secrets to the user config file.

```
co-maintainer set [options]
```

### AI

| Flag | Default | Description |
|---|---|---|
| `--ai=none\|openrouter\|hetzner` | none | Which provider writes the review. |
| `--token=KEY` |  | The provider API key. |
| `--ai-key=KEY` |  | The same key as --token, named for what it is. |
| `--low-model=ID` | openai/gpt-oss-120b | Model for extraction work. |
| `--high-model=ID` | openai/gpt-5.6-luna | Model for the review itself. |

### GitHub access

| Flag | Default | Description |
|---|---|---|
| `--auth=gh\|pat` | gh | Use the gh CLI or a personal access token. |
| `--github-pat=TOKEN` |  | The token when --auth=pat. |

### Server

| Flag | Default | Description |
|---|---|---|
| `--github-app-id=ID` |  | The GitHub App id. |
| `--github-app-private-key=PEM` |  | The GitHub App private key. |
| `--github-app-private-key-file=PATH` |  | Read the private key from a file. |
| `--github-app-private-key-path=PATH` |  | Store the key's path only, never its contents. |
| `--github-webhook-secret=SECRET` |  | The webhook HMAC secret. |
| `--github-oauth-client-id=ID` |  | The GitHub OAuth app client id. |
| `--github-oauth-client-secret=SECRET` |  | The GitHub OAuth app client secret. |
| `--github-oauth-allowed-user=LOGIN` |  | The only GitHub user allowed to sign in. |
| `--remote-host=URL` |  | The remote review server. |
| `--remote-token=TOKEN` |  | The remote review token. |
| `--review-blocking=model\|severity` | model | How a review decides a blocking finding. |
| `--password=TEXT` |  | Replace the dashboard password. |
| `--disable-auth=password` |  | Turn the dashboard password off. |
| `--enable-auth=github` |  | Turn GitHub sign-in on. |
| `--no-verify` |  | Do not check the key and model against OpenRouter. |
| `--unset=NAME` |  | Remove a stored value. |

## `co-maintainer serve`

Run the dashboard, the webhook and the job worker.

```
co-maintainer serve --port=N [options]
```

### Server

| Flag | Default | Description |
|---|---|---|
| `--port=N` |  | The port to listen on. Required. |
| `--webhook-url=URL` |  | The public webhook URL. Defaults to localhost. |
| `--password=TEXT` |  | Set the dashboard password on first start. |
| `--disable-auth=password` |  | Turn the dashboard password off. |
| `--enable-auth=github` |  | Turn GitHub sign-in on. |
| `--trust-proxy` |  | Trust x-forwarded-for and x-forwarded-proto. |
| `--inject-500` |  | Return 500 for mutating requests. Debugging only. |

### Output and diagnostics

| Flag | Default | Description |
|---|---|---|
| `--json` |  | Print machine-readable JSON instead of prose. |
| `--debug` |  | Print the underlying gh and HTTP calls. |
| `--log-time` |  | Print how long each phase took. |

## `co-maintainer version`

Print the version.

```
co-maintainer version
```

See [Configuration](configuration.md) for the `config.json` keys, and
[Troubleshooting](troubleshooting.md) for a failing command.
