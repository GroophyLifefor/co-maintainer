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

test("a malformed section is left out, not failed", async () => {
  const repo = `fixture-invalid-${crypto.randomUUID()}`;
  const provider = new SynthesisProvider(false);
  try {
    const result = await synthesizeSections(
      provider,
      repo,
      [testFact("Run tests before review.", "current", "workflow")],
      undefined,
      "openrouter",
      "fixture",
      3,
    );
    if (result.overrides.tests) {
      throw new Error("a section with no bullet was kept");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});

test("fact extraction allows a little thinking", async () => {
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
        reviewComments: [],
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
  if (extracts.some((item) => item.reasoningEffort !== "low")) {
    throw new Error("an extraction did not ask for low reasoning");
  }
});

test("extraction reads the real array when the model returns two", async () => {
  // A real model answered a file extraction with an empty array followed by the
  // real one (`[]` then `[...]`), which the old first-to-last-bracket slice
  // could not parse.
  const provider: AiProvider = {
    async complete() {
      return {
        text: '[]\n\n[{"sectionKey":"identity","claim":"Work here.","scope":"current","confidence":"high"}]',
        tokensIn: 1,
        tokensOut: 1,
        model: "fixture",
        provider: "openrouter",
      };
    },
  };
  const repo = `fixture-double-array-${crypto.randomUUID()}`;
  const source: Source = {
    repo: { full_name: repo, default_branch: "main" },
    tree: ["README.md"],
    treeSha: {},
    files: { "README.md": "# Fixture" },
    pullRequests: [],
    commits: [],
  };
  try {
    const facts = await extractAiFacts(
      provider,
      repo,
      source,
      testOptions({ includeCodebase: true }),
    );
    if (!facts.some((item) => item.claim === "Work here.")) {
      throw new Error(`the real array was lost: ${JSON.stringify(facts)}`);
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});
