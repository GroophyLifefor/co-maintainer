export type Json = Record<string, unknown>;

export type Options = {
  command: "probe" | "init" | "remake" | "review";
  repo: string;
  prNumber?: number;
  debug: boolean;
  logTime: boolean;
  improveMatrix: number;
  concurrent: number;
  envPath?: string;
  auth: "gh" | "pat";
  ai: "none" | "openrouter" | "hetzner";
  aiToken?: string;
  lowModel?: string;
  highModel?: string;
  synthesisVersion: number;
  includeCodebase: boolean;
  includePullRequests: boolean;
  includePullRequestChanges: boolean;
  includeCommitHistory: boolean;
  includeHowRepoWorks: boolean;
  maxCommits?: number;
  maxPrMonths?: number;
  maxPullRequestChangeLines?: number;
};

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
  options: Omit<Options, "command" | "aiToken">;
  source: Source;
  facts: Fact[];
  sectionHashes: Record<string, string>;
  scanDone: { pullRequests: number; commits: number; updatedAt: string };
  updatedAt: string;
};

export type GitHubClient = {
  request<T>(endpoint: string): Promise<T>;
  pages<T>(
    endpoint: string,
    limit?: number,
    progress?: (page: number, fetched: number) => void,
  ): Promise<T[]>;
};

export type AiRequest = {
  system?: string;
  prompt: string;
  maxTokens: number;
  job: string;
  reasoningEffort?: "high";
};

export type AiResponse = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  cost?: number;
  model: string;
  provider: "openrouter" | "hetzner";
};

export type AiProvider = {
  complete(request: AiRequest): Promise<AiResponse>;
};
