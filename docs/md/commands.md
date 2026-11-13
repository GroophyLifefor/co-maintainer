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
| `--agent-instructions=REGEX` | (^\|/)AGENTS\.md$ | Paths on the default branch to read as agent instruction files for INSTRUCTIONS.md. Needs --include-codebase. A blank value turns it off. Saved for later syncs. |

### Limits

| Flag | Default | Description |
|---|---|---|
| `--max-commits=N` | all | Cap how many commits are read. |
| `--agent-instructions-max-chars=N` | 6000 | Cap on INSTRUCTIONS.md in characters. 0 or below means no limit. Saved for later syncs. |
| `--max-pr-months=N` | all | Cap how far back pull requests are read. |
| `--max-pull-request-change-lines=N` | all | Cap the diff size read. |
| `--max-comment=N` |  | Cap the comments read per pull request. |

### Pull request filter

| Flag | Default | Description |
|---|---|---|
| `--pr-state=open,closed,merged` |  | Which pull request states to read. |
| `--only-request-changed-pr` |  | Read only the pull requests with at least one CHANGES_REQUESTED review. |

### AI

| Flag | Default | Description |
|---|---|---|
| `--ai=openrouter\|openai\|anthropic\|opencode-zen\|opencode-go` |  | Which provider writes the guides. Required: init and sync cannot run without one. |
| `--token=KEY` |  | The provider API key. |
| `--ai-key=KEY` |  | The same key as --token, named for what it is. |
| `--low-model=ID` |  | Model for extraction work. |
| `--high-model=ID` |  | Model for the review itself. |

### Experimental

| Flag | Default | Description |
|---|---|---|
| `--experimental-siwc` |  | Run on your ChatGPT plan through Sign in with ChatGPT instead of an API key. Cannot be combined with --ai. Set up with co-maintainer oauth. |

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
| `--gh-concurrent=N` | 1 | Concurrent GitHub calls for this run only. It does not change the saved default. |
| `--ai-concurrent=N` | 3 | Concurrent AI calls for this run only. It does not change the saved default. |
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
| `--agent-instructions=REGEX` |  | Paths on the default branch to read as agent instruction files for INSTRUCTIONS.md. Needs --include-codebase. A blank value turns it off. Left out, the last run's value is kept. |

### Limits

| Flag | Default | Description |
|---|---|---|
| `--max-commits=N` |  | Cap how many commits are read. |
| `--agent-instructions-max-chars=N` |  | Cap on INSTRUCTIONS.md in characters. 0 or below means no limit. Left out, the last run's value is kept. |
| `--max-pr-months=N` |  | Cap how far back pull requests are read. |
| `--max-pull-request-change-lines=N` |  | Cap the diff size read. |
| `--max-comment=N` |  | Cap the comments read per pull request. |

### AI

| Flag | Default | Description |
|---|---|---|
| `--ai=openrouter\|openai\|anthropic\|opencode-zen\|opencode-go` |  | Which provider writes the guides. Required: init and sync cannot run without one. |
| `--token=KEY` |  | The provider API key. |
| `--ai-key=KEY` |  | The same key as --token, named for what it is. |
| `--low-model=ID` |  | Model for extraction work. |
| `--high-model=ID` |  | Model for the review itself. |

### Experimental

| Flag | Default | Description |
|---|---|---|
| `--experimental-siwc` |  | Run on your ChatGPT plan through Sign in with ChatGPT instead of an API key. Cannot be combined with --ai. Set up with co-maintainer oauth. |

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
| `--gh-concurrent=N` | 1 | Concurrent GitHub calls for this run only. It does not change the saved default. |
| `--ai-concurrent=N` | 3 | Concurrent AI calls for this run only. It does not change the saved default. |

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
| `--remote-byok` |  | Send your own AI key with a remote review (needs --remote). |
| `--no-remote-byok` |  | Do not send your own AI key, even if remote-byok-default is on. |
| `--sync-before-review` |  | Rebuild the guides before reviewing. |

### Codegraph

| Flag | Default | Description |
|---|---|---|
| `--disable-codegraph` |  | Skip the codegraph index. |
| `--allow-tool-install` |  | Install codegraph if it is missing. |

### Custom instructions

| Flag | Default | Description |
|---|---|---|
| `--system-prompt-file=PATH` |  | Append this file's contents to the review instructions for this run only. |
| `--system-prompt-override-file=PATH` |  | Replace the repository's review instructions with this file for this run only. The built-in instructions are kept. |
| `--range=BEFORE..AFTER` |  | With --remote: review a push (commit watch). The server keeps the review going if this run stops waiting. |
| `--timeout-minutes=N` |  | With --range: stop waiting after N minutes and leave the result to the dashboard. Default 10. |

### Diagrams

| Flag | Default | Description |
|---|---|---|
| `--diagram-runtime=mermaid\|plantuml\|plantuml-server` | mermaid | The diagram language the review uses. plantuml keeps the PlantUML source. plantuml-server turns it into an image link on a PlantUML server. Not with --remote. |
| `--plantuml-server=URL` | https://www.plantuml.com | The PlantUML server for plantuml-server. An http or https URL. The diagram source travels in the image link. |
| `--plantuml-output-format=svg\|png` | svg | The image format for plantuml-server. |

### AI

| Flag | Default | Description |
|---|---|---|
| `--ai=none\|openrouter\|openai\|anthropic\|opencode-zen\|opencode-go` | none | Which provider writes the review. `none` turns AI off. |
| `--token=KEY` |  | The provider API key. |
| `--ai-key=KEY` |  | The same key as --token, named for what it is. |
| `--low-model=ID` |  | Model for extraction work. |
| `--high-model=ID` |  | Model for the review itself. |

### Experimental

| Flag | Default | Description |
|---|---|---|
| `--experimental-siwc` |  | Run on your ChatGPT plan through Sign in with ChatGPT instead of an API key. Cannot be combined with --ai. Set up with co-maintainer oauth. |

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
| `--output=github` |  | Print GitHub workflow annotations and write the job summary instead of prose. Cannot be used with --json. |

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
co-maintainer view [owner/repo] --sources [--json]
```

### Guides

| Flag | Default | Description |
|---|---|---|
| `--list` |  | List the guide files with their size and build date. |
| `--sources` |  | List every instruction rule by id, with the instruction file lines it came from. |
| `--json` |  | With --sources, print RULES.json as it is. |
| `--path` |  | Print the directory the guides live in. |
| `--remote` |  | Read the guides from the configured remote review server instead. |

## `co-maintainer clear`

Delete the generated guides and saved settings for a repository, or for every repository.

```
co-maintainer clear <owner/repo|all> [options]
```

### Clear

| Flag | Default | Description |
|---|---|---|
| `--include-cache` |  | Also delete the fetched evidence: pull request listings, AI job cache, costs, local review carry-over, clones and worktrees. The next init is then a cold build. |
| `--yes` |  | Skip the confirmation `all` asks. Needed when there is no terminal. |

## `co-maintainer uninstall`

Delete every co-maintainer data file on this machine.

```
co-maintainer uninstall [--yes]
```

### Uninstall

| Flag | Default | Description |
|---|---|---|
| `--yes` |  | Skip the confirmation. Needed when there is no terminal. |

## `co-maintainer oauth`

Sign in to an OAuth AI provider (experimental).

```
co-maintainer oauth login --provider=sign-in-with-chatgpt
co-maintainer oauth logout --provider=sign-in-with-chatgpt
co-maintainer oauth refresh --provider=sign-in-with-chatgpt
co-maintainer oauth ping --provider=sign-in-with-chatgpt
co-maintainer oauth list-models --provider=sign-in-with-chatgpt
```

### OAuth

| Flag | Default | Description |
|---|---|---|
| `--provider=sign-in-with-chatgpt` |  | Which provider to sign in to. `siwc` is accepted as a short alias. |

## `co-maintainer set`

Persist defaults and secrets to the user config file.

```
co-maintainer set [options]
```

### AI

| Flag | Default | Description |
|---|---|---|
| `--ai=none\|openrouter\|openai\|anthropic\|opencode-zen\|opencode-go` | none | Which provider writes the review. `none` turns AI off. |
| `--token=KEY` |  | The provider API key. |
| `--ai-key=KEY` |  | The same key as --token, named for what it is. |
| `--low-model=ID` |  | Model for extraction work. |
| `--high-model=ID` |  | Model for the review itself. |

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
| `--remote-byok-policy=off\|allow\|require` | off | Whether a remote client may send its own AI key. |
| `--remote-byok=KEY` |  | Your own AI key to send with a remote review. |
| `--remote-byok-default=on\|off` | off | Send remote-byok on every --remote review by default. |
| `--review-policy=everyone\|trusted-auto\|on-request-only` |  | The review policy new repositories start with. |
| `--review-policy-file=PATH` |  | Read a custom review policy from a JSON file and use it as that default. |
| `--repo=owner/repo` |  | Write the repository-scoped settings below to this repository instead of the global config. |
| `--gh-concurrent=N` |  | Server default for concurrent GitHub calls. With --repo, the repository override. 1..16. |
| `--ai-concurrent=N` |  | Server default for concurrent AI calls. With --repo, the repository override. 1..16. |
| `--review-system-prompt=TEXT` |  | A repository's own review instructions. Needs --repo. Empty clears it. |
| `--review-system-prompt-max-chars=N` |  | Cap the repository's review instructions in characters. Needs --repo. 0 or -1 means no limit. |
| `--diagram-runtime=mermaid\|plantuml\|plantuml-server` | mermaid | The diagram language for a repository's reviews, including App reviews. Needs --repo. |
| `--plantuml-server=URL` | https://www.plantuml.com | The PlantUML server for plantuml-server. An http or https URL. Needs --repo. |
| `--plantuml-output-format=svg\|png` | svg | The image format for plantuml-server. Needs --repo. |
| `--review-read-diff-max-chars=N` | 20000 | The most characters one read-full-diff answer returns in a review of this repository. Needs --repo. 0 or -1 means no limit. |
| `--review-blocking=model\|severity` | model | How a review decides a blocking finding. |
| `--codegraph-version=SEMVER` |  | The pinned codegraph version, overriding the built-in one. For a security fix without a release. |
| `--password=TEXT` |  | Replace the dashboard password. |
| `--extension-rerun-on-restart=true\|false` | true | Run an extension again when co-maintainer restarted while it ran. A registration's --rerun-on-restart wins. |
| `--disable-auth=password` |  | Turn the dashboard password off. |
| `--enable-auth=github` |  | Turn GitHub sign-in on. |
| `--no-verify` |  | Do not check the key and model against the provider. |
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
| `--debug` |  | Print the underlying gh and HTTP calls. |
| `--log-time` |  | Print how long each phase took. |

## `co-maintainer extension`

Register external commands whose results join every review.

```
co-maintainer extension register --name=NAME --command=COMMAND [options]
co-maintainer extension update --name=NAME [options]
co-maintainer extension list [--json]
co-maintainer extension remove --name=NAME
co-maintainer extension disable --name=NAME
co-maintainer extension enable --name=NAME
co-maintainer extension debug-run --name=NAME [--command=COMMAND]
```

### Extension

| Flag | Default | Description |
|---|---|---|
| `--name=NAME` |  | The extension's name. Required. |
| `--command=COMMAND` |  | The shell command to run. {{details_path}}, {{review_result_path}} and {{diff_path}} are replaced with quoted paths. Required for register. |
| `--repos=PATTERNS` | * | Where it runs: owner/repo, a/b,a/c, a/*, */a or *. |
| `--review-types=local,pr,remote` | all | Only run in these review types. The extension can also check the type itself and return skipped. |

### Order

| Flag | Default | Description |
|---|---|---|
| `--run-after=NAME\|review` |  | Start when this extension, or the AI review, has finished. A name nobody registered asks first. |
| `--parallelism=true\|false` | true | false with no --run-after means it runs after the review. |
| `--priority=0-3` | 0 | Start order among extensions ready at the same time. 3 runs first, ties keep registration order. |
| `--fail-fast` |  | On failure, the extensions waiting on this one through --run-after do not run. |

### Retries and limits

| Flag | Default | Description |
|---|---|---|
| `--retry-on-fail-times=N` | 0 | Run again when the response does not match the schema. |
| `--max-requested-retries=N` | 3 | How many status retry responses are honoured. |
| `--timeout=DURATION` | 10m | Stop a run after this long, such as 30s, 10m or 1h. The result is Failed. |
| `--rerun-on-restart=true\|false` | true | Run again when co-maintainer restarted mid-run. Overrides the extension-rerun-on-restart config key. |
| `--yes` |  | Save a --run-after that names an unregistered extension without asking. |

### Output

| Flag | Default | Description |
|---|---|---|
| `--json` |  | With list, print the registrations as JSON. |

## `co-maintainer rollback`

Go back to the version before the last upgrade, restoring its data.

```
co-maintainer rollback [--yes]
```

### Rollback

| Flag | Default | Description |
|---|---|---|
| `--yes` |  | Skip the confirmation. Needed when there is no terminal. |

## `co-maintainer version`

Print the version.

```
co-maintainer version
```

See [Configuration](configuration.md) for the `config.json` keys, and
[Troubleshooting](troubleshooting.md) for a failing command.
