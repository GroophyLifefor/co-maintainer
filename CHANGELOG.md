# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Developer e2e** — `deno task review-local-e2e` (fake AI worktree loop) and expanded CLI/store tests for local review, carry-over, and remote protocol validation.

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

[0.3.0]: https://github.com/GroophyLifefor/co-maintainer/compare/v0.2.22...v0.3.0
