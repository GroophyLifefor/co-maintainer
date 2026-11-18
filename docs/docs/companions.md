# Companions

Some changes span repositories: code and its docs, or a backend and the editor
extension that calls it. A review sees one repository's diff, so it cannot tell
whether the other side changed in step, or did not change at all.

`--with` points a review at another checkout on your machine. The review reads
that checkout's changes as context. A companion is read, never reviewed, and
needs no `init`. The reviewed change keeps its whole diff budget.

It works in [local review](local-review.md), [PR review](local-pr-review.md)
and [remote review](remote-review.md).

```sh
co-maintainer review --with=../docs
co-maintainer review --with=../docs --with=../vscode-ext@feature/session-api --intent-file=task.md
co-maintainer review owner/repo 42 --with=../docs
co-maintainer review --remote --with=../vscode-ext@feature/session-api
```

## The flag

| Flag | Default | Meaning |
| --- | --- | --- |
| `--with=PATH[@BRANCH]` | none | A companion checkout. Repeat it for each companion, up to 5 |

- **Without `@BRANCH`** the companion's current branch and working tree are
  read, the same way local review reads its own checkout: committed, staged,
  unstaged and untracked changes against the merge base with its default
  branch.
- **With `@BRANCH`** that branch is diffed against its merge base with the
  companion's default branch. The checkout is never switched, and its working
  tree is not read. A local branch is tried first, then the remote's.
- **The repository name** comes from the companion's git remote, `upstream`
  first, then `origin`. Only GitHub remotes work, as in local review.
- **A folder with `@` in its name** works: a value that names a folder is a
  path whole. Otherwise the text after the last `@` is the branch.
- **Not with `--range`.** A push review takes no companions.

Every error is a usage error with exit code 2, before any model call:

| Case | Message |
| --- | --- |
| PATH is not a git repository | `--with: PATH is not a git repository` |
| BRANCH does not exist there | `--with: no branch BRANCH in owner/repo` |
| PATH is the repository under review | `--with: PATH is the repository under review` |
| More than 5 companions | `--with: at most 5 companions` |
| The same repository twice | `--with: owner/repo is given more than once` |
| An empty value | `--with: give a path, as --with=PATH or --with=PATH@BRANCH` |

"The repository under review" means the same folder in local and remote review,
and the same `owner/repo` from the remote in every mode. A companion whose
remote or default branch cannot be read is refused the same way, with
`--with: PATH:` before the reason.

## What the model gets

Each companion gets a COMPANION block in the user prompt, after the
`WORKSPACE` or `PULL REQUEST` block and before the diff. It lists the changed
files with their status and line counts. Paths carry the repository name, so
they cannot collide with the reviewed change.

```
COMPANION owner/vscode-ext · branch feature/session-api · 3 files changed
owner/vscode-ext:src/client/session.ts   modified  +12 -4
owner/vscode-ext:src/client/api.ts       modified  +3 -1
owner/vscode-ext:package.json            modified  +1 -1

COMPANION owner/docs · branch main · no changes on this branch
```

- **About 100 characters per file.** A list stops at 200 files, or at
  24,000 characters of file lines, with `and N more`. A path longer than 200
  characters ends in `...`.
- **No change is information.** A companion with nothing on its branch says
  `no changes on this branch`.
- **One sentence comes first:** "COMPANION blocks list changes in other
  repositories that belong to this change. They are context. Report findings
  only on this repository's files, and name the companion file in the body when
  it is the reason."
- **The system prompt is the same bytes.** The cached prefix still hits, and a
  review without `--with` sends the same request as before.
- **The patches are not in the prompt.** The model reads them with
  `read-full-diff`, which takes a companion path such as
  `owner/vscode-ext:src/client/session.ts`, with `offset` and `limit`, under
  the same [cap on one answer](review.md#reading-the-rest-of-a-file).
- **Search.** `search-non-code` takes a `repo` argument. It is the repository
  under review when left out, or a companion's `owner/repo`. It searches the
  companion folder's tracked files as they are on disk, with that repository's
  own search settings, so the model can search a companion's docs even when the
  companion did not change. With `@BRANCH` the folder holds whatever branch is
  checked out, not `BRANCH`.

Companion content is untrusted, like pull request text. The model gets it as
data.

## Findings

A finding is anchored to the reviewed repository's files. For example, at the
line that removes `startSession()`: "This removes `startSession()`, but the
companion branch `owner/vscode-ext@feature/session-api` still calls it in
`src/client/session.ts`."

- **A finding the model places on a companion file** has no location. It is
  shown with the other findings, without a path or lines, labeled with the
  companion's name, for example
  ``[P2 · non-blocking] `owner/vscode-ext`: `src/client/session.ts:12` ``. In
  `--output=github` its annotation names no file or line. It is not carried to
  the next round.
- **Findings on the companion's own files** come from its own review, run in
  the companion with `--with` pointing back.

## Carry-over

Local review and PR review keep each companion in their carry record: the
repository, the branch, and a hash of its file list and patches.

When a companion changes, carried findings are checked again, even if the
reviewed repository did not change. Every file is sent again, and each carried
finding in an unchanged file gets the hint "file unchanged since the last
review, but a companion repository changed". Adding or leaving out a companion
counts as a change too.

Remote review does not keep companions in its carry-over yet. A remote round
where only a companion changed reviews only what changed in the reviewed
repository. Use `--fresh` then.

## Output

- **`--json`** has `companions` when `--with` was given, and leaves it out
  otherwise:

  ```json
  "companions": [
    { "repo": "owner/vscode-ext", "branch": "feature/session-api", "source": "flag", "pr": null, "files": 3, "status": "read" },
    { "repo": "owner/docs", "branch": "main", "source": "flag", "pr": null, "files": 0, "status": "empty" }
  ]
  ```

  `source` is `flag`. `status` is `read`, or `empty` when the branch has no
  change.
- **The terminal** prints one line under the header:
  `Companions: owner/vscode-ext@feature/session-api (3 files) · owner/docs@main (no changes)`.
- **`--output=github`** prints the same line in the job summary.

## Privacy

The visibility of the reviewed repository and of each companion is read from
the GitHub API at review time, with your own GitHub auth. A companion whose
visibility cannot be read counts as private.

A private companion in the review of a public repository is context and is
never quoted. Its patches and its search results go through the
[copied-passage check](review.md#mcp-servers): any run of 8 or more words a
finding copies from them is replaced with `[private context removed]`, and the
review adds a `private_text_removed` warning that says the passage came from a
private companion. A companion in the review of a private repository is not
checked.

File paths and names, such as `src/client/session.ts`, can appear in a finding.
The COMPANION block lists them, and the check does not cover them.

## Remote review

The client builds the companion diffs from `--with` on your machine and sends
them with the review. The client reads the visibility, and tells the server
which companions are private.

- **The handshake** lists `companions` among its features. A client that does
  not find it sends no companion and adds the warning `companions_unsupported`,
  which says "This server (version X) does not read companions, so the review
  ran without them." The review runs. An older client with a newer server sends
  none, and nothing changes.
- **The limit.** The server takes at most 500,000 characters of companion
  patches in total. Above that it keeps every file list, drops every patch, and
  adds the warning `companion_list_cut`.
- **Search** runs on your machine, in the companion checkout, through the same
  `search-non-code` tool call with its `repo` argument.

## Cost

About 100 characters per companion file, sent again in every round. Reads of
companion files are capped like any `read-full-diff` answer, and search results
go through the [tool limits](review.md#tool-limits).
