import type { Json, Options } from "../types.ts";

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  updatedAt: string;
  headSha: string;
  labels: string[];
  additions: number;
  deletions: number;
  comments: string[];
  /** Inline review comments (`pulls/{n}/comments`), as `path:line body`. These
   * carry most of the substantive review feedback, and the reviewer never sees
   * them otherwise. */
  reviewComments: string[];
  reviews: string[];
  /** Set once reviews have been read. Missing means an older checkpoint
   * never stored the review state. */
  changesRequested?: boolean;
  changedFiles: string[];
  diff: string;
};

export type Source = {
  repo: Json;
  tree: string[];
  treeSha: Record<string, string>;
  files: Record<string, string>;
  /** Pull requests selected for facts and the skill. */
  pullRequests: PullRequest[];
  /** Every pull request already decided, including ones left out of the skill.
   * The next fetch reads this so a `changesRequested: false` result is not downloaded again. */
  pullRequestCache?: PullRequest[];
  commits: Json[];
};

export type Fact = {
  id: string;
  sectionKey: string;
  claim: string;
  evidence: string[];
  weight: number;
  scope: "current" | "repeated-history" | "historical-example";
  confidence: "high" | "medium" | "low";
  status: "active" | "contradicted" | "stale";
  /** Where the fact was mined from. A fact read out of a single pull request
   * describes that request, not the repository, so it may not become a
   * repository-wide rule. Missing means `repository`, which
   * keeps facts written before this field existed. */
  origin?: "repository" | "pull-request";
  /** Review findings only (`sectionKey === "review"`): the free-form area the
   * finding belongs to, so the guide can group findings into passes without a
   * fixed taxonomy. */
  class?: string;
  /** A repository-relative path or `path:line` the finding is about, when the
   * review named one. Kept because it is the difference between a concrete
   * rule and generic advice. */
  location?: string;
  /** Review findings only: why the finding matters here, in one or two
   * sentences of the review's own reasoning (never a verbatim quote). */
  impact?: string;
  /** Review findings only: what to change or verify. */
  action?: string;
  /** Review findings only: the diff surface that should trigger this rule: a
   * path, a glob, or a symbol. The guide turns these into the "when X changes,
   * also do Y" obligations listed under a pass's exit check, so a reviewer that
   * only sees a diff can still apply the rule. */
  trigger?: string;
};

export type State = {
  version: 1;
  repo: string;
  options: Omit<Options, "command" | "aiToken" | "githubPat">;
  source: Source;
  facts: Fact[];
  sectionHashes: Record<string, string>;
  scanDone: { pullRequests: number; commits: number; updatedAt: string };
  updatedAt: string;
};
