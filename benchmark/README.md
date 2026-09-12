# Benchmarks

Two independent benchmarks live here. They do not share a dataset format or a
numbering scheme — each is its own thing, kept because it measures a different
question.

## `dataset.json` + `run.ts`

Source: AACR-Bench, a third-party dataset of AI-generated review comments on
real pull requests, each labeled `1` (a real, actionable issue) or `0` (not).
`run.ts` reviews every labeled-`1` comment's PR with the model under test and
scores its findings against the labeled comments for that PR.

**Known limitation**: the model is shown the PR's full current diff — not the
diff as it stood when the AACR-Bench labels were produced. On a PR with several
pushes, this can show the model more (or less, or different) code than the
labels were actually about, and it never tests the model against a real human
reviewer's own words — the labels are themselves AI-generated comments a human
later marked valid or not.

```sh
deno task bench --repo=owner/repo
```

## `rereview_dataset.json` + `run_rereview.ts`

Gold is hand-curated from real human PR review comments on repositories with no
AI review bot in their history (checked via each candidate repo's recent
`pulls/{n}/comments` and `pulls/{n}/reviews` authors — no `[bot]` accounts, no
Copilot/CodeRabbit/etc). This benchmark answers a narrower, more realistic
question than "review this PR from scratch": **given a PR that already went
through one round of review and a fix, can the model catch what the next human
reviewer caught in that fix** — a regression the fix introduced, an edge case it
missed, a leftover instance of the original problem?

That mirrors how a review bot is actually used in practice — triggered again on
every push, not just once on PR open — and it turns out to have a better
signal-to-noise ratio than reviewing a PR from scratch: by the time there's a
second round, the obvious style nits are usually already gone, and what a
reviewer flags in that round tends to be sharper.

### How a gold PR is chosen

1. Only PRs from repositories with **zero AI-bot review activity** are
   considered — checked by literally listing commenter usernames on a sample of
   recent merged PRs and confirming none are bots.
2. The PR must be **merged**, and every commit that matters to the gold rows
   must still be fetchable — even if history was later rewritten (a rebase or
   squash before merge), GitHub keeps dangling commits reachable by SHA for a
   while, and `repos/{owner}/{repo}/commits/{sha}` still resolves them.
3. Cluster the PR's inline review comments by the exact commit SHA they were
   originally anchored to (`original_commit_id`), ordered by time. Each distinct
   commit a cluster of comments points at is one **review round**.
4. Pick a round N ≥ 2 — one that came after the PR author pushed new commit(s)
   in response to round N-1's feedback. `round_base_commit` is round N-1's
   commit; `round_commit` is round N's commit. The diff between them
   (`compare/{round_base_commit}...{round_commit}`) is exactly the incremental
   change a re-reviewer would see — not the whole PR.
5. From round N's comments, keep only the ones that are:
   - **not** from the PR's own author (a reply explaining/defending the code is
     not a finding),
   - **not** a bare reply that only asks a clarifying question or restates
     someone else's point without adding a new one,
   - **not** a bot,
   - **not** a self-declared or effectively pure style nit (a bare
     `` ```suggestion``` `` reformat, a naming/import-order preference, a "nit:"
     — these are the majority of what real reviewers leave and they are not what
     this benchmark measures),
   - anchored to a `path` + line **inside the round's diff** (verified by
     actually reading the diff, not by trusting the comment's own line number —
     a line can drift between when the comment was made and when it was
     fetched).
6. What survives is written as one gold row:
   `{ repo, pr, path, from_line, to_line, side, quote, why, round_base_commit,
   round_commit, ref_before }`.
   `quote` is the reviewer's own words; `why` explains, in the curator's words,
   what the actual defect is and why the comment is right — this is what a judge
   model is shown when deciding whether a differently-anchored finding is the
   same defect (see below). `ref_before` is round N's first comment's timestamp;
   it is what keeps the review honest — see below.

Rounds with only one PR (frequent) or where every round-N comment turned out to
be a nit are simply skipped — a PR contributing zero gold rows is a normal
outcome, not an error, and no row is ever invented to hit a target count.

### Running it — how leakage is avoided

`reviewPullRequest` accepts an optional `Snapshot = { base?, commit, before }`
(`src/review.ts`). When given:

- The diff shown to the model comes from `compare/{base}...{commit}` — `base` is
  `round_base_commit`, `commit` is `round_commit` — so the model sees the same
  incremental diff the human re-reviewer saw, not the PR's final state and not
  history the round-N reviewer hadn't pushed yet.
- Every existing PR comment and review with `created_at >= before` is dropped
  from the prompt. Without this, the gold comments themselves (or later ones)
  would leak straight into the "existing review comments" context the model is
  shown, making the benchmark trivial.

### Matching predictions to gold

A model finding and a gold row can describe the same defect while pointing at
different lines — the model often cites the fix site, a human reviewer the line
that triggered the comment, sometimes a few lines or even a different file apart
(verified case: a duplicate validation gap in a second file that is arguably a
_better_ anchor than the gold row's). Exact-line matching (`match.ts`) misses
these. After exact matching, any leftover predicted finding and leftover gold
row are sent to a small model (`judge.ts`, `--judge-model=`, default
`openai/gpt-oss-120b`) that decides — conservatively — whether they describe the
same underlying defect regardless of file/line; a confirmed pair still counts as
a match.

```sh
deno task bench-rereview --review-concurrent=4 --high-model=... --judge-model=...
```

### Comparing against another tool

`--runner=` selects what produces the findings. `comaintainer` (default) calls
`reviewPullRequest`; `ocr` shells out to Alibaba's
[Open Code Review](https://github.com/alibaba/open-code-review) CLI. Both are
handed the same incremental diff (`round_base_commit..round_commit`) and scored
by the same `match.ts` + `judge.ts` + `metrics.ts`, so the numbers sit side by
side.

```sh
deno task bench-rereview --runner=ocr
deno task bench-rereview --runner=comaintainer
```

The gold set spans five repositories, so each row carries its own `repo` and the
run groups jobs by `(repo, pr)`. `--repo=owner/repo` is a **filter** that
narrows a run to one of them, not a default, and `--ocr-clone=` names the
**root** that holds one clone per repo (`benchmark/clones/owner-repo`). Results
are written per dataset rather than per repo, and the summary prints one line
per repo plus a pooled total. A single-repo dataset whose rows have no `repo`
still works, as long as `--repo` is given.

**Preparation is not timed** — for either tool. `deno task init` for
co-maintainer, and for OCR the provider/model setup (`ocr config`) plus a clone
holding both of the round's commits:

```sh
git clone https://github.com/owner/repo benchmark/clones/owner-repo
git -C benchmark/clones/owner-repo fetch origin <round_base_commit> <round_commit>
```

Both runners check every repo in the dataset before the first review, so a
missing init or a missing clone fails in a second with the exact command to fix
it rather than partway through a paid run.

The runner refuses to review a commit the clone does not have, rather than
silently reviewing a different diff — squashed or rebased PRs need the dangling
SHAs fetched explicitly. What is measured is one review call: wall-clock time,
tokens, cost, and findings.

### Upstream scope

A re-review round's diff (`round_base_commit..round_commit`) can include a
`merge <default branch>` the author made mid-round — one measured case here had
a round diff of 48 files where the author's own commits touched 5. Neither the
human reviewer whose comments became gold nor the benchmark's judge ever reads
that other 43; scoring a tool against it would only reward or punish behavior on
code nobody asked it to look at.

Both runners apply the same scope (`src/pr/scope.ts`) before reviewing: files
touched by the author's own non-merge commits, plus the conflict-resolution
hunks of any merge they made — a clean "merge main in" contributes nothing.
co-maintainer still shows upstream files as compact, patch-free context (see
`--review-upstream` below); OCR excludes them outright via `--exclude`, the
closest equivalent its CLI has. Either way, neither tool is scored against code
it was never shown as its own to fix. Scope needs a git clone (the same one
`--runner=ocr` already requires, and co-maintainer's own cache otherwise); if
that clone or its history is unavailable, scoping is skipped for that run and
both tools fall back to reviewing every changed file, logged as such.

Two things to keep honest when reporting a comparison:

- **Same model on both sides**, set OCR to the same model via a custom provider,
  otherwise the result compares models rather than tools.
- **Each tool runs with its own structure.** co-maintainer sees its
  `PR_REVIEW_GUIDE.md` and the PR's prior comments; OCR sees its own ruleset and
  the diff. That asymmetry is the tools being different, not the benchmark being
  unfair, and neither side is stripped down to match the other.
- **Both are scoped to the same files** (above), so a merge the author made
  mid-round does not inflate one tool's false positives or the other's token
  count relative to the other.

Cost is reported only when the tool reports it. OCR's JSON does not always carry
usage, in which case `costKnown` is `false` and the cost column reads `unknown`.

# Results

## typescript-eslint/typescript-eslint — 3 PRs, 4 gold rows, `openai/gpt-5.6-luna`

date: 12.09.2026

|            | co-maintainer | OCR         | Ratio                          |
| ---------- | ------------- | ----------- | ------------------------------ |
| F1         | **0.667**     | 0.211       | 3.16x better than OCR          |
| Precision  | **1.000**     | 0.133       | 7.52x better than OCR          |
| Recall     | 0.500         | 0.500       | same                           |
| Avg time   | **49.8s**     | 202.0s      | 4.05x faster than OCR          |
| Avg tokens | **18.9K**     | 1.35M (71×) | 71.00x fewer (better) than OCR |
| Total cost | **$0.025**    | $1.62 (65×) | 65.00x cheaper than OCR        |

q: why too low PR and gold? 
a: OCR is expensive and right now it's only a side
project. I could run the co-maintainer through 65 benchmark tests, but a single
small OCR benchmark test is cost worth all of them.
