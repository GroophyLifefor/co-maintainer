import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { insertJob } from "../store/jobs.ts";
import {
  getReviewByJobId,
  insertReview,
  setReviewStatus,
} from "../store/reviews.ts";
import {
  insertFinding,
  listFindingsForReview,
  setFindingPosted,
} from "../store/findings.ts";
import { GitHubHttpError } from "../github/client.ts";
import { FakeAiProvider } from "../ai/fake.ts";
import {
  humanCopy,
  reconcileReview,
  reviewBody,
  runReviewJob,
} from "./review.ts";
import type { GitHubClient, Json } from "../types.ts";
import type { JobRow } from "../store/rows.ts";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const originalDb = Deno.env.get("CM_APP_DB");
  const originalRepos = Deno.env.get("CM_REPOS_DIR");
  const originalConfig = Deno.env.get("CM_CONFIG_PATH");
  const dir = Deno.makeTempDirSync();
  Deno.env.set("CM_APP_DB", `${dir}/app.db`);
  Deno.env.set("CM_REPOS_DIR", `${dir}/repos`);
  Deno.env.set("CM_CONFIG_PATH", `${dir}/config.json`);
  await Deno.mkdir(`${dir}/repos/acme/widgets`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/repos/acme/widgets/PR_REVIEW_GUIDE.md`,
    "# guide\nKeep helpers honest.\n",
  );
  try {
    await openAppDb();
    await fn();
  } finally {
    await closeAppDb();
    if (originalDb === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", originalDb);
    if (originalRepos === undefined) Deno.env.delete("CM_REPOS_DIR");
    else Deno.env.set("CM_REPOS_DIR", originalRepos);
    if (originalConfig === undefined) Deno.env.delete("CM_CONFIG_PATH");
    else Deno.env.set("CM_CONFIG_PATH", originalConfig);
  }
}

class FakeGithub implements GitHubClient {
  writes: { endpoint: string; body: unknown }[] = [];
  checkCreates: { endpoint: string; body: unknown }[] = [];
  checkUpdates: { endpoint: string; body: unknown }[] = [];
  listedReviews: Json[] = [];
  files: Json[] = [{ filename: "src/app.ts", patch: "@@ -4 +4 @@" }];
  filesError?: Error;
  writeError?: Error;
  compareError?: Error;

  request<T>(endpoint: string): Promise<T> {
    if (endpoint.includes("/compare/")) {
      if (this.compareError) return Promise.reject(this.compareError);
      return Promise.resolve({ files: this.files } as T);
    }
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
    if (this.filesError && endpoint.includes("/files")) {
      return Promise.reject(this.filesError);
    }
    if (endpoint.includes("/files")) return Promise.resolve(this.files as T[]);
    if (endpoint.includes("/comments")) return Promise.resolve([]);
    if (endpoint.includes("/reviews")) {
      return Promise.resolve(this.listedReviews as T[]);
    }
    return Promise.resolve([]);
  }

  write<T>(endpoint: string, body: unknown): Promise<T> {
    if (this.writeError) return Promise.reject(this.writeError);
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

function seed(): JobRow {
  activateRepo("acme/widgets", 7);
  markKnowledgeBuilt("acme/widgets", "head1");
  insertJob({
    id: "job-rev",
    type: "review",
    repo: "acme/widgets",
    prNumber: 1,
    args: { trigger: "opened" },
  });
  return {
    id: "job-rev",
    type: "review",
    repo: "acme/widgets",
    pr_number: 1,
    status: "running",
    args: JSON.stringify({ trigger: "opened" }),
    delivery_id: null,
    queue_key: null,
    attempt: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    superseded_by: null,
  };
}

Deno.test("fake AI markdown becomes findings rows and a GitHub review POST", async () => {
  await withEnv(async () => {
    const job = seed();
    const github = new FakeGithub();
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const review = getReviewByJobId("job-rev");
    if (review?.status !== "posted" || review.posted_review_id !== "1001") {
      throw new Error(`unexpected review ${JSON.stringify(review)}`);
    }
    const findings = listFindingsForReview(review.id);
    if (findings.length !== 1 || findings[0].path !== "src/app.ts") {
      throw new Error(`unexpected findings ${JSON.stringify(findings)}`);
    }
    const posted = github.writes[0];
    if (!posted.endpoint.endsWith("/pulls/1/reviews")) {
      throw new Error(`posted ${posted.endpoint}`);
    }
    const body = posted.body as {
      event: string;
      commit_id: string;
      body: string;
      comments: { path: string; line: number; body: string }[];
    };
    if (body.event !== "REQUEST_CHANGES" || body.commit_id !== "head1") {
      throw new Error(`payload ${JSON.stringify(body)}`);
    }
    if (
      !body.body.includes("Review summary") ||
      !body.body.includes("The helper ignores its argument")
    ) {
      throw new Error(`review body ${body.body}`);
    }
    if (
      body.comments[0]?.path !== "src/app.ts" || body.comments[0]?.line !== 4
    ) {
      throw new Error(`inline ${JSON.stringify(body.comments)}`);
    }
    if (body.comments[0].body.includes("## Findings")) {
      throw new Error(`inline dump ${body.comments[0].body}`);
    }
    if (
      !body.comments[0].body.includes(
        "The helper ignores its argument, so the new behavior is never applied.",
      ) ||
      !body.comments[0].body.includes(
        "If you'd like me to explain it in more detail, please ask.",
      )
    ) {
      throw new Error(`inline finding was truncated ${body.comments[0].body}`);
    }
    if (JSON.stringify(posted.body).includes(";")) {
      throw new Error("posted review body used a semicolon");
    }
  });
});

Deno.test("review checks use annotations and the conclusion matrix", async () => {
  await withEnv(async () => {
    const findingsGithub = new FakeGithub();
    await runReviewJob(seed(), () => {}, findingsGithub, new FakeAiProvider());
    const created = findingsGithub.checkCreates[0]?.body as Json;
    if (created.status !== "queued" || created.head_sha !== "head1") {
      throw new Error(`unexpected check creation ${JSON.stringify(created)}`);
    }
    const completed = findingsGithub.checkUpdates.find((item) =>
      (item.body as Json).status === "completed"
    )?.body as Json;
    const output = completed.output as Json;
    const annotations = output.annotations as Json[];
    if (completed.conclusion !== "neutral" || annotations.length !== 1) {
      throw new Error(
        `unexpected finding check ${JSON.stringify(completed)}`,
      );
    }
    if (
      annotations[0].path !== "src/app.ts" ||
      annotations[0].start_line !== 4 ||
      annotations[0].annotation_level !== "warning"
    ) {
      throw new Error(`unexpected annotation ${JSON.stringify(annotations)}`);
    }
  });

  await withEnv(async () => {
    const clearGithub = new FakeGithub();
    await runReviewJob(
      seed(),
      () => {},
      clearGithub,
      new FakeAiProvider("## Findings\n\nNo actionable findings.\n"),
    );
    const clearCompleted = clearGithub.checkUpdates.find((item) =>
      (item.body as Json).status === "completed"
    )?.body as Json;
    if (clearCompleted.conclusion !== "success") {
      throw new Error(
        `unexpected clear check ${JSON.stringify(clearCompleted)}`,
      );
    }
  });
});

Deno.test("a failed review completes its check with failure", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const failingAi = {
      complete: () => Promise.reject(new Error("model broke")),
    };
    let threw = false;
    try {
      await runReviewJob(seed(), () => {}, github, failingAi);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("failed review did not throw");
    const completed = github.checkUpdates.find((item) =>
      (item.body as Json).status === "completed"
    )?.body as Json;
    if (completed.conclusion !== "failure") {
      throw new Error(`unexpected failed check ${JSON.stringify(completed)}`);
    }
  });
});

Deno.test("a 422 on inline comments falls back to one issue comment", async () => {
  await withEnv(async () => {
    const job = seed();
    const github = new FakeGithub();
    github.write = async (endpoint, body) => {
      github.writes.push({ endpoint, body });
      if (endpoint.includes("/reviews")) {
        throw new GitHubHttpError(422, "invalid line");
      }
      return { id: 55 } as never;
    };
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const review = getReviewByJobId("job-rev");
    if (review?.status !== "posted" || review.posted_fallback !== 1) {
      throw new Error(`expected fallback, got ${JSON.stringify(review)}`);
    }
    if (!github.writes.some((write) => write.endpoint.includes("/issues/"))) {
      throw new Error("did not post an issue comment");
    }
  });
});

Deno.test("denied pull request files post one comment and access_denied", async () => {
  await withEnv(async () => {
    const job = seed();
    const github = new FakeGithub();
    github.filesError = new GitHubHttpError(403, "Resource not accessible");
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const review = getReviewByJobId("job-rev");
    if (review?.status !== "access_denied" || review.posted_fallback !== 1) {
      throw new Error(`expected access_denied, got ${JSON.stringify(review)}`);
    }
    const write = github.writes[0];
    if (!write.endpoint.includes("/issues/1/comments")) {
      throw new Error(`posted ${write.endpoint}`);
    }
    const body = (write.body as { body: string }).body;
    if (body.includes("\u2014") || body.includes(";")) {
      throw new Error("access denied copy used a dash or semicolon");
    }
  });
});

Deno.test("reconcile after a crash between posting and posted does not post again", async () => {
  await withEnv(async () => {
    const job = seed();
    const github = new FakeGithub();
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const review = getReviewByJobId("job-rev")!;
    const { setReviewStatus } = await import("../store/reviews.ts");
    setReviewStatus(review.id, "posting");
    github.listedReviews = [{
      id: 42,
      commit_id: "head1",
      user: { type: "Bot" },
    }];
    const writesBefore = github.writes.length;
    await reconcileReview(job, () => {}, github);
    if (github.writes.length !== writesBefore) {
      throw new Error("reconcile posted again");
    }
    if (getReviewByJobId("job-rev")?.posted_review_id !== "42") {
      throw new Error("did not take the existing GitHub review id");
    }
  });
});

Deno.test("zero findings post COMMENT with a short body", async () => {
  await withEnv(async () => {
    const job = seed();
    const github = new FakeGithub();
    await runReviewJob(
      job,
      () => {},
      github,
      new FakeAiProvider("## Findings\n\nNo actionable findings.\n"),
    );
    const posted = github.writes[0].body as {
      event: string;
      body: string;
      comments: unknown[];
    };
    if (posted.event !== "COMMENT") {
      throw new Error(`event ${posted.event}`);
    }
    if (posted.body !== "No actionable findings.") {
      throw new Error(`body ${posted.body}`);
    }
    if (posted.comments.length !== 0) {
      throw new Error(`comments ${JSON.stringify(posted.comments)}`);
    }
  });
});

Deno.test("findings outside the diff stay on the review body", async () => {
  await withEnv(async () => {
    const job = seed();
    const github = new FakeGithub();
    github.files = [{ filename: "README.md", patch: "@@ -1 +1 @@" }];
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const posted = github.writes[0].body as {
      event: string;
      body: string;
      comments: unknown[];
    };
    if (posted.event !== "REQUEST_CHANGES") {
      throw new Error(`event ${posted.event}`);
    }
    if (posted.comments.length !== 0) {
      throw new Error(`comments ${JSON.stringify(posted.comments)}`);
    }
    if (
      !posted.body.includes("Review summary") ||
      !posted.body.includes("`src/app.ts`")
    ) {
      throw new Error(`body ${posted.body}`);
    }
  });
});

Deno.test("SKILL.md is enough when PR_REVIEW_GUIDE.md was not generated", async () => {
  await withEnv(async () => {
    const dir = Deno.env.get("CM_REPOS_DIR")!;
    await Deno.remove(`${dir}/acme/widgets/PR_REVIEW_GUIDE.md`);
    await Deno.writeTextFile(
      `${dir}/acme/widgets/SKILL.md`,
      "# skill\nKeep helpers honest.\n",
    );
    const job = seed();
    const github = new FakeGithub();
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    if (github.writes.length === 0) {
      throw new Error("expected a posted review");
    }
  });
});

Deno.test("incremental scope reviews the compare diff", async () => {
  await withEnv(async () => {
    const job = seed();
    job.args = JSON.stringify({
      trigger: "synchronize",
      scope: "incremental",
      sinceCommit: "oldsha",
      round: 2,
    });
    const github = new FakeGithub();
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const review = getReviewByJobId("job-rev");
    if (review?.scope !== "incremental" || review.base_sha !== "oldsha") {
      throw new Error(JSON.stringify(review));
    }
  });
});

Deno.test("a denied incremental compare falls back to a whole-pr review", async () => {
  await withEnv(async () => {
    const job = seed();
    job.args = JSON.stringify({
      trigger: "synchronize",
      scope: "incremental",
      sinceCommit: "forksha",
      round: 2,
    });
    const github = new FakeGithub();
    github.compareError = new GitHubHttpError(403, "no compare");
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const review = getReviewByJobId("job-rev");
    if (review?.scope !== "whole-pr" || review.status !== "posted") {
      throw new Error(JSON.stringify(review));
    }
  });
});

Deno.test("a finding that repeats a previous round replies in the thread", async () => {
  await withEnv(async () => {
    insertReview({
      id: "rev-prev",
      repo: "acme/widgets",
      prNumber: 1,
      jobId: "job-prev",
      headSha: "oldhead",
      baseSha: "base1",
      scope: "whole-pr",
      model: "fake",
    });
    setReviewStatus("rev-prev", "posted");
    insertFinding({
      id: "f-prev",
      reviewId: "rev-prev",
      severity: "P2",
      path: "src/app.ts",
      lineFrom: 4,
      lineTo: 4,
      title: "unused",
      bodyMd: "drop it",
    });
    setFindingPosted("f-prev", "42");
    const job = seed();
    const github = new FakeGithub();
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const reply = github.writes.find((write) =>
      write.endpoint.includes("/comments")
    );
    const payload = reply?.body as { in_reply_to?: number };
    if (payload?.in_reply_to !== 42) {
      throw new Error(`expected a reply, got ${JSON.stringify(github.writes)}`);
    }
    const reviewPost = github.writes.find((write) =>
      write.endpoint.includes("/reviews")
    );
    const comments = (reviewPost?.body as { comments?: unknown[] }).comments;
    if (comments && comments.length !== 0) {
      throw new Error("repeat should not also post a new inline comment");
    }
    const findings = listFindingsForReview(getReviewByJobId("job-rev")!.id);
    if (findings[0]?.first_seen_review_id !== "rev-prev") {
      throw new Error(JSON.stringify(findings));
    }
  });
});

Deno.test("humanCopy preserves the review heading dash and removes semicolons", () => {
  const cleaned = humanCopy("Broken — really; stop");
  if (!cleaned.includes("\u2014") || cleaned.includes(";")) {
    throw new Error(cleaned);
  }
  const body = reviewBody([]);
  if (body.includes(";")) {
    throw new Error(body);
  }
});
