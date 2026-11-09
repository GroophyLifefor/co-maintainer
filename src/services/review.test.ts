import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { writeUserConfig } from "../config.ts";
import { activateRepo, markKnowledgeBuilt } from "../store/repos.ts";
import { insertJob, setJobStatus } from "../store/jobs.ts";
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
import { FAKE_REVIEW_MARKDOWN, FakeAiProvider } from "../ai/fake.ts";
import {
  humanCopy,
  reconcileReview,
  reviewBody,
  runReviewJob,
} from "./review.ts";
import type { AiRequest, AiResponse, GitHubClient, Json } from "../types.ts";
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
import { test } from "node:test";

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

class FakeGithub implements GitHubClient {
  writes: { endpoint: string; body: unknown }[] = [];
  checkCreates: { endpoint: string; body: unknown }[] = [];
  checkUpdates: { endpoint: string; body: unknown }[] = [];
  listedReviews: Json[] = [];
  listedComments: Json[] = [];
  /** Lists what the review POST carried, the way GitHub would after it. */
  echoPosted = false;
  commentsError?: Error;
  files: Json[] = [{ filename: "src/app.ts", patch: "@@ -4 +4 @@" }];
  prFiles?: Json[];
  prExtra: Json = {};
  filesError?: Error;
  writeError?: Error;
  compareError?: Error;
  /** Logins with write access. Everyone else reads. */
  writers = new Set<string>();

  request<T>(endpoint: string): Promise<T> {
    const permission = /\/collaborators\/([^/]+)\/permission$/.exec(endpoint);
    if (permission) {
      const role = this.writers.has(permission[1]!) ? "write" : "read";
      return Promise.resolve({ permission: role, role_name: role } as T);
    }
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
        ...this.prExtra,
      } as T);
    }
    throw new Error(`unexpected request ${endpoint}`);
  }

  pages<T>(endpoint: string): Promise<T[]> {
    if (this.filesError && endpoint.includes("/files")) {
      return Promise.reject(this.filesError);
    }
    if (endpoint.includes("/files")) {
      return Promise.resolve((this.prFiles ?? this.files) as T[]);
    }
    if (endpoint.includes("/comments")) {
      if (this.commentsError) return Promise.reject(this.commentsError);
      const posted = this.echoPosted
        ? this.writes
            .filter((write) => write.endpoint.includes("/reviews"))
            .flatMap(
              (write) => (write.body as { comments?: Json[] }).comments ?? [],
            )
            .map((comment) => ({ ...comment, id: 77 }))
        : [];
      return Promise.resolve([...this.listedComments, ...posted] as T[]);
    }
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
    cancel_reason: null,
  };
}

test("fake AI markdown becomes findings rows and a GitHub review POST", async () => {
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
      body.comments[0]?.path !== "src/app.ts" ||
      body.comments[0]?.line !== 4
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

test("review checks use annotations and the conclusion matrix", async () => {
  await withEnv(async () => {
    const findingsGithub = new FakeGithub();
    await runReviewJob(seed(), () => {}, findingsGithub, new FakeAiProvider());
    const created = findingsGithub.checkCreates[0]?.body as Json;
    if (created.status !== "queued" || created.head_sha !== "head1") {
      throw new Error(`unexpected check creation ${JSON.stringify(created)}`);
    }
    const completed = findingsGithub.checkUpdates.find(
      (item) => (item.body as Json).status === "completed",
    )?.body as Json;
    const output = completed.output as Json;
    const annotations = output.annotations as Json[];
    if (completed.conclusion !== "neutral" || annotations.length !== 1) {
      throw new Error(`unexpected finding check ${JSON.stringify(completed)}`);
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
    const clearCompleted = clearGithub.checkUpdates.find(
      (item) => (item.body as Json).status === "completed",
    )?.body as Json;
    if (clearCompleted.conclusion !== "success") {
      throw new Error(
        `unexpected clear check ${JSON.stringify(clearCompleted)}`,
      );
    }
  });
});

test("a review that was asked for acknowledges the request once, and a failed reaction does not fail it", async () => {
  await withEnv(async () => {
    const job = seed();
    const endpoint = "repos/acme/widgets/issues/comments/900/reactions";
    job.args = JSON.stringify({
      trigger: "request-comment",
      requestReaction: endpoint,
    });
    const github = new FakeGithub();
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const reactions = github.writes.filter((write) =>
      write.endpoint.endsWith("/reactions"),
    );
    if (
      reactions.length !== 1 ||
      reactions[0]!.endpoint !== endpoint ||
      (reactions[0]!.body as { content: string }).content !== "eyes"
    ) {
      throw new Error(`reactions: ${JSON.stringify(reactions)}`);
    }
  });

  await withEnv(async () => {
    const job = seed();
    job.args = JSON.stringify({
      trigger: "request-label",
      requestReaction: "repos/acme/widgets/issues/1/reactions",
    });
    const github = new FakeGithub();
    const write = github.write.bind(github);
    github.write = async (endpoint, body) => {
      if (endpoint.endsWith("/reactions")) throw new Error("no permission");
      return write(endpoint, body);
    };
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    if (getReviewByJobId("job-rev")?.status !== "posted") {
      throw new Error("a missing reaction must not stop the review");
    }
  });
});

test("a comment request over the size cap is dropped once the pull request is fetched", async () => {
  await withEnv(async () => {
    await writeUserConfig({ defaults: { maxPullRequestChangeLines: 100 } });
    const job = seed();
    job.args = JSON.stringify({
      trigger: "request-comment",
      requestReaction: "repos/acme/widgets/issues/comments/900/reactions",
    });
    const github = new FakeGithub();
    github.prExtra = { additions: 90_000, deletions: 0 };
    const lines: string[] = [];
    await runReviewJob(
      job,
      (_level, message) => lines.push(message),
      github,
      new FakeAiProvider(),
    );
    if (getReviewByJobId("job-rev")) throw new Error("the review still ran");
    if (github.writes.length !== 0) {
      throw new Error(`wrote ${JSON.stringify(github.writes)}`);
    }
    if (!lines.some((line) => line.includes("diff-too-large"))) {
      throw new Error(lines.join(" | "));
    }
  });
});

test("a failed review completes its check with failure", async () => {
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
    const completed = github.checkUpdates.find(
      (item) => (item.body as Json).status === "completed",
    )?.body as Json;
    if (completed.conclusion !== "failure") {
      throw new Error(`unexpected failed check ${JSON.stringify(completed)}`);
    }
  });
});

test("a 422 on inline comments falls back to one issue comment", async () => {
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

test("denied pull request files post one comment and access_denied", async () => {
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

test("reconcile after a crash between posting and posted does not post again", async () => {
  await withEnv(async () => {
    const job = seed();
    const github = new FakeGithub();
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const review = getReviewByJobId("job-rev")!;
    const { setReviewStatus } = await import("../store/reviews.ts");
    setReviewStatus(review.id, "posting");
    github.listedReviews = [
      {
        id: 42,
        commit_id: "head1",
        user: { type: "Bot" },
      },
    ];
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

test("zero findings post APPROVE with a short body", async () => {
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
    if (posted.event !== "APPROVE") {
      throw new Error(`event ${posted.event}`);
    }
    if (!posted.body.startsWith("No actionable findings.\n\n<details>")) {
      throw new Error(`body ${posted.body}`);
    }
    if (posted.comments.length !== 0) {
      throw new Error(`comments ${JSON.stringify(posted.comments)}`);
    }
  });
});

test("findings outside the diff stay on the review body", async () => {
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

function reviewAt(location: string): FakeAiProvider {
  return new FakeAiProvider(
    FAKE_REVIEW_MARKDOWN.replace("`src/app.ts:4`", `\`${location}\``),
  );
}

type PostedReview = {
  body: string;
  comments: { line: number; start_line?: number; start_side?: string }[];
};

test("a multi-line finding inside one hunk posts start_line", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    github.files = [{ filename: "src/app.ts", patch: "@@ -1,6 +1,8 @@" }];
    await runReviewJob(seed(), () => {}, github, reviewAt("src/app.ts:3-5"));
    const posted = github.writes[0].body as PostedReview;
    const comment = posted.comments[0];
    if (
      comment?.start_line !== 3 ||
      comment.line !== 5 ||
      comment.start_side !== "RIGHT"
    ) {
      throw new Error(`comments ${JSON.stringify(posted.comments)}`);
    }
  });
});

test("a finding on a changed file but outside every hunk stays on the review body", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    github.files = [{ filename: "src/app.ts", patch: "@@ -40,2 +40,3 @@" }];
    await runReviewJob(seed(), () => {}, github, reviewAt("src/app.ts:4"));
    const posted = github.writes[0].body as PostedReview;
    if (posted.comments.length !== 0 || !posted.body.includes("`src/app.ts`")) {
      throw new Error(`posted ${JSON.stringify(posted)}`);
    }
  });
});

const GATE_PATCH = [
  "@@ -16,3 +16,3 @@",
  " function gate() {",
  "-  const failing = old;",
  "+  const failing = list.filter((v) => v > threshold);",
  "   return failing;",
].join("\n");

function reviewWithSuggestion(code: string): FakeAiProvider {
  return new FakeAiProvider(`## Findings

### [P1 · blocking] \`src/app.ts\` — \`gate()\`
Location: \`src/app.ts:16-18\`

The threshold comparison is strict, so a violation at the threshold passes.

Suggestion: \`src/app.ts:17\`
\`\`\`suggestion
${code}
\`\`\`

If you'd like me to explain it in more detail, please ask.
`);
}

test("a valid suggestion posts on its own line and keeps the block", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    github.files = [{ filename: "src/app.ts", patch: GATE_PATCH }];
    await runReviewJob(
      seed(),
      () => {},
      github,
      reviewWithSuggestion(
        "  const failing = list.filter((v) => v >= threshold);",
      ),
    );
    const posted = github.writes[0].body as {
      comments: { line: number; start_line?: number; body: string }[];
    };
    const comment = posted.comments[0];
    if (
      comment?.line !== 17 ||
      comment.start_line !== undefined ||
      !comment.body.includes("```suggestion\n  const failing") ||
      comment.body.includes("Suggestion:")
    ) {
      throw new Error(`comments ${JSON.stringify(posted.comments)}`);
    }
    const findings = listFindingsForReview(getReviewByJobId("job-rev")!.id);
    if (findings[0].line_from !== 16 || findings[0].line_to !== 18) {
      throw new Error(`full span was not kept ${JSON.stringify(findings)}`);
    }
    const completed = github.checkUpdates.find(
      (item) => (item.body as Json).status === "completed",
    )?.body as Json;
    const annotations = (completed.output as Json).annotations as Json[];
    if (String(annotations[0].message).includes("suggestion")) {
      throw new Error(`annotation kept the block ${annotations[0].message}`);
    }
  });
});

test("a suggestion that changes nothing is dropped and the span is kept", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    github.files = [{ filename: "src/app.ts", patch: GATE_PATCH }];
    await runReviewJob(
      seed(),
      () => {},
      github,
      reviewWithSuggestion(
        "  const failing = list.filter((v) => v > threshold);",
      ),
    );
    const posted = github.writes[0].body as {
      comments: { line: number; start_line?: number; body: string }[];
    };
    const comment = posted.comments[0];
    if (
      comment?.start_line !== 16 ||
      comment.line !== 18 ||
      comment.body.includes("suggestion") ||
      comment.body.includes("Suggestion:") ||
      !comment.body.includes("If you'd like me to explain it")
    ) {
      throw new Error(`comments ${JSON.stringify(posted.comments)}`);
    }
  });
});

test("an incremental review anchors against the pull request diff", async () => {
  await withEnv(async () => {
    const job = seed();
    job.args = JSON.stringify({
      trigger: "synchronize",
      scope: "incremental",
      sinceCommit: "oldsha",
      round: 2,
    });
    const github = new FakeGithub();
    github.prFiles = [{ filename: "src/app.ts", patch: "@@ -40,2 +40,3 @@" }];
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const posted = github.writes.find((write) =>
      write.endpoint.includes("/reviews"),
    )?.body as PostedReview;
    if (posted.comments.length !== 0) {
      throw new Error(`anchored to the compare diff ${JSON.stringify(posted)}`);
    }
  });
});

test("SKILL.md is enough when PR_REVIEW_GUIDE.md was not generated", async () => {
  await withEnv(async () => {
    const dir = getEnv("CM_REPOS_DIR")!;
    await removePath(`${dir}/acme/widgets/PR_REVIEW_GUIDE.md`);
    await writeTextFile(
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

test("incremental scope reviews the compare diff", async () => {
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

test("a denied incremental compare falls back to a whole-pr review", async () => {
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

const DIFF = [{ filename: "src/app.ts", patch: "@@ -4 +4 @@\n-old\n+new" }];

const SUGGESTING_REVIEW = `## Findings

### [P2 · non-blocking] \`src/app.ts\`: \`helper()\`
Location: \`src/app.ts:4\`

The helper ignores its argument.

Suggestion: \`src/app.ts:4\`
\`\`\`suggestion
newer
\`\`\`
`;

/** The round's one POST to /reviews, after checking no comment went out on its
 * own: GitHub would wrap that comment in a second review. */
function theOneReview(github: FakeGithub): { comments: Json[]; body: string } {
  const own = github.writes.filter((write) =>
    write.endpoint.includes("/pulls/1/comments"),
  );
  const reviews = github.writes.filter((write) =>
    write.endpoint.includes("/reviews"),
  );
  if (own.length !== 0 || reviews.length !== 1) {
    throw new Error(
      `expected one review, got ${JSON.stringify(github.writes)}`,
    );
  }
  return reviews[0].body as { comments: Json[]; body: string };
}

function nextRound(job: JobRow): JobRow {
  setJobStatus(job.id, "done");
  insertJob({
    id: "job-rev-2",
    type: "review",
    repo: "acme/widgets",
    prNumber: 1,
    args: { trigger: "synchronize" },
  });
  return { ...job, id: "job-rev-2" };
}

for (const [name, markdown, fence] of [
  ["a repeat", FAKE_REVIEW_MARKDOWN, false],
  ["a repeat first posted with a suggestion", SUGGESTING_REVIEW, true],
] as const) {
  test(`${name} stays on its thread and posts one review`, async () => {
    await withEnv(async () => {
      const job = seed();
      const first = new FakeGithub();
      first.files = DIFF;
      const ai = new FakeAiProvider(markdown);
      await runReviewJob(job, () => {}, first, ai);
      const posted = theOneReview(first).comments[0];
      if (String(posted.body).includes("```suggestion") !== fence) {
        throw new Error(`unexpected first comment ${JSON.stringify(posted)}`);
      }
      const firstRow = listFindingsForReview(
        getReviewByJobId("job-rev")!.id,
      )[0];
      setFindingPosted(firstRow.id, "42");

      const github = new FakeGithub();
      github.files = DIFF;
      github.listedComments = [{ ...posted, id: 42 }];
      await runReviewJob(nextRound(job), () => {}, github, ai);

      const review = theOneReview(github);
      if (review.comments.length !== 0) {
        throw new Error(`repeat went inline: ${JSON.stringify(review)}`);
      }
      if (!review.body.includes("helper()")) {
        throw new Error(`repeat left the summary: ${review.body}`);
      }
      const row = listFindingsForReview(getReviewByJobId("job-rev-2")!.id)[0];
      if (row.posted_comment_id !== "42" || row.thread_comment_id !== "42") {
        throw new Error(`thread chain broke: ${JSON.stringify(row)}`);
      }
    });
  });
}

test("a re-review that closes the last finding approves (#45)", async () => {
  await withEnv(async () => {
    const job = seed();
    const first = new FakeGithub();
    first.files = DIFF;
    await runReviewJob(job, () => {}, first, new FakeAiProvider());

    // The push that fixes it changes the flagged line.
    const github = new FakeGithub();
    github.files = [
      { filename: "src/app.ts", patch: "@@ -4 +4 @@\n-old\n+fixed" },
    ];
    await runReviewJob(
      nextRound(job),
      () => {},
      github,
      new FakeAiProvider(
        "## Findings\n\nNo actionable findings.\n\n## Previous findings\n\n- F1: closed\n",
      ),
    );
    const rows = listFindingsForReview(getReviewByJobId("job-rev-2")!.id);
    if (!rows.some((row) => row.state === "closed")) {
      throw new Error(
        `the earlier finding was not closed: ${JSON.stringify(rows)}`,
      );
    }
    const review = github.writes.find((write) =>
      write.endpoint.includes("/reviews"),
    )?.body as { event: string; body: string };
    if (review.event !== "APPROVE") {
      throw new Error(`event ${review.event}: ${review.body}`);
    }
    const check = github.checkUpdates.find(
      (item) => (item.body as Json).status === "completed",
    )?.body as Json;
    const output = check?.output as Json | undefined;
    if (
      check?.conclusion !== "success" ||
      output?.summary !== "No actionable findings." ||
      (output.annotations as Json[]).length !== 0
    ) {
      throw new Error(`check ${JSON.stringify(check)}`);
    }
  });
});

test("a repeat whose text changed goes inline on the one review", async () => {
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
    github.files = DIFF;
    github.echoPosted = true;
    github.listedComments = [
      { id: 42, path: "src/app.ts", line: 4, body: "drop it" },
    ];
    await runReviewJob(job, () => {}, github, new FakeAiProvider());
    const { comments } = theOneReview(github);
    if (comments.length !== 1 || "in_reply_to" in comments[0]) {
      throw new Error(`expected one new comment: ${JSON.stringify(comments)}`);
    }
    const findings = listFindingsForReview(getReviewByJobId("job-rev")!.id);
    if (findings[0]?.first_seen_review_id !== "rev-prev") {
      throw new Error(JSON.stringify(findings));
    }
    // The older comment sits on the same line, and must not be taken for it.
    if (findings[0]?.posted_comment_id !== "77") {
      throw new Error(`matched the old comment: ${JSON.stringify(findings)}`);
    }
  });
});

test("a repeat goes inline when the earlier comments cannot be read", async () => {
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
    github.files = DIFF;
    // The engine reads the same list first, so the failure starts after it.
    const fake = new FakeAiProvider();
    const ai = {
      complete(request: AiRequest): Promise<AiResponse> {
        github.commentsError = new GitHubHttpError(500, "no list");
        return fake.complete(request);
      },
    };
    await runReviewJob(job, () => {}, github, ai);
    if (theOneReview(github).comments.length !== 1) {
      throw new Error(`repeat went unsaid: ${JSON.stringify(github.writes)}`);
    }
    if (getReviewByJobId("job-rev")?.status !== "posted") {
      throw new Error("the review did not post");
    }
  });
});

test("humanCopy preserves the review heading dash and removes semicolons", () => {
  const cleaned = humanCopy("Broken — really; stop");
  if (!cleaned.includes("\u2014") || cleaned.includes(";")) {
    throw new Error(cleaned);
  }
  const body = reviewBody([], {
    jobId: "job-1",
    model: "test-model",
    durationMs: 1000,
  });
  if (body.includes(";")) {
    throw new Error(body);
  }
});

test("a repository's custom instructions reach the review's system prompt", async () => {
  await withEnv(async () => {
    await writeUserConfig({
      repos: {
        "acme/widgets": {
          reviewSystemPrompt: "Prefer the project's own helpers.",
        },
      },
    });
    let system = "";
    class Capture extends FakeAiProvider {
      complete(request: AiRequest): Promise<AiResponse> {
        system = request.system ?? "";
        return super.complete(request);
      }
    }
    await runReviewJob(seed(), () => {}, new FakeGithub(), new Capture());
    if (!system.includes("CUSTOM REVIEW INSTRUCTIONS")) {
      throw new Error(`heading missing from system prompt: ${system}`);
    }
    if (!system.includes("Prefer the project's own helpers.")) {
      throw new Error("instruction text missing from system prompt");
    }
  });
});

test("a review or comment on a head already reviewed runs nothing", async () => {
  await withEnv(async () => {
    const job = seed();
    await runReviewJob(job, () => {}, new FakeGithub(), new FakeAiProvider());
    setJobStatus(job.id, "done");
    // Queued by a maintainer's reply while the first review was running.
    insertJob({
      id: "job-rev-2",
      type: "review",
      repo: "acme/widgets",
      prNumber: 1,
      args: { trigger: "review" },
    });
    const github = new FakeGithub();
    await runReviewJob(
      { ...job, id: "job-rev-2", args: JSON.stringify({ trigger: "review" }) },
      () => {},
      github,
      new FakeAiProvider(),
    );
    if (github.writes.length !== 0 || github.checkCreates.length !== 0) {
      throw new Error(`reviewed again: ${JSON.stringify(github.writes)}`);
    }
    if (getReviewByJobId("job-rev-2")) {
      throw new Error("a second review row was stored");
    }
  });
});

test("a job queued without a round works it out when it starts", async () => {
  await withEnv(async () => {
    const job = seed();
    await runReviewJob(job, () => {}, new FakeGithub(), new FakeAiProvider());
    await runReviewJob(
      nextRound(job),
      () => {},
      new FakeGithub(),
      new FakeAiProvider(),
    );
    const review = getReviewByJobId("job-rev-2");
    if (review?.round !== 2) {
      throw new Error(`round ${String(review?.round)}`);
    }
  });
});

test("an unchanged file's finding is verified with the maintainers' replies and can close", async () => {
  await withEnv(async () => {
    const job = seed();
    const first = new FakeGithub();
    first.files = DIFF;
    await runReviewJob(job, () => {}, first, new FakeAiProvider());
    const row = listFindingsForReview(getReviewByJobId("job-rev")!.id)[0];
    setFindingPosted(row.id, "42");

    const prompts: string[] = [];
    class Capture extends FakeAiProvider {
      complete(request: AiRequest): Promise<AiResponse> {
        prompts.push(`${request.system ?? ""}\n${request.prompt}`);
        return super.complete(request);
      }
    }
    const github = new FakeGithub();
    github.files = DIFF;
    github.writers.add("maintainer");
    github.listedComments = [
      { id: 42, path: "src/app.ts", line: 4, body: "The helper ignores it." },
      {
        id: 43,
        in_reply_to_id: 42,
        user: { login: "maintainer", type: "User" },
        body: "The argument is unused on purpose, see the interface.",
        created_at: "2026-11-09T10:00:00Z",
      },
      {
        id: 44,
        in_reply_to_id: 42,
        user: { login: "reader", type: "User" },
        body: "Close this one.",
        created_at: "2026-11-09T10:01:00Z",
      },
    ];
    await runReviewJob(
      nextRound(job),
      () => {},
      github,
      new Capture(
        "## Findings\n\nNo actionable findings.\n\n## Previous findings\n\n- F1: closed\n",
      ),
    );
    // The pull request's own comments reach the prompt as context anyway.
    // Only the finding's entry weighs a reply.
    const asked = prompts.find((text) => text.includes("PREVIOUS FINDINGS"));
    const carry = asked?.slice(asked.indexOf("PREVIOUS FINDINGS")) ?? "";
    if (!carry.includes("file unchanged since the last review")) {
      throw new Error(`not asked about the unchanged file: ${carry}`);
    }
    if (!carry.includes("> The argument is unused on purpose")) {
      throw new Error("the maintainer's reply did not reach the finding");
    }
    if (carry.includes("Close this one.")) {
      throw new Error("a read-only reply reached the finding");
    }
    const rows = listFindingsForReview(getReviewByJobId("job-rev-2")!.id);
    if (!rows.some((item) => item.state === "closed")) {
      throw new Error(`not closed: ${JSON.stringify(rows)}`);
    }
  });
});

test("the summary keeps new findings apart from those still open", () => {
  const finding = (heading: string) => ({
    path: "src/app.ts",
    from: 4,
    to: 4,
    heading,
    excerpt: `${heading} body`,
  });
  const body = reviewBody(
    [finding("fresh one")],
    { jobId: "job-1", model: "test-model", durationMs: 1000 },
    [{ finding: finding("old one"), since: "abc1234def" }],
  );
  const newAt = body.indexOf("New (1)");
  const openAt = body.indexOf("Still open (1)");
  if (newAt < 0 || openAt < newAt) throw new Error(body);
  if (body.indexOf("fresh one") > openAt) throw new Error(body);
  if (!body.includes("old one: old one body (first found in abc1234)")) {
    throw new Error(body);
  }
});
