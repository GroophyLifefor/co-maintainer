# Authentication

How `probe`, `init`, `remake`, and `review` read repository data from
GitHub. Different concern from the GitHub App `serve` uses for webhooks, and
from dashboard sign-in — see [`configuration`](configuration.md) and
[`serve`](serve.md) for those.

## `--auth=gh` (default)

```sh
co-maintainer probe owner/repo --auth=gh
```

- Reads through the installed GitHub CLI.
- Requires that you've already run `gh auth login` yourself — co-maintainer
  never performs that login for you, it only checks whether `gh` can already
  reach GitHub.
- `review` intentionally supports this method only.

## `--auth=pat`

```sh
co-maintainer init owner/repo --auth=pat --env=./.env
```

- Reads through a personal access token loaded from `--env=PATH`.
- Use `GITHUB_TOKEN` or `GH_TOKEN` in the env file.
