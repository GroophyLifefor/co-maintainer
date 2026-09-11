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
  reviews: string[];
  changedFiles: string[];
  diff: string;
};

export type Source = {
  repo: Json;
  tree: string[];
  treeSha: Record<string, string>;
  files: Record<string, string>;
  pullRequests: PullRequest[];
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
