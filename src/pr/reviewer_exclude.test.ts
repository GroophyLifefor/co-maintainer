/** A repository's review exclude pattern, end to end through
 * `reviewPullRequest`: a matching file never reaches any AI request, the
 * review prompt says how many were left out, and the outcome carries the
 * count for the Metadata block. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, setCliInteractive } from "../cli/args.ts";
import { writeRepoConfig } from "../config.ts";
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  GitHubClient,
  Json,
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

class RecordingProvider implements AiProvider {
  requests: AiRequest[] = [];

  complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      text: JSON.stringify({ findings: [] }),
      tokensIn: 1,
      tokensOut: 1,
      provider: "openrouter",
      model: "test",
    });
  }
}

/** No head commit, so scope detection is skipped and no compare call made. */
class FakeClient implements GitHubClient {
  request<T>(): Promise<T> {
    return Promise.resolve({
      number: 1,
      title: "Bump the vendored lib",
      body: "",
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
        {
          filename: "vendor/lib.js",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: "@@ -1,1 +1,2 @@\n var b = 2;\n+vendoredSecretMarker();",
        },
      ] as Json[] as T[]);
    }
    return Promise.resolve([] as T[]);
  }
}

async function review(pattern: string | undefined) {
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
  if (pattern !== undefined) {
    await writeRepoConfig("acme/widgets", { reviewExclude: pattern });
  }
  setCliInteractive(false);
  try {
    const options = {
      ...(await parseArgs([
        "review",
        "acme/widgets",
        "1",
        "--token=test",
        "--low-model=low/model",
        "--high-model=test/model",
      ])),
      useCodegraph: false,
    };
    const provider = new RecordingProvider();
    const result = await reviewPullRequest(
      new FakeClient(),
      options,
      undefined,
      undefined,
      provider,
    );
    return { result, provider };
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

const everything = (requests: AiRequest[]): string =>
  requests.map((request) => JSON.stringify(request)).join("\n");

test("an excluded file reaches no AI request and the prompt says one was left out", async () => {
  const { result, provider } = await review("^vendor/");
  const sent = everything(provider.requests);
  assert.ok(provider.requests.length > 0, "no AI request was made");
  assert.ok(!sent.includes("vendor/lib.js"), "the excluded path was sent");
  assert.ok(
    !sent.includes("vendoredSecretMarker"),
    "the excluded diff was sent",
  );
  assert.ok(sent.includes("src/app.ts"), "the kept file is missing");
  assert.ok(
    sent.includes("EXCLUDED BY THE REPOSITORY: 1 changed file matched"),
    "the prompt does not say a file was left out",
  );
  assert.deepEqual(result.excluded, { count: 1, pattern: "^vendor/" });
});

test("without a pattern every file is reviewed and nothing is noted", async () => {
  const { result, provider } = await review(undefined);
  const sent = everything(provider.requests);
  assert.ok(sent.includes("vendoredSecretMarker"));
  assert.ok(!sent.includes("EXCLUDED BY THE REPOSITORY"));
  assert.equal(result.excluded, undefined);
});
