import { extractAiFacts, synthesizeSections } from "./synthesis.ts";
import { testOptions } from "../testing/helpers.ts";
import type { Source } from "./types.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import { testFact } from "../testing/helpers.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { test } from "node:test";

class SynthesisProvider implements AiProvider {
  requests: AiRequest[] = [];
  valid: boolean;

  constructor(valid: boolean) {
    this.valid = valid;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    return {
      text: this.valid
        ? "## Tests\n\n- Run `pnpm test` after behavior changes."
        : "## Tests\n\n| raw | output |\n| --- | --- |\n| x | y |",
      tokensIn: 1,
      tokensOut: 1,
      model: "fixture",
      provider: "openrouter",
    };
  }
}

test("current evidence is ordered before historical evidence", async () => {
  const repo = `fixture-conflict-${crypto.randomUUID()}`;
  const provider = new SynthesisProvider(true);
  const facts = [
    testFact("Use `npm test` after changes.", "historical-example", "PR #1"),
    testFact(
      "Use `pnpm test` after changes.",
      "current",
      ".github/workflows/ci.yml",
    ),
  ];
  try {
    await synthesizeSections(
      provider,
      repo,
      facts,
      undefined,
      "openrouter",
      "fixture",
      3,
    );
    const prompt = provider.requests[0].prompt;
    if (prompt.indexOf("pnpm test") > prompt.indexOf("npm test")) {
      throw new Error(
        "historical evidence was ordered before current evidence",
      );
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("invalid synthesis output is omitted instead of copied", async () => {
  const repo = `fixture-invalid-${crypto.randomUUID()}`;
  const provider = new SynthesisProvider(false);
  try {
    const overridesResult = await synthesizeSections(
      provider,
      repo,
      [testFact("Run tests before review.", "current", "workflow")],
      undefined,
      "openrouter",
      "fixture",
      3,
    );
    if (overridesResult.overrides.tests) {
      throw new Error(
        `invalid synthesis output was accepted: ${JSON.stringify(overridesResult)}`,
      );
    }
    // An output that never validates is skipped, not cached.
    if (overridesResult.skipped.length !== 1) {
      throw new Error(`skipped: ${JSON.stringify(overridesResult.skipped)}`);
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("fact extraction asks for no thinking", async () => {
  const requests: AiRequest[] = [];
  const provider: AiProvider = {
    async complete(request) {
      requests.push(request);
      return {
        text: "[]",
        tokensIn: 1,
        tokensOut: 1,
        model: "fixture",
        provider: "openrouter",
      };
    },
  };
  const repo = `fixture-extract-${crypto.randomUUID()}`;
  const source: Source = {
    repo: { full_name: repo, default_branch: "main" },
    tree: ["README.md"],
    treeSha: {},
    files: { "README.md": "# Fixture" },
    pullRequests: [
      {
        number: 1,
        title: "t",
        body: "",
        state: "closed",
        merged: true,
        updatedAt: "2026-01-01T00:00:00Z",
        headSha: "sha",
        labels: [],
        additions: 1,
        deletions: 1,
        comments: [],
        reviews: [],
        changedFiles: ["README.md"],
        diff: "",
      },
    ],
    commits: [],
  };
  try {
    await extractAiFacts(
      provider,
      repo,
      source,
      testOptions({ includePullRequests: true, includeCodebase: true }),
    );
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
  const extracts = requests.filter((item) => item.job === "extract_unit");
  if (extracts.length !== 2) throw new Error(`${extracts.length} extracts`);
  if (extracts.some((item) => item.reasoningEffort !== "none")) {
    throw new Error("an extraction asked for thinking");
  }
});
