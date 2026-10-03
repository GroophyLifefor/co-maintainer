# AI providers

co-maintainer asks an AI provider to write the guides in [`init`](init.md) and
[`sync`](sync.md) and to write every review. Five providers are supported.

| Provider | `--ai=` | Where you get a key |
| -------- | ------- | ------------------- |
| [OpenRouter](https://openrouter.ai/) | `openrouter` | openrouter.ai, under Keys |
| [OpenAI](https://platform.openai.com/) | `openai` | platform.openai.com, under API keys |
| [Anthropic](https://console.anthropic.com/) | `anthropic` | console.anthropic.com, under API keys |
| [OpenCode Zen](https://opencode.ai/docs/zen) | `opencode-zen` | opencode.ai, after adding credit |
| [OpenCode Go](https://opencode.ai/docs/go) | `opencode-go` | opencode.ai, with a Go subscription |

`--ai=none` is the default until you choose a provider. [`probe`](probe.md)
needs no model, so it works with it.

## Where each provider works

| Command | Which provider |
| ------- | -------------- |
| [`init`](init.md) and [`sync`](sync.md) | The one you saved or pass with `--ai=` |
| [Local review](local-review.md) and [PR review](local-pr-review.md) | The one you saved or pass with `--ai=` |
| [`serve`](serve.md) jobs and automatic reviews | The one saved on the server |
| [Remote review](remote-review.md) | The server's provider |

Every provider works everywhere. A review with no provider saved uses OpenRouter,
which is what every review used before other providers existed, and
`review --ai=none` is refused. For a remote review the provider is whichever
one the server is configured with, so the laptop never needs a key unless it
brings its own (see [your own key](remote-review.md#your-own-ai-key)).

## Pick a provider and save it once

```sh
co-maintainer set --ai=anthropic --token=YOUR_KEY \
  --low-model=YOUR_LOW_MODEL_ID --high-model=YOUR_HIGH_MODEL_ID
```

After that `init`, `sync` and `serve` need no flags. The dashboard does the same
under **Settings**, **Models and API key**.

## There is no default model

co-maintainer never picks a model for you. Models change quickly, and an
installed version cannot fetch a newer list, so a built-in default would one day
name a model the provider no longer serves. You choose both models once and save
them, or pass them on the command:

| Model | Used for |
| ----- | -------- |
| `--low-model` | History extraction and diff summaries, the high volume and cheaper work |
| `--high-model` | Synthesis of the guides and the review itself |

When one is missing, the command stops before it spends anything:

- In a terminal it asks for the value and suggests none.
- Without a terminal, or with `--json`, it exits with code 2 and says which one
  is missing: `Missing low model. Pass it as a CLI option when running without
  an interactive terminal`.
- A review that reaches a model it does not have reports `No low model is
  configured.` with the hint `Run co-maintainer set --low-model=..., or pass
  --low-model=... on the command that needs it.`

Use the model ids the provider lists, for example the ones on its models page.
The examples in these docs use an OpenRouter pair such as
`openai/gpt-oss-120b` and `openai/gpt-5.6-luna`. They are examples, so check your
provider's current list before you copy one.

## Keys

| Provider | Key from | Environment variable |
| -------- | -------- | -------------------- |
| OpenRouter | `--token=`, `--ai-key=`, `set` | `CO_MAINTAINER_TOKEN` or `OPENROUTER_API_KEY` |
| OpenAI | `--token=`, `--ai-key=`, `set` | `CO_MAINTAINER_TOKEN` |
| Anthropic | `--token=`, `--ai-key=`, `set` | `CO_MAINTAINER_TOKEN` |
| OpenCode Zen and Go | `--token=`, `--ai-key=`, `set` | `CO_MAINTAINER_TOKEN` or `OPENCODE_API_KEY` |

`OPENROUTER_API_KEY` is only read when the provider is OpenRouter and
`OPENCODE_API_KEY` only for OpenCode, so a key for one provider is never sent
to another. The saved key belongs to the saved provider, and every command,
review included, sends it there. `OPENROUTER_LOW_MODEL` and
`OPENROUTER_HIGH_MODEL` are likewise only read for OpenRouter. A key is never stored per repository. The
order every setting is resolved in is on [Configuration](configuration.md#precedence).

## `set` checks the key and the model

Before it writes anything, `set` asks the provider whether the key works and, if
you gave a model, whether the provider has it:

| Provider | What is checked |
| -------- | --------------- |
| OpenRouter | The key against its key endpoint, the model against its model list |
| OpenAI | The key and the model against its model list |
| Anthropic | The key and the model against its model list |
| OpenCode Zen and Go | The model against the public model list. The list needs no key, so a wrong key shows up on the first real call |

A rejected key or an unknown model exits with code 2 and **nothing is saved**. A
network failure only warns, because that is not a typo. Pass `--no-verify` to
skip the check.

## What differs between providers

- **OpenRouter** reports the dollar cost of every call, so its reviews show a
  real cost.
- **OpenAI** is called through its Responses API. It does not report a cost, so
  the cost of a review is `unknown`. During a codegraph tool conversation the
  reasoning items of a reasoning model are not passed back between rounds, which
  can make a later round reason a little less well. The number of rounds is
  small, so little is at stake.
- **Anthropic** is called through its Messages API. It does not report a cost
  either. The guides are the same prefix in every review and are marked for
  prompt caching, so a review that follows soon after another reads them from
  Anthropic's cache at the cached rate. The call is not streamed, so a very long
  answer can run into Anthropic's request timeout.

- **OpenCode Zen and Go** route each model to its own API format, and the
  model list does not say which. co-maintainer calls every model over Chat
  Completions. A model that only answers in another format is refused with
  `OpenCode Zen does not know the model` and a hint that says so. Pick a model
  that supports Chat Completions. Gemini models on Zen use Google's format and
  do not work. Neither gateway reports a cost, so a review on it is `unknown`.
- **OpenCode Go** is a subscription meant for coding agents, and OpenCode
  watches its traffic for abuse. co-maintainer identifies itself with its own
  user agent and one session id per run, as Go asks every client to. `init`
  makes many short calls in a row, which is not the traffic Go is built for, so
  heavy use may hit its limits or its abuse checks. Zen has no such rule.

`unknown` is not zero. [Cost](cost.md#what-unknown-means) explains how the two
are kept apart. The [`probe`](probe.md) estimate says `estimate unavailable for
this provider` for OpenAI and Anthropic instead of printing a made-up dollar
range.

## Errors

| Message starts with | Code | What happened |
| ------------------- | ---- | ------------- |
| `OpenRouter rejected the API key`, `OpenAI rejected the API key`, `Anthropic rejected the API key`, `OpenCode Zen rejected the API key`, `OpenCode Go rejected the API key` | 2 | The provider refused the key. Replace it with `co-maintainer set --token=...` |
| `OpenAI does not know the model`, `Anthropic does not know the model`, `OpenCode Zen does not know the model`, `OpenCode Go does not know the model` | 2 | The model id is not one the provider serves. The hint links its model list |
| `OpenAI failed with`, `Anthropic failed with` | 3 | The provider returned an error that is not about the key or the model. The message carries its status |
| `OpenAI refused to answer`, `Anthropic refused to answer` | 3 | The model declined the request. The message says why when the provider did |

More in [Troubleshooting](troubleshooting.md).
