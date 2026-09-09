# Authentication

GitHub data can be read through the installed GitHub CLI:

```sh
co-maintainer probe owner/repo --auth=gh
```

Or through a personal access token loaded from `--env=PATH`:

```sh
co-maintainer init owner/repo --auth=pat --env=./.env
```

Use `GITHUB_TOKEN` or `GH_TOKEN` in the env file for PAT authentication. The
`review` command intentionally supports GitHub CLI authentication only.
