# Commit watch review

> **Coming soon.** This feature is planned and not available yet. This page
> describes what it is meant to do.

Review pushes to a branch without a pull request. It is a sub-page of
[PR review](local-pr-review.md), for the case where PR review cannot apply.

## Why

If you push straight to `main` and do not use branches or pull requests,
nothing gets reviewed. [PR review](local-pr-review.md) needs a PR, so it never
runs for you.

## What it is

A feature of [`serve`](serve.md), not a new CLI command.

## How it works

1. You push.
2. Your CI starts.
3. CI asks the server to run the review.
4. The result returns to CI.

Which branch is watched is decided in the CI setup. See [CI](ci.md).

One push is reviewed as a single diff, from the commit before the push to the
commit after it. It is not reviewed commit by commit.

## It never blocks you

CI does not fail because of findings. A timeout keeps a slow review from
holding up the push. A result that arrives late still shows on the
[dashboard](dashboard.md).

## Findings

| Severity | Where it shows |
| -------- | -------------- |
| P0, P1 | A GitHub issue, when the token has permission. On by default, and it can be turned off in settings. |
| P2, P3 | The website only. |

## Tracking

Issues are stored in the `serve` SQLite database, so the same finding is not
opened twice.

When a later commit changes the related code, a comment `change in <COMMIT-HASH>`
is added to the issue. It does not claim the issue is fixed.

## Scope

- Only new pushes after you enable it are reviewed. History is not scanned.
- After a force-push or a rebase, open issues stay and the new range is
  reviewed normally.
