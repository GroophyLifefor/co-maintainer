import { test } from "node:test";
import { FILE_BATCH, fileTexts, filesQuery } from "./graphql_files.ts";
import { collectSource } from "./collect.ts";
import { testOptions } from "../testing/helpers.ts";
import { isolateTestFile } from "../testing/locations.ts";
import type { GitHubClient, Json } from "../types.ts";

isolateTestFile();

test("each file is an aliased object of the branch", () => {
  const query = filesQuery("main", ["README.md", "src/a.ts"]);
  if (!query.includes('f0: object(expression: "main:README.md")')) {
    throw new Error(query);
  }
  if (!query.includes('f1: object(expression: "main:src/a.ts")')) {
    throw new Error(query);
  }
});

function client(answer: (index: number) => Json | null, calls: string[][]) {
  const fake: GitHubClient = {
    request: async () => ({}) as never,
    pages: async () => [],
    write: async <T>(_endpoint: string, body: unknown): Promise<T> => {
      const query = String((body as Json).query ?? "");
      const aliases = [...query.matchAll(/(f\d+): object/g)].map((m) => m[1]!);
      calls.push(aliases);
      return {
        data: {
          repository: Object.fromEntries(
            aliases.map((alias) => [alias, answer(Number(alias.slice(1)))]),
          ),
        },
      } as T;
    },
  };
  return fake;
}

test("texts come back by path, and a cut or binary file is left for REST", async () => {
  const calls: string[][] = [];
  const texts = await fileTexts(
    client(
      (index) =>
        index === 0
          ? { text: "hello", isBinary: false, isTruncated: false }
          : index === 1
            ? { text: "cut", isBinary: false, isTruncated: true }
            : index === 2
              ? { text: null, isBinary: true, isTruncated: false }
              : null,
      calls,
    ),
    "o/r",
    "main",
    ["a", "b", "c", "d"],
  );
  if (texts.get("a") !== "hello") throw new Error("text lost");
  if (texts.has("b") || texts.has("c")) throw new Error("kept a partial file");
  if (!texts.has("d") || texts.get("d") !== undefined) {
    throw new Error("a missing file is not known as missing");
  }
});

test("many files are read in batches", async () => {
  const calls: string[][] = [];
  const paths = Array.from({ length: FILE_BATCH + 5 }, (_, i) => `f${i}.ts`);
  await fileTexts(
    client(() => ({ text: "x", isBinary: false, isTruncated: false }), calls),
    "o/r",
    "main",
    paths,
  );
  if (calls.length !== 2 || calls[0]!.length !== FILE_BATCH) {
    throw new Error(JSON.stringify(calls.map((call) => call.length)));
  }
});

test("init reads codebase files from the batch with no contents call", async () => {
  let contents = 0;
  const fake: GitHubClient = {
    request: async <T>(endpoint: string): Promise<T> => {
      if (endpoint === "repos/batch/repo") {
        return { default_branch: "main" } as T;
      }
      if (endpoint.includes("/git/trees/")) {
        return {
          tree: [{ type: "blob", path: "package.json", sha: "s1" }],
        } as T;
      }
      if (endpoint.includes("/contents/")) contents++;
      throw new Error(`unexpected ${endpoint}`);
    },
    pages: async () => [],
    write: async <T>(): Promise<T> =>
      ({
        data: {
          repository: {
            f0: { text: '{"name":"x"}', isBinary: false, isTruncated: false },
          },
        },
      }) as T,
  };
  const source = await collectSource(
    fake,
    testOptions({ repo: "batch/repo", includeCodebase: true }),
  );
  if (contents !== 0) throw new Error(`${contents} contents calls`);
  if (source.files["package.json"] !== '{"name":"x"}') {
    throw new Error(JSON.stringify(source.files));
  }
});
