# Getting started

co-maintainer learns a GitHub repo, writes review guides on your machine, then
reviews a PR or local diff. Start with the CLI. [`serve`](serve.md) and
[`remote-review`](remote-review.md) are optional later.

## Overview

```mermaid
flowchart LR
  install[Install CLI] --> auth[gh auth login]
  auth --> probe[probe]
  probe --> init[init]
  init --> review[review]
  init --> remake["remake <br/>(to keep your context up to date)"]
```

**Need:** [Node.js 24+](https://nodejs.org/), a repo you can read, `gh auth login`, an
[OpenRouter](https://openrouter.ai/) key. Details: [Authentication](authentication.md).

## 1. Install

```sh
npm install -g co-maintainer
co-maintainer help
co-maintainer --version
```

PATH issues or general install notes: [README install](https://github.com/GroophyLifefor/co-maintainer#installation).

## 2. Save defaults (once)

```sh
co-maintainer set --auth=gh --ai=openrouter --token=YOUR_OPENROUTER_KEY --low-model=openai/gpt-oss-120b --high-model=openai/gpt-5.6-luna
```

[Configuration](configuration.md)

## 3. One repo

```sh
co-maintainer probe owner/repo 
co-maintainer init owner/repo ...args 
```

[`init`](init.md) takes time and API cost. Prefer the [`init`](init.md) line from [`probe`](probe.md) output.

## 4. Review

```sh
co-maintainer review   # local changes
co-maintainer review owner/repo 123   # pull request
```

[Local review](local-review.md) · [PR review](local-pr-review.md)

## Ways to use it (after `init`)

Same repo guides can power three different setups. You can mix them over time
(for example CLI on your laptop plus `serve` for the team).

```mermaid
mindmap
  root((co-maintainer))
    CLI only
      Local diff in a clone
      PR via gh
      No GitHub App
    Self-hosted server
      serve and dashboard
      init and remake per repo
      GitHub App webhooks
      auto PR reviews
    Remote review
      Shared init on serve
      no per-dev init/remake
      review --remote from clone
      codegraph stays local
```

### How each path runs

```mermaid
flowchart TB
  guides(["Guides from init / remake"])

  guides --> cli
  guides --> hosted
  guides --> remote

  subgraph cli["CLI only"]
    direction TB
    L1["Laptop: co-maintainer review"]
    L2["OpenRouter from your config"]
    L3["Optional: review owner/repo 123"]
    L1 --> L2
    L1 -.-> L3
  end

  subgraph hosted["Self-hosted"]
    direction TB
    S1["Server: co-maintainer serve"]
    S2["GitHub sends PR webhooks"]
    S3["Queue job, post App review"]
    S4["Dashboard for ops"]
    S1 --> S2 --> S3
    S1 --> S4
  end

  subgraph remote["Remote hybrid"]
    direction TB
    R1["Server holds shared guides from init/remake"]
    R2["Laptop: review --remote"]
    R3["CLI uploads diff, polls job"]
    R4["codegraph on laptop if enabled"]
    R1 --> R2 --> R3 --> R4
    R4 -.-> R1
  end
```

| You want | Where it runs | Typical entry | Read |
| -------- | ------------- | ------------- | ---- |
| Try a PR or local branch quickly | Your machine | `review` or `review owner/repo 123` | [local-review](local-review.md) · [PR review](local-pr-review.md) |
| Team-wide PR reviews without everyone running the CLI | Your server + GitHub App | `set` App credentials, then `serve` | [serve](serve.md) |
| Operate repos, tokens, concurrency | Browser on the server | Dashboard after `serve` | [dashboard](dashboard.md) |
| Review a local diff without every developer running init/remake | Laptop + server | `set --remote-host` then `review --remote` | [remote-review](remote-review.md) |
| Refresh guides after main moves | Same place as `init` | `remake owner/repo` | [remake](remake.md) |

Guides and cache paths: [Caching](caching.md). Flags and `co-maintainer set`:
[Configuration](configuration.md).

## If something breaks

Run `probe` only after install. Run `init` before `review`. co-maintainer does
not run `gh auth login` for you. Use `--debug` on failures.
