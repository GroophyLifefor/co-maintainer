/** Shared by tests only — never imported by production code. */
import type { Options } from "../types.ts";
import type { Fact, Source } from "../knowledge/types.ts";

export function testOptions(overrides: Partial<Options> = {}): Options {
  return {
    command: "init",
    repo: "fixture/repo",
    debug: false,
    logTime: false,
    improveMatrix: 1,
    ghConcurrent: 1,
    aiConcurrent: 3,
    auth: "gh",
    ai: "none",
    synthesisVersion: 1,
    includeCodebase: true,
    includePullRequests: false,
    includePullRequestChanges: false,
    includeCommitHistory: false,
    includeHowRepoWorks: false,
    ...overrides,
  };
}

export function testSource(overrides: Partial<Source> = {}): Source {
  return {
    repo: { full_name: "fixture/repo", default_branch: "main" },
    tree: ["src/app.ts", "package.json", "pnpm-lock.yaml", "tests/app.test.ts"],
    treeSha: {
      "src/app.ts": "sha-app",
      "package.json": "sha-package",
      "pnpm-lock.yaml": "sha-lock",
      "tests/app.test.ts": "sha-test",
    },
    files: {
      "src/app.ts": "export function app() { return true; }",
      "package.json": '{"scripts":{"test":"deno test","check":"deno check"}}',
    },
    pullRequests: [],
    commits: [],
    ...overrides,
  };
}

export function testFact(
  claim: string,
  scope: Fact["scope"],
  evidence: string,
): Fact {
  return {
    id: `tests:${claim}`,
    sectionKey: "tests",
    claim,
    evidence: [evidence],
    weight: 1,
    scope,
    confidence: scope === "current" ? "high" : "medium",
    status: "active",
  };
}
