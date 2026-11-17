/** The GitHub side of `/co-maintainer skip-this-commit` and
 * `/co-maintainer skip-this-pr`, against a recording GitHub. */
import { test } from "node:test";
import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo } from "../store/repos.ts";
import { getJob, insertJob } from "../store/jobs.ts";
import { insertReview, setReviewStatus } from "../store/reviews.ts";
import { prReviewsOff, setPrReviewsOff } from "../store/subjects.ts";
import {
  ALREADY_OFF_TEXT,
  nothingToSkipText,
  reviewsOffText,
  reviewsOnText,
  runSkipJob,
  skippedCommitText,
  type SkipJobArgs,
} from "./skip_commands.ts";
import type { GitHubClient, Json } from "../types.ts";
import { deleteEnv, getEnv, setEnv, tempDirSync } from "../testing/runtime.ts";
import { isolateTestFile } from "../testing/locations.ts";

isolateTestFile();

const HEAD = "a".repeat(40);

async function withTempDb(fn: () => Promise<void>): Promise<void> {
  const original = getEnv("CM_APP_DB");
  setEnv("CM_APP_DB", `${tempDirSync()}/app.db`);
  try {
    await openAppDb();
    activateRepo("acme/widgets", 7);
    await fn();
  } finally {
    await closeAppDb();
    if (original === undefined) deleteEnv("CM_APP_DB");
    else setEnv("CM_APP_DB", original);
  }
}

class RecordingGithub implements GitHubClient {
  comments: string[] = [];
  patches: { endpoint: string; body: string }[] = [];
  checks: Json[] = [];

  request<T>(): Promise<T> {
    return Promise.resolve({ number: 3, head: { sha: HEAD } } as T);
  }
  pages<T>(): Promise<T[]> {
    return Promise.resolve([]);
  }
  write<T>(_endpoint: string, body: unknown): Promise<T> {
    this.comments.push(String((body as Json).body));
    return Promise.resolve({ id: 1 } as T);
  }
  patch<T>(endpoint: string, body: unknown): Promise<T> {
    this.patches.push({ endpoint, body: String((body as Json).body) });
    return Promise.resolve({} as T);
  }
  createCheckRun<T>(_endpoint: string, body: unknown): Promise<T> {
    this.checks.push(body as Json);
    return Promise.resolve({ id: 5 } as T);
  }
}

function skipJob(args: SkipJobArgs) {
  const id = crypto.randomUUID();
  insertJob({ id, type: "skip", repo: "acme/widgets", prNumber: 3, args });
  return getJob(id)!;
}

function review(status: string, note?: string): void {
  const id = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  insertJob({ id: jobId, type: "review", repo: "acme/widgets", prNumber: 3 });
  insertReview({
    id,
    repo: "acme/widgets",
    prNumber: 3,
    jobId,
    headSha: HEAD,
    baseSha: "b".repeat(40),
    scope: "full",
    model: "m",
  });
  setReviewStatus(id, status, note ? { note_comment_id: note } : {});
}

test("skip-this-commit on a failed review: a skipped check, and the failed note says so", async () => {
  await withTempDb(async () => {
    review("failed", "4242");
    const github = new RecordingGithub();
    await runSkipJob(
      skipJob({ command: "skip-this-commit", by: "owner" }),
      () => {},
      github,
    );
    const check = github.checks[0];
    if (check?.conclusion !== "skipped" || check.head_sha !== HEAD) {
      throw new Error(JSON.stringify(github.checks));
    }
    const text = skippedCommitText(HEAD, "owner");
    if (
      github.patches[0]?.endpoint !==
        "repos/acme/widgets/issues/comments/4242" ||
      github.patches[0].body !== text
    ) {
      throw new Error(JSON.stringify(github.patches));
    }
    if (github.comments.length !== 0)
      throw new Error("a second comment was posted");
    if (!text.includes("`aaaaaaa`") || !text.includes("`@owner`")) {
      throw new Error(text);
    }
  });
});

test("skip-this-commit when the review did not fail: nothing is skipped", async () => {
  await withTempDb(async () => {
    review("posted");
    const github = new RecordingGithub();
    await runSkipJob(
      skipJob({ command: "skip-this-commit", by: "owner" }),
      () => {},
      github,
    );
    if (github.checks.length !== 0) throw new Error("a check was skipped");
    if (github.comments[0] !== nothingToSkipText(HEAD)) {
      throw new Error(JSON.stringify(github.comments));
    }
  });
});

test("skip-this-pr turns reviews off once, with a skipped check and one reply", async () => {
  await withTempDb(async () => {
    const github = new RecordingGithub();
    await runSkipJob(
      skipJob({ command: "skip-this-pr", by: "owner" }),
      () => {},
      github,
    );
    if (prReviewsOff("acme/widgets", 3)?.by !== "owner") {
      throw new Error("reviews are not off");
    }
    if (github.checks[0]?.conclusion !== "skipped") {
      throw new Error(JSON.stringify(github.checks));
    }
    if (github.comments[0] !== reviewsOffText("owner")) {
      throw new Error(JSON.stringify(github.comments));
    }
    await runSkipJob(
      skipJob({ command: "skip-this-pr", by: "owner" }),
      () => {},
      github,
    );
    if (github.comments[1] !== ALREADY_OFF_TEXT || github.checks.length !== 1) {
      throw new Error(JSON.stringify(github.comments));
    }
  });
});

test("a new commit while reviews are off gets a skipped check, turning them on gets a reply", async () => {
  await withTempDb(async () => {
    setPrReviewsOff("acme/widgets", 3, "owner");
    const github = new RecordingGithub();
    await runSkipJob(
      skipJob({ command: "pr-off", by: "owner", headSha: "c".repeat(40) }),
      () => {},
      github,
    );
    if (
      github.checks[0]?.conclusion !== "skipped" ||
      github.checks[0].head_sha !== "c".repeat(40)
    ) {
      throw new Error(JSON.stringify(github.checks));
    }
    await runSkipJob(
      skipJob({ command: "reviews-on", by: "owner" }),
      () => {},
      github,
    );
    if (github.comments[0] !== reviewsOnText("owner")) {
      throw new Error(JSON.stringify(github.comments));
    }
  });
});

test("every reply is free of the em dash and the semicolon", () => {
  for (const text of [
    skippedCommitText(HEAD, "owner"),
    nothingToSkipText(HEAD),
    reviewsOffText("owner"),
    ALREADY_OFF_TEXT,
    reviewsOnText("owner"),
  ]) {
    if (
      text.includes(String.fromCharCode(0x2014)) ||
      text.includes(String.fromCharCode(59))
    ) {
      throw new Error(text);
    }
  }
});
