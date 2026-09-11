/** Cross-layer contracts only. A type owned by one layer (Fact, Source,
 * PullRequest, State) lives next to the code that owns it instead, in
 * `knowledge/types.ts` — see PLAN.md Section 3. */
export type Json = Record<string, unknown>;

export type Options = {
  command: "probe" | "init" | "remake" | "review";
  repo: string;
  prNumber?: number;
  debug: boolean;
  logTime: boolean;
  improveMatrix: number;
  ghConcurrent: number;
  aiConcurrent: number;
  envPath?: string;
  auth: "gh" | "pat";
  githubPat?: string;
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
  maxComments?: number;
};

export type GitHubClient = {
  request<T>(endpoint: string): Promise<T>;
  pages<T>(
    endpoint: string,
    limit?: number,
    progress?: (page: number, fetched: number) => void,
  ): Promise<T[]>;
  /** POST JSON. Optional so collect-test fakes stay GET-only. Review
   * posting requires it. */
  write?<T>(endpoint: string, body: unknown): Promise<T>;
  /** GitHub Checks API operations. Optional so read-only test clients and
   * older integrations can continue to review without check runs. */
  createCheckRun?<T>(endpoint: string, body: unknown): Promise<T>;
  updateCheckRun?<T>(endpoint: string, body: unknown): Promise<T>;
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
