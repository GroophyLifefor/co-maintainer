# co-maintainer

`co-maintainer` analyzes a GitHub repository and writes repository-specific
`SKILL.md` guidance that helps developers contribute changes more reliably.

It collects current code and workflows, selected pull requests and diffs, and
default-branch commits. A low-cost model extracts evidence-bound observations; a
higher-reasoning model turns them into concise contribution guidance for
implementation, testing, review, and release decisions.

This is a local Deno CLI. It writes generated skills to `repos/owner/repo/` and
keeps source and AI-job caches in `.cache/owner/repo/`.

```sh
deno task probe owner/repo --auth=gh

deno task init owner/repo --auth=gh --ai=openrouter --token=... \
  --low-model=openai/gpt-oss-120b \
  --high-model=openai/gpt-5.6-luna \
  --include-codebase --include-pull-requests \
  --include-pull-request-changes --include-commit-history \
  --include-how-repo-works

deno task review owner/repo 123 --improve-matrix=2 --debug
```

`probe` recommends source limits without writing a skill. `remake` refreshes
changed repository evidence and reuses cached analysis when possible.
`review` checks a pull request against the generated review guides using
OpenRouter and GitHub CLI data. `--improve-matrix=N` performs repeated review
passes with a `24,000 × N` token budget per pass; `--debug` prints each pass
for comparison. Review results are printed to the terminal and costs are
recorded in `.cache/owner/repo/cost.jsonl`.
