# FAQ

Short answers to the questions people ask first. Each one links to the page
with the details.

## What does a review cost?

On our own repository, one review cost about $0.15 with a strong model and
about $0.01 with a small one. Your pull requests will differ. Learning a
repository the first time costs more, and co-maintainer can estimate that for
free before you spend anything.

More: [Cost](cost.md) and [Probe](probe.md).

## What does it learn from?

It reads your code and your past pull request reviews, and writes down how your
team reviews as plain text files you can read and edit. Comments your reviewers
make again and again become rules. It updates these files as your repository
changes.

More: [Init](init.md) and [Sync](sync.md).

## Is co-maintainer free?

Yes. It is open source under the MIT license and there is no fee. You pay your
AI provider for what your reviews use.

More: [AI providers](providers.md).

## Does my code leave my machine?

Only to the AI provider you choose, when it learns your repository and when it
reviews. co-maintainer itself collects nothing.

More: [Data and privacy](../privacy.html).

## Does it work with GitLab, Bitbucket or Azure DevOps?

Not yet. It works with GitHub only.

## Can I choose which PRs get reviewed?

Yes. For each repository you can review every pull request, only those from
people you trust, or none until a maintainer asks for a review on the pull
request.

More: [Review policy](review-policy.md).

## How is it different from CodeRabbit?

co-maintainer is open source, runs on your own AI key, and learns from your past
reviews. CodeRabbit is a hosted product that supports more platforms and does
more beyond review.

More: [co-maintainer vs CodeRabbit](../vs/coderabbit.html).
