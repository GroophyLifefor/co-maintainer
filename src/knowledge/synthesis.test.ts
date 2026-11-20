import {
  extractAiFacts,
  extractPrompt,
  synthesizeSections,
} from "./synthesis.ts";
import { testOptions } from "../testing/helpers.ts";
import type { PullRequest, Source } from "./types.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import { testFact } from "../testing/helpers.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

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

test("fact extraction asks for the global reasoning level", async () => {
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
  // The global level, high when nothing is saved. It used to be a fixed low.
  if (extracts.some((item) => item.reasoningEffort !== "high")) {
    throw new Error("an extraction did not ask for the global high level");
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

// The extract prompt before comment links were kept, copied from 0.7.2. A
// pull request cached without links must get exactly this text, or every
// cached extract answer misses and the first 0.7.3 sync pays for all of them.
function promptText072(value: string, limit = 6_000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}
function extractPrompt072(pr: PullRequest): string {
  const unit = JSON.stringify({
    number: pr.number,
    title: pr.title,
    body: promptText072(pr.body),
    labels: pr.labels,
    comments: pr.comments.map((comment) => promptText072(comment, 2_000)),
    reviewComments: pr.reviewComments.map((comment) =>
      promptText072(comment, 2_000),
    ),
    reviews: pr.reviews.map((review) => promptText072(review, 2_000)),
    changedFiles: pr.changedFiles,
    diff: promptText072(pr.diff, 8_000),
  });
  return `Analyze this pull request's reviews, comments, code and diff, and return only a JSON array of review findings.
Each item must have exactly:
{"sectionKey":"review","class":"a short area name","claim":"the invariant a reviewer would enforce, imperative and general","location":"path or path:line the finding is about, or empty when none","trigger":"the diff surface that should trigger this rule: a path, glob, or symbol, or empty when none","impact":"why this matters here, from the review's reasoning","action":"what to change or verify","scope":"historical-example","confidence":"medium"}
Rules:
- Include only substantive findings: a reviewer identifies something to fix, change, verify or decide.
- Never write an approval, a merge, "LGTM", thanks, a reviewer name, a pull-request number, a commit id, or quoted comment text.
- The claim is a general invariant, not one past fix: "When X changes, Y must also change", or "Every Z uses W", never "change this one line".
- trigger is what a reviewer can see in a diff: a path, a glob, or a symbol. It is how the rule applies to a future change, so a rule with no trigger is a one-off and is not useful.
- impact and action are mandatory and concrete. Paraphrase the reviewer's reasoning for impact. Never quote it.
- class is a short area label chosen from a small, consistent set. Reuse the same label for findings of the same kind so related findings can be grouped.
- location is a repository path when the review names one, otherwise leave it empty.
- Return every distinct finding the reviews support, not a summary. Do not explain the answer.

PULL REQUEST:
${unit}`;
}

function linkFixturePr(links: boolean): PullRequest {
  return {
    number: 212,
    title: "Round percentages",
    body: "Fix rounding",
    state: "closed",
    merged: true,
    updatedAt: "2026-03-01T00:00:00Z",
    headSha: "sha",
    labels: [],
    additions: 1,
    deletions: 1,
    comments: ["thanks"],
    reviewComments: ["src/a.ts:3 this rounds half down"],
    reviews: ["Please round half up"],
    changedFiles: ["src/a.ts"],
    diff: "",
    ...(links
      ? {
          commentUrls: ["https://github.com/o/r/pull/212#issuecomment-1"],
          reviewCommentUrls: ["https://github.com/o/r/pull/212#discussion_r9"],
          reviewUrls: ["https://github.com/o/r/pull/212#pullrequestreview-5"],
        }
      : {}),
  };
}

test("a pull request cached without links keeps the 0.7.2 extract prompt byte for byte", () => {
  const pr = linkFixturePr(false);
  if (extractPrompt(pr) !== extractPrompt072(pr)) {
    throw new Error(
      "the unlinked extract prompt changed, the cache would miss",
    );
  }
});

test("a linked pull request numbers its comments and a finding keeps only real links", async () => {
  const pr = linkFixturePr(true);
  const prompt = extractPrompt(pr);
  for (const id of ["[c1] thanks", "[r1] src/a.ts:3", "[v1] Please"]) {
    if (!prompt.includes(id)) throw new Error(`no ${id} in the prompt`);
  }
  if (!prompt.includes('"sources"')) throw new Error("no sources field");
  const repo = `fixture-links-${crypto.randomUUID()}`;
  const provider: AiProvider = {
    async complete() {
      return {
        text: JSON.stringify([
          {
            sectionKey: "review",
            class: "rounding",
            claim: "Percentages round half up",
            impact: "Totals drift",
            action: "Use half up",
            sources: ["r1", "v1", "r9"],
          },
        ]),
        tokensIn: 1,
        tokensOut: 1,
        model: "fixture",
        provider: "openrouter",
      };
    },
  };
  const source: Source = {
    repo: { full_name: repo, default_branch: "main" },
    tree: ["src/a.ts"],
    treeSha: {},
    files: {},
    pullRequests: [pr],
    commits: [],
  };
  try {
    const facts = await extractAiFacts(
      provider,
      repo,
      source,
      testOptions({ includePullRequests: true, includeCodebase: false }),
    );
    const links = facts.find((fact) => fact.sectionKey === "review")?.links;
    const urls = (links ?? []).map((link) => `${link.pr} ${link.url}`);
    const expected = [
      "212 https://github.com/o/r/pull/212#discussion_r9",
      "212 https://github.com/o/r/pull/212#pullrequestreview-5",
    ];
    if (JSON.stringify(urls) !== JSON.stringify(expected)) {
      throw new Error(`links ${JSON.stringify(urls)}`);
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});
