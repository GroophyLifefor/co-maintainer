/** A review sends `INSTRUCTIONS.md` inside the cached system prompt, and a
 * repository without it sends the same system prompt as before. */
import { test } from "node:test";
import { reviewWorkspaceRevision } from "./reviewer.ts";
import { testOptions } from "../testing/helpers.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  mkdir,
  remove,
  setEnv,
  writeTextFile,
} from "../util/runtime.ts";

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

async function systemPrompt(files: Record<string, string>): Promise<string> {
  const root = await makeTempDir({ prefix: "cm-review-instructions-" });
  const previous = getEnv("CM_REPOS_DIR");
  setEnv("CM_REPOS_DIR", root);
  try {
    const dir = `${root}/acme/widgets`;
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
      testOptions({ repo: "acme/widgets", ai: "openrouter" }),
      "head",
      undefined,
      provider,
    );
    return provider.requests[0]?.system ?? "";
  } finally {
    if (previous === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", previous);
    await remove(root, { recursive: true });
  }
}

test("a review's system prompt carries INSTRUCTIONS.md and never RULES.json", async () => {
  const base = {
    "PR_REVIEW_GUIDE.md": "# Guide\n\n- Check it · it breaks [R1]\n",
  };
  const without = await systemPrompt(base);
  const withFile = await systemPrompt({
    ...base,
    "INSTRUCTIONS.md":
      "# Repository instructions\n\n- Format amounts with `formatMoney()`. [I1]\n",
    "RULES.json":
      '{"schemaVersion":1,"builtAt":"2026-11-13","rules":{"R1":{"file":"PR_REVIEW_GUIDE.md","text":"x","sources":[{"pr":212,"mergedAt":"2026-01-20"}]}}}',
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
  if (withFile.includes("2026-01-20") || withFile.includes("#212")) {
    throw new Error("a source from RULES.json reached the prompt");
  }
});
