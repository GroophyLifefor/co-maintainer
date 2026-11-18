/** What `--with` companions do to a review request. A review without them
 * sends exactly the request it sent before companions existed: the fixture
 * holds the requests of 8c445fb, byte for byte. With companions the system
 * prompt stays the same bytes and only the user prompt gains the COMPANION
 * blocks. */
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, setCliInteractive } from "../cli/args.ts";
import type { Revision } from "../review/revision.ts";
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  GitHubClient,
  Json,
  Options,
} from "../types.ts";
import { withIsolatedHome } from "../testing/isolated_home.ts";
import { mkdirPath, writeTextFile } from "../testing/runtime.ts";
import {
  type ReviewExtras,
  reviewPullRequest,
  reviewWorkspaceRevision,
} from "./reviewer.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/review_requests.json");
const PATCH = "@@ -1,1 +1,2 @@\n const a = 1\n+retry()";

/** Answers the first call with a Mermaid tool call, so the loop makes a second
 * round, and every later call with `answer`. Every request is kept. */
export class RecordingProvider implements AiProvider {
  requests: AiRequest[] = [];
  #calls = 0;
  answer: unknown;
  constructor(answer: unknown = { findings: [] }) {
    this.answer = answer;
  }

  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    this.#calls++;
    const base = {
      tokensIn: 1,
      tokensOut: 1,
      provider: "openrouter" as const,
      model: "test",
    };
    if (this.#calls === 1) {
      return Promise.resolve({
        ...base,
        text: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "read-mermaid-syntaxes",
              arguments: JSON.stringify({ tools: ["flowchart"] }),
            },
          },
        ],
      });
    }
    return Promise.resolve({ ...base, text: JSON.stringify(this.answer) });
  }
}

export function revision(): Revision {
  return {
    title: "",
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
        patch: PATCH,
      },
    ],
  };
}

export class FakeClient implements GitHubClient {
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
          patch: PATCH,
        },
      ] as Json[] as T[]);
    }
    return Promise.resolve([] as T[]);
  }
}

/** Runs `fn` in an isolated home that holds a guide for acme/widgets. */
export async function withOptions<T>(
  extra: Partial<Options>,
  fn: (options: Options, root: string) => Promise<T>,
): Promise<T> {
  return await withIsolatedHome(async (root) => {
    await mkdirPath(`${root}/repos/acme/widgets`, { recursive: true });
    await writeTextFile(
      `${root}/repos/acme/widgets/PR_REVIEW_GUIDE.md`,
      "Review small changes.",
    );
    setCliInteractive(false);
    try {
      return await fn(
        {
          ...(await parseArgs([
            "review",
            "acme/widgets",
            "--token=test",
            "--low-model=low/model",
            "--high-model=test/model",
          ])),
          useCodegraph: false,
          ...extra,
        },
        root,
      );
    } finally {
      setCliInteractive(true);
    }
  });
}

/** A local review whose tools search the tree at the isolated home, and every
 * request it made. `extras` adds to what local review hands the engine. */
export async function localRequests(
  extras: (root: string) => Partial<ReviewExtras> = () => ({}),
  answer?: unknown,
): Promise<{ requests: AiRequest[]; text: string; outcome: unknown }> {
  return await withOptions({}, async (options, root) => {
    const provider = new RecordingProvider(answer);
    const outcome = await reviewWorkspaceRevision(
      revision(),
      options,
      "abc123",
      undefined,
      provider,
      undefined,
      {
        catchesUp: true,
        tools: { kind: "tree", root, codegraph: [], mcp: false },
        ...extras(root),
      },
    );
    return { requests: provider.requests, text: outcome.text, outcome };
  });
}

/** A pull request review, and every request it made. */
export async function pullRequests(
  extras: Partial<ReviewExtras> = {},
): Promise<AiRequest[]> {
  return await withOptions({ prNumber: 1 }, async (options) => {
    const provider = new RecordingProvider();
    await reviewPullRequest(
      new FakeClient(),
      options,
      undefined,
      undefined,
      provider,
      undefined,
      // No checkout: the tools come from the diff plan alone.
      { catchesUp: true, ...extras },
    );
    return provider.requests;
  });
}

/** The requests in the fixture's shape. */
async function baseline(): Promise<Record<string, AiRequest[]>> {
  return {
    local: (await localRequests()).requests,
    pull: await pullRequests(),
  };
}

test("a review without --with sends exactly the requests it sent on 8c445fb", async () => {
  const now = await baseline();
  if (process.env.CM_WRITE_REVIEW_FIXTURE === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const before = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
    string,
    AiRequest[]
  >;
  for (const mode of ["local", "pull"]) {
    const a = JSON.stringify(now[mode], null, 2);
    const b = JSON.stringify(before[mode], null, 2);
    if (a !== b) {
      const lines = a.split("\n");
      const old = b.split("\n");
      const at = lines.findIndex((line, i) => line !== old[i]);
      throw new Error(
        `${mode} request changed at line ${at + 1}:\nnow: ${lines[at]}\nwas: ${old[at]}`,
      );
    }
  }
});
