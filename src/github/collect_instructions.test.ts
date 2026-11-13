import { test } from "node:test";
import { collectSource } from "./collect.ts";
import { testOptions } from "../testing/helpers.ts";
import { withLogSink } from "../util/log.ts";
import type { GitHubClient, Json } from "../types.ts";
import { withIsolatedHome } from "../testing/isolated_home.ts";

/** A name no other test uses, so no cache row is ever shared. */
const REPO = `fixture/instructions-${crypto.randomUUID()}`;

/** A repository with many source files, so the 80-file codebase cap is full,
 * plus instruction files at several depths. */
class InstructionsClient implements GitHubClient {
  contentPaths: string[] = [];
  tree: { path: string; sha: string }[];

  constructor(extra: { path: string; sha: string }[] = []) {
    this.tree = [
      ...Array.from({ length: 120 }, (_, index) => ({
        path: `src/module${index}.ts`,
        sha: `sha-${index}`,
      })),
      { path: "README.md", sha: "sha-readme" },
      { path: "AGENTS.md", sha: "sha-agents" },
      { path: "packages/api/AGENTS.md", sha: "sha-api-agents" },
      { path: "CLAUDE.md", sha: "sha-claude" },
      ...extra,
    ];
  }

  async request<T>(endpoint: string): Promise<T> {
    if (endpoint === `repos/${REPO}`) {
      return { default_branch: "main", full_name: REPO } as T;
    }
    if (endpoint.startsWith(`repos/${REPO}/git/trees/`)) {
      return {
        tree: this.tree.map((item) => ({ type: "blob", ...item })),
      } as T;
    }
    const match = /\/contents\/(.+)\?ref=/.exec(endpoint);
    if (match) {
      const path = match[1].split("/").map(decodeURIComponent).join("/");
      this.contentPaths.push(path);
      return { content: btoa(`content of ${path}\n`) } as T;
    }
    if (endpoint.startsWith(`repos/${REPO}/pulls?`)) {
      const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1);
      if (page > 1) return [] as T;
      return [
        {
          number: 7,
          title: "Merged one",
          state: "closed",
          merged_at: "2026-03-04T10:00:00Z",
          updated_at: new Date().toISOString(),
          head: { sha: "head-7" },
          additions: 1,
          deletions: 1,
          labels: [],
        },
      ] as T;
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  }

  async pages<T>(): Promise<T[]> {
    return [] as T[];
  }
}

async function quietly<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const result = await withIsolatedHome(() =>
    withLogSink(
      (phase, message) => void lines.push(`[${phase}] ${message}`),
      fn,
    ),
  );
  return { result, lines };
}

test("instruction files are read outside the codebase cap and kept out of the codebase files", async () => {
  // Ninety workflows fill the 80-file codebase cap on their own.
  const client = new InstructionsClient(
    Array.from({ length: 90 }, (_, index) => ({
      path: `.github/workflows/w${index}.yml`,
      sha: `sha-w${index}`,
    })),
  );
  const { result: source } = await quietly(() =>
    collectSource(client, testOptions({ repo: REPO })),
  );
  if (Object.keys(source.files).length !== 80) {
    throw new Error(
      `the codebase cap is not full: ${Object.keys(source.files).length}`,
    );
  }
  const instructionPaths = Object.keys(source.instructionFiles ?? {});
  if (instructionPaths.join(",") !== "AGENTS.md,packages/api/AGENTS.md") {
    throw new Error(`instruction files: ${instructionPaths.join(",")}`);
  }
  if (source.instructionFiles?.["AGENTS.md"] !== "content of AGENTS.md\n") {
    throw new Error("the instruction file was not read in full");
  }
  if ("AGENTS.md" in source.files || "CLAUDE.md" in source.files) {
    throw new Error("an instruction file reached the codebase files");
  }
});

test("a custom pattern picks other files and an unchanged blob is not fetched again", async () => {
  const options = testOptions({
    repo: REPO,
    agentInstructions: "(^|/)(AGENTS|CLAUDE)\\.md$",
  });
  const client = new InstructionsClient();
  const { result: first } = await quietly(() => collectSource(client, options));
  if (!first.instructionFiles?.["CLAUDE.md"]) {
    throw new Error("the custom pattern did not read CLAUDE.md");
  }
  const before = client.contentPaths.length;
  const { result: second } = await quietly(() =>
    collectSource(client, options, { source: first } as never),
  );
  if (client.contentPaths.length !== before) {
    throw new Error(
      `fetched again: ${client.contentPaths.slice(before).join(", ")}`,
    );
  }
  if (Object.keys(second.instructionFiles ?? {}).length !== 3) {
    throw new Error("the cached instruction files were not reused");
  }
});

test("with --include-codebase off, or a blank pattern, no instruction file is read", async () => {
  for (const options of [
    testOptions({
      repo: REPO,
      includeCodebase: false,
      includeHowRepoWorks: true,
    }),
    testOptions({ repo: REPO, agentInstructions: "" }),
  ]) {
    const client = new InstructionsClient();
    const { result: source } = await quietly(() =>
      collectSource(client, options),
    );
    if (source.instructionFiles !== undefined) {
      throw new Error(
        `instruction files read: ${JSON.stringify(source.instructionFiles)}`,
      );
    }
    if (client.contentPaths.includes("AGENTS.md")) {
      throw new Error("AGENTS.md was fetched");
    }
  }
});

test("past 50 files the deepest ones are left out and named", async () => {
  const extra = Array.from({ length: 60 }, (_, index) => ({
    path: `deep/pkg${String(index).padStart(2, "0")}/AGENTS.md`,
    sha: `sha-deep-${index}`,
  }));
  const client = new InstructionsClient(extra);
  const { result: source, lines } = await quietly(() =>
    collectSource(client, testOptions({ repo: REPO })),
  );
  const read = Object.keys(source.instructionFiles ?? {});
  if (read.length !== 50 || !read.includes("AGENTS.md")) {
    throw new Error(
      `read ${read.length}, root kept: ${read.includes("AGENTS.md")}`,
    );
  }
  const leftOut = lines.find((line) =>
    line.includes("instruction files left out"),
  );
  if (!leftOut?.includes("deep/pkg59/AGENTS.md (over the 50-file cap)")) {
    throw new Error(`the left-out files are not named: ${leftOut}`);
  }
});

test("a matched file the caps left out is still read by the codebase extraction", async () => {
  const extra = Array.from({ length: 60 }, (_, index) => ({
    path: `pkg${String(index).padStart(2, "0")}/README.md`,
    sha: `sha-readme-${index}`,
  }));
  const client = new InstructionsClient(extra);
  const { result: source } = await quietly(() =>
    collectSource(
      client,
      testOptions({ repo: REPO, agentInstructions: "README\\.md$" }),
    ),
  );
  const asInstructions = Object.keys(source.instructionFiles ?? {});
  if (asInstructions.length !== 50) {
    throw new Error(`read ${asInstructions.length} as instructions`);
  }
  const all = ["README.md", ...extra.map((item) => item.path)];
  const neither = all.filter(
    (path) => !asInstructions.includes(path) && !(path in source.files),
  );
  if (neither.length > 0) {
    throw new Error(`read by neither step: ${neither.join(", ")}`);
  }
  const both = asInstructions.filter((path) => path in source.files);
  if (both.length > 0) {
    throw new Error(`read twice: ${both.join(", ")}`);
  }
});

test("a pull request keeps its merge time from the listing", async () => {
  // The cache rows live in the isolated home, under a name no other test uses.
  const { result: source } = await quietly(() =>
    collectSource(
      new InstructionsClient(),
      testOptions({
        repo: REPO,
        includeCodebase: false,
        includePullRequests: true,
      }),
    ),
  );
  const pr = source.pullRequests[0] as { mergedAt?: string } & Json;
  if (pr?.mergedAt !== "2026-03-04T10:00:00Z") {
    throw new Error(`mergedAt: ${JSON.stringify(pr)}`);
  }
});
