import { test } from "node:test";
import { matchesSearch } from "./github_graphql.ts";
import type { SimPull } from "./github.ts";

const pull = {
  repo: "sim/sample",
  state: "closed",
  mergedAt: "2026-03-02T00:00:00Z",
  updatedAt: "2026-03-02T10:00:00Z",
} as SimPull;

test("the simulated search reads repo, state and updated qualifiers", () => {
  const cases: [string, boolean][] = [
    ["repo:sim/sample is:pr", true],
    ["repo:other/repo is:pr", false],
    ["repo:sim/sample is:pr is:merged", true],
    ["repo:sim/sample is:pr is:closed is:unmerged", false],
    ["repo:sim/sample is:pr is:open", false],
    ["repo:sim/sample is:pr updated:2026-01-01..2026-12-31", true],
    ["repo:sim/sample is:pr updated:2025-01-01..2025-12-31", false],
    ["repo:sim/sample is:pr updated:>=2026-03-02", true],
    ["repo:sim/sample is:pr updated:>=2026-03-03", false],
  ];
  for (const [query, expected] of cases) {
    if (matchesSearch(pull, query) !== expected) {
      throw new Error(`${query} should be ${expected}`);
    }
  }
});
