# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-09-21

### Added

- **Change the dashboard password from Settings** — A new Password card asks for the current password and a new one (8 to 200 characters), then signs out every other browser session. The new endpoint is `POST /api/settings/password`, and repeated wrong guesses count toward the same lockout as sign-in.
- **`co-maintainer set --password=...`** — Sets the dashboard password without starting `serve`. `--unset=password` clears it, and the next `serve` start generates a fresh one.

### Changed

- **The dashboard password is stored in `config.json` as a scrypt hash** — It used to live only in the memory of the running `serve` process, so a restart printed a new one. `serve` now generates a password on the first start only, keeps it across restarts, and reads it on every sign-in so a change applies immediately. `serve --password=...` replaces the stored password, and a value outside 8 to 200 characters stops `serve` before it opens the database, matching Settings and `set --password`.

## [0.4.2] - 2026-09-21

### Fixed

- **Remake failed with `referenced path is absent from source`** — The "frequently changed files" fact was built from pull request history without checking the current tree, so a file that was later deleted or moved ended up in the skill and failed validation. When that skill was the deterministic fallback, every `init` and `remake` failed until the pull request aged out of the window. The fact now lists only files that still exist, and stale path or command references in the final skill are logged as warnings instead of aborting the run. AI output that references a missing path is still rejected.

## [0.4.1] - 2026-09-21

### Added

- **`-v` and `--version`** — Print the installed version and exit.

### Changed

- **`serve` starts without a GitHub App** — Startup no longer exits when the App ID or private key is missing. It prints a notice and keeps running, so a fresh instance can be brought up first and connected to GitHub afterwards from the dashboard settings.
- **GitHub App credentials apply without a restart** — The App ID, private key, and webhook secret are read from `config.json` on every request instead of once at startup. Saving them in the dashboard takes effect immediately, including for webhook signature checks.

## [0.4.0] - 2026-09-18

The first release that runs on Node.js. co-maintainer was Deno/JSR-only through
`0.3.0`; `0.4.0` moves the runtime, the install channel, and the toolchain to
Node.js 24+, and drops Deno support entirely.

### Changed

- **Runtime: Deno → Node.js 24+** — Every `Deno.*` API was replaced with a Node equivalent across config, store, process execution, CLI prompts, and the HTTP server. Tests now run under `node --test`.
- **Install** — `deno install … jsr:@murat/co-maintainer` → `npm install -g co-maintainer`. The JSR package is deprecated and no longer updated; the remote-review `426` upgrade hint and all docs now point at npm.
- **SQLite** — The `@db/sqlite` driver was replaced by a thin wrapper over `node:sqlite`; behavior (`prepare<T>()`, `db.changes`, `undefined` → NULL, `boolean` → 0/1) is preserved on both the positional and named-parameter paths. Existing `app.db` / `cache.db` files are read in place.
- **HTTP server** — `Deno.serve` was replaced with a `node:http` bridge that feeds Web `Request`/`Response` objects, with graceful shutdown for SSE.
- **Interactive prompts** — `confirm` now uses `node:readline/promises`, so prompt APIs are async.
- **Tooling** — `deno task` → npm scripts; `deno lint`/`deno fmt` → `oxlint`/`oxfmt`.
- **Packaging** — Sources are compiled to `dist/` with `tsc` for the published package; development still runs the `.ts` sources directly.
- **Publish CI** — The workflow caches the npm download, sets `timeout-minutes: 20`, and serializes runs with a `concurrency` group. Because a queued run is only serialized and not skipped, the publish step first checks `npm view` and no-ops when the version is already on the registry.

### Fixed

- **Codegraph on Windows** — `codegraph` is installed as a `.cmd`/`.ps1` shim, and `node:child_process.spawn` cannot execute those without a shell (`EINVAL`). `Deno.Command` resolved them natively, so this regressed in the Node move and every Windows review reported `codegraph: unavailable`. The runner now routes through `cmd /c`, matching `git`.
- **Dashboard "Remote" tab** — `/repos/{owner}/{repo}/remote` returned `no route for …`. The page, its nav link, and its `sub === "remote"` handler all existed, but the page router's regex never listed `remote` as a sub-route, so the handler was unreachable.
- **`serve --webhook-url` validation** — `new URL()` accepted malformed values such as `http://http://host/:5000/…` (parsed with host `http`) and `http:///github/webhook` (parsed with host `github`). A leaked scheme, an empty authority, and a bare `/` path are now rejected with a clear message, while internal single-label hosts (a Docker/k8s service name) and IPv6 literals are accepted.
- **Codegraph install prompt was effectively ignored** — `confirm()` became async with `node:readline/promises`, but `ensureCodegraph` / `ensureCodegraphForReview` still tested the returned promise for truthiness. A promise is always truthy, so answering "no" installed anyway (and a non-interactive run reported the binary as unavailable instead of declining). Both now await the answer, and an explicit decline stops the install.
- **`review --json` could still prompt** — `parseReviewArgs` applied `setCliInteractive(!json)` only after parsing, and `--json` is stripped before `parseArgs` ever sees it. A missing value that has a default (`high-model`) died with "pass it as a CLI option" instead of taking the default. The flag is now applied before the parse.
- **Stray number on a repo subpage** — `/repos/{owner}/{repo}/remote/{n}` (and `settings`/`knowledge`) rendered the page while silently dropping the number. Only `pulls` is keyed by a number; anything else is now a 404.
- **Windows PID liveness could fail open** — a `tasklist` spawn failure or empty output was read as "process is dead", which would let a second writer take over a live `app.db` / review lock. An indeterminate probe now reports alive; an explicit no-match is still dead.
- **`makeTempFile` leaked a directory per call** — it created a fresh `mkdtemp` directory for a single file, and callers only delete the file, so benchmark and review runs left empty `cm-*` directories in the temp dir. The file is now created directly with `wx` uniqueness.
- **Codegraph tool args reached `cmd.exe` unescaped** — on Windows the CLI runs through `cmd /c`, so a search term or path containing `&`, `|`, `>`, `^`, `%` or a newline could append a second command. Tool arguments are now rejected if they contain a shell metacharacter.
- **`askLine`/`askConfirm` rejected on a closed stdin** — a Ctrl-D or a detached pipeline surfaced as an uncaught rejection instead of an empty answer, bypassing the caller's fallback and `required` validation.
- **Remote fixture hash was line-ending sensitive** — the expected `REMOTE_FIXTURE_HASH` had been computed on a Windows checkout, where `autocrlf` turned the fixture files into CRLF; CI checks the repo out at LF (`.gitattributes` is `eol=lf`) and computed a different digest, so the test only passed locally. The hash now normalizes `\r\n` to `\n` before digesting, and the constant was recomputed against the canonical LF contents.
- **Publish CI could fail on a duplicate push** — a `concurrency` group only serializes a queued run, it does not skip it, so two pushes carrying the same `package.json` version ran `npm publish` twice and the second one failed with "version already exists". The publish step now checks `npm view` first and no-ops when that version is already on the registry.

### Removed

- `deno.json`, `jsr.json`, and `deno.lock`.
- Deno-specific JSR publishing workflow (replaced by npm publishing in CI).

## [0.3.0] - 2026-09-17

### Added

- **Local `review`** — Review the current git worktree (staged, unstaged, and untracked files) without opening a pull request. Supports `--to-branch`, `--branch`, `--repo`, `--fresh`, and optional `--remake-before-review`.
- **Local carry-over** — Repeated local reviews on the same repo root and branch reuse prior findings via `cache.db` (open / closed / new), with graceful fallback when the cache is unavailable.
- **PR review carry-over** — Incremental PR reviews can carry findings across rounds using stored revisions, subject IDs, and guide timestamps (`migration 7`).
- **Structured review output** — `--json` for local and PR reviews: `schemaVersion`, findings, summary counts, usage, duration, and codegraph state. Human-friendly grouped CLI output on stderr for progress.
- **Codegraph on CLI review by default** — Local and remote reviews enable codegraph tools unless `--disable-codegraph` is set. Use `--allow-tool-install` to install the pinned codegraph build without a prompt.
- **Remote review** — Run `co-maintainer review --remote` against a `serve` instance: handshake, diff submit, job queue, and `/sync` polling. Server runs AI; the CLI executes codegraph tools locally and returns results through the **tool bridge**.
- **Remote dashboard** — Settings: create/deactivate/delete bearer tokens (`cmr_…`), sync timeout, per-token concurrency, and tool output limits. Per-repo **Remote** tab and analytics for CLI-submitted reviews.
- **CLI configuration** — `co-maintainer set --remote-host=…` and `--remote-token=…` for remote review targets.
- **Documentation** — Review docs split into [`review`](docs/review.html), [`local-review`](docs/local-review.html), [`remote-review`](docs/remote-review.html), and [`local-pr-review`](docs/local-pr-review.html) (sources in [`docs/md/`](docs/md/)).
- **Developer e2e** — `npm run review-local-e2e` (fake AI worktree loop) and expanded CLI/store tests for local review, carry-over, and remote protocol validation.

### Changed

- **PR review prompts** — Stronger guidance to use codegraph (callers, impact, affected) instead of guessing from the diff alone; upstream merge context is scoped so findings are not raised on non-PR code.
- **Workspace / remote review prompts** — Same codegraph verification instructions as PR review; improve pass re-checks findings that depend on behavior outside the diff.
- **Remote review logs** — Tool rounds (`review-tools`) are forwarded into job logs during remote reviews for easier debugging.
- **Remote CLI output** — Human-readable finding text in the terminal for remote reviews (not a placeholder count).
- **Codegraph execution** — Server and local paths share `codegraph_exec`; tool arguments reject escaping paths and unsafe flags.
- **Git diffs** — Fallback to per-file `git diff` when bulk unified patches are missing; safer handling when GitHub withholds large patches.
- **GitHub PR review summary** — Aligns posted summary with open carry-over findings.

### Fixed

- **Login lockout** — Use client IP from the HTTP server for API login attempts (non-interactive `serve` / SSH).
- **Remote API** — Correct body size limits, JSON null bodies, and revision/path validation on submit.
- **Remote sync** — Schema validation, abort cleanup, and client minimum schema checks on sync.
- **Local review** — Shallow merge-base fetch remote, `numstat -z` parsing, Ctrl-C / sync lock release, keyed lock cleanup on interrupt.
- **Carry-over** — Incremental diff edge cases, guide timestamp alignment, first-seen review IDs, and path narrowing for typecheck.
- **Atomic writes** — Windows backup-swap for guide writes; orphan job cancel reasons recorded.
- **Job worker** — `maxConcurrentJobs` respected in `claimAndRun`.
- **Settings (remote tokens)** — Escape token names in the dashboard list (XSS).
- **Remote review cancellation** — Deactivating or deleting a token, or canceling a queued job from the dashboard, marks the associated remote **review** row as `aborted` (not only the job).
- **Repo remote list** — Remote reviews on the repo tab filter to the last **30 days**, matching the page copy.

### Security

- Remote bearer tokens are stored hashed; raw `cmr_…` values are shown once at creation.
- Deactivating or deleting a token cancels in-flight remote reviews for that token.

[0.4.0]: https://github.com/GroophyLifefor/co-maintainer/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/GroophyLifefor/co-maintainer/compare/v0.2.22...v0.3.0
