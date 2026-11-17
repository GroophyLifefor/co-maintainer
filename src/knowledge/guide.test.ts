import {
  reviewSignalCount,
  synthesizeReviewGuides,
  validateGuide,
} from "./guide.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import type { Fact } from "./types.ts";
import { test } from "node:test";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

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
    ["an attribution", method([...CHECKS, "Fix it \u2014 Ada · she asked"])],
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

test("guide lines cite numbered findings and code turns them into ids with pull requests", async () => {
  const repo = `guide-ids-${crypto.randomUUID()}`;
  const bracketed = method(
    CHECKS.map((check, index) => `${check} [${(index % 3) + 1}]`),
  );
  const provider = new GuideProvider(bracketed);
  const facts = [
    finding("Require a test for a behavior change.", {
      evidence: ["PR #212", "PR #340"],
      weight: 3,
    }),
    finding("Add the MCP tool for a new route.", {
      evidence: ["PR #198"],
      weight: 2,
    }),
    finding("Add an index for a new array predicate.", {
      evidence: ["repository files"],
    }),
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
    if (!documents?.rules) throw new Error("no rules were returned");
    const prompt = provider.requests[0]?.prompt ?? "";
    // The pull request numbers live outside the prompt in any spelling.
    if (!prompt.includes('"number": 1') || /\b(212|340|198)\b/.test(prompt)) {
      throw new Error("findings are not numbered, or a pull request leaked");
    }
    if (!/\[3, 17\]/.test(prompt)) {
      throw new Error("the prompt does not ask for finding brackets");
    }
    if (/\[\d+\]/.test(documents.guide)) {
      throw new Error(
        `a finding bracket reached the guide:\n${documents.guide}`,
      );
    }
    if (!documents.guide.includes("[R1]")) {
      throw new Error(`no id in the guide:\n${documents.guide}`);
    }
    const byFinding = documents.rules.map(
      (rule) => `${rule.findings.join(",")}=${rule.pullRequests.join(",")}`,
    );
    if (
      byFinding[0] !== "1=212,340" ||
      byFinding[1] !== "2=198" ||
      byFinding[2] !== "3="
    ) {
      throw new Error(`sources: ${byFinding.join(" ")}`);
    }
    if (documents.counts?.[0]?.withIds !== CHECKS.length) {
      throw new Error(`counts: ${JSON.stringify(documents.counts)}`);
    }
  } finally {
    await cleanup(repo);
  }
});

/** Answers each guide job with `text`, marked cut while its `maxTokens` is at
 * or below `cutAt`. */
class CuttingProvider implements AiProvider {
  requests: AiRequest[] = [];
  private readonly cutAt: Record<string, number>;
  private readonly byJob: Record<string, string>;

  constructor(cutAt: Record<string, number>, byJob: Record<string, string>) {
    this.cutAt = cutAt;
    this.byJob = byJob;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    const limit = this.cutAt[request.job];
    const cut = limit !== undefined && (request.maxTokens ?? 0) <= limit;
    return {
      text: this.byJob[request.job] ?? "",
      ...(cut ? { cutOff: true as const } : {}),
      tokensIn: 1,
      tokensOut: 1,
      model: "fixture",
      provider: "openrouter",
    };
  }
}

const THREE = [
  finding("Require a test for a behavior change."),
  finding("Add the MCP tool for a new route."),
  finding("Add an index for a new array predicate."),
];

test("a guide cut at the output limit is asked once more with twice the limit", async () => {
  const repo = `guide-cut-once-${crypto.randomUUID()}`;
  const provider = new CuttingProvider(
    { synth_guide: 16_000 },
    { synth_guide: SHORT_GUIDE },
  );
  try {
    const documents = await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      THREE,
    );
    const limits = provider.requests.map(
      (request) => `${request.job}:${request.maxTokens}`,
    );
    if (
      limits.slice(0, 2).join(",") !== "synth_guide:16000,synth_guide:32000"
    ) {
      throw new Error(`requests: ${limits.join(",")}`);
    }
    if (!documents?.guide.includes("Review method")) {
      throw new Error("the second, complete answer was not used");
    }
  } finally {
    await cleanup(repo);
  }
});

test("a guide cut twice is not written, so the last run's guide stays", async () => {
  const repo = `guide-cut-twice-${crypto.randomUUID()}`;
  const provider = new CuttingProvider(
    { synth_guide: 32_000 },
    { synth_guide: SHORT_GUIDE },
  );
  try {
    const documents = await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      THREE,
    );
    if (documents !== undefined) {
      throw new Error("a guide cut twice was returned to be written");
    }
    if (provider.requests.length !== 2) {
      throw new Error(`${provider.requests.length} calls, expected 2`);
    }
  } finally {
    await cleanup(repo);
  }
});

test("a short guide cut twice keeps both files of the last run", async () => {
  const repo = `guide-short-cut-${crypto.randomUUID()}`;
  const provider = new CuttingProvider(
    { synth_guide_short: 16_000 },
    { synth_guide: LONG_GUIDE, synth_guide_short: SHORT_GUIDE },
  );
  try {
    const documents = await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      THREE,
    );
    const limits = provider.requests.map(
      (request) => `${request.job}:${request.maxTokens}`,
    );
    if (
      limits.join(",") !==
      "synth_guide:16000,synth_guide_short:8000,synth_guide_short:16000"
    ) {
      throw new Error(`requests: ${limits.join(",")}`);
    }
    if (documents !== undefined) {
      throw new Error("a cut short guide was returned to be written");
    }
  } finally {
    await cleanup(repo);
  }
});

const EDIT_GUIDE = `# Checklist

Check these.

## Tests

- Require a test for a behavior change · regressions hide otherwise [R1]
- Add the MCP tool for a new route · the parity test fails otherwise [R2]

**Exit check:** tests and tools are there.
`;

class EditProvider implements AiProvider {
  requests: AiRequest[] = [];
  answerFor?: (prompt: string) => string;
  private readonly answer: string;
  constructor(answer: string) {
    this.answer = answer;
  }
  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    return {
      text: this.answerFor ? this.answerFor(request.prompt) : this.answer,
      tokensIn: 1,
      tokensOut: 1,
      model: "fixture",
      provider: "openrouter",
    };
  }
}

const EDIT_RULES = {
  R1: { file: "PR_REVIEW_GUIDE.md", text: "a", sources: [{ pr: 21 }] },
  R2: { file: "PR_REVIEW_GUIDE.md", text: "b", sources: [{ pr: 22 }] },
};

const OLD_THREE = [
  finding("Require a test for a behavior change.", { evidence: ["PR #21"] }),
  finding("Add the MCP tool for a new route.", { evidence: ["PR #22"] }),
  finding("Add an index for a new array predicate.", { evidence: ["PR #23"] }),
];

test("an edit sync sends only the new finding and keeps every other guide line", async () => {
  const repo = `guide-edit-${crypto.randomUUID()}`;
  // Like a real model, the answer cites the number the prompt gave the new
  // finding. Findings are numbered by how often they recur.
  const provider = new EditProvider("");
  provider.answerFor = (prompt) => {
    const added = JSON.parse(
      prompt.split("NEW FINDINGS:\n")[1]!.split("\n\nGONE FINDINGS:")[0]!,
    ) as { number: number }[];
    return JSON.stringify({
      add: [
        {
          pass: "Tests",
          rule: `Drain writes before shutdown · a dropped write is lost [${added[0]!.number}]`,
        },
      ],
      change: [],
      remove: [],
    });
  };
  const facts = [
    ...OLD_THREE,
    finding("Drain writes before shutdown.", { evidence: ["PR #24"] }),
  ];
  const outcome: { mode?: "full" | "edit" | "unchanged" } = {};
  try {
    const documents = await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      facts,
      undefined,
      undefined,
      {
        guide: EDIT_GUIDE,
        rules: EDIT_RULES,
        findings: OLD_THREE.map((item) => item.claim.toLowerCase()),
      },
      outcome,
    );
    const jobs = provider.requests.map((request) => request.job);
    if (jobs.join(",") !== "edit_guide" || outcome.mode !== "edit") {
      throw new Error(`calls ${jobs.join(",")} · mode ${outcome.mode}`);
    }
    const prompt = provider.requests[0]!.prompt;
    if (
      !prompt.includes("Drain writes") ||
      prompt.includes('"rule": "Add an index')
    ) {
      throw new Error("the edit prompt did not send only the new finding");
    }
    for (const line of [
      "- Require a test for a behavior change · regressions hide otherwise [",
      "- Add the MCP tool for a new route · the parity test fails otherwise [",
      "- Drain writes before shutdown · a dropped write is lost [",
    ]) {
      if (!documents?.guide.includes(line)) {
        throw new Error(`missing ${line}\n${documents?.guide}`);
      }
    }
    const byText = new Map(
      (documents?.rules ?? []).map((rule) => [rule.text.split(" · ")[0], rule]),
    );
    if (
      byText
        .get("Require a test for a behavior change")
        ?.pullRequests.join() !== "21"
    ) {
      throw new Error("a kept rule lost its pull request");
    }
    if (
      byText.get("Drain writes before shutdown")?.pullRequests.join() !== "24"
    ) {
      throw new Error(
        `the new rule did not get its pull request: ${JSON.stringify(documents?.rules)}`,
      );
    }
  } finally {
    await cleanup(repo);
  }
});

test("an edit sync with the same findings makes no call and keeps the guide", async () => {
  const repo = `guide-same-${crypto.randomUUID()}`;
  const provider = new EditProvider("{}");
  const outcome: { mode?: "full" | "edit" | "unchanged" } = {};
  try {
    const documents = await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      OLD_THREE,
      undefined,
      undefined,
      {
        guide: EDIT_GUIDE,
        rules: EDIT_RULES,
        findings: OLD_THREE.map((item) => item.claim.toLowerCase()),
      },
      outcome,
    );
    if (provider.requests.length !== 0 || outcome.mode !== "unchanged") {
      throw new Error(`${provider.requests.length} calls · ${outcome.mode}`);
    }
    if (documents?.rules?.length !== 2) {
      throw new Error(`${documents?.rules?.length} rules kept`);
    }
  } finally {
    await cleanup(repo);
  }
});

test("an edit answer that does not fit rewrites the guide in full", async () => {
  const repo = `guide-fallback-${crypto.randomUUID()}`;
  let calls = 0;
  const provider: AiProvider = {
    async complete(request) {
      calls++;
      return {
        text:
          request.job === "edit_guide"
            ? JSON.stringify({ add: [], change: [], remove: ["R99"] })
            : SHORT_GUIDE,
        tokensIn: 1,
        tokensOut: 1,
        model: "fixture",
        provider: "openrouter",
      };
    },
  };
  const outcome: { mode?: "full" | "edit" | "unchanged" } = {};
  try {
    await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      [...OLD_THREE, finding("Drain writes before shutdown.")],
      undefined,
      undefined,
      {
        guide: EDIT_GUIDE,
        rules: EDIT_RULES,
        findings: OLD_THREE.map((item) => item.claim.toLowerCase()),
      },
      outcome,
    );
    if (outcome.mode !== "full" || calls < 2) {
      throw new Error(`mode ${outcome.mode} after ${calls} calls`);
    }
  } finally {
    await cleanup(repo);
  }
});

test("a changed sync at the full-rewrite count rewrites, an unchanged one keeps the guide", async () => {
  const repo = `guide-count-${crypto.randomUUID()}`;
  const input = {
    guide: EDIT_GUIDE,
    rules: EDIT_RULES,
    findings: OLD_THREE.map((item) => item.claim.toLowerCase()),
    rewriteIfChanged: true,
  };
  try {
    const same = new EditProvider("{}");
    const kept: { mode?: "full" | "edit" | "unchanged" } = {};
    await synthesizeReviewGuides(
      same,
      repo,
      "openrouter",
      "fixture",
      1,
      OLD_THREE,
      undefined,
      undefined,
      input,
      kept,
    );
    if (kept.mode !== "unchanged" || same.requests.length !== 0) {
      throw new Error(
        `unchanged sync: ${kept.mode} after ${same.requests.length} calls`,
      );
    }
    const changed = new EditProvider(SHORT_GUIDE);
    const full: { mode?: "full" | "edit" | "unchanged" } = {};
    await synthesizeReviewGuides(
      changed,
      repo,
      "openrouter",
      "fixture",
      1,
      [...OLD_THREE, finding("Drain writes before shutdown.")],
      undefined,
      undefined,
      input,
      full,
    );
    if (full.mode !== "full" || changed.requests[0]?.job !== "synth_guide") {
      throw new Error(
        `changed sync: ${full.mode}, first call ${changed.requests[0]?.job}`,
      );
    }
  } finally {
    await cleanup(repo);
  }
});

test("a guide too long to send is rewritten in full, not edited", async () => {
  const repo = `guide-long-${crypto.randomUUID()}`;
  const provider = new EditProvider(SHORT_GUIDE);
  const outcome: { mode?: "full" | "edit" | "unchanged" } = {};
  try {
    await synthesizeReviewGuides(
      provider,
      repo,
      "openrouter",
      "fixture",
      1,
      [...OLD_THREE, finding("Drain writes before shutdown.")],
      undefined,
      undefined,
      {
        guide: `${EDIT_GUIDE}${"\n- filler line".repeat(9000)}`,
        rules: EDIT_RULES,
        findings: OLD_THREE.map((item) => item.claim.toLowerCase()),
      },
      outcome,
    );
    if (
      outcome.mode !== "full" ||
      provider.requests.some((r) => r.job === "edit_guide")
    ) {
      throw new Error(`mode ${outcome.mode}`);
    }
  } finally {
    await cleanup(repo);
  }
});
