# Benchmarks

Two independent benchmarks live here. They do not share a dataset format or a
numbering scheme — each is its own thing, kept because it measures a
different question.

## `dataset.json` + `run.ts`

Source: AACR-Bench, a third-party dataset of
AI-generated review comments on real pull requests, each labeled `1` (a real,
actionable issue) or `0` (not). `run.ts` reviews every labeled-`1` comment's
PR with the model under test and scores its findings against the labeled
comments for that PR.

**Known limitation**: the model is shown the PR's full current diff — not the
diff as it stood when the AACR-Bench labels were produced. On a PR with
several pushes, this can show the model more (or less, or different) code
than the labels were actually about, and it never tests the model against a
real human reviewer's own words — the labels are themselves AI-generated
comments a human later marked valid or not.

```sh
deno task bench --repo=owner/repo
```

## `rereview_dataset.json` + `run_rereview.ts`

Gold is hand-curated from real human PR review comments on repositories with
no AI review bot in their history (checked via each candidate repo's recent
`pulls/{n}/comments` and `pulls/{n}/reviews` authors — no `[bot]` accounts,
no Copilot/CodeRabbit/etc). This benchmark answers a narrower, more realistic
question than "review this PR from scratch": **given a PR that already went
through one round of review and a fix, can the model catch what the
next human reviewer caught in that fix** — a regression the fix introduced,
an edge case it missed, a leftover instance of the original problem?

That mirrors how a review bot is actually used in practice — triggered again
on every push, not just once on PR open — and it turns out to have a better
signal-to-noise ratio than reviewing a PR from scratch: by the time there's a
second round, the obvious style nits are usually already gone, and what a
reviewer flags in that round tends to be sharper.

### How a gold PR is chosen

1. Only PRs from repositories with **zero AI-bot review activity** are
   considered — checked by literally listing commenter usernames on a sample
   of recent merged PRs and confirming none are bots.
2. The PR must be **merged**, and every commit that matters to the gold rows
   must still be fetchable — even if history was later rewritten (a rebase or
   squash before merge), GitHub keeps dangling commits reachable by SHA for a
   while, and `repos/{owner}/{repo}/commits/{sha}` still resolves them.
3. Cluster the PR's inline review comments by the exact commit SHA they were
   originally anchored to (`original_commit_id`), ordered by time. Each
   distinct commit a cluster of comments points at is one **review round**.
4. Pick a round N ≥ 2 — one that came after the PR author pushed new
   commit(s) in response to round N-1's feedback. `round_base_commit` is
   round N-1's commit; `round_commit` is round N's commit. The diff between
   them (`compare/{round_base_commit}...{round_commit}`) is exactly the
   incremental change a re-reviewer would see — not the whole PR.
5. From round N's comments, keep only the ones that are:
   - **not** from the PR's own author (a reply explaining/defending the code
     is not a finding),
   - **not** a bare reply that only asks a clarifying question or restates
     someone else's point without adding a new one,
   - **not** a bot,
   - **not** a self-declared or effectively pure style nit (a bare
     ` ```suggestion``` ` reformat, a naming/import-order preference, a
     "nit:" — these are the majority of what real reviewers leave and they
     are not what this benchmark measures),
   - anchored to a `path` + line **inside the round's diff** (verified by
     actually reading the diff, not by trusting the comment's own line
     number — a line can drift between when the comment was made and when it
     was fetched).
6. What survives is written as one gold row:
   `{ pr, path, from_line, to_line, side, quote, why, round_base_commit,
   round_commit, ref_before }`. `quote` is the reviewer's own words; `why`
   explains, in the curator's words, what the actual defect is and why the
   comment is right — this is what a judge model is shown when deciding
   whether a differently-anchored finding is the same defect (see below).
   `ref_before` is round N's first comment's timestamp; it is what keeps the
   review honest — see below.

Rounds with only one PR (frequent) or where every round-N comment turned out
to be a nit are simply skipped — a PR contributing zero gold rows is a normal
outcome, not an error, and no row is ever invented to hit a target count.

### Running it — how leakage is avoided

`reviewPullRequest` accepts an optional `Snapshot = { base?, commit, before }`
(`src/review.ts`). When given:

- The diff shown to the model comes from
  `compare/{base}...{commit}` — `base` is `round_base_commit`, `commit` is
  `round_commit` — so the model sees the same incremental diff the human
  re-reviewer saw, not the PR's final state and not history the round-N
  reviewer hadn't pushed yet.
- Every existing PR comment and review with `created_at >= before` is
  dropped from the prompt. Without this, the gold comments themselves (or
  later ones) would leak straight into the "existing review comments"
  context the model is shown, making the benchmark trivial.

### Matching predictions to gold

A model finding and a gold row can describe the same defect while pointing at
different lines — the model often cites the fix site, a human reviewer the
line that triggered the comment, sometimes a few lines or even a different
file apart (verified case: a duplicate validation gap in a second file that
is arguably a *better* anchor than the gold row's). Exact-line matching
(`match.ts`) misses these. After exact matching, any leftover predicted
finding and leftover gold row are sent to a small model (`judge.ts`,
`--judge-model=`, default `openai/gpt-oss-120b`) that decides — conservatively
— whether they describe the same underlying defect regardless of file/line;
a confirmed pair still counts as a match.

```sh
deno task bench-rereview --repo=owner/repo --review-concurrent=4 --high-model=... --judge-model=...
```
