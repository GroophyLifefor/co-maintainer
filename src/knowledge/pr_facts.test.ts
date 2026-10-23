/** Section bodies are authored by the synthesis job. There is no deterministic
 * fact renderer, so an assembled skill never restates a raw fact, and a single
 * pull request's narrative cannot become repository policy. */
import { test } from "node:test";
import { assembleSkill, codebaseBody } from "./skill.ts";
import type { Fact } from "./types.ts";

function fact(
  sectionKey: string,
  claim: string,
  origin?: Fact["origin"],
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

async function assemble(
  facts: Fact[],
  overrides: Record<string, string> = {},
): Promise<string> {
  const result = await assembleSkill(
    "acme/widgets",
    facts,
    undefined,
    {},
    overrides,
  );
  return result.markdown;
}

test("section text is never rendered from facts", async () => {
  const markdown = await assemble([
    fact("identity", "Work in acme/widgets on the `main` default branch."),
    fact("process", "PR #7 adds src/app.ts exporting app().", "pull-request"),
  ]);
  for (const leaked of [
    "Work in acme/widgets on the `main` default branch.",
    "PR #7 adds",
  ]) {
    if (markdown.includes(leaked)) {
      throw new Error(
        `a fact was rendered into the skill (${leaked}):\n${markdown}`,
      );
    }
  }
});

test("a synthesized override is the only source of a section body", async () => {
  const markdown = await assemble([fact("identity", "Ignore this fact.")], {
    identity: "## Repository\n\n- Keep the API stable.",
  });
  if (!markdown.includes("Keep the API stable.")) {
    throw new Error(`the override was dropped:\n${markdown}`);
  }
  if (markdown.includes("Ignore this fact.")) {
    throw new Error(`a fact leaked past the override:\n${markdown}`);
  }
});

test("a heading-only override omits the section", async () => {
  const markdown = await assemble([fact("identity", "x")], {
    identity: "## Repository",
  });
  if (markdown.includes("## Repository")) {
    throw new Error(`an empty section was kept:\n${markdown}`);
  }
});

test("codebase sections link instead of repeating CODEBASE.md", async () => {
  const markdown = await assemble([
    fact("layout", "`src/cli.js` owns command dispatch."),
  ]);
  if (!markdown.includes("[CODEBASE.md](CODEBASE.md)")) {
    throw new Error(`no CODEBASE.md link:\n${markdown}`);
  }
  if (markdown.includes("`src/cli.js` owns command dispatch.")) {
    throw new Error(
      `the codebase text was repeated in the skill:\n${markdown}`,
    );
  }
});

test("codebaseBody is built from synthesized overrides only", () => {
  const body = codebaseBody({
    layout: "## Code layout\n\n- `src/cli.js` owns command dispatch.",
  });
  if (!body.includes("`src/cli.js` owns command dispatch.")) {
    throw new Error(`CODEBASE.md lost the override:\n${body}`);
  }
  if (body.includes("[CODEBASE.md](CODEBASE.md)")) {
    throw new Error(`CODEBASE.md linked to itself:\n${body}`);
  }
  if (codebaseBody({}).length !== 0) {
    throw new Error("codebaseBody rendered something without overrides");
  }
});
