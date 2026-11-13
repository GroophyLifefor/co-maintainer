# `view`

Print the guides co-maintainer generated for a repository. This is the way to
see exactly what a review will be judged against, without starting a review.

The guides are the output of [`init`](init.md) / [`sync`](sync.md):
`SKILL.md`, `CODEBASE.md`, the review guides, and `INSTRUCTIONS.md` when the
repository has agent instruction files. They live under the config
directory, not in your clone. See [Caching: Generated guides](caching.md#generated-guides).

## Usage

```sh
co-maintainer view                                  # every guide for the detected repo
co-maintainer view owner/repo                       # every guide, with headers
co-maintainer view owner/repo review-guide          # one guide, raw
co-maintainer view owner/repo instructions          # INSTRUCTIONS.md, raw
co-maintainer view owner/repo --list                # file, size, build date
co-maintainer view owner/repo --path                # the directory they live in
co-maintainer view owner/repo --sources             # each instruction rule and its source lines
co-maintainer view owner/repo --remote              # read from the review server
```

With no repository argument, the name is detected from the `git` remote in the
current directory.

## What it prints

With no guide named, every guide is printed in reading order, each under an
`== SKILL.md · built 2026-09-22 ==` style header. Naming one guide prints that
file raw, with no header, so the output can be redirected straight to a file:

```sh
co-maintainer view owner/repo review-guide > PR_REVIEW_GUIDE.md
```

A guide name is matched case-insensitively as either the page name
(`review-guide`) or the file or body name. `--list` lists every file in the
folder, including any file co-maintainer did not write, with its size and date.

## Sources

[`INSTRUCTIONS.md`](init.md#agent-instruction-files) is built from the repository's
agent instruction files, and each rule in it ends with an id such as `[I1]`.
`--sources` lists every rule by id with the file lines it came from:

```
$ co-maintainer view owner/repo --sources
INSTRUCTIONS.md
  I1  Format amounts with formatMoney(), never with number methods
      AGENTS.md:31 · packages/billing/AGENTS.md:8
```

`--sources --json` prints `RULES.json` as it is. `RULES.json` is the data behind
this view. It is never printed by plain `view`, by `--list` or by a single-guide
view. `--sources` works with `--remote`, which reads the copy the server holds.

These are usage errors with exit code 2:

| Message | When |
| ------- | ---- |
| `--json needs --sources.` | `--json` without `--sources` |
| `--sources cannot be combined with --list or --path.` | Both given |
| `<owner/repo> has no RULES.json.` | No rule was built. The hint is `co-maintainer sync <owner/repo>` |
| `RULES.json for <owner/repo> could not be read.` | The file is not valid. The hint is the same |

## Reading from the server

`--remote` reads the copies a configured [`serve`](serve.md) instance holds,
using the same remote token as [`review --remote`](remote-review.md). The output
format is identical, only the source differs. This is how you check what the
team's shared context says without downloading anything.

`--path` is local-only and is refused with `--remote`, because the directory
belongs to the machine you are on. A rejected token prints the same Settings
hint that `review --remote` prints.

## Before you run

| Check | Why |
| ----- | --- |
| A successful [`init`](init.md) or [`sync`](sync.md) for the repo | Without guides there is nothing to print |
| For `--remote`: a host and token | See [Remote review](remote-review.md) |

If no guides exist, `view` exits with code `2` and suggests
`co-maintainer probe owner/repo`.

## Related

- [`init`](init.md) and [`sync`](sync.md) build and refresh the guides.
- [Caching](caching.md) shows where they are stored.
- [Configuration](configuration.md) lists the flags for each command.
