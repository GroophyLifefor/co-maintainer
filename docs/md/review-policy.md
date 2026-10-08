# Review policy

A review policy decides which pull requests the [GitHub App](github-app.md) reviews
on its own, which ones wait until a maintainer asks, and which are never
reviewed. It runs in [`serve`](serve.md) when a webhook arrives. You set it per
repository in the [dashboard](dashboard.md), and for new repositories as a
server default.

The policy is about the App's reviews. A [remote review](remote-review.md) from
a laptop or from [CI](ci.md) looks at a diff, not at a pull request, so it does
not apply it.

## Three actions

| Action | What happens to a pull request |
| ------ | ------------------------------ |
| Review | It is reviewed automatically |
| Wait for a request | It is left alone until a maintainer [asks](#asking-for-a-review) |
| Do not review | It is never reviewed, and asking does not change that |

## Templates

| Template | What it does |
| -------- | ------------ |
| Everyone | Every pull request is reviewed, except drafts and pull requests by bots |
| Trusted authors, automatic | Owners, members and collaborators are reviewed. Everyone else waits for a request. Drafts and bots are skipped |
| Only when requested | Nothing is reviewed until a maintainer asks |
| Custom rules | Your own list of rules, see below |
| Simple switches | The three on and off switches a repository had before policies existed, see [Existing repositories](#existing-repositories) |

## Rules

A policy is an ordered list of rules. For each pull request the first rule whose
conditions all hold decides the action. When no rule holds, the last setting,
**Any other pull request**, decides. A rule can test:

| Condition | Matches when |
| --------- | ------------ |
| Author | The author's relation to the repository is one of the ones you tick |
| Opened from a fork | The head branch lives in another repository, or in none because the fork was deleted |
| Is a draft | The pull request is a draft, or is not |
| Is by a bot | The author is a bot account, or is not |
| Labels | The pull request has at least one of the labels, compared without regard to case |
| Target branch | The pull request merges into one of the branches, by exact name |
| Changed lines | Additions plus deletions are within a minimum and a maximum |

The author's relation is GitHub's own `author_association`:

| Value | Meaning |
| ----- | ------- |
| `OWNER` | Owns the repository |
| `MEMBER` | Belongs to the organization that owns it |
| `COLLABORATOR` | Was invited to the repository |
| `CONTRIBUTOR` | Has had a commit merged before |
| `FIRST_TIME_CONTRIBUTOR` | First contribution to this repository |
| `FIRST_TIMER` | First contribution anywhere on GitHub |
| `NONE` | No relation |

A rule that asks about something GitHub did not send never matches.

## Asking for a review

A pull request that waits, or one that no rule reviews, can be started three ways:

- **The request label.** Add `co-maintainer:review` to the pull request. Adding a
  label already needs triage rights, so nothing else is checked.
- **The request comment.** Comment `/co-maintainer review` as the first words of
  a comment on the pull request. Only people in the allowed set can ask, which is
  owners, members and collaborators unless you change it.
- **Review now.** On the dashboard, a pull request that is waiting shows a
  **Review now** button on the Activity page, under **Pull requests we
  skipped**. Whoever is signed in is already allowed to ask, and the button ignores
  the round limit.

When a label or comment request starts a review, the App reacts with an eyes
emoji on the comment or the pull request, so the person who asked can see it was
picked up.

A request never overrides **Do not review**. If a rule skips the pull request, a
request is refused and the reason is recorded.

GitHub sends no fork, target branch or size with a comment, so a **comment**
request is checked again when the review starts and the pull request has been
fetched. If a rule about those three skips it, or it is over the size limit, the
review does not run and no eyes reaction is added.

### What a request covers

| Setting | Covers |
| ------- | ------ |
| Only the commit it was made on | Each new push waits for a new request |
| Every later push to the pull request | After the first review, every push is reviewed |

Comments and reviews on a waiting pull request do not start a review either. The
second setting is the one that carries an earlier request forward.

### Round limit

**Reviews per pull request** stops the webhook after that many reviews. A request
obeys it too, and the skip reason reads `Round limit reached: 2 of 2 reviews.`
Leave it blank for no limit.

## Set it up

### In the dashboard

- **Repository settings**, card **Who gets a review.** Pick a template, read the
  plain sentences under **In short**, and open **Edit the rules** to change them.
  The sentences update as you edit, and **Save** is disabled while the policy is
  not valid. Editing a template turns it into custom rules.
- **Settings**, **Defaults for new repositories.** The template a repository
  starts with. Custom rules are set with a file, see below.
- **Add repository.** After the preview, the plan step lists the templates with
  their descriptions. The server default is selected, and you decide.

### On the command line

```sh
# The server default for new repositories
co-maintainer set --review-policy=trusted-auto

# A custom policy from a file
co-maintainer set --review-policy-file=policy.json

# Back to no default
co-maintainer set --unset=review-policy
```

A policy file is JSON. Everything except the rules can be left out:

```json
{
  "rules": [
    { "name": "draft", "when": { "draft": true }, "action": "skip" },
    {
      "name": "first time contributor",
      "when": { "association": ["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"] },
      "action": "on-request"
    },
    {
      "name": "small change by anyone we know",
      "when": { "association": ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"], "changedLines": { "max": 300 } },
      "action": "review"
    }
  ],
  "default": "on-request",
  "requestLabel": "co-maintainer:review",
  "requestCommand": "/co-maintainer review",
  "requesters": ["OWNER", "MEMBER", "COLLABORATOR"],
  "approvalScope": "head",
  "maxRounds": 3
}
```

| Field | Values | Default |
| ----- | ------ | ------- |
| `rules[].action` and `default` | `review`, `on-request`, `skip` | `default` is `review` |
| `rules[].when` | `association`, `fork`, `draft`, `bot`, `labels`, `targetBranch`, `changedLines` (`min`, `max`) | No condition matches everything |
| `requestLabel` | Label name | `co-maintainer:review` |
| `requestCommand` | Text a comment starts with | `/co-maintainer review` |
| `requesters` | Author relations that may ask by comment | `OWNER`, `MEMBER`, `COLLABORATOR` |
| `approvalScope` | `head`, `pull-request` | `head` |
| `maxRounds` | Whole number of 1 or more | No limit |

A policy that cannot be read is refused and says what is wrong, for example
`unknown template "x"` or `rules[0].action must be one of review, on-request, skip`.
Nothing is saved.

## Existing repositories

A repository added before policies existed keeps the three switches it had:
automatic review on or off, skip drafts, skip bots. They behave exactly as they
always did, and the repository shows **Simple switches**. Choosing a template
replaces them. On a repository that follows a policy, the switches are hidden and
changing one through the API is refused with a message that says to change the
policy instead.

A new repository with no choice follows the server default. With no server
default it behaves like **Everyone**.

## Why a pull request was skipped

**Activity**, **Pull requests we skipped** names the rule that decided, for
example `Rule 3 (trusted author): waiting for a maintainer request.` or
`Default rule: waiting for a maintainer request.` A rule without a name shows its
position only, so name the rules you write.

## Permissions

A request needs nothing new. The eyes reaction uses the Issues permission the App
already has, and a label request arrives on the `pull_request` event it already
receives. See [GitHub App](github-app.md) for the permission table.
