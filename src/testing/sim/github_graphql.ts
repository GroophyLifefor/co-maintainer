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

/** GitHub's answer to one GraphQL request. */
export function answerGraphql(github: SimGithub, body: Json): Answer {
  const query = String(body.query ?? "");
  return (
    searches(github, query) ?? {
      errors: [{ message: "the simulation does not answer this query" }],
    }
  );
}
