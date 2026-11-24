# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`co-maintainer login-link` signs in to the dashboard with a one-time link, made on the server.** A script, an agent or a person with a shell on the server opens the printed address and presses **Sign in**, with no password. The link works once, for 5 minutes, on one address. A new link replaces the old one, a password change ends it, and opening it only shows the button, so a link preview cannot use it up. The token rides after `#`, so it never reaches the server on the GET or a proxy log. Making and using a link are in the audit log, the link never is, and a wrong link counts toward the sign-in lockout.
- **A repository added back to the App stays off, says why, and resumes with one click.** It used to look like any repository turned off by hand. Now the Repositories page shows "This repository is back in the installation" with **Resume reviews**, which turns it on with the knowledge it had and no init. A reinstall of the App takes the same path, and the return and the resume are in the audit log.
- **e2e:simulate has `probe`, `installation` and `lifecycle` flows.** probe reads and writes nothing it should not, and the recommended init makes no more GitHub calls than probe estimated. The installation webhooks, a repository added back and resumed, and a reinstall. `clear`, `rollback` with no backup and `uninstall`, inside the sandbox only.
- **e2e:simulate has a `login-link` flow.** The confirm page, one sign-in, a replay, a replaced link and another address.

## [0.7.23] - 2026-11-24

### Fixed

- **A GitHub rate limit no longer reads as missing access.** A secondary limit that outlived its three tries, or a 403 that says it is a rate limit, posted "The App does not have access to review this pull request." and ended the review as access denied. It now fails as a temporary error you can retry, with no comment. A rate limit on the incremental compare call no longer widens the round to the whole pull request.
- **A Stop during a GitHub rate limit wait sends no retry.**
- **A review cut off by a server restart no longer leaves its check run in progress.** When GitHub had already taken the review, the restart kept it but never completed the check, so the pull request waited forever. When GitHub never got it, the job was marked done with nothing posted. The check run now completes in both cases, and a review that was not posted fails with a message, so the dashboard offers Retry.
- **After a restart, another bot's review of the same commit is no longer taken for co-maintainer's.** The review is matched by the job its metadata names.

### Added

- **e2e:simulate has a `rate-limit` flow.** A primary limit on an App review and on `init`, a secondary limit once and three times, and a rate limit 403 with no limit headers. GitHub faults can now carry headers, a message and a reset time.
- **e2e:simulate has a `restart` flow.** The server dies with a review queued, reading the files, and posting before and after GitHub took it, with another bot's review on the commit, then starts again with the same startup code `serve` runs. A new `hang` fault freezes a GitHub call the way a killed process leaves it.

## [0.7.22] - 2026-11-23

### Changed

- **probe counts pull requests instead of listing them.** One GraphQL query gives the total, each year, each estimate window, and a sample with line counts. On nodejs/node that replaces 438 listing pages and 66 detail calls.
- **init reads pull requests in GraphQL pages.** Each page of 20 brings the line counts, comments, review comments and reviews, so the four calls per pull request are gone. `--pr-state=merged` is filtered by GitHub, and the listing progress shows `fetched 8,800 / 14,333` instead of `total unknown`.
- **init reads codebase files in GraphQL batches of 20** instead of one call each.
- **The probe estimate counts these calls,** and only the REST ones count toward the hourly quota, since GraphQL has its own.
- When a GraphQL call fails, that part is read with REST as before.

### Fixed

- **A temporary GitHub error no longer stops probe or init.** A 5xx or a dropped connection on a read is retried twice with a wait, and a pull request whose diff still fails is kept without it. Writes are still sent once.

## [0.7.21] - 2026-11-23

### Fixed

- **Fact extraction no longer drops pull requests a thinking model could not finish.** Its output limit was 2,400 tokens and thinking counts toward it, so a model like `openai/gpt-6-luna` used it all before writing a word and about half the pull requests were skipped after three tries at the same limit. The first try now gets 8,000 tokens, and an answer cut at the limit is asked again with 16,000, then 32,000, before the pull request is skipped. The first sync after the update runs fact extraction again, since the cached answers were made with the old limit.

## [0.7.20] - 2026-11-21

### Added

- **Close a finding yourself.** The **Findings** list has **Close** and **Reopen**, and a reply of `/co-maintainer dismiss` with an optional reason in a finding's thread closes it. The same people who may skip may dismiss. Each one goes to the audit log, and a closed finding is not raised again while its lines stay the same. Asking in plain words in the thread closes it too, even when the bot still disagrees: it says it closed the finding, asks what was wrong, and keeps the answer in the audit log as feedback.
- **Comment only reviews.** `set --repo=owner/repo --review-event=comment`, the repository page, or the server default under **Review defaults**: the App posts its findings as a comment, never approving and never blocking.
- **Every repository setting on both sides.** `set --repo` takes the provider, models, auth, blocking rule, exclude pattern, review mode, diff limits and the switches the dashboard kept (`--auto-review`, `--review-scope`, `--skip-drafts`, `--skip-bots`, `--codegraph`, `--watch-open-issues`, `--watch-push-mode`, `--review-policy`, `--remake-cron`), also next to a running `serve`. The repository page gets **AI for this repository** and **Review tools and limits**, and every dashboard field shows its CLI flag.
- **Extensions on the dashboard.** **Settings**, **Extensions** lists, registers, enables, disables and removes them, with the same checks as the CLI.
- **Diff limits per repository.** `--review-diff-max-chars` and `--review-file-patch-max-chars` raise or lift the DIFF section and per-file cut for a model with a large context.
- **`review-timeout-minutes` in the action.** A pull request review that runs past it, 30 minutes by default, fails with exit code 3. `--timeout-minutes` bounds `review --remote` on a pull request too.
- **`--no-only-request-changed-pr`** turns a saved filter off.

### Changed

- **One order for every setting, on every surface.** The environment, then the repository's own value, then the account's, then what the repository's last init ran with. App, remote and push reviews used the account's model and blocking rule while the CLI used the repository's, and `serve` ignored most of the variables the CLI reads.
- **init and sync no longer pin the repository's provider and models.** They keep them as the init fallback, used only where the account has none, so a later account change reaches every repository. Values an older release copied move there once.
- **Usage is the whole bill.** init, sync, replies and commit watch answers record their spend, from the dashboard and from the CLI, and CLI reviews, inits and syncs are Activity rows with their cost. Stopped, push and CLI reviews get their own rows, the CSV gains `kind`, `branch` and `extensions_cost_usd`, and clearing knowledge keeps the history.
- **Findings covers every review.** Push, remote and CLI review findings are listed, and a source filter shows the findings extensions added.
- **A cleared setting is kept out of sight.** Emptying a field or `--unset` moves the value to `clearedSettings`, which no page shows and no run uses.
- **Exit codes in CI.** A server failure, a cancel or a failed sync is exit code 3, a run a newer one replaced is a notice with exit code 0, and a blocker a later round closed no longer fails the step.
- **The secret name in the CI docs is `CO_MAINTAINER_REMOTE_TOKEN`**, so it cannot be mistaken for the AI key variable.

### Fixed

- **Withdrawing the last blocking finding approves the commit** the review read, with a fixed text and no AI call (#144).
- **Sign-in changes apply without a restart**, and changing the allowed user signs old sessions out.
- **A push review sends your own key** and the server enforces its key policy for pushes. Before, the server paid.
- **The exclude pattern applies to local, remote and push reviews**, not only to pull requests.
- **The dashboard shows the webhook URL `serve` uses** and refuses one `serve` would not start with. A field the environment sets is shown locked, with its name.
- **`config get` shows the value a run uses** and where it came from, with `--repo` for a repository's own values.
- **`--ai-key` works on init, sync and review**, a pull request review no longer stops on a saved `auth=pat`, and `review --remote` refuses server-owned and unknown flags.
- **The dashboard and `set` run the same checks** on keys, models, the PAT, the App and the sign-in methods, and `set --enable-auth=password` turns password sign-in back on.
- **A failed or stopped review keeps its known cost**, a local review run from the CLI included, also when a call fails after paid tool rounds. The GitHub job summary carries the run's warnings, the codegraph state, and a push review's cost.
- **`rollback` restores config.json as it was before the upgrade.** `serve` now takes the upgrade backup before it writes config.json.
- **Simulate checks pass with a real AI too** (#121).

## [0.7.19] - 2026-11-20

### Added

- **Global reasoning effort.** **Settings**, **AI models** has a **Reasoning effort** choice for every AI job: reviews, replies, guides and fact extraction. The levels are `none`, `low`, `default`, `high`, `xhigh` and `max`, and unset means `high`. `default` sends no reasoning field and leaves the level to the provider. From the CLI: `co-maintainer set --global-reasoning-effort=LEVEL` or `co-maintainer config set global-reasoning-effort LEVEL`.

### Changed

- **Fact extraction reasons at the global level.** It used a fixed `low`, so with the default it now asks for `high`. Init and sync can take longer and cost more. Set the level lower to go back.

### Fixed

- **A provider that refuses the reasoning field no longer fails the job.** An OpenCode Go model behind the Responses API refused `reasoning` with a 400, and only a `none` level was retried. Now a 400 about reasoning at any level gets one retry without it, for OpenRouter, OpenCode Zen and Go, OpenAI and Anthropic. The review log says when that happened.

## [0.7.18] - 2026-11-20

### Fixed

- **A slow model no longer fails at five minutes.** An AI request now waits up to 15 minutes for the provider, not Node's built-in 300 seconds. A thinking model on a large pull request used to fail with `UND_ERR_HEADERS_TIMEOUT`. The limit applies to OpenRouter, OpenCode Zen, OpenCode Go, OpenAI and Anthropic.
- **Retry with the same model really uses one model.** It pinned only the review model, so the per-file summaries ran on whatever the setting said by then. Both now run on the model the failed review used.

### Added

- **AI request timeout setting.** **Settings**, **AI models** has an **AI request timeout (minutes)** field. Blank means 15. From the CLI: `co-maintainer set --ai-timeout-minutes=N` or `co-maintainer config set ai-timeout-minutes N`.
- **Retry with the new default model.** After **Change default model**, a failed review also offers **Retry with** the new model, on its own page, on its Activity row and in the bulk actions for the selected rows. It shows only when the new model differs from the one that failed. The plain **Retry** still keeps the failed model and says which one on hover.
- **Excluded files.** A repository's settings take a regular expression over changed file paths. A review drops matching files as soon as the file list loads, so they get no diff and no summary. A renamed file also matches by its old path. The prompt tells the model how many files were left out, and the review comment's **Metadata** shows the count and the pattern. Init and sync still read every file. An invalid pattern is refused when saved.

## [0.7.17] - 2026-11-19

### Fixed

- **`probe` counts the pull requests `init` reads.** The estimate counted every pull request in the repository, even with `--max-pr-months`, so a large repository was estimated at many hours. It now counts only the pull requests in the recommended window, the way `init` does. AI time now accounts for `--ai-concurrent`, and the codebase job is counted from the recommended flags.

### Added

- **GitHub time and quota in the `probe` estimate.** The `init estimate` shows the GitHub calls the run makes, how long they take (measured from the probe's own calls) and whether they fit in the hourly quota from `/rate_limit`. A run that needs more than what is left either stays under the hourly limit as it runs or says how long it waits for it. The time is the GitHub time plus the AI time, and the line says which part decides it.
- **A faster option.** When the recommended `init` would take more than 30 minutes, `probe` also shows a faster `init` with a shorter PR window and half the commits per step, with its own time, calls, cost and full command.
- **Review estimate.** `probe` reads the files of up to 10 recent pull requests a review would run on (no bots, no drafts, no empty diffs, from the 30 most recently updated) and shows what one review costs, as the median and the highest. It follows the review's own rules: tool rounds that grow with the diff, summaries for very large files and the diff cap. It assumes one pass and no codebase graph.
- **Clearer `probe` output.** Sections and options are colored on a terminal (off with `NO_COLOR`, in CI and with `--json`), each option has a full command to copy, and without models each cost line says which flags to add. `--json` gains `pullRequestsInWindow`, `totalSeconds`, `bottleneck`, `github`, `faster` and `review`.
- **The dashboard's Add repository preview** shows the same time, GitHub calls, cost, faster option and review estimate as the CLI.

## [0.7.16] - 2026-11-18

### Changed

- **An App review with only non-blocking findings approves.** The review type now follows the same blocking rule as the exit code, in both `reviewBlocking` modes: no open blocking finding approves, and the non-blocking findings stay as comments, an open blocking finding requests changes. Under `model` a finding the model labeled non-blocking used to request changes, and under `severity` a review with only P2 and P3 findings only commented, which left an earlier "changes requested" standing. An approval clears it. An extension finding without `request_changes` no longer turns an approval into a comment. (#137)

## [0.7.15] - 2026-11-18

### Added

- **Findings lists.** A **Findings** item in the left menu lists every finding across repositories, and each repository has a **Findings** tab. Filters for severity, state, pull request, file, author and words live in the URL, each as a chip, and a row opens the pull request page at that finding.
- **Activity filters, failures and bulk actions.** Activity filters by status, kind, repository, pull request, day range and words. Each failed row shows its reason with **Retry** and **Dismiss**, the failed list has **Dismiss all**, rows have checkboxes with **Retry** and **Dismiss** on the selection, and a later successful review resolves the earlier failures of its pull request. A migration adds the seen time and the resolving review.
- **Check for new versions and Star Co-Maintainer.** At the bottom of the sidebar, **Check for new versions** says first that it asks github.com, then shows what is new since the running version from the GitHub release and `CHANGELOG.md`. Nothing about the server is sent. **Star Co-Maintainer** opens the repository.
- **Keyboard shortcuts** on Activity, Findings and the Pull requests tab: `j` and `k` move, `Enter` opens, `x` selects, `/` searches and `?` shows the panel, with a bar that names them.
- **Job warning banner.** A job that finished but logged a problem says what is wrong and how to fix it, for example a check run update that needs **Checks: Read and write**, and its Activity row gets a mark. The job page links the pull request page and the posted GitHub review.
- **Usage filters and export.** Usage filters by repository and by pull request author next to the range, and **Export CSV** downloads one row per review: time, repository, pull request, author, model, tokens, cost, billing, findings and status. A review now stores the pull request title and author.
- **Settings search and save state.** A search box above the Settings menu finds a setting by name or description and jumps to its field. Settings pages say **Unsaved changes**, **Saving**, **All changes saved** or **Not saved**.
- **Audit log.** **Settings**, **Audit log** lists who changed settings and repository settings, created or deleted remote tokens, added or removed repositories, signed in, started reviews, dismissed failures and started updates, filterable by kind and person. Secrets only say that they changed. A migration adds the table.
- **Setup wizard.** `/setup` is a step by step wizard with progress, **Back** and **Next**, and a **How reviews look** step whose review comment preview follows the blocking rule, diagram language and references. The settings API accepts the server's `reviewBlocking`.
- **Newer version and update.** When the host sets `CM_UPDATE_URL`, the dashboard reads the latest stable release from GitHub at most once a day and shows "co-maintainer 0.7.15 is out. This instance runs 0.7.14." in the sidebar and in Settings, with an **Update** button that POSTs the version to the host. It never offers an older version. Without `CM_UPDATE_URL` nothing calls out and Settings shows the `docker pull` and restart lines. (#138)

### Changed

- **Activity shows one row per review** with its pull request, result, cost, time and status, and job kinds and skip reasons read as sentences. The open page polls a small change stamp and fetches the list only when something changed, instead of refetching it every 5 seconds.
- **Every count opens the list it counts**: the Activity result, the job page **Found** card, the overview findings and severities, the recent pull request badges and the Usage cards.
- **The pull request page** shows the title, a state badge on every finding, open and closed counts, anchors for rounds and findings, job log links, GitHub line links and review thread links.
- **Open failures are one number.** The menu badge, the home list and the repository overview count failures of the last 30 days nobody dismissed and no review resolved, say "5 open failures", and open the failed list with that many rows.
- **Commit watch setup moves to the Pushes tab.** The overview keeps a short status line that links there.
- **The skipped list** has column headings, merges repeats within a minute and hides the bot's own comments behind a toggle.
- **Settings and repository tabs.** Every repository tab shows the same breadcrumb, a click on a row of the Pull requests tab opens that pull request, and a GitHub sign-in names the GitHub login in the session.

### Fixed

- **The Pull requests tab** keeps the installation, its token and the open list for a minute, so a second visit makes no GitHub call. The overview reads the default branch stored at setup and sync instead of starting `git` on every visit.
- **One cost format** on every page, with at most four decimals below a cent, and a stat card's big number never wraps.
- **Plurals and labels.** "1 repository", and the overview, the home list and Usage each say whether a figure counts pull requests or reviews.
- **Layout.** The Usage **By model** table fits its card, the Copy button of a long code block stays at its top right corner, empty states link the place they name, and the Knowledge tab hides the empty History card.
- **A review logs GitHub permission problems as warnings,** such as a failed check run update, so the job page can say how to fix them.

## [0.7.14] - 2026-11-18

### Added

- **App review and PR review read companion pull requests.** `set --repo=owner/app --companions=owner/docs,owner/vscode-ext` lists up to 5 repositories whose pull requests a review may read as context. A `Companion: owner/docs#112` line anywhere in the pull request body names a companion pull request, and a listed repository without one is matched by an open pull request with the same head branch name. Body lines win, a line for a repository that is not listed is ignored, and a closed or merged companion pull request is read with its final diff. (#81)
- **Each companion is read with the App client of its own installation.** Its files come from `pulls/N/files`, and `search-non-code` with `repo` searches a worktree of its head, made from one reused blobless clone. A companion no installation can read gives a `companion_unreachable` warning in the job log, and the review goes on without it. CLI PR review reads companion pull requests with your own GitHub auth, and `--with` wins for a repository given both ways. (#81)
- **Output and carry-over.** The GitHub review's Metadata block gets `- Companions: owner/vscode-ext#45, owner/docs (no matching pull request)`. In `--json`, `source` is `flag`, `pr-body` or `branch-name`, `pr` is the pull request number or `null`, and `status` can be `unreachable`. App review stores the companions in a new `companions_json` column, and a companion that changed rechecks the carried findings over the whole pull request. A finding on a companion file is listed in the review summary and never carried. A repository without the setting sends the same request as before. (#81)

### Fixed

- **The App token for git keeps the environment's own git config.** It replaced `GIT_CONFIG_COUNT` and the first entry, so a URL rewrite set through `GIT_CONFIG_*` was lost for App clones.

## [0.7.13] - 2026-11-18

### Added

- **A review can read the changes of a companion repository.** Some changes span repositories, such as code and its docs, or a backend and the editor extension that calls it. `review --with=PATH[@BRANCH]` reads another checkout as context in local review, CLI pull request review and `review --remote`, up to 5 companions. Without `@BRANCH` the companion's current branch and working tree are read. With `@BRANCH` that branch is diffed against its merge base with the companion's default branch, and the checkout is never switched. The repository name comes from the companion's git remote. A companion is read, never reviewed, and needs no `init`. (#81)
- **The model gets one COMPANION block per companion.** It lists the changed files with their status and line counts, as `owner/repo:path`, at most 200 of them, or says `no changes on this branch`. The system prompt is the same bytes, and a review without `--with` sends the same request as before. `read-full-diff` reads a companion file by its `owner/repo:path`, with `offset` and `limit`, and `search-non-code` takes a `repo` argument to search a companion checkout. (#81)
- **Findings stay on the reviewed repository.** A finding the model places on a companion file is shown without a location, labeled with the companion's name, and is not carried to the next round. In local and CLI pull request review the carry record keeps each companion's repository, branch and a hash of its files, and a companion that changed rechecks the carried findings even when the reviewed repository did not change. (#81)
- **A private companion is never quoted.** The visibility of the reviewed repository and of each companion is read from the GitHub API at review time, and a companion that cannot be read counts as private. In the review of a public repository, a private companion's patches and search results go through the copied-passage check, and a removed passage gives a `private_text_removed` warning. (#81)
- **Output and remote review.** `--json` has `companions`, the terminal and the `--output=github` job summary print a `Companions:` line. A remote server lists the `companions` feature, takes at most 500,000 characters of companion patches and warns `companion_list_cut` above that, and searches a companion through the client. An older server gets no companion, and the CLI warns `companions_unsupported`. An older CLI with a newer server changes nothing. (#81)

## [0.7.12] - 2026-11-17

### Added

- **Your own MCP servers can join a remote review.** A server that allows it, with `set --remote-client-tools-policy=on` or `CM_REMOTE_CLIENT_TOOLS_POLICY=on`, offers the model the tools of the MCP servers in your own config for the repository. The CLI starts them, declares each read-only tool with its name, description and parameters as `client-<server>-<tool>`, and runs every call on your machine. The policy is `off` by default, and then, or on an older server, the CLI declares nothing and warns `client_tools_refused`. An older CLI with a newer server sends tool names only, as before. (#79)
- **The server limits what a client declares.** At most 16 tools, 16 KB per declaration and 64 KB for all of them together, and a name of 2 to 64 lowercase letters, digits or dashes that is not a name of the server's own tools. Each declaration left out gives a `client_tools_refused` warning. Every result goes through the server's tool limits, is capped at 40,000 characters before them, comes behind the line that says it is outside data, and is private: the server removes a passage copied from it before the result comes back. (#79)

### Fixed

- **A slow tool batch no longer cancels a remote review.** The CLI sent no sync while it ran the server's tool calls, so a batch that took longer than the server's sync timeout, 10 seconds by default, was cancelled as a client timeout. The CLI now sends a sync with no results at the poll interval, and at least three times per timeout, until the batch ends.

## [0.7.11] - 2026-11-17

### Added

- **A review can read private context from MCP servers.** Some context lives outside the repository and is private, such as an issue in a private tracker. `set --repo=owner/repo --mcp-config=./mcp.json` stores a repository's stdio MCP servers, and the model sees each listed tool as `mcp-<server>-<tool>`. Only the tools in `tools` are offered, and a tool the server marks as not read-only is refused. A tool whose input schema is over 16 KB is refused, and all MCP tool definitions of one review stay within 64 KB. The servers start once per review and stop however it ends, get only their own `env` with `PATH` and `HOME`, and a server that fails leaves the review going on without it. MCP runs in local, CLI pull request, App and remote review, where the server uses its own config. (#79)
- **Private results never reach what a review prints, posts or stores.** The prompt tells the model never to quote an MCP result, and before a review is printed, posted or stored, any run of 8 or more words that also appears in a private result is replaced with `[private context removed]`, and a suggestion block that holds one is removed whole. With `--debug`, the model text it prints goes through the same check. It runs in every mode, `--json` and the dashboard included. MCP results never go to the JSON output, the log or the database. (#79)
- **Forks and the cloud stay off.** In `serve`, a pull request from a fork gets no MCP tools unless the repository sets `--mcp-allow-forks=true`. `CM_MCP_DISABLED=1` refuses `--mcp-config` and starts no server, and the cloud sets it. (#79)
- **New warnings and a Metadata line.** `mcp_unavailable`, `mcp_tool_missing`, `mcp_tool_refused` and `private_text_removed` join the review's warnings, `usage.tools.byTool` counts each MCP tool, and the GitHub review's Metadata gets `- Tools: 11 calls · MCP: tracker` with server names only. (#79)

### Changed

- **The prompt for private MCP results lets the model act on them.** The wording the issue proposed, "You may base a finding on them, but never quote, paraphrase or summarize them", left the model with no way to explain such a finding, so on a real review it reported nothing. The model is now told to base a finding on a private result when it shows the change is wrong and to say only that a private source of this repository requires it. Quoting and paraphrasing stay forbidden, and the copied-passage check is unchanged.

## [0.7.10] - 2026-11-17

### Added

- **A review can search docs and configuration.** Codegraph follows code and cannot see docs, YAML or configuration, so a change that made a paragraph false went unnoticed. The new `search-non-code` tool searches the tracked files codegraph does not index, through `git grep`: never an untracked file, a binary file, a code file or an agent instruction file. It answers at most 30 matches with their line numbers, a regex search stops after 5 seconds, and it runs in local, CLI pull request, App and remote review. A pull request review now checks the pull request out even with codegraph off, and a tool result counts as evidence for a finding. (#79)
- **Tool results are limited per review.** One result stops at 8000 characters and ends with `[cut at N characters]`, and once a review's tool results reach 40000 characters every later call is answered with `Tool budget spent. Answer with what you found.` and a `tool_budget_spent` warning. Codegraph results are not limited yet. Set them with `set --repo=owner/repo --review-tool-result-max-chars=N`, `--review-tool-budget-chars=N` and `--review-search-max-context-lines=N`, where `0` means no limit. (#79)
- **`usage.tools` in every review's JSON.** It counts the tool rounds, the calls, the result characters and the calls per tool, and says whether the budget was spent. The human output adds `Tools: 11 calls · 18,240 characters` under the summary. (#79)

### Fixed

- **An App review of a private repository gets its checkout.** 0.7.5 gave the App's token to the clone and the fetch, but the clone is blobless, so making the pull request's worktree downloads file contents too, and that step still used the machine's own login. On a server with no git login, a private repository's review ran with no checkout, so with no codegraph and no search. Every git command in the clone that can reach GitHub now gets the token.

## [0.7.9] - 2026-11-17

### Added

- **A CI annotation names the rules a finding rests on.** With `--output=github` and references turned on for the repository, each annotation ends with the guide and instruction rules behind the finding, for example `(rule R3)` or `(rules R3, I1)`, as the terminal output lists them. (#78)

## [0.7.8] - 2026-11-17

**Before you upgrade.** Each repository's first `sync` after the upgrade rewrites the guide in full once, because the last build did not record which findings it was written from.

### Added

- **`sync` edits the review guide instead of rewriting it.** The model gets the current guide with its rule ids and only the findings that are new or gone, and answers with rules to add, change and remove. Every other line stays as it was and keeps its id, the short guide gets the same edits, and a sync whose findings did not change makes no guide call at all. Every 10th changed sync rewrites in full, set with `set --repo=owner/repo --guide-full-every=N` (`1` always, `0` never after `init`), and `sync --full-guide` rewrites now. An edit that does not fit the guide is not applied, and that sync rewrites in full. (#113)

## [0.7.7] - 2026-11-17

**Before you upgrade.** The database migrates once, as in 0.7.0: one migration adds two columns to the `subjects` table, after the same backup.

### Added

- **Skip a failed review, or turn reviews off for one pull request.** A failed App review ends its check run as failed, which blocks the merge where the check is required. `/co-maintainer skip-this-commit` on the pull request ends that commit's check as skipped and rewrites the failed note to say so, and the next commit is reviewed again. `/co-maintainer skip-this-pr` turns reviews off for the pull request: a running review stops and posts nothing, and every commit gets a skipped check. `/co-maintainer review` turns them back on, and the policy decides what happens next. The repository owner may always skip. Anyone else only when the repository's settings list their relation to the repository (`skippers` in the policy, off by default). Anyone else is ignored without a reply. A new `e2e:simulate` flow, `skip-commands`, covers it. (#112)

### Changed

- **A failed review says it reviewed nothing.** Its check run summary said "No actionable findings." It now says the commit was not reviewed, links the error on the dashboard and names the skip comment, and the failed note ends with the same paragraph.

## [0.7.6] - 2026-11-17

### Added

- **A reply on a finding knows which rules the finding rests on.** When someone asks on a finding's thread why it was raised, the reply gets the finding's references with their pull request and file links, and each rule's text from `RULES.json`. So "which rule?" is answered with the rule and where it came from. (#78)

### Fixed

- **A reply never posts an em dash or a semicolon in its prose.** The model is asked not to write them, and a reply on a pull request still came back with an em dash. A reply's prose is now cleaned before it is posted, as the dashboard already did, and code in it is left as it is.

## [0.7.5] - 2026-11-17

### Fixed

- **A review guide cut at the output limit is no longer written.** An answer that stopped at the limit was written as if it were complete, so a guide could end mid-line and lose its last passes. `sync` now asks once more with twice the limit, and when that answer is cut too it keeps the last guide and says so. `sync --json` then has `reviewGuide: "kept"`. The same holds for the short guide. (#114)
- **A finding the bot agrees was wrong closes.** When a reply on a finding's thread agreed that the finding was wrong, the next round still listed it as open. It now closes at once, and a later round does not raise it again while its lines are unchanged. (#119)
- **Stop on the dashboard stops the job.** Stop marked a job as canceled, but `init` and `sync` ran to the end and wrote their files, and an App review without extensions could still post. Every job now checks Stop before it writes or posts: the AI call in progress finishes, no new one starts, and nothing is written or posted. A stopped App review closes its check run as cancelled.
- **An App review of a private repository keeps its scope.** The review cloned with the machine's own git login, so a server with the App and no git login reviewed a private repository from the diff alone. It now clones and fetches with the App's installation token, given to git for that one command and never saved.

## [0.7.4] - 2026-11-16

### Fixed

- **Two rules on the same pull request keep their own ids.** A rule keeps its id by the pull requests it shares with an old rule, so two rules that rest only on the same pull request could swap ids when a rebuilt guide listed them in another order, and a review that cited one then pointed at the other. The review comment link now decides between them, and the wording does when there are no links yet.

## [0.7.3] - 2026-11-16

**Before you upgrade.** `review --json` gains `references` on every finding, and `sync --json` gains `contradicted` when a new guide rule goes against an old one. `RULES.json` gains `lastIds`, and a guide rule source can carry `url`. Once a repository has a `RULES.json`, the guide prompt also lists its rules, so each repository's next `sync` writes both guides once more.

**The database migrates once.** The first command that opens `app.db` adds a `references_json` column to findings and a `rule_events` table. The backup and `co-maintainer rollback` work as in 0.7.0.

### Added

- **A review finding says where its rule came from.** The model names the ids a finding rests on, and code turns them into references from `RULES.json`: `Rules-12 · #212, #340 · 2026-03`, `Instructions-3 · AGENTS.md:14`, `Codebase · Tests` or `System Prompt`. A pull request links to the review comment the rule came from. No pull request number or date goes into the prompt, and an id that is not in `RULES.json` is dropped. References are stored with each finding, in `review --json` and on the dashboard pull request page. `set --repo=owner/repo --review-references=on` also shows them in review comments, as a collapsed `References (n)` block, and in the terminal. Off by default.
- **Guide rules keep their review comment.** `collect` keeps the link of each comment and review, the extract prompt numbers them and the model names the ones a finding came from. A pull request cached before this keeps the old prompt and its cached answer. Turning references on reads every cached pull request again once, on the next `sync`.
- **A rule that goes against an older one says so.** The guide prompt lists the last build's rules, and a new line can name the one it overturns. `sync` prints `[guide] R4 dropped, R9 goes against it (#340, 2026-03)` when the new rule's newest pull request merged later, `sync --json` lists it in `contradicted`, and the dashboard repository page shows the last ten.
- **An `e2e:simulate` flow, `review-references`,** runs init, a review with references off and on, and the one-time read again.

### Changed

- **Rule ids stay the same across syncs.** A rewritten rule keeps its id, a new rule gets the next number ever given, and a dropped id is never given again. Before, every build numbered its rules from 1.

## [0.7.2] - 2026-11-15

**Before you upgrade.** A review comment posted by a release older than 0.5.0 used an em dash between the path and the symbol in a finding heading. co-maintainer no longer splits that form into a path and a symbol, so such an old comment reads as one heading. The note that a retry posts after a failed review now reads `co-maintainer reviewed this push. The review is below.`

### Added

- **A punctuation check.** `npm run punctuation` fails on an em dash, an en dash, or a semicolon in prose, in code comments, strings, Markdown and CSS. CI runs it on every pull request and on every push to `main`. A string that needs a semicolon as code carries a note with its reason, for example for a Cookie header.
- **Every AI job carries the punctuation rule.** `createAiProvider` wraps each provider so the rule reaches the system prompt of the review, the replies, the watch jobs, the guide synthesis and the benchmark judge. A job added later gets it without extra work.
- **`CONTRIBUTING.md` explains the rule.** It shows the right and wrong form and how to write the note.

### Changed

- **Text that a person reads no longer holds the marks the rule rejects.** Code comments, the prompt lines that list diagram types, the joined messages of `init` and of the guide's commit examples, and the benchmark text were reworded.

## [0.7.1] - 2026-11-15

**Before you upgrade.** The guide prompt changed, so each repository's next `sync` misses the AI cache and pays for both review guides once. `ruleChanges` in `sync --json` gains a `guide` list next to `instructions`, and a repository without instruction files now gets a `RULES.json` too.

### Added

- **The review guide says which pull requests each check came from.** Every check line in `PR_REVIEW_GUIDE.md` and `PR_REVIEW_DETAILED_GUIDE.md` ends with an id such as `[R12]`, and `RULES.json` records the pull requests behind it and the date each merged. No pull request number or date goes into the prompt. `view --sources` lists the guide rules before the instruction rules, each with its pull requests and the newest month one of them merged. After a rebuild `sync` prints what changed, for example `[guide] 2 rules added (#402, #407) · 1 rewritten (R12, #340 joined) · 1 dropped (#101 left the window)`. An `e2e:simulate` flow, `guide-sources`, checks it, including a model answer with brackets in the middle of its lines.

## [0.7.0] - 2026-11-13

**Before you upgrade.** `--json` gains fields and one new value, and a few first runs cost a little more. `schemaVersion` stays 1 and nothing is renamed or removed. `revision.coverage` and `warnings` appear in local, pull request, remote and push results, `revision.truncated` can now be true, and a pull request result carries real `summary.open`, `summary.closed` and `findings[].state` values. Local, pull request and remote results always have `extensions`, an empty array when nothing is registered, and every finding has `extensionId`, which is `null` for an AI finding. `subject.intent` appears only when a review was given an intent. `reviewGuide` in `init --json` and `sync --json` can now be `kept`, so a script that checks it must accept that value. A pull request review of a repository without guides now exits with code 2, not 3. The long review guide regains its nested indentation on each repository's next `sync`, and where that guide is over 30 lines it can cost one extra short-guide call. A carry-over record saved by 0.6.13 does not list the files its round skipped as unchanged, so the first round after the upgrade sends them once more. Ctrl-C now ends a prompt, where it used to count as no answer.

**The database migrates once.** The first time a command opens `app.db`, such as `serve`, `init` or `sync`, one migration adds two tables for extension results. Before it runs, co-maintainer copies `app.db`, `cache.db` and `config.json` into `backups/previous` next to the database, and without a complete backup the migration does not run. After it, a downgrade is not a plain reinstall: a release refuses an `app.db` newer than it knows, and installing an older release over migrated data is unsupported. The way back is `co-maintainer rollback` with the new version still installed, which restores the backup and prints the version to install. It asks first, because everything written after the upgrade is lost. The repository's `npm run downgrade:check` exercises this path with 0.4.13: it upgrades that release's data with the current code, rolls back, and starts 0.4.13 again.

### Added

- **Extensions run your own checks in every review.** Register a command with `co-maintainer extension register --name=... --command=...` and its result joins the review. It runs in local reviews, CLI pull request reviews, the reviews `serve` posts as the GitHub App, and remote reviews, where `serve` runs its own registrations. The command reads `details.json`, `cm-review.json` and `diff.patch` through `{{details_path}}`, `{{review_result_path}}` and `{{diff_path}}` and prints one JSON response with a status, a verdict, findings, Markdown, media links and cost. Only paths are substituted, and the command starts with an empty environment, so no token reaches it. It runs as the user that runs co-maintainer and can read that user's files, `config.json` included. `extension update`, `list`, `remove`, `disable` and `enable` manage the registrations in `config.json`, and `extension debug-run --name=...` runs one against a built-in mock review with no AI, no network and nothing posted. `--run-after`, `--parallelism`, `--priority` and `--fail-fast` set the order, `--retry-on-fail-times` and `--max-requested-retries` set retries, and a `--timeout` (default 10m) ends the command's whole process group. `set --extension-rerun-on-restart=true|false` decides whether an extension cut off by a restart runs again. `CM_EXTENSIONS_DISABLED=1` turns extensions off, so `register` refuses and no review runs one. A commit watch push review runs none.
- **Extension results show in every output.** One extension's `request_changes` makes the review Request changes and the CLI exit code blocking, and a failed extension never blocks. The GitHub review posts extension findings inline or in the summary with a `[P2 · blocking] · extension: name` label, adds an `#### Extensions` section and Metadata lines, and stays under 250,000 characters by dropping the longest extension Markdown first. `review --json` has `extensions[]` and `extensionId` on every finding, and `--include-extension-markdowns` keeps each extension's Markdown. `--output=github` annotates located extension findings and adds their Markdown to the job summary, capped at 1 MiB. A finding with a `key` is tracked across rounds as open or closed. The total cost of a review includes its extensions, and the pull request page of the dashboard shows each extension's result, reason and cost.
- **Every review says what the model received.** A large diff is no longer cut without a word. Each changed file ends in one state: `full` (the whole patch), `partial` (the first 12,000 characters), `summarized` (a low-model summary), `dropped` (only its path and line counts, under `NOT SHOWN (diff budget)` in the prompt) or `withheld` (GitHub sent no patch). The whole diff stays under 240,000 characters, files in full come first, and room left after dropping goes back to dropped files that fit. Only a patch over 4,000 characters is summarized, at most 40 per review. A diff that fits is sent exactly as before. `--json` in local, pull request, remote and push review has `revision.truncated` (true when any file is not `full`, it was always `false` before), `revision.coverage` and `warnings` (`diff_dropped`, `diff_withheld`, `summary_failed`). The terminal prints `Coverage: 58 full · 1 partial · 3 summarized · 0 dropped` when a file is not full, and says "No actionable findings in the files reviewed." when a file was dropped or withheld. The GitHub review lists up to 20 files it did not review, with each file name as an inert code span, and its metadata always has a `Coverage` line. `--output=github` puts both in the job summary and gives one `::warning` for dropped files.
- **`read-full-diff` reads any cut file, in pages.** It serves `partial`, `summarized` and `dropped` files with `offset` and `limit` in diff lines, and lines keep their new-file numbers. One answer stops at `reviewReadDiffMaxChars` characters (default 20000) and ends with `[more: call again with offset=N]`. Set the cap per repository with `set --repo=owner/repo --review-read-diff-max-chars=N`, `0` or `-1` for no limit.
- **`review --intent-file` tells a review what the change is for.** `--intent-file=PATH` reads a text from a file and `--intent-file=-` reads standard input. It works in local review, in `review owner/repo N` and in `review --remote`. The text is context only: it is not a rule, it produces no findings of its own, and it never replaces the diff or the guide. It goes into the user prompt, next to four sentences that say so, and the system prompt is the same bytes as before. The cap is the repository's `reviewSystemPromptMaxChars` (8000 characters by default). A longer text is a usage error with exit code 2, an empty file is no intent and gives an `intent_empty` warning, and `--range` refuses the flag. The result says an intent was given and never holds its text: `--json` has `subject.intent` as `{ "source": "file" | "stdin", "chars": N }`, and the terminal and the job summary print `Intent file: provided`. A new round with another intent still carries the earlier findings over, so use `--fresh` when the intent changes. A remote review applies the cap again on the server, and a client that talks to a server from before this release reviews without the intent and adds an `intent_unsupported` warning.
- **A choice of diagram language for reviews.** Reviews draw Mermaid diagrams, and that stays the default. `review --diagram-runtime=plantuml` asks the model for standard PlantUML and keeps the fenced source in the comment. `review --diagram-runtime=plantuml-server` turns each PlantUML block into an image link on a PlantUML server, as `svg` (default) or `png` with `--plantuml-output-format`. `--plantuml-server=URL` picks the server and defaults to `https://www.plantuml.com`. co-maintainer only builds the link and never calls the server, so the reader's browser fetches the image. That means the diagram source is sent to that server, so use your own server for private code. The three settings are also saved per repository with `set --repo=owner/repo --diagram-runtime=...`, which is how reviews run by the GitHub App, `serve` and `review --remote` get them. Replies to review comments follow the same setting.
- **`INSTRUCTIONS.md` from your agent instruction files.** `init` and `sync` read every file on the default branch that `--agent-instructions` matches (default `(^|/)AGENTS\.md$`, every `AGENTS.md` at any depth) and keep only the rules a reviewer can check in a diff. Setup steps, commands to run, tool use and anything about the agent's own behavior are dropped. Each rule must cite a real line of the files it came from, or it is dropped and counted. The file is capped at `--agent-instructions-max-chars` (default 6000, 0 or below for no limit). Both flags are saved for later syncs, and a blank `--agent-instructions=` turns the file off. It needs `--include-codebase`. Every review, local, pull request and remote, reads it with the other guides. Unchanged instruction files cost nothing on the next `sync`, and a repository with no instruction file sees no change at all. Every rule ends with an id such as `[I1]`, and `RULES.json` next to the guides records each id's text, scope and source lines. It is never sent to the model.
- **`view --sources`.** Lists every instruction rule by id with the file lines it came from. `--json` prints `RULES.json`.
- **`sync` says what changed in the instruction rules.** After a rebuild it prints which rules were added, rewritten or dropped, matched by their file lines, for example `[instructions] 1 rule added (AGENTS.md:40) · 1 rewritten (I3, AGENTS.md:12 joined) · 1 dropped (AGENTS.md:9)`. `sync --json` carries the full lists.
- **More `e2e:simulate` flows.** `npm run e2e:simulate` now runs 13 flows, each in its own sandbox with a simulated GitHub and the real product code, and takes under a minute with the fake AI. They cover `init`, `init` with `sync`, local review, pull request review with carry-over, remote and push review, App reviews, large diffs, `INSTRUCTIONS.md`, the diagram runtimes, extensions, the intent file and a repository without guides. `--flow=NAME` runs one and `--keep` leaves its sandbox on disk. Many of the fixes below came from these checks, and `CONTRIBUTING.md` says how to add a flow.

### Changed

- **A CLI pull request review remembers its findings between runs.** `co-maintainer review owner/repo 123` labelled every finding `new` on every run, so its summary always read `0 open · 0 closed`. It now stores each run in the cache, keyed by repository and pull request number, and the next run shows what the author fixed as `closed`, what is left as `open`, and only real new findings as `new`. This is the carry-over local review already used, in the terminal output, `--json` and `--output=github`. `--fresh` now works for a pull request review and clears the stored run. A guide rebuilt since the last run starts fresh on its own, and so does a force-push. A blocking finding that is still open keeps the exit code at 1. If the cache cannot be read or written, the review still runs and the output carries a `carry_over_unavailable` warning.
- **A repository without guides gives the same error in every review mode.** Local review already stopped with `not_initialized` and exit code 2. Pull request review ended with a plain error and exit code 3, and `review --remote` printed `remote_handshake_failed` for both a repository without guides and one the server does not know. All of them now stop with `not_initialized` and exit code 2, in the human, `--json` and `--output=github` outputs. Local and pull request review hint `co-maintainer init owner/repo`. Remote review says where to run it: `Run co-maintainer init owner/repo on the server at <host>.` A repository the server does not know is now `repo_unavailable` with its own hint. A client and a server of different versions still work together, and an error text from the server no longer writes control characters to the terminal.
- **Summaries of large files use the low model in every mode.** Local, GitHub App and push review summarized large files on the high model. With no low model configured they still use the review's model and say so in the log. Summary calls respect `--ai-concurrent`, so App and push reviews, which use 1, run them one at a time. One failed summary no longer fails the review. That file is shown as `partial` with a `summary_failed` warning.

### Fixed

- **`config.json` is replaced whole, so a reader never sees half a file.** `serve` reads `config.json` on every job while `set` can write it from another process. The write went in place, so a reader could see an empty or cut file and fail with `Unexpected end of JSON input`. `config.json` and the Sign in with ChatGPT credentials now go to a temp file beside them and are renamed over the old one, with mode 600 set before the rename. On Windows a busy target is retried for about a second, then reported with its name. A failed write leaves the old file and removes its temp file.
- **A dropped file is reviewed in the next round.** A file counts as unchanged since the last review only when the model received it then. A change too large for one review is covered over the following rounds of a local review, a CLI pull request review, a remote review or an incremental App review, with no flag. An incremental App round also sends a file the last round dropped when nobody touched it since. Push review and whole-pr App reviews say plainly that the files are not reviewed in that mode instead of promising a later run.
- **A fixed finding no longer stays open after a run that did not show its file.** A review leaves unchanged files out of what the model sees, and the saved list of seen files held only what it saw. A file left out once was unverifiable on the next run, so its finding stayed open, was reported again as new at another line, and a blocking one kept the exit code at 1 after the fix. The saved list now also keeps the files an earlier run judged that have not changed since. This covers local review, CLI pull request review, remote review and App reviews in incremental scope.
- **`sync` keeps every `CODEBASE.md` section it did not rebuild.** A sync after a merge rewrote `CODEBASE.md` from only the sections whose facts changed, so Tests, Development and debugging and the other untouched sections were gone after one sync. An untouched section now keeps its text, a rebuilt one takes the new text, and one the model had nothing durable to say about is dropped. A section whose AI call failed after its retries keeps its old text, and a section that has facts but is missing from the file is rebuilt on the next sync, which also repairs a file that an earlier version cut short.
- **The review guide keeps each example nested under its rule.** Cleaning the guide removed the leading indent, so the examples became top-level bullets.
- **`SKILL.md` keeps its link to a review guide a failed guide call kept.** When the guide call failed, `sync` kept `PR_REVIEW_GUIDE.md` and `PR_REVIEW_DETAILED_GUIDE.md` but wrote `SKILL.md` without the link to them, and `--json` said `reviewGuide` `skipped`. The link stays, and `--json` now says `kept`. The log no longer says there were fewer than 3 review signals when the call failed.
- **Ctrl-C stops a local review.** It printed the aborted result, then kept going: it waited for the model, printed the full report (a second JSON document with `--json`) and exited with the report's code instead of 3. Now Ctrl-C or SIGTERM stops the model call in flight and sends no new one, during a rate-limit wait too. The review prints nothing more, saves nothing, releases its lock and exits with 3. A second Ctrl-C ends the process at once.
- **Ctrl-C at a prompt stops the command.** It counted as "no answer". At the codegraph install prompt a local review went on to the model and printed a full report. `init`, `sync` and `review` asking for a missing model or key went on with an empty answer and then failed, and `clear`, `rollback` and `uninstall` took it as no. Now a local review stops with exit code 3 and no model call, and every other command ends as Ctrl-C ends it anywhere else.
- **A local review only removes its own lock.** A review stopped with Ctrl-C could delete the lock of a review started right after it, so two reviews could run in one repository.
- **A clean tree is reviewed once.** `review` and `review --remote` on a tree with no changes printed "No changes to review." and then still called the model or the server, which printed a second result with `--json` and ended `review --remote` with exit code 2. They now stop after the one line, or the one JSON document with `--json`, and exit 0. A finished remote review also no longer keeps a process that ran the remote routes alive for another minute.
- **A pure rename is shown as a rename.** Local review described a binary file or a pure rename as "diff withheld by GitHub", and pull request review did the same for a pure rename. Both now say what the file is, and a pull request that only renames files is not reported as truncated.
- **A reply the App posts records its AI cost.** Before, a reply's tokens and cost were kept nowhere.
- **An App review's token count includes a JSON retry and a large diff summary.** Before, only the last review call's tokens were stored, while the cost already counted every call.
- **The first App review of a pull request stores the line each finding points at.** The second round can find those findings again instead of telling the model it could not locate any of them.
- **A successful retry after a failed App review edits the failure note with `PATCH`.** That is the method GitHub documents and the App's permission table names. A client without `PATCH` fell back to `POST`, which GitHub does not accept for an edit.
- **A remote review keeps a finding that is still open.** From the second review of a branch on, `review --remote` read only the new findings of the model's answer and ignored its verdicts on the earlier ones. A blocking finding that was not fixed disappeared and the run exited 0. It is now listed under `Still open` and the exit code stays 1, as in a local review.
- **A pull request number that does not exist is reported as the pull request.** `co-maintainer review owner/repo 404` said the repository was not found. With `gh` it now says `Pull request #404 was not found in owner/repo.`, with the error code `pull_request_not_found`. The exit code stays 2.
- **A review without codegraph leaves `.git/info/exclude` alone.** The line that hides the local code index was added even when codegraph was unavailable, and its path was read relative to the folder the command ran in instead of the repository.
- **A failed clone says why.** When the clone for a review failed, the message ended with git's opening line, `Cloning into ...`. It now ends with git's reason, such as `fatal: could not read Username for 'https://github.com'`.

## [0.6.13] - 2026-11-12

### Fixed

- **`set --password` works while `serve` is running.** It saved the new password, then failed with `A co-maintainer serve process (pid N) is using this data directory.` because it opened `app.db` to delete the old dashboard sessions. It no longer opens `app.db`. It saves the time of the change in `config.json`, and `serve` refuses every session started before it. The same holds for `--disable-auth`, `--enable-auth` and `--github-oauth-allowed-user`.
- **`serve` starts after a hard stop in a container.** A lock left behind named pid 2, and `serve` gets pid 2 on every container start, so it read its own pid as another `serve` and refused to start. A lock that names the process's own pid is now taken over.

## [0.6.12] - 2026-11-12

### Fixed

- **A connection closed mid-answer names the host and the cause.** When a provider closed the connection while its answer was arriving, the run ended with only `[error] terminated`. It now says `<host> closed the connection before the answer was complete (UND_ERR_SOCKET: other side closed).` with a hint to run the command again. This covers OpenRouter, OpenCode Zen and Go, OpenAI, Anthropic and Sign in with ChatGPT. The call is still not retried.

## [0.6.11] - 2026-11-09

### Fixed

- **One review per commit.** A review submitted or a review comment written while a review of the same commit was running queued a second review of that commit, which posted the same findings again. The queued review now checks when it starts and runs nothing when that commit is already reviewed. Its round and the commit an incremental review starts from are also worked out when it starts, not when it was queued.
- **A finding in a file that did not change is checked again.** It used to stay open without being looked at, so a fix made in another file never closed it. The next round now asks about it too, with what maintainers with write access replied on its thread, and a reply that shows the finding is wrong can close it.
- **The review summary tells new findings from old ones.** Open findings are listed under `New` and `Still open`, and a still open one says which commit first found it, so a finding from an earlier round no longer reads as a new problem.

## [0.6.10] - 2026-11-08

### Added

- **Commit watch review.** Pushes to the default branch are reviewed when there is no pull request. The server gets a push from the GitHub App's `push` event (off by default, the owner ticks it in the App's settings) or from CI running `review --remote --range=<before>..<after>`. When both report the same push it is reviewed once. A finding never blocks: the App's check run always succeeds, and in CI findings are warnings and the step stays green, with a notice after `timeout-minutes` (default 10) while the review finishes on the server. See the commit watch review docs page.
- **Issues for P0 and P1 commit watch findings.** Opened by the GitHub App as `[P1] <what is wrong>` with the `co-maintainer` and `cm-P1` labels, on by default per repository. A push that changes a finding's lines comments `change in <commit>: changed, still found by the review of <range>`, and when the review says that known issue is fixed co-maintainer closes it. An issue a maintainer closed is checked once on the next push review.
- **Comments on commit watch issues.** From people with write access, and only when meant for co-maintainer: a question gets an answer in its language, and "ignore" or information gets "Noted", then the next sync adds the note to the detailed review guide and stops reporting an ignored finding.
- **Dashboard.** A Commit watch card on each repository's overview with the App and CI setup (the CI workflow carries the server's address), a Pushes tab with each push review, its findings by severity, the issues it opened and its cost, and two repository settings: issues for P0/P1 and what happens to pushes in a row (review each in turn, or cancel and merge into the newest).
- **The GitHub Action reviews pushes.** On a `push` event the action runs a commit watch review. New input `timeout-minutes`.
- **`probe` shows a `commit watch` line** when the machine has the GitHub App configured.

### Fixed

- **`owner/repo` in another case is the same repository** (#67). `init groophylifefor/co-maintainer` and `init GroophyLifefor/co-maintainer` made two repositories, each with its own config entry, guide folder and dashboard row, and a webhook in the owner's spelling missed a repository stored in another. A name is now matched against what is already stored, ignoring case, and the stored spelling is used, so existing repositories keep theirs. A repository seen for the first time is stored in lower case.

## [0.6.9] - 2026-11-08

### Security

- **Windows command execution from a reviewed pull request.** git now runs directly instead of through `cmd /c`, and `NoDefaultCurrentDirectoryInExePath` is set, so a `git.cmd` planted in a repository or a path such as `x&...` in a diff can no longer run a command.
- **Unauthenticated request size limits.** The webhook, the login API and the sign-in form read a bounded body, and the server sets header and request timeouts, so a single large or slow request can no longer exhaust memory.
- **The GitHub Action installs outside the checkout.** The reviewer is installed into a directory outside the workspace with a neutral npm config and no install scripts, so a committed `.npmrc`, `node_modules` or install script in a pull request cannot run with the job's secrets.
- **Signed webhooks are required.** When no webhook secret is configured the server rejects the delivery instead of trusting it.
- **Open redirect after sign-in.** The post-sign-in redirect rejects a backslash or a control character, so it can only point inside the dashboard.
- **Session invalidation on a credential change.** Resetting the password or the sign-in settings from the CLI drops every existing dashboard session.
- **Control characters are stripped** from model and server output before it is printed, so a finding or a remote server cannot inject terminal escape sequences.
- **Review clones disable symlinks** and the codegraph file argument is held inside the repository, so a tool call cannot read a file outside the tree.
- **Default concurrency limits** cap how many reviews a single remote token can run at once.

## [0.6.8] - 2026-11-07

### Fixed

- **A review with no open finding approves.** The review type was computed from every stored finding, closed ones included, so a re-review that confirmed the last finding was fixed still requested changes while its body said "No actionable findings". Only open findings count now, and a review with none open, the first round included, posts `APPROVE` instead of `COMMENT`.
- **The check run counts only open findings.** A re-review whose findings were all closed ended `neutral` with "N finding(s) reported" and annotations on fixed lines. It now ends `success` with "No actionable findings."

## [0.6.7] - 2026-11-07

### Added

- **`--json` for `probe`, `init` and `sync`.** Help and the docs listed the flag, but the parser refused it with `Unknown option: --json. Did you mean --json?`. Each command now prints one `schemaVersion 1` JSON document on stdout, with progress on stderr and no prompts. `probe --run --json` exits with code 2, because the probe and the `init` would be two documents on one stdout.

### Changed

- **AI and GitHub progress lines go through the shared logger.** The `[ai]` queue, retry and cache lines and the `[github]` rate-limit wait printed straight to stdout. They now follow the same rule as every other progress line, so they move to stderr under `--json` and land in a dashboard job's log.

### Fixed

- **`serve` no longer lists `--json`.** It prints no result, so the flag is gone from its help and `commands.md`.
- **`--only-request-changed-pr` help says what it does.** It read "pull requests that changed the requested files". It now says it keeps pull requests with at least one `CHANGES_REQUESTED` review.

## [0.6.6] - 2026-11-06

### Added

- **A copy button for the install command.** The landing page's `npm install -g co-maintainer` line has a `Copy` button that shows `Copied` for a moment after it writes to the clipboard.
- **Website analytics.** co-maintainer.com loads Umami for page analytics and session recordings, and counts copies of the install command and clicks on GitHub links. The CLI, `serve` and the dashboard send no telemetry.

## [0.6.5] - 2026-11-06

### Fixed

- **A review round posts one review.** A finding that repeated an earlier round was posted as a thread reply, and GitHub wraps every reply in a review of its own, so one commit showed an empty extra review and the finding twice. A repeat with the same text now stays on its thread and in the summary, and a finding whose text changed goes inline on the round's single review, opening a new thread.

## [0.6.4] - 2026-10-28

### Added

- **A design-system component library for the dashboard.** `src/server/pages/ui.ts` builds the shared pieces (page headers, cards, tables, badges, alerts, fields, steps, timeline and more) as pure string builders, backed by one stylesheet, so a page composes components instead of hand-writing markup.
- **An internal component gallery.** `serve --debug` (or `CM_DEBUG=1`) serves `/__ui`, a page that renders every component twice, light and dark. It is off by default, so a normal server never serves it.
- **Embedded icons and self-hosted fonts.** Lucide icon SVGs under `src/server/pages/icons/` are embedded into an inline sprite, and the Outfit font files under `src/server/pages/fonts/` ship with the dashboard. The UI makes no external request for either.
- **Copy buttons on code blocks.** A `Copy` button copies a command to the clipboard, with a hidden-textarea fallback so it also works on plain `http://localhost`.
- **Third-party notices.** `THIRD_PARTY_NOTICES` reproduces the Outfit (SIL OFL 1.1) and Lucide (ISC) licenses for the bundled assets, and it is included in the published package.

### Changed

- **`serve` gains `--debug`.** The flag, and the `CM_DEBUG=1` environment variable, expose the internal component gallery without changing any other behavior.

## [0.6.3] - 2026-10-28

### Fixed

- **An interrupted `sync` no longer throws away the pull request cache.** Every pull request is now cached as its own row in `cache.db` (namespace `pr`, keyed `owner/repo:number`) instead of living inside the single `state` row. A run stopped with Ctrl+C keeps the evidence it already fetched, and the next run reuses every unchanged pull request and downloads only what changed, where before it overwrote the whole list with only the pull requests it had finished. An existing `state` is migrated to the new rows on the first run.

### Changed

- **Pull request evidence moved out of the single state blob.** `source.pullRequestCache` is gone, and the per-pull-request rows replace it, so a partial checkpoint can no longer drop the other pull requests' comments, reviews and diffs.

## [0.6.1] - 2026-10-26

### Added

- **PR review can install codegraph.** `co-maintainer review owner/repo PR --allow-tool-install` now installs the pinned codegraph when it is missing, instead of only using an install that is already there. A PR review still never prompts, so it stays safe to run unattended.
- **The pinned codegraph version is configurable.** `co-maintainer set --codegraph-version=X` and the `CM_CODEGRAPH_VERSION` environment variable override the version this build ships, resolved in the order environment, then config, then the built-in pin. This lets a codegraph security or bug fix land without a new co-maintainer release.
- **A Codegraph docs page.** What codegraph is, where it installs, when each command installs it, and how to change the pinned version.
- **Reviews print the provider and models as they start.** Every review logs one line, `models · provider=... · low=... · high=...`, so it is clear which models a run is using before any AI call.

## [0.6.0] - 2026-10-23

### Changed

- **Guides are written by the AI, with no offline build.** `init` and `sync` no longer assemble `SKILL.md`, `CODEBASE.md` or the review guides from facts. Every document is authored by the provider, so `--ai=none` is refused for `init` and `sync` and a run with no provider stops before it fetches anything. `probe` still works with no provider.
- **The review guide is a method, not a list.** The guide is one AI synthesis. Each pass states a general invariant a future change must satisfy, keeps the concrete case as an example under it, and ends with an exit check followed by its obligations, `when <surface> changes -> what must also change`. It carries no priority tag, no pull request number, no commit id, no reviewer name, no quoted comment and no command to run, and passes and rules are ordered by how often the findings recur.
- **Extraction reads inline review comments.** `init` and `sync` now read `pulls/{n}/comments`, where most substantive review feedback lives, next to the issue comments and review bodies. Each review finding carries a class, a location, an impact and an action, so the guide keeps the specifics instead of flattening every review into a short claim.
- **A bad AI response no longer fails the run.** A provider error that outlives its retries drops that one unit, and a response that does not match the expected shape is used as written. Format and provider failures are never fatal after the work is paid for. A rate limit (`429`) waits and retries with backoff.

### Removed

- **The deterministic guide builder.** `buildReviewDocuments` and the fact renderer in `assembleSkill` and `codebaseBody` are gone. There is no offline or AI-free path that writes the guides.

## [0.5.4] - 2026-10-20

### Added

- **Per-repository review instructions.** A repository can carry its own review instructions, appended to the built-in reviewer prompt as a `CUSTOM REVIEW INSTRUCTIONS` section so the role, the diagram rules and the guide are always kept. Set them with `co-maintainer set --repo=owner/repo --review-system-prompt=...` or on the repository's **Settings** page. `review` also takes `--system-prompt-file=PATH` to add and `--system-prompt-override-file=PATH` to replace them for one run, in PR, local and remote review. `reviewSystemPromptMaxChars` caps them per repository (default 8000, `0` or `-1` for no limit). See [Review](docs/md/review.md#repository-review-instructions).

## [0.5.3] - 2026-10-09

### Added

- **`clear` command.** `co-maintainer clear owner/repo` deletes the generated guides, the knowledge stamp, the skill state and the saved per-repo settings, so the repository goes back to "never inited" and the next build is `init`, not `sync`. `--include-cache` also deletes the fetched evidence (pull request listings, AI job cache, costs, local review carry-over) plus its clones and worktrees, so the next `init` is a cold build. `co-maintainer clear all` clears every repository on the machine and asks first, with `--yes` for a terminal-less run. Pending jobs are asked about: queued jobs are canceled and a running review can be stopped. See [Caching](docs/md/caching.md#clearing).
- **Dashboard: clear knowledge.** The Knowledge page has a **Clear knowledge** card with an optional cached-evidence checkbox, and Settings can clear every repository at once. Both ask about jobs in flight: a running review can be stopped, and a running sync cannot be interrupted, so the page waits for it and then clears. Repository records, review history and tokens stay.
- **`uninstall` command.** `co-maintainer uninstall` deletes every data file (config.json, app.db, cache.db, repos, clones, worktrees and tools) and prints the `npm uninstall -g co-maintainer` command that finishes the job, because a running npm package cannot remove itself.
- **Landing page stats.** co-maintainer.com shows GitHub stars and npm downloads this month next to the install command. The numbers refresh from the public GitHub and npm APIs on every visit, with the last known values kept in the markup for offline and no-JS readers.

## [0.5.2] - 2026-10-09

### Fixed

- **`init` and `sync` learned nothing from pull requests and files on a thinking model.** Pulling facts out of a pull request had a small output limit, and a model that thinks by default, such as DeepSeek V4.1 Flash, spent all of it thinking. Every unit was skipped with `AI fact output is not JSON` and the guide was written without them. Fact extraction now asks for no thinking. A model that must always think gets the same request once more without that setting.
- **An answer cut off before its first word read as an empty answer.** When a model reached its output limit before writing anything, OpenRouter, OpenCode, OpenAI and Anthropic answers were taken as empty text and failed later with a misleading message. They now fail with `reached its output limit before writing an answer`, which says that thinking counts toward that limit.

## [0.5.1] - 2026-10-07

### Added

- **OpenAI, Anthropic, OpenCode Zen and OpenCode Go as AI providers.** `--ai=openai`, `--ai=anthropic`, `--ai=opencode-zen` and `--ai=opencode-go` work for `init`, `sync`, `review`, `serve` jobs and automatic reviews, next to OpenRouter. OpenAI is called through its Responses API and Anthropic through its Messages API, with prompt caching on the guides. The two OpenCode gateways are called over Chat Completions, and a model that only answers in another format is refused with a hint that says so. `set` checks the key and the model against the provider before saving, and a rejected key or an unknown model names the provider and exits 2. The OpenCode key can also come from `OPENCODE_API_KEY`. See [AI providers](docs/md/providers.md).
- **No default model.** co-maintainer no longer picks a model for you. `--low-model` and `--high-model` come from `set` or a flag, a terminal asks for the missing one without suggesting a value, and a non-interactive run exits 2 naming which one is missing.
- **Your own AI key for remote review.** `review --remote --remote-byok` sends the key saved as `remote-byok` (or set in `CM_REMOTE_BYOK`) with a remote review, so the server's key is not used and the AI cost is billed to you. The server decides with `CM_REMOTE_BYOK_POLICY` (`off`, `allow` or `require`, `off` by default) and reviews with its own models. The key lives in memory for that review only and is never stored. `--no-remote-byok` and `remote-byok-default` control sending it. See [Remote review](docs/md/remote-review.md#your-own-ai-key).
- **Review policies.** An ordered list of rules decides which pull requests the GitHub App reviews on its own, which wait for a maintainer, and which are never reviewed. Rules can test the author's relation, fork, draft, bot, labels, target branch and changed lines. Templates cover the common cases, and a repository that existed before keeps its three old switches until you pick one. Setting one up is in the dashboard (**Who gets a review**, the server default, the add repository step) and on the command line (`--review-policy`, `--review-policy-file`). See [Review policy](docs/md/review-policy.md).
- **Ask for a review.** A pull request that waits can be started with the `co-maintainer:review` label, a `/co-maintainer review` comment from an allowed author, or **Review now** on the Activity page. The App reacts with an eyes emoji, a request never overrides a rule that skips, and **Reviews per pull request** limits the rounds.
- **GitHub Action.** A composite action runs a remote review on a pull request from a workflow. Inputs reach the script through the environment, keys are masked, and a blocking finding fails the step. Releases move the `v0` style major tag after publish. See [CI](docs/md/ci.md).
- **`review --output=github`.** Findings print as `::error` and `::warning` annotations and a table goes to the job summary. Text the model wrote is escaped, so a pull request can never start a workflow command of its own. The exit code is unchanged.
- **`CM_REMOTE_HOST` and `CM_REMOTE_TOKEN`.** The remote host and token can come from the environment, so a workflow needs no saved config.
- **Back up before an upgrade, and `rollback`.** When an upgrade has to migrate `app.db`, the old `app.db`, `cache.db` and `config.json` are copied first. `co-maintainer rollback` puts them back and tells you what you lose.
- **Permission tables.** The GitHub App permissions and the scopes a token needs are one documented list, and a missing permission now names the permission in the error.
- **Documentation.** New pages for AI providers and review policy, and updated pages for configuration, remote review, cost, the dashboard, troubleshooting, privacy and the commands reference.

### Changed

- **Review uses your saved provider.** Local and PR `review` were pinned to OpenRouter. They now run on whichever provider is saved or passed with `--ai`. With none saved they still use OpenRouter, and `review --ai=none` is refused with `review needs an AI provider`.
- **Unknown cost reads `unknown`.** A review whose provider did not report a cost used to show `$0.00`. It now shows `unknown` with the reason, and a total says how many of its reviews have no recorded cost instead of rounding them away. OpenAI, Anthropic and the OpenCode gateways never report a cost. A remote review billed to your own key is listed as `$x + $y BYOK`.
- **`probe` on providers without prices.** The estimate says `estimate unavailable for this provider` instead of printing a dollar range it cannot know.
- **`OPENROUTER_LOW_MODEL` and `OPENROUTER_HIGH_MODEL`** are only read when OpenRouter is the provider.
- **The saved key goes only to the saved provider.** A run on another provider, with `--ai` or a repository that was set up on another one, asks for that provider's key instead. Switching the provider with `set --ai` or in the dashboard needs the new provider's key.

### Fixed

- **`serve` ignored a key in its environment.** Jobs read the AI key only from `config.json`, so a server started with `CO_MAINTAINER_TOKEN` or a provider key variable failed every job and the dashboard said AI was not set up. It now resolves the key the way the CLI does.
- **Failed job errors carried the class name.** The dashboard and a remote client showed `Error: ...` in front of a failed job's message. Only the message is shown now.
- **Checkboxes on the Settings page.** They stretched across the whole row and pushed their label to the next line. They now sit beside the label.
- **OpenAI keys are masked in logs and output**, like OpenRouter and Anthropic keys.

## [0.5.0] - 2026-09-23

### Added

- **`sync` replaces `remake`.** The command that rebuilds a repository's guides now reads `sync` everywhere: help, logs, tips, the dashboard, and the docs. `remake` keeps working as a hidden alias with the same handler and flags, and `--remake-before-review` keeps working too. The stored values do not move: `job.type` stays `remake`, the per-repo key stays `remakeCron`, and the API route stays `/api/repos/:owner/:repo/remake`. `--sync-before-review` is the new name on the CLI, and `npm run sync` joins `npm run remake`.
- **`config` command.** `co-maintainer config list` prints every setting as key, value, and source (env, file, or default). `config get`, `config set`, `config unset`, and `config path [--all]` round it out. Secrets are masked: twelve characters or more show the last four after a row of dots, shorter ones show dots only, and the dashboard password hash is never listed. A value is checked against OpenRouter (`/key` and `/models`) before it is saved, and a bad key or model exits 2 without touching the file. `--ai-key` is an alias for `--token`, and `--review-blocking=model|severity` lives here.
- **`view` command.** Print the guides a repository has: `view owner/repo` prints all of them with a `== SKILL.md · built <date> ==` heading each, `view owner/repo review-guide` prints one raw so it can be redirected to a file, and `--list` and `--path` describe the guide folder. Without a repo argument it reads the git remote. A missing guide exits 2 with a `probe` hint.
- **`probe` estimates cost and time.** The plan now ends with an `estimate` block (jobs, token range, duration, dollars, and whether the basis is this repository's own history or the calibration set), a `next` block naming the recommended `init`, and `--run` to start that `init` in the same process. Pricing comes from OpenRouter and is cached for a day, and if it cannot be reached the dollar line is left out rather than guessed.
- **`--remote-host` and `--remote-token`.** Override the configured remote for one `review --remote` run without saving anything. Rejected with exit 2 outside `--remote` and in PR mode.
- **One cost and time line per run.** `init`, `sync`, local review, PR review, and remote review end with one line on stderr, for example `Done in 21.0s · 3,125 in, 1,308 out tokens · $0.0016`. `--json` stdout is untouched, and in a dashboard job the line goes to the job log instead of a terminal.
- **Every command rendered from one registry.** `help`, `<cmd> --help`, and `<cmd> -h` all exit 0, `serve --help` no longer starts a server, and a mistyped command or flag gets a did-you-mean within edit distance 2. `version` becomes a command alongside `--version`.
- **`GET /api/remote/guides?repo=owner/repo`.** A remote token can read a repository's guides, and `view --remote` uses it. The same bearer model as remote review applies: valid and active token, path validated, unknown or inactive repo answers 404.
- **Structured findings.** The model returns findings as JSON (`severity, blocking, path, lineFrom, lineTo, symbol, title, body, suggestion`) and co-maintainer renders the Markdown, so a boundary is never guessed. A schema and `tools` combination that the provider rejects is retried once without the schema, and unparseable JSON is retried once before falling back to the older Markdown reader. Comments posted before 0.5.0 still parse, so carry-over keeps working.
- **Dashboard: Create GitHub App.** The GitHub App card can create the App for you instead of copying a private key, a webhook secret, and OAuth credentials by hand. Set a public webhook address, pick a name (default `co-maintainer-<host>`), and GitHub confirms the permissions and events the code actually uses. GitHub redirects back and `serve` writes the App ID, private key, webhook secret, and OAuth credentials into `config.json`. On an unreachable webhook address the button says why. The manual fields stay.
- **`--github-app-private-key-path=path`.** Store only the path to the App private key, never its contents, so the key stays on disk and is read at startup. `serve` warns when the file is missing. `--github-app-private-key` and `--github-app-private-key-file` keep their existing behavior.
- **`CM_LOGIN_HINT`.** Replace the sign-in page's default "printed when serve started" line with your own text, escaped as plain text. For a deployment that hands out its own password.
- **Dashboard: setup checklist.** The home page shows a **Finish setup** card until an install is complete, with a link to the settings card that fixes each gap.
- **Dashboard: preview before adding a repository.** Add a repo now probes, shows the recommendation and estimated cost, and waits for confirmation before starting `init`.
- **Dashboard: open pull requests.** The Pull requests tab lists open, non-draft PRs with a **Review** button each.
- **Dashboard: webhook reachability.** The repo overview warns when the webhook URL is unreachable from GitHub, and shows the last delivery.
- **Documentation on `co-maintainer.com`.** Every page now lives under `co-maintainer.com/docs/`, and the root is the landing page. Each page carries a meta description, a canonical link to the site origin, and the site ships a `CNAME`, a `sitemap.xml`, and a redirect stub at every old flat address (`remake.html` included). The docs build runs in CI, so a dead internal link or a missing redirect fails a pull request.
- **New documentation pages and search.** The site gains Troubleshooting (every exit code and message, with the fix), Cost (what spends tokens and how `probe` estimates it before you start), Data and privacy (what is stored and where), Cloud (the hosted service and how `review --remote` connects to it), GitHub App (the manifest flow plus a permissions and events table), View guides, and a Commands reference generated from the command registry. The sidebar is grouped into Getting started, Review, Self-hosted, Cloud, and Reference, and a client-side search over a generated `search-index.json` finds a page or a heading. Links are checked down to the anchor, so a renamed heading cannot leave a dead link.
- **Model-readable docs.** Every page is also published as Markdown at `/docs/<slug>.md`, and the site serves `llms.txt` (the llmstxt.org index of every page) and `llms-full.txt` (the same pages combined in one file). All three are built from the same `docs/md/` source as the HTML, so they cannot drift.

### Changed

- **Exit-code contract.** 0 is success, 1 is a blocking review finding in `review`, 2 is a usage or precondition error, and 3 is a run error. Every CLI failure now goes through one error type and one exit point, so the code and the printed message cannot disagree. This is a behavior change for scripts that read the old codes.
- **One human output layer.** Local, PR, and remote reviews print the same header (repo, subject, guide date, codegraph state), the same findings grouped as `Closed`, `Still open`, and `New`, and the same `Summary:` line. The fixed Severity legend and the "explain it in more detail" line are gone from the terminal, and stay in the GitHub comment. Both `local` and PR output now read the real guide date and the real codegraph state instead of a `guide unknown` placeholder and an optimistic `used`.
- **Blocking from severity.** A new `review-blocking` setting chooses the rule. `model` (default, the 0.4.13 behavior) lets the model mark each finding blocking, with P0 always blocking. `severity` blocks on P0 and P1 only. All four paths read the same decision: the local exit code and human output, the PR exit code, the remote result (the server decides and the `blocking` field is read back), and the App review's `REQUEST_CHANGES` or `COMMENT` choice. `--json`'s `blocking` field and the exit code now come from that one decision. Set it with `config set --review-blocking=severity` or `CO_MAINTAINER_REVIEW_BLOCKING`.
- **Carry-over no longer shadows a fresh scan.** The prompt now asks for two separate jobs: scan the diff from scratch, and decide the fate of each earlier finding, saying outright that a new finding may sit at the same location as an old one. When the guide was rebuilt after the last review, the run is fresh on its own and carry-over is off, with no `unchangedPaths` narrowing, across local, PR, and remote reviews.
- **Real error text.** Every failure names what, why, and what to do next. A `gh` 404 names the `owner/repo`, an OpenRouter 401 becomes a usage error, a network error names the host and the cause code, a rejected remote token points at the dashboard, and a `serve` lock names the pid. No raw provider body or `user_id` ever reaches the output.
- **Dashboard: high and low model labels.** "Main model" and "Cheap model" now read "High model" and "Low model", matching the CLI, with hints naming their real jobs.
- **Windows platform warning.** `serve` no longer points at an internal document. It says Linux (WSL included) is recommended and links to the public troubleshooting page.
- **No em dash or semicolon in product text.** User-visible copy, the dashboard, the AI prompts that shape a finding, and new changelog entries now use a colon or a comma where an em dash used to sit, and full stops where a semicolon did. The finding heading is `[P2 · non-blocking] \`path\`: \`symbol\``. Comments posted before 0.5.0 still parse, so carry-over keeps working.

### Deprecated

- **`remake` as a command name.** `co-maintainer remake` and `--remake-before-review` keep working, but they are hidden from help. Use `sync` and `--sync-before-review`. The stored names (`remakeCron`, `job.type="remake"`, `/api/repos/:owner/:repo/remake`) are not changing, so nothing needs migrating.
- **Old flat documentation addresses.** `co-maintainer.com/<page>.html` now redirects to `co-maintainer.com/docs/<page>.html`. The redirect stubs stay for now and are removed in a later release.

### Fixed

- **Windows crash on exit.** `process.exit` after a `fetch` left the undici connection pool open and tripped a libuv assertion (`0xC0000409`) on Windows. Every path now sets `process.exitCode` and lets the event loop drain, the heartbeat interval is `unref`ed and cleared on every error path, and the clone passes `-c core.longpaths=true`. The old code is proven red against the new test.
- **Failed AI units are not cached.** A unit whose output does not parse is validated, retried once, and, if it still fails, reported as skipped instead of being written to the cache, so the next run does not reuse garbage.
- **A skipped `PR_REVIEW_GUIDE.md` says why.** Below the threshold the run prints one line naming the reason instead of silently leaving the guide out.
- **The codegraph install prompt no longer hangs.** `readline` did not settle on EOF, so a non-interactive run waited forever on a question it could not answer.
- **Dashboard scripts and token secret.** The dashboard helper runs after the page is parsed, so `bindToggle` and the activity poll no longer throw at load time. The remote token secret is shown in an in-page panel with a copy button instead of a browser `prompt()`.

## [0.4.13] - 2026-09-22

### Fixed

- **CLI `init` and `remake` open `app.db`**: The run wrote the skill, then called `markKnowledgeBuilt` on a database only `serve` had opened, and exited with `app.db is not open` before the final state write. The command now opens `app.db` for the run and closes it afterward, so the cache from that run is saved. A `serve` process that already holds the database is left open.

## [0.4.12] - 2026-09-22

### Fixed

- **Fetched pull request decisions and commit history stay in the cache**: A pull request dropped by `--only-request-changed-pr` was left out of the saved state, so the next `init` or `remake` downloaded its detail and reviews again (`dropped download`). The decision is now stored, and an unchanged pull request logs `dropped cache` without calling `gh`. It still stays out of the skill. Commit history reuses the saved list when the newest commit is unchanged, instead of paging the whole window again.

## [0.4.11] - 2026-09-21

### Fixed

- **Skill markdown no longer aborts `init` or `remake`**: Commands, missing links, tables, code fences, bullet limits, and other skill-markdown problems used to exit with `generated skill is invalid`. The run now writes the skill anyway and logs `skill problems kept`. A missing source path still drops that model section, then continues.

## [0.4.10] - 2026-09-21

### Added

- **`--pr-state=open,closed,merged`**: `init` and `remake` can keep a comma-separated subset of pull request states. `closed` is closed and not merged. Omit the flag to keep every state. The choice is saved for the repo, so a later `remake` without the flag keeps it. Pass `--pr-state=open,closed,merged` to collect every state again. The listing cache is stored per state set, so a run with a different set does not reuse the previous listing. The listing log names the set (`pull request listing · merged · concurrency=…`).

### Changed

- **Init, remake, and per-repo config docs**: [`init`](docs/init.html), [`remake`](docs/remake.html), and [per-repo memory](docs/configuration.html#per-repo-memory) now document `--only-request-changed-pr` and `--pr-state`, including that a saved request-changed filter stays on.

## [0.4.9] - 2026-09-21

### Changed

- **A dropped pull request log says cache or download**: With `--only-request-changed-pr`, a pull request skipped because the saved decision is already `changesRequested: false` logs `dropped cache` and does not call `gh`. One whose reviews were just fetched and had no `CHANGES_REQUESTED` review logs `dropped download`. Comment and diff downloads stay skipped either way.

## [0.4.8] - 2026-09-21

### Added

- **`--only-request-changed-pr`**: `init` and `remake` can keep only the pull requests in the `--max-pr-months` window that have at least one `CHANGES_REQUESTED` review. A dismissed review does not count. Dropped pull requests skip comment and diff downloads. The run logs `only request-changed pr · kept N · dropped N`. The choice is saved for the repo, so a later `remake` without the flag keeps it. Off by default, and the flag does not turn itself back off.

## [0.4.7] - 2026-09-21

### Added

- **`--debug` prints the GitHub quota**: While `gh` requests are running, debug mode prints the core and search remaining quota every two minutes (`github quota · core 4120/5000 · search 28/30 · reset 21:58`). The line is a log line, so `review --json` stays intact, and the timer stops once the `gh` calls stop.

### Changed

- **A primary GitHub rate limit waits instead of failing**: When the remaining quota is 0, `githubFetch` (a PAT or the GitHub App) and the `gh` client sleep until the reset time, then retry the same request. If the reset is more than 30 minutes away they wake and try again anyway, and a reset header that keeps moving forward stops the wait after two hours. Calls that hit the limit together share one sleep. `gh` reads `gh api rate_limit` to decide: `search/` uses the search bucket, everything else uses core, and a failure that still has remaining quota is thrown as before. A secondary limit is unchanged and still retries in place up to three times on `retry-after`.

## [0.4.6] - 2026-09-21

### Added

- **`serve --trust-proxy` and `CM_TRUST_PROXY=1`**: For a `serve` that sits behind a reverse proxy. It takes the client address from the last entry of `x-forwarded-for` and marks the session cookie `Secure` when the last `x-forwarded-proto` is `https`. Before this, every visitor behind a proxy looked like one address, so anyone on the internet could lock the owner out of password sign-in with five wrong guesses, and the session cookie never carried the `Secure` flag even over HTTPS. Off by default, because without a proxy the headers can be forged.

## [0.4.5] - 2026-09-21

### Added

- **Docker image**: The repository now has a `Dockerfile`, and every release publishes `ghcr.io/groophylifefor/co-maintainer` tagged with the version (plus `latest` for stable releases). The image runs `serve --port=5000` as a non-root user on Node.js 26, bundles `git` and the codegraph version this release expects, and keeps all state in a `/data` volume. Its entrypoint clears a stale `app.db.lock`, because a container restarts with small PIDs that can match the PID a killed run left behind. The publish workflow builds and pushes the image after the npm publish and skips a version that is already on ghcr.io. For a stable version that is already there, it also re-creates a missing `latest` tag without rebuilding, and leaves an existing `latest` alone.

## [0.4.4] - 2026-09-21

### Added

- **Scheduled remake**: Each repository has a Scheduled remake card in its dashboard Settings that takes a five field cron expression in UTC. `serve` checks the schedules every 15 seconds and queues a `remake` when one matches. A schedule fires at most once an hour, so the minute field must be a single value. A repository is skipped while its first setup is unfinished or a setup job for it is already queued or running, and a minute the server was down for is not made up. The value is saved as `remakeCron` through `PATCH /api/repos/:owner/:repo`, which answers `422 invalid_cron` for a bad expression and changes nothing else in that request.

## [0.4.3] - 2026-09-21

### Added

- **Change the dashboard password from Settings**: A new Password card asks for the current password and a new one (8 to 200 characters), then signs out every other browser session. The new endpoint is `POST /api/settings/password`, and repeated wrong guesses count toward the same lockout as sign-in.
- **`co-maintainer set --password=...`**: Sets the dashboard password without starting `serve`. `--unset=password` clears it, and the next `serve` start generates a fresh one.

### Changed

- **The dashboard password is stored in `config.json` as a scrypt hash**: It used to live only in the memory of the running `serve` process, so a restart printed a new one. `serve` now generates a password on the first start only, keeps it across restarts, and reads it on every sign-in so a change applies immediately. `serve --password=...` replaces the stored password, and a value outside 8 to 200 characters stops `serve` before it opens the database, matching Settings and `set --password`.

## [0.4.2] - 2026-09-21

### Fixed

- **Remake failed with `referenced path is absent from source`**: The "frequently changed files" fact was built from pull request history without checking the current tree, so a file that was later deleted or moved ended up in the skill and failed validation. When that skill was the deterministic fallback, every `init` and `remake` failed until the pull request aged out of the window. The fact now lists only files that still exist, and stale path or command references in the final skill are logged as warnings instead of aborting the run. AI output that references a missing path is still rejected.

## [0.4.1] - 2026-09-21

### Added

- **`-v` and `--version`**: Print the installed version and exit.

### Changed

- **`serve` starts without a GitHub App**: Startup no longer exits when the App ID or private key is missing. It prints a notice and keeps running, so a fresh instance can be brought up first and connected to GitHub afterwards from the dashboard settings.
- **GitHub App credentials apply without a restart**: The App ID, private key, and webhook secret are read from `config.json` on every request instead of once at startup. Saving them in the dashboard takes effect immediately, including for webhook signature checks.

## [0.4.0] - 2026-09-18

The first release that runs on Node.js. co-maintainer was Deno/JSR-only through
`0.3.0`. `0.4.0` moves the runtime, the install channel, and the toolchain to
Node.js 24+, and drops Deno support entirely.

### Changed

- **Runtime: Deno → Node.js 24+**: Every `Deno.*` API was replaced with a Node equivalent across config, store, process execution, CLI prompts, and the HTTP server. Tests now run under `node --test`.
- **Install**: `deno install … jsr:@murat/co-maintainer` → `npm install -g co-maintainer`. The JSR package is deprecated and no longer updated. The remote-review `426` upgrade hint and all docs now point at npm.
- **SQLite**: The `@db/sqlite` driver was replaced by a thin wrapper over `node:sqlite`. Behavior (`prepare<T>()`, `db.changes`, `undefined` → NULL, `boolean` → 0/1) is preserved on both the positional and named-parameter paths. Existing `app.db` / `cache.db` files are read in place.
- **HTTP server**: `Deno.serve` was replaced with a `node:http` bridge that feeds Web `Request`/`Response` objects, with graceful shutdown for SSE.
- **Interactive prompts**: `confirm` now uses `node:readline/promises`, so prompt APIs are async.
- **Tooling**: `deno task` → npm scripts. `deno lint`/`deno fmt` → `oxlint`/`oxfmt`.
- **Packaging**: Sources are compiled to `dist/` with `tsc` for the published package. Development still runs the `.ts` sources directly.
- **Publish CI**: The workflow caches the npm download, sets `timeout-minutes: 20`, and serializes runs with a `concurrency` group. Because a queued run is only serialized and not skipped, the publish step first checks `npm view` and no-ops when the version is already on the registry.

### Fixed

- **Codegraph on Windows**: `codegraph` is installed as a `.cmd`/`.ps1` shim, and `node:child_process.spawn` cannot execute those without a shell (`EINVAL`). `Deno.Command` resolved them natively, so this regressed in the Node move and every Windows review reported `codegraph: unavailable`. The runner now routes through `cmd /c`, matching `git`.
- **Dashboard "Remote" tab**: `/repos/{owner}/{repo}/remote` returned `no route for …`. The page, its nav link, and its `sub === "remote"` handler all existed, but the page router's regex never listed `remote` as a sub-route, so the handler was unreachable.
- **`serve --webhook-url` validation**: `new URL()` accepted malformed values such as `http://http://host/:5000/…` (parsed with host `http`) and `http:///github/webhook` (parsed with host `github`). A leaked scheme, an empty authority, and a bare `/` path are now rejected with a clear message, while internal single-label hosts (a Docker/k8s service name) and IPv6 literals are accepted.
- **Codegraph install prompt was effectively ignored**: `confirm()` became async with `node:readline/promises`, but `ensureCodegraph` / `ensureCodegraphForReview` still tested the returned promise for truthiness. A promise is always truthy, so answering "no" installed anyway (and a non-interactive run reported the binary as unavailable instead of declining). Both now await the answer, and an explicit decline stops the install.
- **`review --json` could still prompt**: `parseReviewArgs` applied `setCliInteractive(!json)` only after parsing, and `--json` is stripped before `parseArgs` ever sees it. A missing value that has a default (`high-model`) died with "pass it as a CLI option" instead of taking the default. The flag is now applied before the parse.
- **Stray number on a repo subpage**: `/repos/{owner}/{repo}/remote/{n}` (and `settings`/`knowledge`) rendered the page while silently dropping the number. Only `pulls` is keyed by a number. Anything else is now a 404.
- **Windows PID liveness could fail open**: a `tasklist` spawn failure or empty output was read as "process is dead", which would let a second writer take over a live `app.db` / review lock. An indeterminate probe now reports alive. An explicit no-match is still dead.
- **`makeTempFile` leaked a directory per call**: it created a fresh `mkdtemp` directory for a single file, and callers only delete the file, so benchmark and review runs left empty `cm-*` directories in the temp dir. The file is now created directly with `wx` uniqueness.
- **Codegraph tool args reached `cmd.exe` unescaped**: on Windows the CLI runs through `cmd /c`, so a search term or path containing `&`, `|`, `>`, `^`, `%` or a newline could append a second command. Tool arguments are now rejected if they contain a shell metacharacter.
- **`askLine`/`askConfirm` rejected on a closed stdin**: a Ctrl-D or a detached pipeline surfaced as an uncaught rejection instead of an empty answer, bypassing the caller's fallback and `required` validation.
- **Remote fixture hash was line-ending sensitive**: the expected `REMOTE_FIXTURE_HASH` had been computed on a Windows checkout, where `autocrlf` turned the fixture files into CRLF. CI checks the repo out at LF (`.gitattributes` is `eol=lf`) and computed a different digest, so the test only passed locally. The hash now normalizes `\r\n` to `\n` before digesting, and the constant was recomputed against the canonical LF contents.
- **Publish CI could fail on a duplicate push**: a `concurrency` group only serializes a queued run, it does not skip it, so two pushes carrying the same `package.json` version ran `npm publish` twice and the second one failed with "version already exists". The publish step now checks `npm view` first and no-ops when that version is already on the registry.

### Removed

- `deno.json`, `jsr.json`, and `deno.lock`.
- Deno-specific JSR publishing workflow (replaced by npm publishing in CI).

## [0.3.0] - 2026-09-17

### Added

- **Local `review`**: Review the current git worktree (staged, unstaged, and untracked files) without opening a pull request. Supports `--to-branch`, `--branch`, `--repo`, `--fresh`, and optional `--remake-before-review`.
- **Local carry-over**: Repeated local reviews on the same repo root and branch reuse prior findings via `cache.db` (open / closed / new), with graceful fallback when the cache is unavailable.
- **PR review carry-over**: Incremental PR reviews can carry findings across rounds using stored revisions, subject IDs, and guide timestamps (`migration 7`).
- **Structured review output**: `--json` for local and PR reviews: `schemaVersion`, findings, summary counts, usage, duration, and codegraph state. Human-friendly grouped CLI output on stderr for progress.
- **Codegraph on CLI review by default**: Local and remote reviews enable codegraph tools unless `--disable-codegraph` is set. Use `--allow-tool-install` to install the pinned codegraph build without a prompt.
- **Remote review**: Run `co-maintainer review --remote` against a `serve` instance: handshake, diff submit, job queue, and `/sync` polling. Server runs AI. The CLI executes codegraph tools locally and returns results through the **tool bridge**.
- **Remote dashboard**: Settings: create/deactivate/delete bearer tokens (`cmr_…`), sync timeout, per-token concurrency, and tool output limits. Per-repo **Remote** tab and analytics for CLI-submitted reviews.
- **CLI configuration**: `co-maintainer set --remote-host=…` and `--remote-token=…` for remote review targets.
- **Documentation**: Review docs split into [`review`](docs/review.html), [`local-review`](docs/local-review.html), [`remote-review`](docs/remote-review.html), and [`local-pr-review`](docs/local-pr-review.html) (sources in [`docs/md/`](docs/md/)).
- **Developer e2e**: `npm run review-local-e2e` (fake AI worktree loop) and expanded CLI/store tests for local review, carry-over, and remote protocol validation.

### Changed

- **PR review prompts**: Stronger guidance to use codegraph (callers, impact, affected) instead of guessing from the diff alone. Upstream merge context is scoped so findings are not raised on non-PR code.
- **Workspace / remote review prompts**: Same codegraph verification instructions as PR review. Improve pass re-checks findings that depend on behavior outside the diff.
- **Remote review logs**: Tool rounds (`review-tools`) are forwarded into job logs during remote reviews for easier debugging.
- **Remote CLI output**: Human-readable finding text in the terminal for remote reviews (not a placeholder count).
- **Codegraph execution**: Server and local paths share `codegraph_exec`. Tool arguments reject escaping paths and unsafe flags.
- **Git diffs**: Fallback to per-file `git diff` when bulk unified patches are missing. Safer handling when GitHub withholds large patches.
- **GitHub PR review summary**: Aligns posted summary with open carry-over findings.

### Fixed

- **Login lockout**: Use client IP from the HTTP server for API login attempts (non-interactive `serve` / SSH).
- **Remote API**: Correct body size limits, JSON null bodies, and revision/path validation on submit.
- **Remote sync**: Schema validation, abort cleanup, and client minimum schema checks on sync.
- **Local review**: Shallow merge-base fetch remote, `numstat -z` parsing, Ctrl-C / sync lock release, keyed lock cleanup on interrupt.
- **Carry-over**: Incremental diff edge cases, guide timestamp alignment, first-seen review IDs, and path narrowing for typecheck.
- **Atomic writes**: Windows backup-swap for guide writes. Orphan job cancel reasons recorded.
- **Job worker**: `maxConcurrentJobs` respected in `claimAndRun`.
- **Settings (remote tokens)**: Escape token names in the dashboard list (XSS).
- **Remote review cancellation**: Deactivating or deleting a token, or canceling a queued job from the dashboard, marks the associated remote **review** row as `aborted` (not only the job).
- **Repo remote list**: Remote reviews on the repo tab filter to the last **30 days**, matching the page copy.

### Security

- Remote bearer tokens are stored hashed. Raw `cmr_…` values are shown once at creation.
- Deactivating or deleting a token cancels in-flight remote reviews for that token.

[0.5.0]: https://github.com/GroophyLifefor/co-maintainer/compare/v0.4.13...v0.5.0
[0.4.0]: https://github.com/GroophyLifefor/co-maintainer/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/GroophyLifefor/co-maintainer/compare/v0.2.22...v0.3.0
