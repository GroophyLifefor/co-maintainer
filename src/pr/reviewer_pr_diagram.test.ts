/** The pull request review path, which App reviews and `review owner/repo N`
 * use, with each diagram runtime. The default is pinned against the Mermaid
 * wording as it was before the runtime choice existed, so a change to that
 * wording fails here. */
import { test } from "node:test";
import { parseArgs, setCliInteractive } from "../cli/args.ts";
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  GitHubClient,
  Json,
  Options,
} from "../types.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { reviewPullRequest } from "./reviewer.ts";

const MERMAID_SYSTEM_RULES = `People generally find it easier to understand the
problem you've identified when it's presented in diagrams. When a multi-step
flow, lifecycle, dependency, data model, protocol, or architecture change is
part of the finding, you are expected to draw it. Do not skip the diagram
just to avoid the extra tool call. During the initial review, use at most one
diagram, so spend it on the finding that benefits most. If a user later asks
for detailed reasoning in a reply, that reply may use up to five diagrams, but
only when each adds a distinct useful view.
Mermaid selection and minimal syntax:
flowchart = decisions, branches, pipelines, and fallback paths;
swimlane-beta = work crossing owners, actors, services, teams, or layers;
sequenceDiagram = ordered calls, webhooks, retries, responses, and timing;
classDiagram = class, interface, type, inheritance, or composition relationships;
stateDiagram-v2 = lifecycle and state transitions;
erDiagram = database entities, keys, and cardinality;
requirementDiagram = requirements linked to tests or implementation;
usecase-beta = actors and system capabilities;
C4Context = users, systems, boundaries, and integrations;
zenuml = compact nested call sequences;
packet = binary fields, bit ranges, and protocol layout;
architecture-beta = services, containers, storage, and deployment topology;
eventmodeling = commands, events, processors, read models, and timelines;
treeView-beta = directory, file, module, or dependency hierarchy.
If a diagram is useful, call read-mermaid-syntaxes before writing any Mermaid.
Request every type you need in a single call, because repeated tool rounds are
capped. Use the smallest type that matches the evidence.
Do not invent nodes, actors, states, services, tables, or events. Omit the
diagram only when no finding actually fits one of the categories above, or
when the syntax is genuinely uncertain.`;

const MERMAID_PROMPT_RULES = `People generally find it easier to understand the
problem you've identified when it's presented in diagrams. When a finding
involves a multi-step flow, lifecycle, dependency, data model, protocol, or
architecture change, you are expected to include a Mermaid fenced code block
for it. Reading the syntax with read-mermaid-syntaxes first is a small cost,
not a reason to skip the diagram. This review may contain at most one diagram
in total, so if more than one finding qualifies, pick the one the diagram
clarifies most. Its type must be one of the types named in the system
instructions. Keep labels short and grounded in the supplied evidence. A
one-line fix or an obvious, single-step cause and effect genuinely needs no
diagram. That is the only reason to omit one. Close every fenced block.`;

const ROLE = `You are a precise open-source code reviewer.
Evidence must come from the supplied diff and review guide. Keep findings
concise by default.`;

const ANSWER = JSON.stringify({
  findings: [
    {
      severity: "P2",
      blocking: false,
      path: "src/app.ts",
      lineFrom: 2,
      title: "The helper skips the retry",
      body: "The retry never runs.\n\n```plantuml\n@startuml\nClient -> API : request\n@enduml\n```\n",
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

/** Only what `reviewPullRequest` reads. The pull request has no head commit,
 * so scope detection is skipped and no compare call is made. */
class FakeClient implements GitHubClient {
  request<T>(): Promise<T> {
    return Promise.resolve({
      number: 1,
      title: "Retry the call",
      body: "Adds a retry.",
      state: "open",
      base: { ref: "main" },
    } as T);
  }

  pages<T>(endpoint: string): Promise<T[]> {
    if (endpoint.endsWith("/files")) {
      return Promise.resolve([
        {
          filename: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+retry();",
        },
      ] as Json[] as T[]);
    }
    return Promise.resolve([] as T[]);
  }
}

async function withReview(
  extra: Partial<Options>,
  fn: (
    run: () => Promise<{ text: string; provider: RecordingProvider }>,
  ) => Promise<void>,
): Promise<void> {
  const dir = tempDirSync();
  const saved = {
    config: getEnv("CM_CONFIG_PATH"),
    repos: getEnv("CM_REPOS_DIR"),
  };
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
        "1",
        "--token=test",
        "--low-model=low/model",
        "--high-model=test/model",
      ])),
      useCodegraph: false,
      ...extra,
    };
    await fn(async () => {
      const provider = new RecordingProvider();
      const result = await reviewPullRequest(
        new FakeClient(),
        options,
        undefined,
        undefined,
        provider,
      );
      return { text: result.text, provider };
    });
  } finally {
    setCliInteractive(true);
    for (const [name, value] of [
      ["CM_CONFIG_PATH", saved.config],
      ["CM_REPOS_DIR", saved.repos],
    ] as const) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

const toolNames = (request: AiRequest): string[] =>
  ((request.tools ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );

test("the default pull request review keeps the Mermaid wording and tool", async () => {
  await withReview({}, async (run) => {
    const { provider, text } = await run();
    const request = provider.requests[0]!;
    if (!request.system?.startsWith(`${ROLE}\n${MERMAID_SYSTEM_RULES}\n\n`)) {
      throw new Error(`system prompt changed:\n${request.system}`);
    }
    if (!request.prompt.includes(`\n${MERMAID_PROMPT_RULES}\n`)) {
      throw new Error("the review prompt's Mermaid wording changed");
    }
    const names = toolNames(request);
    if (names.length !== 1 || names[0] !== "read-mermaid-syntaxes") {
      throw new Error(`tools: ${names.join(",")}`);
    }
    if ("withoutMermaidTool" in request) {
      throw new Error("a Mermaid request must not carry the PlantUML field");
    }
    if (!text.includes("```plantuml\n@startuml")) throw new Error(text);
  });
});

test("an explicit mermaid runtime sends the same pull request review", async () => {
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
});

test("plantuml-server on a pull request review sends PlantUML wording and no tool", async () => {
  await withReview(
    {
      diagramRuntime: "plantuml-server",
      plantumlServer: "https://uml.example.com",
      plantumlOutputFormat: "png",
      improveMatrix: 2,
    },
    async (run) => {
      const { provider, text } = await run();
      if (provider.requests.length < 2) throw new Error("no improvement pass");
      for (const request of provider.requests) {
        const wording = `${request.system ?? ""}\n${request.prompt}`;
        if (/Mermaid|mermaid/.test(wording)) {
          throw new Error(`Mermaid wording in ${request.job}`);
        }
        if (toolNames(request).length !== 0) {
          throw new Error(`tools in ${request.job}: ${toolNames(request)}`);
        }
        if (!request.system?.includes("PlantUML")) {
          throw new Error(`no PlantUML wording in ${request.job}`);
        }
      }
      const improve = provider.requests.find(
        (request) => request.job === "improve_review",
      )!;
      if (!improve.prompt.includes("```plantuml\n@startuml")) {
        throw new Error("the improvement pass lost the source");
      }
      if (
        !/!\[PlantUML diagram\]\(https:\/\/uml\.example\.com\/png\/[\w-]+\)/.test(
          text,
        )
      ) {
        throw new Error(text);
      }
      if (text.includes("```plantuml")) throw new Error(text);
    },
  );
});

test("plantuml on a pull request review keeps the fenced source", async () => {
  await withReview({ diagramRuntime: "plantuml" }, async (run) => {
    const { provider, text } = await run();
    if (toolNames(provider.requests[0]!).length !== 0) {
      throw new Error("the Mermaid tool is still offered");
    }
    if (!text.includes("```plantuml\n@startuml\nClient -> API : request")) {
      throw new Error(text);
    }
    if (text.includes("![PlantUML diagram]")) throw new Error(text);
  });
});
