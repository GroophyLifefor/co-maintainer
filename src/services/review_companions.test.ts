/** Companion pull requests in App review (issue 81). A repository without
 * the `companions` setting sends exactly the model request and the GitHub
 * calls it sent on 5b7471b: the fixture holds them, byte for byte. */
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { insertJob } from "../store/jobs.ts";
import { runReviewJob } from "./review.ts";
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  GitHubClient,
  Json,
} from "../types.ts";
import type { JobRow } from "../store/rows.ts";
import {
  deleteEnv,
  getEnv,
  mkdirPath,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { offlineEnv } from "../testing/offline_env.ts";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

const FIXTURE = join(import.meta.dirname, "fixtures/app_review_requests.json");
const REPO = "acme/widgets";
const PATCH = "@@ -1,1 +1,2 @@\n const a = 1\n+retry()";

export async function withAppEnv(fn: () => Promise<void>): Promise<void> {
  const saved = ["CM_APP_DB", "CM_REPOS_DIR", "CM_CONFIG_PATH"].map(
    (name) => [name, getEnv(name)] as const,
  );
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  const offline = offlineEnv(dir);
  await mkdirPath(`${dir}/repos/${REPO}`, { recursive: true });
  await writeTextFile(
    `${dir}/repos/${REPO}/PR_REVIEW_GUIDE.md`,
    "# guide\nKeep helpers honest.\n",
  );
  try {
    await openAppDb();
    await fn();
    if (offline.fetched.length) {
      throw new Error(
        `the test used the network: ${offline.fetched.join(", ")}`,
      );
    }
  } finally {
    await closeAppDb();
    offline.restore();
    await removePath(dir, { recursive: true });
    for (const [name, value] of saved) {
      if (value === undefined) deleteEnv(name);
      else setEnv(name, value);
    }
  }
}

/** GitHub for one pull request of acme/widgets. Every call is kept, in
 * order, as `METHOD endpoint`. */
export class RecordingGithub implements GitHubClient {
  calls: string[] = [];
  body = "Adds a retry.";
  headRef = "feature/retry";

  request<T>(endpoint: string): Promise<T> {
    this.calls.push(`GET ${endpoint}`);
    if (endpoint === `repos/${REPO}/pulls/1`) {
      return Promise.resolve({
        number: 1,
        title: "Retry the call",
        body: this.body,
        state: "open",
        head: { sha: "head1", ref: this.headRef },
        base: { sha: "base1", ref: "main" },
      } as T);
    }
    return Promise.reject(new Error(`unexpected request ${endpoint}`));
  }

  pages<T>(endpoint: string): Promise<T[]> {
    this.calls.push(`PAGES ${endpoint}`);
    if (endpoint === `repos/${REPO}/pulls/1/files`) {
      return Promise.resolve([
        {
          filename: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: PATCH,
        },
      ] as T[]);
    }
    return Promise.resolve([]);
  }

  write<T>(endpoint: string): Promise<T> {
    this.calls.push(`POST ${endpoint}`);
    return Promise.resolve({ id: 1000 + this.calls.length } as T);
  }

  createCheckRun<T>(endpoint: string): Promise<T> {
    this.calls.push(`POST ${endpoint}`);
    return Promise.resolve({ id: 9001 } as T);
  }

  updateCheckRun<T>(endpoint: string): Promise<T> {
    this.calls.push(`PATCH ${endpoint}`);
    return Promise.resolve({ id: 9001 } as T);
  }
}

/** Answers every request with no findings and keeps each one. */
export class RecordingAi implements AiProvider {
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

export function seedJob(id = "job-rev"): JobRow {
  activateRepo(REPO, 7);
  markKnowledgeBuilt(REPO, "head1");
  insertJob({
    id,
    type: "review",
    repo: REPO,
    prNumber: 1,
    args: { trigger: "manual" },
  });
  return {
    id,
    type: "review",
    repo: REPO,
    pr_number: 1,
    status: "running",
    args: JSON.stringify({ trigger: "manual" }),
    delivery_id: null,
    queue_key: null,
    attempt: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    superseded_by: null,
    cancel_reason: null,
  };
}

/** What a run sent: the GitHub calls in order and every model request. The
 * posted bodies are left out, since their Metadata block holds a duration. */
function shape(github: RecordingGithub, ai: RecordingAi): Json {
  return {
    calls: github.calls,
    requests: ai.requests as unknown as Json[],
  };
}

test("an App review without the companions setting sends exactly the request and GitHub calls it sent on 5b7471b", async () => {
  let now: Json = {};
  await withAppEnv(async () => {
    const github = new RecordingGithub();
    github.body = "Adds a retry.\n\nCompanion: acme/docs#4";
    const ai = new RecordingAi();
    await runReviewJob(seedJob(), () => {}, github, ai);
    now = shape(github, ai);
  });
  if (process.env.CM_WRITE_REVIEW_FIXTURE === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const a = JSON.stringify(now, null, 2);
  const b = JSON.stringify(JSON.parse(readFileSync(FIXTURE, "utf8")), null, 2);
  if (a !== b) {
    const lines = a.split("\n");
    const old = b.split("\n");
    const at = lines.findIndex((line, i) => line !== old[i]);
    throw new Error(
      `App review changed at line ${at + 1}:\nnow: ${lines[at]}\nwas: ${old[at]}`,
    );
  }
});
