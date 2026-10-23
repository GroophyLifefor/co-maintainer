import {
  reviewSignalCount,
  synthesizeReviewGuides,
  validateGuide,
} from "./guide.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import type { Fact } from "./types.ts";
import { test } from "node:test";

function method(
  checks: string[],
  areas = ["Call sites", "Data cost", "Tests"],
): string {
  const perArea = Math.ceil(checks.length / areas.length);
  const body = areas
    .map((area, index) => {
      const slice = checks.slice(index * perArea, (index + 1) * perArea);
      return [
        `## ${area}`,
        "",
        "**Goal:** keep this area correct.",
        "**Applies to:** related changes.",
        "",
        ...slice.map((check) => `- ${check}`),
        "",
        "**Exit check:** the area is satisfied.",
      ].join("\n");
    })
    .join("\n\n");
  return `# Review method\n\nHow to review a change here.\n\n${body}\n`;
}

const CHECKS = [
  "Update every caller of a changed symbol · a stale caller keeps the old behavior (→ `src/app.ts`)",
  "Add the new route's MCP tool or a stated reason · the parity test fails otherwise",
  "Add an index for a new array predicate · array containment cannot use a btree",
  "Scope every read to one tenant · a whole-tenant scan is a per-request cost",
  "Drain writes before shutdown · a dropped write is lost on redeploy",
  "Pin third-party actions to a commit · a moved tag runs with the workflow's secrets",
  "Pin the regression with a test that runs in CI · a dropped line otherwise leaves CI green",
  "Keep error bodies shape-stable · a non-array field turned a 400 into a 500",
  "Document the companion change in the same commit · reviewers re-check it otherwise",
];

const SHORT_GUIDE = method(CHECKS);

const LONG_GUIDE = method(
  Array.from(
    { length: 140 },
    (_, index) => `Check behavior ${index} · it can regress (→ \`src/app.ts\`)`,
  ),
);

class GuideProvider implements AiProvider {
  requests: AiRequest[] = [];
  private readonly byJob: Record<string, string>;

  constructor(text: string, short?: string) {
    this.byJob = short
      ? { synth_guide: text, synth_guide_short: short }
      : { synth_guide: text };
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    return {
      text: this.byJob[request.job] ?? this.byJob.synth_guide,
      tokensIn: 1,
      tokensOut: 1,
      model: "fixture",
      provider: "openrouter",
    };
  }
}

function finding(claim: string, extra: Partial<Fact> = {}): Fact {
  return {
    id: `review:${claim}`,
    sectionKey: "review",
    claim,
    evidence: ["PR #1"],
    weight: 1,
    scope: "historical-example",
    confidence: "medium",
    status: "active",
    origin: "pull-request",
    impact: "it can regress",
    action: "check it",
    ...extra,
  };
}

async function cleanup(repo: string): Promise<void> {
  await cacheDeletePrefix("ai-jobs", `${repo}:`);
}

test("validateGuide accepts a method and rejects generic or banned content", () => {
  if (validateGuide(SHORT_GUIDE) !== null) {
    throw new Error(
      `a valid method was rejected: ${validateGuide(SHORT_GUIDE)}`,
    );
  }
  const banned = [
    [
      "no title",
      "How to review.\n\n" + method(CHECKS).split("\n").slice(1).join("\n"),
    ],
    ["too few passes", method(CHECKS, ["Call sites", "Data cost"])],
    [
      "too many passes",
      method(
        CHECKS,
        Array.from({ length: 13 }, (_, index) => `Area ${index}`),
      ),
    ],
    [
      "a slug pass name",
      method(CHECKS, ["test-cleanup", "Data cost", "Tests"]),
    ],
    ["a bare check with no reason", method([...CHECKS, "Inspect the build"])],
    [
      "a vague check",
      method([...CHECKS, "Check whether the build is fine · it matters"]),
    ],
    ["a priority tag", method([...CHECKS, "Fix the P1 leak · it is critical"])],
    ["a pull-request number", method([...CHECKS, "Fix PR #12 · it regressed"])],
    ["an attribution", method([...CHECKS, "Fix it — Ada · she asked"])],
    ["a mention", method([...CHECKS, "Ping @octocat · they own it"])],
    ["a commit id", method([...CHECKS, "See deadbeef0 · it changed"])],
    ["a placeholder", method([...CHECKS, "TODO fix · later"])],
  ] as const;
  for (const [label, text] of banned) {
    if (validateGuide(text) === null) {
      throw new Error(`banned content was accepted (${label})`);
    }
  }
  // A no-reason check and a code fence must fail even when counts pass.
  if (
    validateGuide(method([...CHECKS, "```\nrun it\n``` · it matters"])) === null
  ) {
    throw new Error("a code fence was accepted");
  }
});

test("validateGuide accepts a trigger→obligation bullet under an exit check", () => {
  const text = method(CHECKS).replaceAll(
    "**Exit check:** the area is satisfied.",
    "**Exit check:** the area is satisfied.\n- `docker-compose.yml` → document profile startup",
  );
  if (validateGuide(text) !== null) {
    throw new Error(
      `an obligation bullet was rejected: ${validateGuide(text)}`,
    );
  }
});

test("reviewSignalCount counts review findings that carry an impact and an action", () => {
  const findings = [
    finding("Require a test for a behavior change."),
    finding("Missing impact and action.", {
      impact: undefined,
      action: undefined,
    }),
    { ...finding("A prose fact."), sectionKey: "review-bar" },
  ];
  if (reviewSignalCount(findings) !== 1) {
    throw new Error(`signals: ${reviewSignalCount(findings)} (want 1)`);
  }
});

test("no guide is built below three review findings", async () => {
  const repo = `guide-threshold-${crypto.randomUUID()}`;
  const provider = new GuideProvider(SHORT_GUIDE);
  try {
    const documents = await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      [finding("A"), finding("B")],
    );
    if (documents !== undefined) {
      throw new Error("a guide was built below the threshold");
    }
    if (provider.requests.length !== 0) {
      throw new Error("AI was asked below the threshold");
    }
  } finally {
    await cleanup(repo);
  }
});

test("the guide is authored and validated", async () => {
  const repo = `guide-author-${crypto.randomUUID()}`;
  const provider = new GuideProvider(SHORT_GUIDE);
  const facts = [
    finding("Require a test for a behavior change."),
    finding("Add the MCP tool for a new route.", { class: "api-mcp" }),
    finding("Add an index for a new array predicate.", { class: "data-cost" }),
  ];
  try {
    const documents = await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      facts,
    );
    if (!documents) throw new Error("no guide was built");
    if (!documents.guide.includes("## Call sites")) {
      throw new Error("the AI method is missing from the guide");
    }
    if (documents.guide.includes("Require a test for a behavior change.")) {
      throw new Error("a raw finding was rendered into the guide");
    }
    if (validateGuide(documents.guide) !== null) {
      throw new Error(
        `the guide is unusable: ${validateGuide(documents.guide)}`,
      );
    }
  } finally {
    await cleanup(repo);
  }
});

test("a long method is split into a short file plus a detailed file", async () => {
  const repo = `guide-split-${crypto.randomUUID()}`;
  const provider = new GuideProvider(LONG_GUIDE, SHORT_GUIDE);
  const facts = [
    finding("Require a test for a behavior change."),
    finding("Add the MCP tool for a new route."),
    finding("Add an index for a new array predicate."),
  ];
  try {
    const documents = await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      facts,
    );
    if (!documents?.detailed) throw new Error("no detailed method was built");
    if (documents.guide.includes("Check behavior 30")) {
      throw new Error("the short file kept the long body");
    }
    const jobs = provider.requests.map((request) => request.job);
    if (!jobs.includes("synth_guide_short")) {
      throw new Error(`the short file was not asked for: ${jobs.join(", ")}`);
    }
  } finally {
    await cleanup(repo);
  }
});
