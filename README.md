[![npm](https://img.shields.io/npm/v/co-maintainer)](https://www.npmjs.com/package/co-maintainer)
![License](https://img.shields.io/badge/license-MIT-blue)
![Price](https://img.shields.io/badge/price-%240-brightgreen)
![Providers](https://img.shields.io/badge/models-OpenRouter%20%C2%B7%20OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20OpenCode-0969da)

![co-maintainer](docs/assets/readme/splash.png)

# co-maintainer

An open source PR reviewer that learns how your repo is reviewed, then reviews like that.

It reads your code, your merged PRs and the review comments on them, and writes
review guides as plain Markdown. Every review follows those guides. It runs on
your machine or on your own server, with your own model key.

[Website](https://co-maintainer.com/?utm_source=github&utm_content=readme) ·
[Docs](https://co-maintainer.com/docs/getting-started.html?utm_source=github&utm_content=readme) ·
[Newsletter](https://buttondown.com/murat)

```sh
npm install -g co-maintainer

co-maintainer probe owner/repo        # reads only, spends nothing
co-maintainer init owner/repo --include-codebase --include-pull-requests \
  --max-pr-months=12 --max-commits=500
co-maintainer review owner/repo 123   # review a pull request
```

> [!TIP]
> `co-maintainer review` with no arguments reviews your local branch before you
> open the PR. `co-maintainer serve` runs the GitHub App and a dashboard for every
> repository on your own server.

<img src="docs/assets/readme/spacer.gif" width="1" height="48"/>

## What it does

<table>
<tr>
<td><img src="docs/assets/readme/01-finding.png" alt="A P1 finding on PR 54"></td>
<td><img src="docs/assets/readme/02-ask.png" alt="Asking the reviewer what it meant"></td>
</tr>
<tr>
<td><img src="docs/assets/readme/03-carry-over.png" alt="New, still open and closed findings"></td>
<td><img src="docs/assets/readme/04-policy.png" alt="Review policy options"></td>
</tr>
<tr>
<td><img src="docs/assets/readme/05-probe.png" alt="probe output before init"></td>
<td><img src="docs/assets/readme/06-json.png" alt="review --json output for agents"></td>
</tr>
</table>

<img src="docs/assets/readme/spacer.gif" width="1" height="32"/>

## How it works

```mermaid
flowchart LR
  A[Your repo<br>code, PRs, review comments] --> B[init]
  B --> C[Review guides<br>plain Markdown]
  C --> D[review]
  E[New merged PRs] --> F[sync] --> C
```

A low model reads the history and extracts evidence. A high model writes the
guides and does the review. You pick both models. Read what it learned with
`co-maintainer view`.

<img src="docs/assets/readme/spacer.gif" width="1" height="32"/>

## Pricing

| Solo                | Team                                      | Company                           |
| ------------------- | ----------------------------------------- | --------------------------------- |
| $0                  | $0 per seat                               | $0 forever                        |
| The CLI on a laptop | One server, guides shared with `--remote` | Your infrastructure, MIT licensed |

You only pay your model provider. No telemetry from the CLI, `serve` or the
dashboard. How we earn: donations and thanks.

<img src="docs/assets/readme/spacer.gif" width="1" height="32"/>

## Benchmark

`core_v3`: 30 PRs in one target repo, 14 with seeded defects and 16 clean
controls, so precision is measured too.

| Recall | Precision | F1    | Cost / PR | Time / PR |
| ------ | --------- | ----- | --------- | --------- |
| 0.857  | 0.353     | 0.500 | $0.0045   | 28.9s     |

deepseek-v4-flash + gpt-5.6-luna, judge gpt-5.6-luna, 2026-09-14. A small
dataset, read it as a signal. Details: [`benchmark/core_v3`](benchmark/core_v3/README.md).

<img src="docs/assets/readme/spacer.gif" width="1" height="32"/>

## Development

```sh
npm install
npm test                 # unit, script and benchmark tests
npm run check            # tsc --noEmit
npm run docs:build       # rebuild docs/ from docs/md/
npm run e2e              # end-to-end CLI loop
npm run review-local-e2e # fake-AI local review loop
npm run dashboard:smoke  # browser smoke test
npm run e2e:simulate     # init, sync, review and App flows in a simulated GitHub, see CONTRIBUTING.md
```

Made by [Murat Kirazkaya](https://muratkirazkaya.com). If it helps you, a star or a thank you is how this project gets paid.
