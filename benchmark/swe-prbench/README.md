# swe-prbench

Gold sourced from
[foundry-ai/swe-prbench](https://huggingface.co/datasets/foundry-ai/swe-prbench):
350 real, merged PRs across 65 repos, with human review comments as ground truth
(CC BY 4.0). Unlike `benchmark/core_v2/run_rereview.ts`, this isn't a re-review
round — the model is shown the whole PR diff (`base_commit` -> `head_commit`)
and scored against whatever a human reviewer actually flagged in that PR's first
round.

Since co-maintainer amortizes cost through a per-repo `init`, repo count matters
more here than PR count — see `prepare_dataset.ts`'s `--repos`.

## Scope (first pass)

Only two repos to start, chosen for PR count and language spread, run one at a
time rather than concurrently:

- `stylelint/stylelint` (JavaScript, 20 PRs) — run this one first
- `pipecat-ai/pipecat` (Python, 30 PRs) — after stylelint looks sane

## Setup

```sh
# download dataset/prs.jsonl from the HF dataset above into benchmark/swe-prbench/prs.jsonl (not committed, ~29MB)

deno task swe-prbench-prepare -- --repos=stylelint/stylelint,pipecat-ai/pipecat
```

Then init each repo (not timed, run once per repo):

```sh
deno task init stylelint/stylelint --auth=gh \
  --max-pr-months=6 --max-commits=200 \
  --gh-concurrent=8 --ai-concurrent=10 \
  --ai=openrouter --low-model=deepseek/deepseek-v4-flash-0731 --high-model=openai/gpt-5.6-luna \
  --env=.env

deno task init pipecat-ai/pipecat --auth=gh \
  --max-pr-months=6 --max-commits=200 \
  --gh-concurrent=8 --ai-concurrent=10 \
  --ai=openrouter --low-model=deepseek/deepseek-v4-flash-0731 --high-model=openai/gpt-5.6-luna \
  --env=.env
```

`--codegraph` is intentionally omitted (off by default).

## Running

Stylelint alone first:

```sh
deno task bench-swe-prbench -- --repo=stylelint/stylelint \
  --ai=openrouter --low-model=deepseek/deepseek-v4-flash-0731 --high-model=openai/gpt-5.6-luna \
  --env=.env
```

Then pipecat, once stylelint's numbers look right — don't run both repos in the
same pass while still validating the setup:

```sh
deno task bench-swe-prbench -- --repo=pipecat-ai/pipecat \
  --ai=openrouter --low-model=deepseek/deepseek-v4-flash-0731 --high-model=openai/gpt-5.6-luna \
  --env=.env
```

Every run writes the full metric set — per-PR precision/recall/F1, tokens, cost,
timing, and the raw review text for each PR — under
`benchmark/swe-prbench/results/<dataset>-<runner>/`. Nothing here is summarized
away; the whole `reports`/`details` arrays land in `<slug>.json` /
`<slug>/detail.json`.

## Filtering (`prepare_dataset.ts`)

A gold row is kept only if it is:

- a top-level comment (`replyTo` is null) — a reply defends or explains a
  finding, it isn't a new one,
- anchored to a `path` + `line` inside the diff.

`ref_before` (see `src/pr/snapshot.ts`) is pinned to an epoch sentinel for
every row, so the model never sees the PR's real (already-merged) comment or
review history — not just the gold quotes, the whole thread.

**Known gap:** a top-level, anchored comment can still be the PR author's own
note on their own diff (seen in practice: `stylelint/stylelint#9080`'s entire
gold set is the author's `[note]` self-annotations, not reviewer findings) —
`prs.jsonl` carries no PR-author field to filter these out yet.
