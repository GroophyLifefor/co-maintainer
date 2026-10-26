# Codegraph

codegraph is a code graph tool that lets a review follow calls between files
instead of guessing from the diff alone. co-maintainer keeps it as its own
tool, pinned to a version, and runs it beside the review when it helps.

## Why a pinned version

The reviewer parses codegraph's CLI output, so the version is pinned rather
than tracking latest: an upstream format change must be an explicit upgrade,
not a surprise on someone else's machine. This build ships codegraph `1.6.0`
(`@colbymchenry/codegraph` from npm, about 250 MB unpacked).

## Where it lives

codegraph is installed under the tools directory, one folder per version, and
it is **never added to your `PATH`**. The CLI runs the binary by absolute path:

```
<tools dir>/codegraph/1.6.0/node_modules/.bin/codegraph
```

The tools directory sits under the cache directory (see
[Caching](caching.md#tools-directory)). `CM_TOOLS_DIR` overrides it. Because
each version has its own folder, a change of version never overwrites a working
install.

## When it installs

| Command | Behavior |
| ------- | -------- |
| [Local review](local-review.md#codegraph) | Asks before installing on an interactive terminal, `--allow-tool-install` installs without a prompt |
| [PR review](local-pr-review.md) | Uses an install that is already there, `--allow-tool-install` installs a missing or mismatched one without a prompt |
| [Remote review](remote-review.md) | The client prepares the tools locally, the server never installs |
| CI, pipelines, `--json`, closed stdin | Never prompts. Without `--allow-tool-install`, reviews without codegraph |

`--disable-codegraph` skips the check entirely. A prompt is only shown when
both stdin and stdout are a terminal and `CI` is unset, so a pipeline cannot
hang on it.

## Changing the pinned version

Use this when a codegraph security or bug fix must land without waiting for a
new co-maintainer release. The version is resolved in this order:

1. `CM_CODEGRAPH_VERSION` environment variable
2. `config.json` `codegraphVersion`, written by `co-maintainer set`
3. the version this build ships

A layer that is missing, or whose value is not a version number, is skipped, so
a typo falls back to the next one instead of breaking detection. A leading `v`
is accepted and dropped.

```sh
co-maintainer set --codegraph-version=1.7.0
# or, for one run or a CI job:
CM_CODEGRAPH_VERSION=1.7.0 co-maintainer review owner/repo 123 --allow-tool-install
```

Changing the version only changes what co-maintainer looks for. The new build
is downloaded on the next run that is allowed to install, which is a prompt on
local review or `--allow-tool-install` on PR review. An existing older version
stays on disk.

Install the pinned build by hand if you prefer:

```sh
npm install @colbymchenry/codegraph@1.7.0 \
  --prefix "<tools dir>/codegraph/1.7.0" --no-audit --no-fund
```

`co-maintainer config get codegraph-version` prints the configured value when
one is set, and `co-maintainer config list` shows whether the value comes from
the environment, the file, or nothing.

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `codegraph is missing` | The pinned version is not installed | `--allow-tool-install`, or install it by hand |
| `codegraph is mismatch` | An install exists but reports another version | `--allow-tool-install` reinstalls the pinned version |
| A review skipped codegraph | Non-interactive run with no install | Install it, or pass `--allow-tool-install` |
| A review is much slower | Indexing a large repository | `--disable-codegraph` |

See [Local review: Codegraph](local-review.md#codegraph) for the prompt text and
[Caching](caching.md#tools-directory) for the directory layout.
