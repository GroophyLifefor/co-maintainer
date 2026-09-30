# CI (GitHub Action)

Run [remote review](remote-review.md) on every pull request from a workflow. The
findings show up as annotations on the changed files, a table lands in the job
summary, and the step turns red when a finding blocks.

The action needs a server that already runs `co-maintainer serve` with the
repository added, and a remote review token from its dashboard. It sends the
diff of the pull request to that server, the same way `review --remote` does
from a laptop.

## Set it up

1. On the dashboard open **Settings**, **Remote review tokens** and create a
   token for CI.
2. In the GitHub repository open **Settings**, **Secrets and variables**,
   **Actions**, and add two secrets. `CO_MAINTAINER_HOST` holds the URL of the
   server and `CO_MAINTAINER_TOKEN` holds the token.
3. Add a workflow:

```yaml
name: co-maintainer
on:
  pull_request:

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: GroophyLifefor/co-maintainer@v0
        with:
          remote-host: ${{ secrets.CO_MAINTAINER_HOST }}
          remote-token: ${{ secrets.CO_MAINTAINER_TOKEN }}
```

`fetch-depth: 0` gives the action the history it needs to find where the pull
request branched off. Without it the action fetches what is missing, which is
slower.

## Inputs

| Input | Required | Default | What it does |
| ----- | -------- | ------- | ------------ |
| `remote-host` | yes | none | URL of your server, for example `https://review.example.com` |
| `remote-token` | yes | none | The remote review token. Pass it as a secret |
| `remote-byok` | no | empty | Your own AI key, see [your own key](#your-own-ai-key) |
| `to-branch` | no | the pull request base branch | The branch the pull request merges into |
| `version` | no | the version at the action's own commit | The co-maintainer version to run |
| `node-version` | no | `24` | The Node.js version to run it with |

Inputs are never removed or renamed within `v0`. A new input is only ever added,
with a default that keeps the old behavior.

## What you see

- **Annotations.** Each finding that is still open is an error when it blocks
  and a warning when it does not. They appear on the **Files changed** tab and
  in the run's annotation list. GitHub shows at most ten errors and ten
  warnings per step, so when there are more the action adds one notice that
  says how many were left out.
- **Job summary.** A table of every finding with its severity, state and
  location, the cost of the review, and how long it took. An unknown cost reads
  `cost unknown` with the reason, never `$0`.
- **Exit status.** The step fails when a finding blocks, the same rule as
  `review` on the command line.

Nothing else goes to the step's output in this mode, so a finding can never
write a workflow command of its own. See [`review`](review.md) for the
`--output=github` option the action uses.

## Choose which pull requests get reviewed

The action reviews the diff it is given. The server's
[review policy](dashboard.md) decides which pull requests its GitHub App reviews,
and it does not apply here, because a remote review looks at a diff and not at a
pull request. Choose in the workflow instead:

```yaml
    # Skip drafts.
    if: github.event.pull_request.draft == false

    # Skip a bot.
    if: github.actor != 'dependabot[bot]'

    # Only pull requests a maintainer labeled.
    if: contains(github.event.pull_request.labels.*.name, 'needs-review')

    # Only people with a stake in the repository.
    if: contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.pull_request.author_association)
```

## Pull requests from forks

GitHub does not give repository secrets to a workflow started by a pull request
from a fork. The action then sees an empty `remote-token`, stops, and the step
turns red with this message:

```text
remote-token is empty. Pull requests from forks do not receive repository
secrets, so this step cannot run for them.
```

That is on purpose. A quiet skip would look like a clean review. If you would
rather not see red on fork pull requests, skip the job for them:

```yaml
    if: github.event.pull_request.head.repo.full_name == github.repository
```

Do not switch the trigger to `pull_request_target` and check out the fork's code
to get around this. That runs untrusted code with your secrets.

## Pin a version

| You write | What runs | When it changes |
| --------- | --------- | --------------- |
| `@v0` | The newest stable release | On every stable release, on its own |
| `@v0.5.1` | That release | Never |
| A full commit SHA | That exact commit | Never |

The action runs the co-maintainer version that matches its own commit, so
pinning the action pins the tool too. Use `@v0.5.1` or a SHA when a workflow
must not change without a pull request. Beta releases are never reached through
`@v0`.

## Your own AI key

If the server allows it, pass your own key and the review is billed to you and
not to the server. See [remote review](remote-review.md) for the server side of
this.

```yaml
      - uses: GroophyLifefor/co-maintainer@v0
        with:
          remote-host: ${{ secrets.CO_MAINTAINER_HOST }}
          remote-token: ${{ secrets.CO_MAINTAINER_TOKEN }}
          remote-byok: ${{ secrets.OPENROUTER_API_KEY }}
```

The key goes to the tool by environment variable, never on a command line, and
both the token and the key are masked in the log. The server answers with an
error and does not fall back to its own key when it does not accept yours.
Use an `https://` host. The key travels with the request.

## Environment variables

Outside the action the same settings can be given to the CLI by environment:
`CM_REMOTE_HOST`, `CM_REMOTE_TOKEN` and `CM_REMOTE_BYOK`. A flag wins over the
environment, and the environment wins over the saved config. An empty value
counts as not set.

## When it fails

| Message | Cause |
| ------- | ----- |
| `remote-token is empty` | The secret is missing, misspelled, or a fork pull request |
| `Could not fetch the base branch` | `to-branch` names a branch that does not exist on `origin` |
| `This server does not accept your own key` | The server's BYOK policy is `off` |
| `This server requires your own key` | The server's BYOK policy is `require`, add `remote-byok` |

More in [troubleshooting](troubleshooting.md).
