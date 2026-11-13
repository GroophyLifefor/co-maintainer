/** What a review asks the model, and what it hands back, for each diagram
 * runtime. */
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "../cli/args.ts";
import type { Revision } from "../review/revision.ts";
import type { AiProvider, AiRequest, AiResponse, Options } from "../types.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { MERMAID_GUIDANCE, reviewWorkspaceRevision } from "./reviewer.ts";

const ANSWER = JSON.stringify({
  findings: [
    {
      severity: "P2",
      blocking: false,
      path: "src/app.ts",
      lineFrom: 2,
      title: "The helper skips the retry",
      body: "The retry never runs.\n\n```plantuml\n@startuml\nClient -> API : request\nAPI --> Client : response\n@enduml\n```\n",
    },
  ],
});

class RecordingProvider implements AiProvider {
  requests: AiRequest[] = [];

  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      text: ANSWER,
      tokensIn: 1,
      tokensOut: 1,
      provider: "openrouter",
      model: "test",
    });
  }
}

const REVISION: Revision = {
  title: "Change",
  description: "",
  baseLabel: "main",
  producer: "local",
  files: [
    {
      path: "src/app.ts",
      previousPath: null,
      status: "modified",
      binary: false,
      additions: 1,
      deletions: 0,
      patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+retry();",
    },
  ],
};

async function withReview(
  extra: Partial<Options>,
  fn: (
    run: () => Promise<{ text: string; provider: RecordingProvider }>,
  ) => Promise<void>,
): Promise<void> {
  const dir = tempDirSync();
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const originalRepos = getEnv("CM_REPOS_DIR");
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  await mkdirPath(`${dir}/repos/acme/widgets`, { recursive: true });
  await writeTextFile(
    `${dir}/repos/acme/widgets/PR_REVIEW_GUIDE.md`,
    "Review small changes.",
  );
  setCliInteractive(false);
  try {
    const options: Options = {
      ...(await parseArgs([
        "review",
        "acme/widgets",
        "--token=test",
        "--low-model=low/model",
        "--high-model=test/model",
      ])),
      useCodegraph: false,
      ...extra,
    };
    await fn(async () => {
      const provider = new RecordingProvider();
      const result = await reviewWorkspaceRevision(
        REVISION,
        options,
        "abc123",
        undefined,
        provider,
      );
      return { text: result.text, provider };
    });
  } finally {
    setCliInteractive(true);
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
    if (originalRepos === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", originalRepos);
  }
}

const toolNames = (request: AiRequest): string[] =>
  ((request.tools ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );

const wording = (request: AiRequest): string =>
  `${request.system ?? ""}\n${request.prompt}`;

test("mermaid, set or not, sends exactly the same request", async () => {
  let plain: AiRequest | undefined;
  await withReview({}, async (run) => {
    plain = (await run()).provider.requests[0];
  });
  await withReview({ diagramRuntime: "mermaid" }, async (run) => {
    const explicit = (await run()).provider.requests[0];
    if (JSON.stringify(explicit) !== JSON.stringify(plain)) {
      throw new Error("an explicit mermaid runtime changed the request");
    }
  });
  if (!plain) throw new Error("no request");
  if (!plain.system?.includes(MERMAID_GUIDANCE)) {
    throw new Error("the Mermaid guidance is gone from the system prompt");
  }
  if (!plain.prompt.includes("include a Mermaid fenced code block")) {
    throw new Error("the Mermaid review wording is gone from the prompt");
  }
  if (!toolNames(plain).includes("read-mermaid-syntaxes")) {
    throw new Error(`tools: ${toolNames(plain).join(",")}`);
  }
  if ("withoutMermaidTool" in plain) {
    throw new Error("a Mermaid request must not carry the PlantUML field");
  }
});

test("mermaid leaves a PlantUML fence in the review as written", async () => {
  await withReview({}, async (run) => {
    const { text } = await run();
    if (!text.includes("```plantuml\n@startuml")) throw new Error(text);
  });
});

for (const runtime of ["plantuml", "plantuml-server"] as const) {
  test(`${runtime} asks for PlantUML and never mentions Mermaid`, async () => {
    await withReview({ diagramRuntime: runtime }, async (run) => {
      const { provider } = await run();
      const request = provider.requests[0]!;
      const text = wording(request);
      if (!text.includes("PlantUML") || !text.includes("@startuml")) {
        throw new Error("the model is not asked for PlantUML");
      }
      if (/Mermaid|mermaid/.test(text)) {
        throw new Error("Mermaid wording is still in the request");
      }
      if (toolNames(request).includes("read-mermaid-syntaxes")) {
        throw new Error("the Mermaid tool is still offered");
      }
      if (!request.system?.includes("Review small changes.")) {
        throw new Error("the guide block is gone");
      }
    });
  });
}

test("plantuml keeps the fenced source in the review", async () => {
  await withReview({ diagramRuntime: "plantuml" }, async (run) => {
    const { text } = await run();
    if (!text.includes("```plantuml\n@startuml\nClient -> API : request")) {
      throw new Error(text);
    }
    if (text.includes("![PlantUML diagram]")) throw new Error(text);
  });
});

test("plantuml-server turns the diagram into an image link", async () => {
  await withReview(
    {
      diagramRuntime: "plantuml-server",
      plantumlServer: "https://uml.example.com",
      plantumlOutputFormat: "png",
    },
    async (run) => {
      const { text } = await run();
      if (
        !/!\[PlantUML diagram\]\(https:\/\/uml\.example\.com\/png\/[\w-]+\)/.test(
          text,
        )
      ) {
        throw new Error(text);
      }
      if (text.includes("```plantuml")) throw new Error(text);
      if (!text.includes("The retry never runs.")) throw new Error(text);
    },
  );
});

test("an improvement pass is shown the source, not the link", async () => {
  await withReview(
    { diagramRuntime: "plantuml-server", improveMatrix: 2 },
    async (run) => {
      const { provider, text } = await run();
      const improve = provider.requests.find(
        (request) => request.job === "improve_review",
      );
      if (!improve) throw new Error("no improvement request");
      if (!improve.prompt.includes("```plantuml")) {
        throw new Error("the draft lost its PlantUML source");
      }
      if (improve.prompt.includes("plantuml.com/plantuml/svg")) {
        throw new Error("the draft was already turned into a link");
      }
      if (!text.includes("![PlantUML diagram](")) throw new Error(text);
    },
  );
});
