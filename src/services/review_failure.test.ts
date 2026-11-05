import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { getJob, insertJob } from "../store/jobs.ts";
import {
  getReviewByJobId,
  listReviewsForPr,
  reviewStats,
} from "../store/reviews.ts";
import { listFindingsForReview } from "../store/findings.ts";
import { GitHubHttpError } from "../github/client.ts";
import { FakeAiProvider } from "../ai/fake.ts";
import { enqueueManualReview, runReviewJob } from "./review.ts";
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
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

const REVIEW_NOTE_START = "co-maintainer couldn't review this push";
const REVIEWED_NOTE = "co-maintainer reviewed this push; the review is below.";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const originalDb = getEnv("CM_APP_DB");
  const originalRepos = getEnv("CM_REPOS_DIR");
  const originalConfig = getEnv("CM_CONFIG_PATH");
  const dir = tempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  await mkdirPath(`${dir}/repos/acme/widgets`, { recursive: true });
  await writeTextFile(
    `${dir}/repos/acme/widgets/PR_REVIEW_GUIDE.md`,
    "# guide\nKeep helpers honest.\n",
  );
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (originalDb === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", originalDb);
    if (originalRepos === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", originalRepos);
    if (originalConfig === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", originalConfig);
  }
}

class ThrowingProvider implements AiProvider {
  private readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
  complete(_request: AiRequest): Promise<AiResponse> {
    return Promise.reject(new Error(this.message));
  }
}

class EmptyCostProvider implements AiProvider {
  private readonly cost: number | undefined;
  constructor(cost: number | undefined) {
    this.cost = cost;
  }
  complete(_request: AiRequest): Promise<AiResponse> {
    return Promise.resolve({
      text: "   ",
      tokensIn: 11,
      tokensOut: 1,
      cost: this.cost,
      model: "fake",
      provider: "openrouter",
    });
  }
}

class FakeGithub implements GitHubClient {
  writes: { endpoint: string; body: unknown }[] = [];
  checkCreates: { endpoint: string; body: unknown }[] = [];
  checkUpdates: { endpoint: string; body: unknown }[] = [];
  files: Json[] = [{ filename: "src/app.ts", patch: "@@ -4 +4 @@" }];
  writeError: Error | undefined;
  reviewWriteError: Error | undefined;

  request<T>(endpoint: string): Promise<T> {
    if (endpoint.includes("/pulls/1") && !endpoint.includes("/files")) {
      return Promise.resolve({
        title: "Change",
        body: "",
        state: "open",
        head: { sha: "head1" },
        base: { sha: "base1", ref: "main" },
      } as T);
    }
    throw new Error(`unexpected request ${endpoint}`);
  }

  pages<T>(endpoint: string): Promise<T[]> {
    if (endpoint.includes("/files")) return Promise.resolve(this.files as T[]);
    return Promise.resolve([] as T[]);
  }

  write<T>(endpoint: string, body: unknown): Promise<T> {
    if (this.writeError) return Promise.reject(this.writeError);
    if (this.reviewWriteError && endpoint.includes("/reviews")) {
      return Promise.reject(this.reviewWriteError);
    }
    this.writes.push({ endpoint, body });
    return Promise.resolve({ id: 1000 + this.writes.length } as T);
  }

  createCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    this.checkCreates.push({ endpoint, body });
    return Promise.resolve({ id: 9001 } as T);
  }

  updateCheckRun<T>(endpoint: string, body: unknown): Promise<T> {
    this.checkUpdates.push({ endpoint, body });
    return Promise.resolve({ id: 9001 } as T);
  }
}

function noteCreates(github: FakeGithub) {
  return github.writes.filter((w) => /\/issues\/1\/comments$/.test(w.endpoint));
}

function noteEdits(github: FakeGithub) {
  return github.writes.filter((w) =>
    /\/issues\/comments\/\d+$/.test(w.endpoint),
  );
}

function reviewPosts(github: FakeGithub) {
  return github.writes.filter((w) => w.endpoint.endsWith("/pulls/1/reviews"));
}

function noteBody(write: { body: unknown }): string {
  return String((write.body as { body?: unknown }).body ?? "");
}

function seed(jobId = "job-rev"): JobRow {
  activateRepo("acme/widgets", 7);
  markKnowledgeBuilt("acme/widgets", "head1");
  insertJob({
    id: jobId,
    type: "review",
    repo: "acme/widgets",
    prNumber: 1,
    args: { trigger: "opened" },
  });
  return getJob(jobId)!;
}

function sinceIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

async function runFailing(
  github: FakeGithub,
  ai: AiProvider,
  job = seed(),
): Promise<Error> {
  try {
    await runReviewJob(job, () => {}, github, ai);
  } catch (error) {
    return error as Error;
  }
  throw new Error("the failing review did not throw");
}

test("an empty AI answer is recorded as a failed review, not a successful review with zero findings", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    await runFailing(github, new FakeAiProvider(""));

    const review = getReviewByJobId("job-rev");
    if (!review) throw new Error("the attempt left no review row");
    if (review.status !== "failed") {
      throw new Error(`expected a failed review, got ${review.status}`);
    }
    if (review.findings_count !== 0) {
      throw new Error(`findings_count ${review.findings_count}`);
    }
    if (listFindingsForReview(review.id).length !== 0) {
      throw new Error("an empty answer produced findings");
    }
    if (reviewStats(sinceIso(), "acme/widgets").failed !== 1) {
      throw new Error("the failed attempt did not reach the failed tally");
    }
    if (
      listReviewsForPr("acme/widgets", 1).some((row) => row.status === "posted")
    ) {
      throw new Error("an empty answer was counted as a posted review");
    }
  });
});

test("the provider's own error message is preserved on the failed attempt", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const error = await runFailing(
      github,
      new ThrowingProvider("reasoning budget exhausted"),
    );
    if (!error.message.includes("reasoning budget exhausted")) {
      throw new Error(
        `the failure result dropped the reason: ${error.message}`,
      );
    }
    const review = getReviewByJobId("job-rev");
    const result = `${error.message} ${review?.status ?? ""}`;
    if (!result.includes("reasoning budget exhausted")) {
      throw new Error(
        `the failure result does not carry the reason: ${result}`,
      );
    }
    if (review?.status !== "failed") {
      throw new Error(`the attempt is not failed: ${review?.status}`);
    }
  });
});

test("a failed review posts exactly one PR note with the dashboard job link, and no provider body or retry command", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    await runFailing(
      github,
      new ThrowingProvider("reasoning budget exhausted"),
    );
    const notes = noteCreates(github);
    if (notes.length !== 1) {
      throw new Error(`expected one PR note, got ${notes.length}`);
    }
    const body = noteBody(notes[0]!);
    if (!body.startsWith(REVIEW_NOTE_START)) {
      throw new Error(`unexpected failure note: ${body}`);
    }
    if (!body.includes("job-rev") || !body.includes("/activity/job-rev")) {
      throw new Error(`the note does not link the dashboard job: ${body}`);
    }
    if (body.includes("reasoning budget exhausted")) {
      throw new Error(`the note leaked the provider message: ${body}`);
    }
    if (/retry/i.test(body)) {
      throw new Error(`the note carries a retry command: ${body}`);
    }
  });
});

test("retrying the same push starts a new attempt without a second PR note, and a successful retry edits the same note and posts the review", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    await runFailing(
      github,
      new ThrowingProvider("reasoning budget exhausted"),
    );
    const firstNotes = noteCreates(github);
    const noteId = getReviewByJobId("job-rev")?.note_comment_id;
    if (firstNotes.length !== 1 || !noteId) {
      throw new Error(
        `the first attempt left the wrong note set: ${JSON.stringify(firstNotes)}`,
      );
    }

    const retry = enqueueManualReview("acme/widgets", 1);
    if (retry.id === "job-rev") {
      throw new Error("the retry reused the first job id");
    }
    const retryJob = getJob(retry.id);
    if (!retryJob) throw new Error("the retry did not create a job");

    await runReviewJob(retryJob, () => {}, github, new FakeAiProvider());

    if (listReviewsForPr("acme/widgets", 1).length !== 2) {
      throw new Error("the retry did not add a second attempt");
    }
    const retryReview = getReviewByJobId(retry.id);
    if (retryReview?.head_sha !== "head1") {
      throw new Error(
        `the retry is not the same push: ${retryReview?.head_sha}`,
      );
    }
    if (noteCreates(github).length !== 1) {
      throw new Error("the retry opened a second PR note");
    }
    const edits = noteEdits(github);
    if (edits.length !== 1) {
      throw new Error(`the existing note was not edited: ${edits.length}`);
    }
    if (noteBody(edits[0]!) !== REVIEWED_NOTE) {
      throw new Error(`unexpected retry note: ${noteBody(edits[0]!)}`);
    }
    if (reviewPosts(github).find((w) => w.body === undefined)) {
      throw new Error("the retry did not post a review");
    }
    if (reviewPosts(github).length !== 1) {
      throw new Error("the retry did not post exactly one review");
    }
  });
});

test("a check run for a failed attempt is neutral or failure, never success", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    await runFailing(github, new ThrowingProvider("model broke"));
    const completed = github.checkUpdates
      .map((item) => item.body as Json)
      .filter((body) => body.status === "completed");
    if (completed.length === 0) {
      throw new Error("the failed attempt completed no check run");
    }
    for (const check of completed) {
      if (check.conclusion === "success") {
        throw new Error(
          `a failed attempt posted a successful check: ${JSON.stringify(check)}`,
        );
      }
      if (check.conclusion !== "failure" && check.conclusion !== "neutral") {
        throw new Error(`unexpected check conclusion ${check.conclusion}`);
      }
    }
  });
});

test("the failed attempt cost is recorded and an unknown cost is not stored as zero", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    await runFailing(github, new EmptyCostProvider(0.004));
    const review = getReviewByJobId("job-rev");
    if (review?.cost_status !== "known" || review.cost !== 0.004) {
      throw new Error(
        `the failed cost was not recorded: status=${review?.cost_status} cost=${review?.cost}`,
      );
    }
  });

  await withEnv(async () => {
    const github = new FakeGithub();
    await runFailing(github, new EmptyCostProvider(undefined));
    const review = getReviewByJobId("job-rev");
    if (review?.cost_status !== "unknown" || review.cost !== null) {
      throw new Error(
        `an unknown cost was stored as a number: status=${review?.cost_status} cost=${review?.cost}`,
      );
    }
  });
});

test("a GitHub 403 on the review post keeps the AI result and cost, marks the review not posted, and posts no note claiming it was posted", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    github.reviewWriteError = new GitHubHttpError(
      403,
      "Resource not accessible",
    );
    let threw = false;
    try {
      await runReviewJob(seed(), () => {}, github, new FakeAiProvider());
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("the rejected post did not surface");

    const review = getReviewByJobId("job-rev");
    if (!review) throw new Error("the attempt left no review row");
    if (listFindingsForReview(review.id).length !== 1) {
      throw new Error("the AI result was lost when GitHub rejected the post");
    }
    if (review.cost_status !== "known" || review.cost !== 0) {
      throw new Error(
        `the AI cost was lost: status=${review.cost_status} cost=${review.cost}`,
      );
    }
    if (review.posted_review_id !== null || review.status === "posted") {
      throw new Error("the review was recorded as posted after a 403");
    }
    if (review.status === "failed") {
      throw new Error(
        "a valid review whose post was rejected is not an AI failure",
      );
    }
    for (const write of noteCreates(github)) {
      if (/reviewed this push/i.test(noteBody(write))) {
        throw new Error(
          `a PR note claimed the review was posted: ${noteBody(write)}`,
        );
      }
    }
  });
});
