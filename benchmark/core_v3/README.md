# bench core v3

Gold sourced from
[`GroophyLifefor/heap-analysis`](https://github.com/GroophyLifefor/heap-analysis)
(PRs 21-50, "Phase B"): deliberately seeded, hand-verified defects, not human
review comments. See `ledger.json` for the answer key and its
`quote`/`why`/`axis` per defect, and the heap-analysis repo's own (gitignored)
`plan.md` for the full defect catalog and design rationale.

Unlike `benchmark/core_v2` and `benchmark/swe-prbench`, every PR in the ledger
is reviewed — including the 16 with no gold at all — so precision is measurable,
not just recall. See `run.ts` for the two mechanical differences from the older
runners.

## Run config

|                   |                                                          |
| ----------------- | -------------------------------------------------------- |
| repo              | `GroophyLifefor/heap-analysis`                           |
| runner            | `co-maintainer`                                          |
| low-model         | `deepseek/deepseek-v4-flash-0731`                        |
| high-model        | `openai/gpt-5.6-luna`                                    |
| judge-model       | `openai/gpt-5.6-luna`                                    |
| review-concurrent | 4                                                        |
| `--codegraph`     | off (default)                                            |
| PRs               | 30 (14 defective, 16 control)                            |
| results file      | `results/GroophyLifefor-heap-analysis-comaintainer.json` |
| run date          | 2026-09-14                                               |

**Caveat:** this run happened before `ledger.json` was committed (K8
pre-registration). The ledger was not touched after seeing results, but the
commit-before-run guarantee that closes "you adjusted the defect list to fit the
numbers" wasn't formally in place for this pass.

## Headline

| metric                          | value                      |
| ------------------------------- | -------------------------- |
| F1 (defective PRs)              | 0.750                      |
| Precision                       | 0.667                      |
| Recall                          | 0.857                      |
| tp / fp / fn                    | 12 / 6 / 2                 |
| Control false positives (P0-P2) | 16 total — **1.00 per PR** |
| Control nice-to-haves (P3)      | 0                          |
| Total cost                      | $0.1340                    |
| Avg cost / PR                   | $0.0045                    |
| Avg time / PR                   | 28.9s (+1.9s prep)         |
| Avg tokens / PR (in/out/total)  | 5917 / 2564 / 8480         |

## Recall by axis

The number each axis exists to produce (`plan.md` §11.3): what capability a miss
on that axis is actually pointing at.

| axis         | capability it measures                      | tp | fn | recall    |
| ------------ | ------------------------------------------- | -- | -- | --------- |
| `repo_wide`  | codegraph / cross-file reasoning            | 4  | 0  | **1.000** |
| `convention` | `CODEBASE.md`                               | 2  | 0  | **1.000** |
| `history`    | `PR_REVIEW_GUIDE.md` / prior review culture | 1  | 0  | **1.000** |
| `diff_local` | base review, no extra context needed        | 4  | 1  | **0.800** |
| `file_local` | rest-of-file context                        | 1  | 1  | **0.500** |

`file_local` and `diff_local` are supposed to be the _easiest_ axes — both
misses are worth reading in detail below rather than writing off as noise.

## Per-PR results

### Defective (14 PRs, gold = the seeded defect)

| PR     | defect                             | axis           | tp    | fp    | fn    | time  | tokens | cost    |
| ------ | ---------------------------------- | -------------- | ----- | ----- | ----- | ----- | ------ | ------- |
| 22     | D7 predecessor/successor confusion | repo_wide      | 1     | 0     | 0     | 32.7s | 8070   | $0.0048 |
| 24     | D8 off-by-one bounds check         | diff_local     | 1     | 0     | 0     | 8.6s  | 6487   | $0.0022 |
| 26     | D9 byte/KB unit mixup              | convention     | 1     | 0     | 0     | 12.7s | 6583   | $0.0027 |
| 27     | D10 reversed output order          | diff_local     | 1     | 0     | 0     | 13.1s | 6468   | $0.0027 |
| 30     | D12 substring match                | file_local     | 1     | 0     | 0     | 8.1s  | 5087   | $0.0019 |
| **33** | **D13 incomplete type coverage**   | **file_local** | **0** | **1** | **1** | 38.3s | 8552   | $0.0052 |
| 34     | D14 wrong field / unit mismatch    | diff_local     | 1     | 0     | 0     | 14.9s | 6958   | $0.0029 |
| 36     | D15 raw offset as array index      | repo_wide      | 1     | 0     | 0     | 28.8s | 8557   | $0.0047 |
| 37     | D16 wrong alignment key            | repo_wide      | 1     | 0     | 0     | 19.5s | 11761  | $0.0033 |
| **40** | **D17 divide by zero**             | **diff_local** | **0** | **0** | **1** | 19.1s | 6179   | $0.0030 |
| 43     | D18 formatting in library layer    | convention     | 1     | 0     | 0     | 20.0s | 8867   | $0.0039 |
| 47     | D19 swallowed error                | history        | 1     | 1     | 0     | 26.4s | 8489   | $0.0044 |
| 48     | D20 off-by-one threshold           | diff_local     | 1     | 0     | 0     | 22.3s | 9939   | $0.0043 |
| 49     | D21 schema/return type mismatch    | repo_wide      | 1     | 4     | 0     | 79.1s | 14968  | $0.0107 |

Bold rows are the two misses (`fn=1`):

- **PR 33 (D13):** missed the seeded defect _and_ raised one unrelated finding —
  a clean miss, not a near-hit.
- **PR 40 (D17):** returned "No actionable findings." — the divide-by-zero →
  `Infinity` → JSON `null` chain was not flagged at all.

PR 47 and PR 49 found the real defect (`tp=1`) but also raised extra findings
scored as `fp` under this benchmark's one-gold-per-PR design. PR 49's four
extras (JSON-RPC notification handling, protocol version negotiation, a
null-request crash, and a missing parse-error response) are plausible real
critiques of a minimal hand-rolled MCP server, not obvious hallucinations — K1
already flags this class of ambiguity: a model finding something real that isn't
in the ledger can't be told apart from a false positive by this scoring alone.

### Control (16 PRs, gold = nothing)

| PR     | severe FP (P0-P2) | nice-to-have (P3) | time  | tokens | cost    |
| ------ | ----------------- | ----------------- | ----- | ------ | ------- |
| 21     | 0                 | 0                 | 6.9s  | 5075   | $0.0018 |
| 23     | 1                 | 0                 | 26.6s | 7603   | $0.0040 |
| 25     | 1                 | 0                 | 58.0s | 10418  | $0.0075 |
| 28     | 0                 | 0                 | 48.7s | 9444   | $0.0068 |
| 29     | 1                 | 0                 | 23.3s | 7244   | $0.0039 |
| 31     | 1                 | 0                 | 28.5s | 7387   | $0.0043 |
| 32     | 1                 | 0                 | 30.3s | 7403   | $0.0044 |
| **35** | **2**             | 0                 | 45.6s | 9652   | $0.0065 |
| 38     | 1                 | 0                 | 23.4s | 7158   | $0.0039 |
| 39     | 0                 | 0                 | 18.9s | 6226   | $0.0030 |
| **41** | **2**             | 0                 | 52.9s | 16016  | $0.0069 |
| **42** | **2**             | 0                 | 48.2s | 10598  | $0.0068 |
| 44     | 1                 | 0                 | 23.6s | 7138   | $0.0036 |
| **45** | **2**             | 0                 | 19.9s | 7692   | $0.0037 |
| 46     | 1                 | 0                 | 15.3s | 7094   | $0.0029 |
| 50     | 0                 | 0                 | 53.2s | 11289  | $0.0073 |

4 of 16 control PRs (21, 28, 39, 50 — 25%) came back genuinely clean. The rest
average just over 1 severe finding, topping out at 2 on PRs 35, 41, 42, 45.

## What this run does and doesn't show

- **Precision is the headline result.** 0.667 overall, dragged down almost
  entirely by control-PR noise, not by wrong calls on real defects (every `fp`
  on a defective PR came bundled with a correct `tp` on PR 47/49, only PR 33 was
  a wrong call with nothing right alongside it).
- **`file_local` and `diff_local` underperforming `repo_wide` is the interesting
  finding**, not the reverse — this run's defect set doesn't support the story
  "the model needs codegraph to do well," it supports "the model sometimes
  misses close-range, obvious-looking bugs."
- No ablation yet (`plan.md` §11.4: diff-only vs. +CODEBASE.md vs.
  +PR_REVIEW_GUIDE.md vs. +codegraph) — this run used the full default context
  for every PR, so axis labels are unvalidated claims until that's run.
- Every review's raw text and per-line findings are in
  `results/GroophyLifefor-heap-analysis-comaintainer/detail.json` and the 30
  individual `.md` files next to it — nothing here is summarized away.

## Reproducing

```sh
deno task bench-core-v3 -- --repo=GroophyLifefor/heap-analysis \
  --review-concurrent=4 \
  --ai=openrouter --low-model=deepseek/deepseek-v4-flash-0731 --high-model=openai/gpt-5.6-luna \
  --judge-model=openai/gpt-5.6-luna \
  --gh-concurrent=8 --ai-concurrent=10 --auth=gh --log-time
```

Requires the guide frozen at
`%APPDATA%/co-maintainer/repos/GroophyLifefor/heap-analysis/`
(`SKILL.md`/`CODEBASE.md`, see `guide_v1/` for the archived copy) — build it
once with `deno task init` per `plan.md` §11.1 before running this.
