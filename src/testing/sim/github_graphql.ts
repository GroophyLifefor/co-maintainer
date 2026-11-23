/** The simulated GitHub's GraphQL: the aliased `search` counts the product
 * sends. It reads the same pull requests as the REST routes, so a count and
 * a listing agree. A query it does not know gets GitHub's error answer, and
 * the product takes its REST path. */
import type { Json } from "../../types.ts";
import type { SimGithub, SimPull } from "./github.ts";

type Answer = { data?: Json; errors?: { message: string }[] };

/** Whether one pull request matches a search string's qualifiers. Only the
 * qualifiers the product writes are known: repo, is, updated, sort. */
export function matchesSearch(pull: SimPull, query: string): boolean {
  for (const term of query.split(/\s+/).filter(Boolean)) {
    const [key, value = ""] = term.split(/:(.*)/s);
    if (key === "repo" && value.toLowerCase() !== pull.repo.toLowerCase()) {
      return false;
    }
    if (key === "is") {
      const merged = pull.mergedAt !== null;
      if (value === "open" && pull.state !== "open") return false;
      if (value === "closed" && pull.state !== "closed") return false;
      if (value === "merged" && !merged) return false;
      if (value === "unmerged" && merged) return false;
    }
    if (key === "updated") {
      const day = pull.updatedAt.slice(0, 10);
      const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
      if (range && (day < range[1]! || day > range[2]!)) return false;
      const since = /^>=(\d{4}-\d{2}-\d{2})$/.exec(value);
      if (since && day < since[1]!) return false;
    }
  }
  return true;
}

const SEARCH =
  /(\w+): search\(type: ISSUE, first: (\d+), query: ("(?:[^"\\]|\\.)*")\) \{ issueCount( nodes \{[^}]*\{[^}]*\}[^}]*\} \})? \}/g;

function pullNode(github: SimGithub, pull: SimPull): Json {
  const rest = github.pullJson(pull);
  return {
    number: pull.number,
    additions: rest.additions,
    deletions: rest.deletions,
    isDraft: pull.draft,
    updatedAt: pull.updatedAt,
    author: {
      login: pull.author,
      __typename: pull.authorType === "Bot" ? "Bot" : "User",
    },
  };
}

function searches(github: SimGithub, query: string): Answer | undefined {
  const data: Json = {};
  let found = false;
  for (const match of query.matchAll(SEARCH)) {
    found = true;
    const [, alias, first, quoted, nodes] = match;
    const text = JSON.parse(quoted!) as string;
    const hits = github.pulls
      .filter((pull) => matchesSearch(pull, text))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    data[alias!] = {
      issueCount: hits.length,
      ...(nodes
        ? {
            nodes: hits
              .slice(0, Number(first))
              .map((pull) => pullNode(github, pull)),
          }
        : {}),
    };
  }
  return found ? { data } : undefined;
}

function connection(nodes: Json[]): Json {
  return { totalCount: nodes.length, nodes };
}

/** A pull request as the listing query asks for it, with its comments,
 * reviews and review threads. */
function listedNode(github: SimGithub, pull: SimPull): Json {
  const rest = github.pullJson(pull);
  const ofPull = github.comments.filter(
    (comment) => comment.repo === pull.repo && comment.number === pull.number,
  );
  const issueComments = ofPull.filter((comment) => comment.kind === "issue");
  const reviewComments = ofPull.filter((comment) => comment.kind === "review");
  const threads = reviewComments
    .filter((comment) => comment.inReplyTo === undefined)
    .map((root) =>
      connection(
        reviewComments
          .filter(
            (comment) =>
              comment.id === root.id || comment.inReplyTo === root.id,
          )
          .map((comment) => {
            const json = github.commentJson(comment);
            return {
              body: comment.body,
              path: comment.path ?? "",
              line: json.line,
              originalLine: json.original_line,
              url: json.html_url,
              createdAt: comment.createdAt,
            };
          }),
      ),
    )
    .map((comments) => ({ comments }));
  const reviews = github.reviews.filter(
    (review) => review.repo === pull.repo && review.number === pull.number,
  );
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state:
      pull.mergedAt !== null
        ? "MERGED"
        : pull.state === "open"
          ? "OPEN"
          : "CLOSED",
    mergedAt: pull.mergedAt,
    updatedAt: pull.updatedAt,
    headRefOid: pull.headSha,
    additions: rest.additions,
    deletions: rest.deletions,
    labels: connection(pull.labels.map((name) => ({ name }))),
    comments: connection(
      issueComments.map((comment) => ({
        body: comment.body,
        url: github.commentJson(comment).html_url,
        createdAt: comment.createdAt,
      })),
    ),
    reviews: connection(
      reviews.map((review) => ({
        body: review.body,
        state: review.state,
        url: `https://github.com/${review.repo}/pull/${review.number}#pullrequestreview-${review.id}`,
      })),
    ),
    reviewThreads: connection(threads),
  };
}

/** `repository.pullRequests`, newest update first, with the cursor being
 * the index of the next pull request. */
function listing(
  github: SimGithub,
  query: string,
  body: Json,
): Answer | undefined {
  if (!query.includes("pullRequests(states:")) return undefined;
  const variables = (body.variables ?? {}) as Json;
  const repo = `${String(variables.owner)}/${String(variables.name)}`;
  const states = new Set((variables.states as string[] | undefined) ?? []);
  const first = Number(/first: (\d+), after/.exec(query)?.[1] ?? 20);
  const start = Number(variables.after ?? 0);
  const all = github.pulls
    .filter((pull) => pull.repo.toLowerCase() === repo.toLowerCase())
    .filter((pull) => {
      const state =
        pull.mergedAt !== null
          ? "MERGED"
          : pull.state === "open"
            ? "OPEN"
            : "CLOSED";
      return states.size === 0 || states.has(state);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!github.world.repos.size) return { data: { repository: null } };
  const page = all.slice(start, start + first);
  const end = start + page.length;
  return {
    data: {
      repository: {
        pullRequests: {
          pageInfo: {
            hasNextPage: end < all.length,
            endCursor: end < all.length ? String(end) : null,
          },
          nodes: page.map((pull) => listedNode(github, pull)),
        },
      },
    },
  };
}

/** GitHub's answer to one GraphQL request. */
export function answerGraphql(github: SimGithub, body: Json): Answer {
  const query = String(body.query ?? "");
  return (
    listing(github, query, body) ??
    searches(github, query) ?? {
      errors: [{ message: "the simulation does not answer this query" }],
    }
  );
}
