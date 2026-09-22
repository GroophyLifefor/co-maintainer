/** A single pull request's narrative may not become repository policy
 * (CORE-32 / F26b, F26c).
 *
 * F26b: `remake` wrote a "Pull request title and body" section full of
 * `The PR title is "Support weeks in parse and format".` lines, so a pull
 * request still under review was learned as a norm. F26c: the four codebase
 * sections were byte-identical in `SKILL.md` and `CODEBASE.md`, paying for the
 * same guidance twice in a review prompt.
 */
import { test } from "node:test";
import { assembleSkill, codebaseBody } from "./skill.ts";
import { buildReviewDocuments } from "./guide.ts";
import type { Fact } from "./types.ts";

function fact(
  sectionKey: string,
  claim: string,
  origin: Fact["origin"],
  evidence = "PR #7",
): Fact {
  return {
    id: `${sectionKey}:${claim}`,
    sectionKey,
    claim,
    evidence: [evidence],
    weight: 1,
    scope: origin === "pull-request" ? "historical-example" : "current",
    confidence: origin === "pull-request" ? "medium" : "high",
    status: "active",
    origin,
  };
}

async function assemble(facts: Fact[]): Promise<string> {
  const result = await assembleSkill("acme/widgets", facts, undefined, {});
  return result.markdown;
}

test("a pull request's narrative never reaches a normative section", async () => {
  const markdown = await assemble([
    fact(
      "identity",
      "Work in acme/widgets on the `main` default branch.",
      undefined,
    ),
    fact("identity", "PR #7 adds src/app.ts exporting app().", "pull-request"),
    fact("style", "Adds #firstEdge private field.", "pull-request"),
  ]);
  if (!markdown.includes("Work in acme/widgets")) {
    throw new Error(`the repository fact was dropped:\n${markdown}`);
  }
  for (const leaked of ["PR #7 adds", "#firstEdge private field"]) {
    if (markdown.includes(leaked)) {
      throw new Error(
        `a PR narrative reached the skill (${leaked}):\n${markdown}`,
      );
    }
  }
});

test("a fact written before origin existed still counts as repository policy", async () => {
  // Facts persisted by an earlier release have no `origin`; treating those as
  // PR narrative would silently blank every existing guide.
  const legacy = { ...fact("identity", "Legacy repository rule.", undefined) };
  delete legacy.origin;
  const markdown = await assemble([legacy]);
  if (!markdown.includes("Legacy repository rule.")) {
    throw new Error(`a pre-origin fact was dropped:\n${markdown}`);
  }
});

test("review-bar may keep pull request facts", async () => {
  const markdown = await assemble([
    fact("review-bar", "Explain the risk in the pull request.", "pull-request"),
  ]);
  if (!markdown.includes("Explain the risk in the pull request.")) {
    throw new Error(`the review-bar fact was dropped:\n${markdown}`);
  }
});

test("codebase sections link instead of repeating CODEBASE.md", async () => {
  const facts = [
    fact("layout", "`src/cli.js` owns command dispatch.", undefined),
    fact("tests", "Repository tests live under `test/`.", undefined),
  ];
  const markdown = await assemble(facts);
  for (const key of ["layout", "style", "tests", "devloop"]) {
    const heading = markdown.match(
      new RegExp(`## .*\\n\\nSee \\[CODEBASE\\.md\\]\\(CODEBASE\\.md\\)\\.`),
    );
    if (!heading) throw new Error(`no link for ${key}:\n${markdown}`);
  }
  if (markdown.includes("`src/cli.js` owns command dispatch.")) {
    throw new Error(`the skill repeated the codebase text:\n${markdown}`);
  }
  // The text still exists, in the file the skill points at.
  const body = codebaseBody(facts);
  if (!body.includes("`src/cli.js` owns command dispatch.")) {
    throw new Error(`CODEBASE.md lost the text:\n${body}`);
  }
  if (body.includes("[CODEBASE.md](CODEBASE.md)")) {
    throw new Error(`CODEBASE.md linked to itself:\n${body}`);
  }
});

test("the short guide is not stripped of pull request signals", () => {
  const facts = [
    fact(
      "review-bar",
      "Include tests for behavior changes.",
      undefined,
      "review discussion (4 mentions)",
    ),
    fact(
      "review-bar",
      "Update the changelog when the process requires it.",
      undefined,
      "review discussion (3 mentions)",
    ),
    fact("review-bar", "Keep the pull request focused.", "pull-request"),
  ];
  const documents = buildReviewDocuments(facts);
  if (!documents) throw new Error("no review documents were built");
  if (!documents.guide.includes("Keep the pull request focused.")) {
    throw new Error(`the short guide dropped a PR signal:\n${documents.guide}`);
  }
});

test("the detailed guide excludes pull request facts", () => {
  // Enough facts that the detailed guide is actually produced (it only appears
  // above 100 lines).
  const facts = [
    fact(
      "review-bar",
      "Include tests for behavior changes.",
      undefined,
      "review discussion (4 mentions)",
    ),
    fact("review-bar", "Keep the pull request focused.", "pull-request"),
    ...Array.from({ length: 40 }, (_, index) =>
      fact(
        "review-bar",
        `Repository expectation ${index}: verify the affected behavior.`,
        undefined,
        "review discussion (3 mentions)",
      ),
    ),
  ];
  const documents = buildReviewDocuments(facts);
  if (!documents?.detailed) {
    throw new Error("no detailed guide was built");
  }
  if (documents.detailed.includes("Keep the pull request focused.")) {
    throw new Error(
      `the detailed guide kept PR narrative:\n${documents.detailed}`,
    );
  }
  if (!documents.detailed.includes("Include tests for behavior changes.")) {
    throw new Error(
      `the detailed guide dropped the repository rule:\n${documents.detailed}`,
    );
  }
});
