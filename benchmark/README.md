# Benchmarks

Three gold sets live under this folder: `core_v2/dataset.json` (AACR-Bench),
`core_v2/rereview_dataset.json`, and `swe-prbench/`. Each measures a
different question, see the README in its own folder for the mechanics.

## Why the numbers can look bad even when the review is good

Every one of these benchmarks scores a model against real human PR comments
as gold. That gold is only as good as the humans who wrote it, and human
code review at the scale GitHub produces it is noisy in ways that punish a
careful AI reviewer rather than reward it.

We hit this directly while validating `swe-prbench` against
`stylelint/stylelint`. Two PRs (`#9064`, `#9080`, 18 of 36 gold rows, half
the dataset) turned out to be the PR author's own notes on their own diff,
not reviewer findings, things like:

```
[note] Alphabetical order
Moved this check up to speedup this rule.
```

The real reviewer feedback on those PRs sat in the *replies* to those notes,
inverted from what every filtering heuristic assumes (top-level comment =
reviewer, reply = author). A model that correctly found nothing wrong on
`#9080` was scored as having missed 8 findings.

Of what was left after removing that, most of the remaining gold was
nitpicks the reviewer themselves flagged as optional:

```
Minor. Just curious, does it make sense to introduce a constant for the function?
Optional. I noticed filePath and filepath are used inconsistently.
nitpick ...
```

co-maintainer's review prompt deliberately does not surface these. It has a
severity bar (P0 to P3, "actionable", "blocking") built to filter exactly
this kind of comment out, on purpose, because a maintainer reading 300 PRs a
year does not want a bot repeating every nit a human reviewer happened to
type into a text box that day.

So the low score is not necessarily the model missing bugs. It is a
benchmark treating "a human, in the middle of an unrelated conversation,
typed something into a review thread" as equivalent to "there is a defect
here" and then measuring an AI reviewer against that bar. AI review at scale
can be more consistent and more targeted than the individual human review
that produced the gold set, and still lose the benchmark, because the
benchmark is measuring agreement with humans, not correctness.

This does not mean the numbers are useless. Precision, real false positives,
and clear P1 misses on obvious defects are still meaningful. It means recall
against raw "did the model say the same thing a human happened to type" is
not a correctness score, and a low one is a prompt to go read the actual gold
row before concluding the model is bad. See `swe-prbench/README.md`'s
"Known gap" section for the concrete numbers.
