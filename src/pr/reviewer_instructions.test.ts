/** A review sends `INSTRUCTIONS.md` inside the cached system prompt, and a
 * repository without it sends the same system prompt as before. */
import { test } from "node:test";
import { reviewWorkspaceRevision } from "./reviewer.ts";
import { testOptions } from "../testing/helpers.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import { mkdir, writeTextFile } from "../util/runtime.ts";
import { withIsolatedHome } from "../testing/isolated_home.ts";

class Recorder implements AiProvider {
  supportsTools = false;
  requests: AiRequest[] = [];
  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    return {
      text: '{"findings":[]}',
      tokensIn: 1,
      tokensOut: 1,
      model: "fixture",
      provider: "openrouter",
    };
  }
}

const REPO = `acme/review-${crypto.randomUUID()}`;

async function systemPrompt(files: Record<string, string>): Promise<string> {
  return withIsolatedHome(async (root) => {
    const dir = `${root}/repos/${REPO}`;
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeTextFile(`${dir}/${name}`, body);
    }
    const provider = new Recorder();
    await reviewWorkspaceRevision(
      {
        files: [
          {
            path: "src/app.ts",
            previousPath: null,
            status: "modified",
            binary: false,
            additions: 1,
            deletions: 0,
            patch: "@@ -1,1 +1,2 @@\n line\n+added\n",
          },
        ],
        title: "",
        description: "",
        baseLabel: "main",
        producer: "local",
      },
      testOptions({ repo: REPO, ai: "openrouter" }),
      "head",
      undefined,
      provider,
    );
    return provider.requests[0]?.system ?? "";
  });
}

test("a review's system prompt carries INSTRUCTIONS.md and never RULES.json", async () => {
  const base = {
    "PR_REVIEW_GUIDE.md": "# Guide\n\n- Check it · it breaks\n",
  };
  const without = await systemPrompt(base);
  const withFile = await systemPrompt({
    ...base,
    "INSTRUCTIONS.md":
      "# Repository instructions\n\n- Format amounts with `formatMoney()`. [I1]\n",
    "RULES.json":
      '{"schemaVersion":1,"builtAt":"2026-11-13","rules":{"I1":{"file":"INSTRUCTIONS.md","text":"x","sources":[{"path":"docs/SOURCE_ONLY.md","line":4}]}}}',
  });
  if (without.includes("REPOSITORY INSTRUCTIONS")) {
    throw new Error("a repository without the file got the section");
  }
  if (
    !withFile.includes("REPOSITORY INSTRUCTIONS:") ||
    !withFile.includes("[I1]")
  ) {
    throw new Error(`the instructions are missing:\n${withFile}`);
  }
  if (withFile.includes("SOURCE_ONLY")) {
    throw new Error("a source from RULES.json reached the prompt");
  }
});
