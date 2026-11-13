/** A reply uses the repository's diagram runtime too. */
import { test } from "node:test";
import { writeUserConfig } from "../config.ts";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo } from "../store/repos.ts";
import { createReplyRequestAndJob } from "../store/replies.ts";
import { getJob } from "../store/jobs.ts";
import { runReplyJob } from "./replies.ts";
import type { AiProvider, AiRequest, GitHubClient, Json } from "../types.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

async function withEnv(
  runtime: "plantuml" | "plantuml-server" | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = {
    db: getEnv("CM_APP_DB"),
    repos: getEnv("CM_REPOS_DIR"),
    config: getEnv("CM_CONFIG_PATH"),
  };
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  await mkdirPath(`${dir}/repos/acme/widgets`, { recursive: true });
  await writeTextFile(
    `${dir}/repos/acme/widgets/PR_REVIEW_GUIDE.md`,
    "Answer review questions from the supplied code.",
  );
  if (runtime) {
    await writeUserConfig({
      repos: {
        "acme/widgets": {
          diagramRuntime: runtime,
          plantumlServer: "https://uml.example.com",
        },
      },
    });
  }
  try {
    await openAppDb();
    activateRepo("acme/widgets", 7);
    await fn();
  } finally {
    await closeAppDb();
    for (const [name, value] of [
      ["CM_APP_DB", saved.db],
      ["CM_REPOS_DIR", saved.repos],
      ["CM_CONFIG_PATH", saved.config],
    ] as const) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

class FakeGithub implements GitHubClient {
  writes: { endpoint: string; body: unknown }[] = [];

  request<T>(): Promise<T> {
    return Promise.resolve({
      number: 1,
      title: "Change",
      body: "Please review this change.",
      head: { sha: "head1" },
    } as T);
  }

  pages<T>(): Promise<T[]> {
    return Promise.resolve([] as T[]);
  }

  write<T>(endpoint: string, body: unknown): Promise<T> {
    this.writes.push({ endpoint, body });
    return Promise.resolve({ id: 900 } as T);
  }
}

const ANSWER =
  "Here is the flow.\n\n```plantuml\n@startuml\nClient -> API : request\n@enduml\n```\n";

async function reply(): Promise<{ request: AiRequest; posted: string }> {
  const seen: AiRequest[] = [];
  const ai: AiProvider = {
    complete: (request) => {
      seen.push(structuredClone(request));
      return Promise.resolve({
        text: ANSWER,
        tokensIn: 1,
        tokensOut: 1,
        model: "fake",
        provider: "openrouter",
      });
    },
  };
  const github = new FakeGithub();
  const result = createReplyRequestAndJob({
    repo: "acme/widgets",
    prNumber: 1,
    sourceKind: "issue_comment",
    sourceCommentId: "201",
    sourceBody: "Can you draw the flow?",
    sourceAuthor: "octocat",
  });
  await runReplyJob(getJob(result.request.job_id!)!, () => {}, github, ai);
  const body = (github.writes[0]!.body as Json).body;
  return { request: seen[0]!, posted: String(body) };
}

const toolNames = (request: AiRequest): string[] =>
  ((request.tools ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );

test("a reply keeps the Mermaid wording and tool by default", async () => {
  await withEnv(undefined, async () => {
    const { request, posted } = await reply();
    if (!request.system?.includes("Use zero Mermaid diagrams")) {
      throw new Error(request.system);
    }
    if (!toolNames(request).includes("read-mermaid-syntaxes")) {
      throw new Error(toolNames(request).join(","));
    }
    if (!posted.includes("```plantuml")) throw new Error(posted);
  });
});

test("a plantuml reply asks for PlantUML and keeps the source", async () => {
  await withEnv("plantuml", async () => {
    const { request, posted } = await reply();
    if (!request.system?.includes("Use zero PlantUML diagrams")) {
      throw new Error(request.system);
    }
    if (/Mermaid/.test(request.system)) throw new Error(request.system);
    if (toolNames(request).includes("read-mermaid-syntaxes")) {
      throw new Error("the Mermaid tool is still offered");
    }
    if (!posted.includes("```plantuml\n@startuml")) throw new Error(posted);
  });
});

test("a plantuml-server reply is posted with an image link", async () => {
  await withEnv("plantuml-server", async () => {
    const { posted } = await reply();
    if (
      !/!\[PlantUML diagram\]\(https:\/\/uml\.example\.com\/svg\/[\w-]+\)/.test(
        posted,
      )
    ) {
      throw new Error(posted);
    }
    if (posted.includes("```plantuml")) throw new Error(posted);
    if (!posted.includes("Here is the flow.")) throw new Error(posted);
  });
});
