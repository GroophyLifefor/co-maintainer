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
  /** Reviews every changed file with no own/upstream split — the behavior
   * before scope.ts existed. Off by default: a re-review round's diff can
   * carry a merge from the default branch that dwarfs the PR's own change,
   * and neither a human reviewer nor this flag's absence asks anyone to read
   * it as if the PR authored it. */
  reviewUpstream?: boolean;
  /** CLI review enables codegraph by default (`--disable-codegraph` to skip).
   * Server jobs still follow per-repo settings. Indexing adds tokens and time;
   * measured PR recall gains were small when this was opt-in only (K25). */
  useCodegraph?: boolean;
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
  /** Keep only pull requests in the window that have at least one
   * `CHANGES_REQUESTED` review. Off by default, so the window is unchanged. */
  onlyRequestChangedPr: boolean;
  /** Empty or omitted means every state. `closed` is closed and not merged. */
  prState?: ("open" | "closed" | "merged")[];
  maxCommits?: number;
  maxPrMonths?: number;
  maxPullRequestChangeLines?: number;
  maxComments?: number;
  /** `probe --run`: after printing the plan, run the recommended init in the
   * same process (CORE-24). */
  run?: boolean;
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

export type AiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: AiToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type AiRequest = {
  system?: string;
  prompt: string;
  messages?: AiMessage[];
  tools?: Json[];
  maxTokens: number;
  job: string;
  // The full scale OpenRouter exposes for models that support it (see a
  // model's `reasoning.supported_efforts`), highest first. Not every model
  // supports every level — "max"/"xhigh" are newer additions some models
  // don't have, and requesting an unsupported one is the caller's mistake to
  // avoid, not something validated here.
  reasoningEffort?: "max" | "xhigh" | "high" | "medium" | "low" | "none";
};

export type AiResponse = {
  text: string;
  toolCalls?: AiToolCall[];
  tokensIn: number;
  tokensOut: number;
  cost?: number;
  model: string;
  provider: "openrouter" | "hetzner";
};

export type AiProvider = {
  supportsTools?: boolean;
  complete(request: AiRequest): Promise<AiResponse>;
};
