/** What `--with` companions do to a review request. A review without them
 * sends exactly the request it sent before companions existed: the fixture
 * holds the requests of 8c445fb, byte for byte, plus the line that tells
 * the model what a secret mask is. With companions the system
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
  type ReviewOutcome,
  reviewPullRequest,
  reviewWorkspaceRevision,
} from "./reviewer.ts";
import { type Companion, companionSection } from "../review/companions.ts";
import type { ReviewCompanions } from "./companion_tools.ts";
import { numberPatch } from "./hunks.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/review_requests.json");
const PATCH = "@@ -1,1 +1,2 @@\n const a = 1\n+retry()";

type Call = { name: string; arguments: Record<string, unknown> };
const MERMAID: Call = {
  name: "read-mermaid-syntaxes",
  arguments: { tools: ["flowchart"] },
};

/** Answers the first call with tool calls, a Mermaid one unless told
 * otherwise, so the loop makes a second round, and every later call with
 * `answer`. Every request is kept. */
export class RecordingProvider implements AiProvider {
  requests: AiRequest[] = [];
  #calls = 0;
  answer: unknown;
  first: Call[];
  constructor(answer: unknown = { findings: [] }, first: Call[] = [MERMAID]) {
    this.answer = answer;
    this.first = first;
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
        toolCalls: this.first.map((call, index) => ({
          id: `call-${index + 1}`,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
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
  first?: Call[],
): Promise<{ requests: AiRequest[]; outcome: ReviewOutcome }> {
  return await withOptions({}, async (options, root) => {
    const provider = new RecordingProvider(answer, first);
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
    return { requests: provider.requests, outcome };
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

// ------------------------------------------------------------- companions

const DOC_PATCH = [
  "@@ -1,2 +1,4 @@",
  " # API",
  "-Call startSession() before the first request.",
  "+The session opens on the first request.",
  "+Nothing else has to be called first by the extension client code.",
  " The rest is unchanged.",
].join("\n");

function docs(isPrivate = false): Companion {
  return {
    repo: "owner/docs",
    branch: "feature/session",
    private: isPrivate,
    files: [
      {
        path: "docs/api.md",
        previousPath: null,
        status: "modified",
        binary: false,
        additions: 2,
        deletions: 1,
        patch: DOC_PATCH,
      },
    ],
  };
}

const EMPTY: Companion = {
  repo: "owner/vscode-ext",
  branch: "main",
  private: false,
  files: [],
};

const systemOf = (request: AiRequest) =>
  request.system ??
  String(request.messages?.find((m) => m.role === "system")?.content ?? "");
const promptOf = (request: AiRequest) =>
  request.prompt ??
  String(request.messages?.find((m) => m.role === "user")?.content ?? "");
const toolResults = (request: AiRequest | undefined) =>
  (request?.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

const companions = (
  list: Companion[],
  search?: ReviewCompanions["search"],
): Partial<ReviewExtras> => ({
  companions: { list, ...(search ? { search } : {}) },
});

test("with --with the system prompt is the same bytes and only the user prompt gains the COMPANION blocks", async () => {
  const list = [docs(), EMPTY];
  const section = companionSection(list);
  must(
    section ===
      "\n\nCOMPANION blocks list changes in other repositories that belong to this change. They are context. Report findings only on this repository's files, and name the companion file in the body when it is the reason." +
        "\n\nCOMPANION owner/docs · branch feature/session · 1 file changed\nowner/docs:docs/api.md   modified  +2 -1" +
        "\n\nCOMPANION owner/vscode-ext · branch main · no changes on this branch",
    section,
  );
  const plain = (await localRequests()).requests;
  const given = (await localRequests(() => companions(list))).requests;
  must(plain.length === given.length, "the same rounds");
  for (const [i, request] of given.entries()) {
    must(systemOf(request) === systemOf(plain[i]!), `system of round ${i}`);
  }
  const prompt = promptOf(given[0]!);
  must(
    prompt.includes(`"changedFiles":["src/app.ts"]}${section}\n\nDIFF:\n`),
    "the blocks sit after WORKSPACE, before DIFF",
  );
  must(
    prompt.replace(section, "") === promptOf(plain[0]!),
    "only the blocks differ",
  );

  const plainPr = await pullRequests();
  const givenPr = await pullRequests(companions(list));
  must(systemOf(givenPr[0]!) === systemOf(plainPr[0]!), "pull request system");
  must(
    promptOf(givenPr[0]!).replace(section, "") === promptOf(plainPr[0]!),
    "only the blocks differ in a pull request review",
  );
  must(
    promptOf(givenPr[0]!).includes(`"existingReviews":[]}${section}\n\nDIFF:`),
    "the blocks sit after PULL REQUEST, before DIFF",
  );
});

test("read-full-diff reads a companion file by owner/repo:path, with offset and limit", async () => {
  const { requests } = await localRequests(
    () => companions([docs()]),
    undefined,
    [
      {
        name: "read-full-diff",
        arguments: { path: "owner/docs:docs/api.md", offset: 1, limit: 2 },
      },
      { name: "read-full-diff", arguments: { path: "src/app.ts" } },
    ],
  );
  const tool = (requests[0]!.tools ?? []).find(
    (item) =>
      (item as { function?: { name?: string } }).function?.name ===
      "read-full-diff",
  );
  must(Boolean(tool), "read-full-diff is offered for the companion");
  must(
    JSON.stringify(tool).includes("owner/repo:path from a COMPANION block"),
    "its path names companion files",
  );
  const [page, own] = toolResults(requests[1]);
  const lines = numberPatch(DOC_PATCH).split("\n");
  must(
    page ===
      `${lines.slice(1, 3).join("\n")}\n[more: call again with offset=3]`,
    String(page),
  );
  must(
    own ===
      "The whole diff of `src/app.ts` is already shown in the DIFF section.",
    String(own),
  );
});

test("search-non-code takes a repo, this repository by default", async () => {
  const asked: [string, Record<string, unknown>][] = [];
  const { requests } = await localRequests(
    () =>
      companions([docs()], async (repo, args) => {
        asked.push([repo, args]);
        return "docs/api.md:2: startSession";
      }),
    undefined,
    [
      {
        name: "search-non-code",
        arguments: { pattern: "startSession", repo: "owner/docs" },
      },
      { name: "search-non-code", arguments: { pattern: "startSession" } },
      {
        name: "search-non-code",
        arguments: { pattern: "x", repo: "owner/elsewhere" },
      },
    ],
  );
  const tool = JSON.stringify(
    (requests[0]!.tools ?? []).find(
      (item) =>
        (item as { function?: { name?: string } }).function?.name ===
        "search-non-code",
    ),
  );
  must(tool.includes('"repo"'), "the tool has a repo parameter");
  must(
    JSON.stringify(asked) ===
      JSON.stringify([["owner/docs", { pattern: "startSession" }]]),
    JSON.stringify(asked),
  );
  const [companion, own, unknown] = toolResults(requests[1]);
  must(companion === "docs/api.md:2: startSession", String(companion));
  // The temp folder is not a git checkout, so the reviewed tree's own
  // search answers with its error, never with the companion's result.
  must(own !== companion && Boolean(own?.includes("search")), String(own));
  must(
    Boolean(unknown?.includes("no repository owner/elsewhere in this review")),
    String(unknown),
  );
});

const COMPANION_FINDING = {
  severity: "P1",
  blocking: true,
  path: "owner/docs:docs/api.md",
  lineFrom: 2,
  lineTo: 2,
  title: "The docs still describe startSession",
  body: "The companion docs no longer mention startSession, but this change keeps it.",
};

test("a finding placed on a companion file leaves the review text and comes back without a location", async () => {
  const { outcome } = await localRequests(() => companions([docs()]), {
    findings: [
      COMPANION_FINDING,
      {
        severity: "P2",
        path: "src/app.ts",
        lineFrom: 2,
        title: "Retry has no limit",
        body: "The retry loops forever.",
      },
    ],
  });
  must(!outcome.text.includes("owner/docs:"), outcome.text);
  must(outcome.text.includes("Location: `src/app.ts:2`"), "the own finding");
  const moved = outcome.companionFindings ?? [];
  must(moved.length === 1, `${moved.length} moved`);
  must(
    moved[0]!.path === null &&
      moved[0]!.lineFrom === null &&
      moved[0]!.title === "[P1 · blocking] `owner/docs`: `docs/api.md:2`" &&
      moved[0]!.bodyMd === COMPANION_FINDING.body,
    JSON.stringify(moved[0]),
  );
  const alone = await localRequests(() => companions([docs()]), {
    findings: [COMPANION_FINDING],
  });
  must(
    alone.outcome.text.includes("No actionable findings."),
    alone.outcome.text,
  );
});

test("a passage copied from a private companion is removed, a public one's is not", async () => {
  const copied = {
    ...COMPANION_FINDING,
    path: "src/app.ts",
    body: "The docs say nothing else has to be called first by the extension client code anymore.",
  };
  const hidden = await localRequests(() => companions([docs(true)]), {
    findings: [copied],
  });
  must(
    !hidden.outcome.text.includes("called first by the extension client"),
    hidden.outcome.text,
  );
  must(
    hidden.outcome.warnings.some(
      (w) =>
        w.code === "private_text_removed" &&
        w.message.includes("from a private companion"),
    ),
    JSON.stringify(hidden.outcome.warnings),
  );
  const shown = await localRequests(() => companions([docs(false)]), {
    findings: [copied],
  });
  must(
    shown.outcome.text.includes("called first by the extension client"),
    "a public companion is quoted as it is",
  );
});

test("a private companion's search result goes through the copied-passage check", async () => {
  const result =
    "docs/api.md:9: every reviewer must keep this sentence private and unquoted";
  const { outcome } = await localRequests(
    () => companions([docs(true)], async () => result),
    {
      findings: [
        {
          ...COMPANION_FINDING,
          path: "src/app.ts",
          body: "It says every reviewer must keep this sentence private and unquoted.",
        },
      ],
    },
    [
      {
        name: "search-non-code",
        arguments: { pattern: "reviewer", repo: "owner/docs" },
      },
    ],
  );
  must(!outcome.text.includes("keep this sentence private"), outcome.text);
});
