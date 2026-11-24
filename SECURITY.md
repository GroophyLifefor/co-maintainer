# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. If you cannot use GitHub, email cos@co-maintainer.com.

Include what you can:

- the affected version (`co-maintainer --version`) or commit
- how to reproduce it, ideally the smallest config or pull request that shows it
- what an attacker gains

## What happens next

| Step                                                | Target time                       |
| --------------------------------------------------- | --------------------------------- |
| We confirm we received your report                  | 2 business days                   |
| We tell you whether we accept it as a vulnerability | 7 days                            |
| A fix is released for an accepted report            | 30 days, sooner for high severity |

We keep you updated while we work on it. When the fix is out, we publish a GitHub Security Advisory and credit you, unless you ask us not to.

## Supported versions

Security fixes go to the latest release. Upgrade with `npm i -g co-maintainer@latest`.

## Scope

In scope:

- the `co-maintainer` CLI and the GitHub App code in this repository
- prompt injection that makes the bot approve a pull request, leak secrets or act outside its permissions
- secrets from a repository or config reaching a place they should not

Out of scope:

- the content of a review being wrong. That is a quality issue, please open a normal issue
- the model provider you connect. Report those to the provider
- attacks that need write access to your own server

## Disclosure

We follow coordinated disclosure. Please give us the time above before going public. If we miss these targets, tell us and we will agree on a date together.
