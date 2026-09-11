import { synthesizeSections } from "./synthesis.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import { testFact } from "../testing/helpers.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

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

Deno.test("current evidence is ordered before historical evidence", async () => {
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

Deno.test("invalid synthesis output is omitted instead of copied", async () => {
  const repo = `fixture-invalid-${crypto.randomUUID()}`;
  const provider = new SynthesisProvider(false);
  try {
    const overrides = await synthesizeSections(
      provider,
      repo,
      [testFact("Run tests before review.", "current", "workflow")],
      undefined,
      "openrouter",
      "fixture",
      3,
    );
    if (overrides.tests !== "") {
      throw new Error("invalid synthesis output was accepted");
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});
