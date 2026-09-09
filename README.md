# co-maintainer

`co-maintainer` analyzes a GitHub repository and writes repository-specific
`SKILL.md` guidance that helps developers contribute changes more reliably.

It collects current code and workflows, selected pull requests and diffs, and
default-branch commits. A low-cost model extracts evidence-bound observations; a
higher-reasoning model turns them into concise contribution guidance for
implementation, testing, review, and release decisions.

This is a local Deno CLI. It writes generated skills to `repos/owner/repo/` and
keeps source and AI-job caches in `.cache/owner/repo/`.

## Installation

```sh
deno install -g -A --name co-maintainer jsr:@murat/co-maintainer
```

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

## Flow

- Parse `owner/repo`, PR number, OpenRouter key/model, `--improve-matrix`, and `--debug`.
- Verify the review command uses GitHub CLI authentication.
- Load `PR_REVIEW_GUIDE.md`.
- Load `PR_REVIEW_DETAILED_GUIDE.md` if available.
- Fetch the PR metadata with `gh`.
- Fetch issue comments.
- Fetch review comments and review states.
- Fetch changed files and patches.
- Build one review context containing:
  - Review guides
  - PR title and description
  - Changed file list
  - Existing comments/reviews
  - Complete available diff
- Instruct the model to:
  - Follow only the repository review guides.
  - Report actionable code-level violations.
  - Ignore bot noise and historical reviewer identities.
  - Avoid duplicate or already-resolved comments.
  - Avoid inventing requirements.
  - Inspect the complete diff.
  - Return every valuable finding, with no fixed finding count.
  - Include severity, location, problem, reason, and suggested fix.
  - Use a `diff` codeblock for supported multi-line fixes.
- Send the initial review to OpenRouter with high reasoning.
- If `--improve-matrix=N` is greater than `1`:
  - Send the current draft back to the model.
  - Ask it to remove unsupported findings.
  - Correct inaccurate findings.
  - Add missing actionable findings.
  - Preserve valid findings and their structure.
  - Repeat until the configured pass count is reached.
- With `--debug`, print each pass’s:
  - Prompt size
  - Diff size
  - Token budget
  - Input/output tokens
  - Full initial and improved review text
- Reject empty model responses.
- Add the static P0–P3 severity legend.
- Print the final review to the terminal.
- Record the final AI usage in `.cache/owner/repo/cost.jsonl`.

The actual review decision is made from the combination of the repository guides, PR context, comments, review history, and changed code—not from comments alone.