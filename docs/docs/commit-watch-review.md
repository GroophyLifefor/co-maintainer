# Commit watch review

Review pushes to your default branch when there is no pull request. It is a
sub-page of [PR review](local-pr-review.md), for the case where PR review
cannot apply.

## Why

If you push straight to `main` and do not use branches or pull requests,
nothing gets reviewed. [PR review](local-pr-review.md) needs a PR, so it never
runs for you.

## Turn it on

Commit watch is a feature of [`serve`](serve.md). The repository must be added
and initialized on the server. On the repository's page in the
[dashboard](dashboard.md), the **Commit watch** card shows whether pushes are
watched and the two ways to turn it on. Use either one, or both.

**GitHub App.** In the App's settings on GitHub open **Permissions & events**
and tick **Push** under **Subscribe to events**. That is your explicit yes, and
it applies to every repository the App is installed on. The App watches the
default branch only. See [GitHub App](github-app.md).

**CI.** Add a workflow that runs the co-maintainer action on a push. The card
gives you the workflow with your server's address filled in. See
[CI](ci.md#review-pushes-commit-watch).

When both report the same push, it is reviewed once and the CI step waits for
that review.

`co-maintainer probe` shows a `commit watch` line when the machine it runs on
has the GitHub App configured.

## How a push is reviewed

One push is reviewed as a single diff, from the commit before the push to the
commit after it. It is not reviewed commit by commit. A push that merges a pull
request is reviewed too.

- A push that creates the branch has nothing to compare with, so it is not
  reviewed.
- After a force-push or a rebase, open issues stay and the new commits are
  reviewed.
- Only pushes after you turn it on are reviewed. History is not scanned, and a
  push the server missed while it was down is not reviewed later.
- A repository that is not initialized is not reviewed. With the App, the
  commit gets a skipped check run that says so. With CI and no App, the step
  fails.
- A push review runs no [extensions](extensions.md).
- A push with a very large diff is reviewed within the diff budget. A push review
  does not carry its seen files into the next push, so files that did not fit are
  dropped again, and the review's warning says so. See
  [Large diffs](review.md#large-diffs).

When pushes come in a row, the repository settings decide what happens:

| Setting | What happens |
| ------- | ------------ |
| Review each push in turn (default) | Every push gets its own review, oldest first. |
| Cancel and merge into the newest | A waiting or running review is canceled and its range is reviewed together with the newest push. |

## It never blocks you

The push is already in, so a finding never fails anything.

- **With the App** the commit gets a check run that always succeeds, with the
  findings as annotations.
- **With CI** findings are warnings and the step stays green. After the
  `timeout-minutes` input (10 by default) the step ends green with a notice,
  and the review finishes on the server. The step fails only when it cannot
  reach the server or the token is refused.

Every push review, its findings by severity and its cost are on the
**Pushes** tab of the repository.

## Issues for P0 and P1

Each P0 and P1 finding becomes a GitHub issue. Issues are opened by the GitHub
App, so without the App there are none. It is on by default and can be turned
off per repository in its settings. P2 and P3 findings are annotations and on
the dashboard only.

An issue is titled `[P1] <what is wrong>` and labeled `co-maintainer` and
`cm-P1` (the labels are created when missing). The body says where the problem
is, with a link to the code at the pushed commit, and which push found it.
Issues are written in English.

The server keeps track of each issue, and a finding with the same file and code
as an earlier one is not opened again.

### When the code changes

A push that changes the lines of an open issue's finding gets a comment, and
the review is asked about that issue explicitly:

- Still there: `change in <commit> (push <after>): changed, still found by the
  review of <range>`. When the commit is the push, its hash is written once.
- Fixed: `change in <commit>: changed, no longer found by the review of
  <range>. Closing.`, and co-maintainer closes the issue. It closes an issue
  only when a push changed those lines and the review said that problem is
  fixed. If it is not allowed to close issues, it says so in a comment.

### When you close an issue yourself

The first push review after you close it checks the problem once, even when the
push does not touch that file. If the problem is still there, co-maintainer
says so on the same issue and asks you to leave a comment if there is something
it should know. The issue stays closed, and it says this once per closing.

If that review finds it solved and the problem comes back later, a new issue is
opened.

### Talking to it on an issue

co-maintainer reads comments on the issues it opened, from people with write
access, and only when the comment is meant for it. "@someone can you take a
look" is not.

- A question gets an answer, in the language of the question.
- A comment that says to ignore the finding, or that tells it something, gets
  "Noted, I will take this into account on the next sync." The next
  [sync](sync.md) adds the note to the detailed review guide, and a finding you
  said to ignore is not reported, commented on or opened as an issue again.
