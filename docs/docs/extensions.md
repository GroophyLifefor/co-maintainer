# Extensions

An extension is a command you register. co-maintainer runs it around a
review, reads one JSON document from its stdout, and joins its findings,
verdict, Markdown and cost into the review. Nothing is built in. Any check
can plug in without changing co-maintainer: a linter, a secret scanner, a
browser QA run that records videos.

Extensions run in every review type: a [local review](local-review.md), a
[PR review](local-pr-review.md) from the CLI, the reviews
[`serve`](serve.md) posts as the [GitHub App](github-app.md), and a
[remote review](remote-review.md), where `serve` runs the extensions
registered on `serve`. A [commit watch](commit-watch-review.md) push review runs
none.

## Register one

```sh
co-maintainer extension register --name=qa-vision \
  --command='HOME=/home/me /usr/bin/node /opt/qa-vision.mjs {{details_path}} --json'
co-maintainer extension debug-run --name=qa-vision
co-maintainer extension list
```

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--name` | required | The extension's name, its id in every output |
| `--command` | required | The shell command, with `{{variable}}` paths |
| `--repos` | `*` | `owner/repo`, `a/b,a/c`, `a/*`, `*/a` |
| `--review-types` | all | `local`, `pr`, `remote`, comma separated |
| `--run-after` | none | An extension name, or `review` |
| `--parallelism=true\|false` | `true` | `false` with no `--run-after` runs after the review |
| `--priority` | `0` | `0` to `3`, 3 starts first, ties keep registration order |
| `--fail-fast` | off | On failure, what waits on it through `--run-after` does not run |
| `--retry-on-fail-times` | `0` | Runs again when the response does not match the schema |
| `--max-requested-retries` | `3` | How many `status: retry` responses are honoured |
| `--timeout` | `10m` | Such as `30s`, `10m` or `1h`, at most `6h` |
| `--rerun-on-restart=true\|false` | `true` | Overrides the `extension-rerun-on-restart` config key |

`update` takes the same flags and changes only the ones given. `remove`,
`disable` and `enable` take `--name`. Registrations live in `config.json` as an
`extensions` array, and the array order is the registration order.

`register` and `update` refuse a `--run-after` cycle. A `--run-after` name that
nobody registered asks "Are you sure?" first. Without a terminal, pass `--yes`.

## The command

co-maintainer runs your command through `/bin/sh -c` (`cmd /d /s /c` on Windows) and
replaces three variables with quoted paths:

| Variable | What it points at |
| -------- | ----------------- |
| `{{details_path}}` | `details.json`, the review's context |
| `{{review_result_path}}` | `cm-review.json`, the AI review's findings. Empty for an extension that starts before the review finishes |
| `{{diff_path}}` | `diff.patch`, the unified diff, in every review type |

Write a variable bare, `{{details_path}}`, never inside your own quotes. Only
paths are substituted, so nothing a pull request author wrote, such as a
branch name or a title, ever reaches the shell. Any other `{{name}}` is
refused when you register.

The command starts with an empty environment. No token or key co-maintainer
holds is passed to it. Set what the command needs inside the command itself,
`HOME=/home/me /usr/bin/node ...`, and use absolute paths. Credentials in a
command are the extension's responsibility, and so is checking out or running
pull request code.

The command runs as the user that runs co-maintainer, `serve` included, and
can read every file that user can read. That includes `config.json`, which
holds co-maintainer's keys. An extension that runs pull request code must
sandbox that code itself. Outside a local review the command runs in its run
folder.

The three files sit in one folder per review, shared by its extensions:

```
<config dir>/co-maintainer/extensions/<run-id>/details.json
<config dir>/co-maintainer/extensions/<run-id>/cm-review.json
<config dir>/co-maintainer/extensions/<run-id>/diff.patch
```

With `CM_CONFIG_PATH` set, the run folders live in
`co-maintainer-extensions` next to that `config.json` instead.

The folder is removed however the review ends. `serve` removes the folders of
jobs no longer running when it starts, and the CLI removes those of runs whose
process is gone on its next review.

### details.json

```json
{
  "schemaVersion": 1,
  "reviewType": "pr",
  "repo": "owner/repo",
  "prNumber": 45,
  "branch": "feature",
  "workdir": "",
  "headSha": "4f1c2d9a...",
  "baseSha": "9a8b7c6d...",
  "scope": "incremental",
  "sinceCommit": "1e2d3c4b...",
  "trigger": "synchronize",
  "round": 2,
  "reviewResultPath": "",
  "diffPath": "/home/me/.config/co-maintainer/extensions/9f.../diff.patch"
}
```

In a local review `prNumber` is null, `branch` and `workdir` are set, and the
command runs in `workdir`. In a PR review and in `serve`, `workdir` is empty
and the extension makes its own checkout if it needs one. A remote review has
no `workdir` either, because the checkout is on the client's machine.
`reviewResultPath` is filled in once the AI review has finished.

`cm-review.json` holds `schemaVersion`, `summary` and `findings`, in the same
finding shape `review --json` prints.

## The response

Print exactly one JSON document on stdout. Log lines go to stderr.

```json
{
  "schemaVersion": 1,
  "name": "qa-vision",
  "status": "ok",
  "verdict": "request_changes",
  "markdown": "**QA vision (beta)** found one problem.",
  "findings": [
    {
      "key": "snapshot-button",
      "severity": "P2",
      "blocking": true,
      "title": "Snapshot button missing",
      "body": "The toolbar hides the button while a snapshot runs.",
      "path": "src/snapshot/toolbar.tsx",
      "lineFrom": 15,
      "lineTo": 21
    }
  ],
  "data": {
    "media": [{ "kind": "video", "label": "main", "url": "https://cdn.example.com/main.mp4" }],
    "metrics": [{ "name": "cases", "value": 4 }]
  },
  "extraData": { "cases": [] },
  "usage": { "costUsd": 0.42, "tokensIn": 0, "tokensOut": 0 }
}
```

<!-- extension-schema:start -->
| Field | Type | Required | Meaning |
|---|---|---|---|
| `schemaVersion` | integer | yes | Must be 1. Any other value is Failed, with that as the reason. |
| `name` | string | yes | The extension's own name, for its logs. (at most 100 characters) |
| `status` | `ok`, `failed`, `skipped`, `retry` | yes | How the run ended. |
| `verdict` | `request_changes`, `comment` | with `ok`, absent otherwise | `request_changes` makes the whole review Request changes. It always wins over a finding's `blocking`. |
| `reason` | string | with `skipped` and `retry` | Why the extension skipped, failed or wants a retry. (at most 2000 characters) |
| `retryAfterSeconds` | integer | with `retry` | How long to wait before the next run. (min 0, max 180) |
| `markdown` | string | no | Shown in the GitHub review and the job summary, inside a `<details>` block named after the extension. (at most 200000 characters) |
| `findings` | array of objects | no | Findings that join the review. |
| `findings[].key` | string | no | A stable id. With one, the finding is tracked across rounds: seen again means still open, missing means closed. (at most 200 characters) |
| `findings[].severity` | `P0`, `P1`, `P2`, `P3` | yes | P0 is the most severe. |
| `findings[].blocking` | boolean | yes | Whether this finding alone should block the merge. |
| `findings[].title` | string | yes | One line. (at most 500 characters) |
| `findings[].body` | string | yes | The explanation, in Markdown. (at most 20000 characters) |
| `findings[].path` | string | no | A file path relative to the repository root. (at most 1000 characters) |
| `findings[].lineFrom` | integer | no | First line in the new file. (min 1) |
| `findings[].lineTo` | integer | no | Last line in the new file. (min 1) |
| `data` | object | no | Results with a fixed shape co-maintainer can show. |
| `data.media` | array of objects | no | Files the extension uploaded itself. co-maintainer uploads nothing. |
| `data.media[].kind` | `image`, `video`, `link` | yes | What the URL points at. |
| `data.media[].label` | string | yes | A short name, such as `main` or `pr`. (at most 100 characters) |
| `data.media[].url` | string (URL) | yes | An http or https URL. |
| `data.metrics` | array of objects | no | Numbers worth showing next to the result. |
| `data.metrics[].name` | string | yes | What was measured. |
| `data.metrics[].value` | number | yes | The measurement. |
| `data.metrics[].unit` | string | no | Such as `ms` or `MB`. |
| `extraData` | any | no | Free-form. Passed through to `--json` and never read by co-maintainer. |
| `usage` | object | no | What the run cost, when it used AI. |
| `usage.costUsd` | number | no | Joins the review's total cost. (min 0, max 10000) |
| `usage.tokensIn` | integer | no | Input tokens. (min 0, max 10000000000) |
| `usage.tokensOut` | integer | no | Output tokens. (min 0, max 10000000000) |
| `usage.cachedIn` | integer | no | Cached input tokens. (min 0, max 10000000000) |
| `usage.cachedOut` | integer | no | Cached output tokens. (min 0, max 10000000000) |
<!-- extension-schema:end -->

- Unknown fields are ignored.
- An unsupported `schemaVersion` is Failed, with that as the reason.
- A response that does not match the schema is Failed. With
  `--retry-on-fail-times`, the command runs again first.
- `retry` waits `retryAfterSeconds` and runs the command again, up to
  `--max-requested-retries` times. After that the result is Failed.
- Each attempt gets the full `--timeout`. The longest an extension can take is
  one attempt, plus `--retry-on-fail-times` attempts, plus
  `--max-requested-retries` attempts with their waits.
- Inside the `<details>` block, `details` and `summary` tags in `markdown` are
  shown as text, and a heading named like one of the review's own sections is
  escaped. Mentions and images are posted as written: the extension owner is
  responsible for them, even when a pull request shaped them.
- Media is always a URL the extension uploaded itself. co-maintainer uploads
  nothing.

## Order and failures

- The AI review is the start point and never waits for an extension or reads
  its output. The review is posted only after every extension has finished.
- Extensions run on every review, incremental ones included. There is no
  trigger filter: `details.json` has the fields to decide, and an extension can
  return `skipped`.
- A `--run-after` target that does not exist, or does not run for this review,
  skips the extension that waits on it. So does a target that returns
  `skipped`.
- A `--fail-fast` failure skips what waits on it. Extensions not connected to
  it are not affected.
- A timeout or a cancel sends SIGTERM to the command's process group and
  SIGKILL 30 seconds later. The result is Failed.
- When co-maintainer restarts while an extension runs, the extension runs
  again. With `--rerun-on-restart=false` the result is Failed instead.
- Failures do not block. A failed extension is named in the summary and its
  reason, with stdout and stderr and the exit code (at most 128 KB), is kept
  for the dashboard.

## What the review shows

- One extension's `request_changes` makes the whole review Request changes
  and the CLI exit code blocking (1). A verdict always wins over a finding's
  own `blocking`.
- In the GitHub review, a finding on a diff line is posted inline, headed
  `[P2 · blocking] · extension: name`. A finding off the diff, or with no
  location, goes in the summary list with the same label. At most 50
  extension comments go inline and 50 findings are listed, then a line says
  how many more the dashboard holds.
- An `#### Extensions` section follows the review summary, with each
  extension's `markdown` inside a `<details>` block. The whole review body is
  capped at 250,000 characters. Over it, the longest `markdown` is replaced
  with "Not added to this comment because of the length limit, see the
  dashboard.", then the next longest, until it fits. The AI review is never
  cut.
- Metadata lists `Extensions`, `Failed Extensions`, `Skipped Extensions` and
  `Requested changes`.
- The terminal shows each extension's findings and `data`, never its
  `markdown`.
- `review --json` adds `extensions[]` and puts extension findings into
  `findings[]` with `extensionId`. AI findings have `extensionId: null`.
  `markdown` is empty unless you pass `--include-extension-markdowns`.
- `review --output=github` annotates located findings with the extension
  label, within the 10 per level GitHub shows, and the job summary lists all
  of them with each `markdown`. The job summary is capped at 1 MiB, by the
  same longest first rule.
- The dashboard shows each result with its fail or skip reason.

A finding with a `key` is tracked across rounds: seen again means still open,
missing means closed. A finding without a `key` is shown fresh each run and
never closed.

The total cost of a review includes its extensions. The review's own cost is
the total minus the extensions, and each extension's cost comes from its
`usage`.

## Try it with debug-run

`co-maintainer extension debug-run --name=NAME` runs one extension against a
built-in mock of pull request 45 of `GroophyLifefor/heap-analysis`: its
context, its diff and a finished AI review. There is no AI call, no network
and nothing is posted. Pass `--command=...` to try a command before you
register it. The run prints what the terminal output of a review would show,
and the full output when the extension failed.

## Turning extensions off

`CM_EXTENSIONS_DISABLED=1` turns extensions off. `register` and `debug-run`
refuse, and no review runs an extension. The hosted cloud sets it from
outside the container, so extensions are always off there. On a self-hosted
Docker image, tools an extension needs, such as ffmpeg or a browser, are for
the extension owner to add with their own image.

## Changing the schema

This part is for people changing co-maintainer itself.

- The response schema lives in `src/extensions/schema.ts` as one list of
  field specs. The validator reads it, and the table on this page is generated
  from it. `npm run docs:build` rewrites the table, and a test fails when the
  table here is older than the code.
- Adding an optional field, or a new value an extension may send, keeps
  `schemaVersion` at 1. Old extensions keep working because unknown fields
  are ignored.
- Removing a field, renaming one, making one required, or changing what a
  value means is a new `schemaVersion`. An extension built for a version this
  build does not read gets Failed with that reason, so the reason tells its
  owner what to change.
- `details.json` follows the same rules with its own `schemaVersion`.
