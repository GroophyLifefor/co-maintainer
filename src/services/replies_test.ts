import { closeAppDb, openAppDb } from "../store/app_db.ts";
import { activateRepo } from "../store/repos.ts";
import {
  createReplyRequestAndJob,
  getReplyRequest,
  setReplyStatus,
} from "../store/replies.ts";
import { getJob } from "../store/jobs.ts";
import { runReplyJob } from "./replies.ts";
import type { AiProvider, GitHubClient, Json } from "../types.ts";
import type { JobRow } from "../store/rows.ts";

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const originalDb = Deno.env.get("CM_APP_DB");
  const originalRepos = Deno.env.get("CM_REPOS_DIR");
  const dir = Deno.makeTempDirSync();
  Deno.env.set("CM_APP_DB", `${dir}/app.db`);
  Deno.env.set("CM_REPOS_DIR", `${dir}/repos`);
  await Deno.mkdir(`${dir}/repos/acme/widgets`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/repos/acme/widgets/PR_REVIEW_GUIDE.md`,
    "Answer review questions from the supplied code.",
  );
  try {
    await openAppDb();
    activateRepo("acme/widgets", 7);
    await fn();
  } finally {
    await closeAppDb();
    if (originalDb === undefined) Deno.env.delete("CM_APP_DB");
    else Deno.env.set("CM_APP_DB", originalDb);
    if (originalRepos === undefined) Deno.env.delete("CM_REPOS_DIR");
    else Deno.env.set("CM_REPOS_DIR", originalRepos);
  }
}

class FakeGithub implements GitHubClient {
  writes: { endpoint: string; body: unknown }[] = [];
  existingReply?: Json;

  request<T>(endpoint: string): Promise<T> {
    if (endpoint.includes("/pulls/1")) {
      return Promise.resolve({
        number: 1,
        title: "Change",
        body: "Please review this change.",
        head: { sha: "head1" },
      } as T);
    }
    throw new Error(`unexpected request ${endpoint}`);
  }

  pages<T>(endpoint: string): Promise<T[]> {
    if (endpoint.includes("/pulls/1/comments")) {
      return Promise.resolve([{
        id: 10,
        body: "The original finding.",
        path: "src/app.ts",
        line: 4,
        user: { login: "co-maintainer-beta[bot]", type: "Bot" },
      }] as T[]);
    }
    if (endpoint.includes("/issues/1/comments")) {
      return Promise.resolve(
        (this.existingReply ? [this.existingReply] : []) as T[],
      );
    }
    return Promise.resolve([] as T[]);
  }

  write<T>(endpoint: string, body: unknown): Promise<T> {
    this.writes.push({ endpoint, body });
    return Promise.resolve({ id: 900 } as T);
  }
}

function replyAi(text: string): AiProvider {
  return {
    complete: () =>
      Promise.resolve({
        text,
        tokensIn: 1,
        tokensOut: 1,
        model: "fake",
        provider: "openrouter",
      }),
  };
}

function requestJob(
  sourceKind: "review_comment" | "issue_comment",
  sourceCommentId: string,
  targetCommentId?: string,
): JobRow {
  const result = createReplyRequestAndJob({
    repo: "acme/widgets",
    prNumber: 1,
    sourceKind,
    sourceCommentId,
    targetCommentId,
    sourceBody: "Can you explain this?",
    sourceAuthor: "octocat",
  });
  return getJob(result.request.job_id!)!;
}

Deno.test("reply jobs post inline replies to the stored thread target", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("review_comment", "101", "10");
    await runReplyJob(
      job,
      () => {},
      github,
      replyAi("The finding blocks the unsafe branch."),
    );
    const posted = github.writes[0];
    if (!posted.endpoint.endsWith("/pulls/1/comments")) {
      throw new Error(`unexpected endpoint ${posted.endpoint}`);
    }
    const body = posted.body as { body: string; in_reply_to: number };
    if (body.in_reply_to !== 10 || !body.body.includes("unsafe branch")) {
      throw new Error(`unexpected reply ${JSON.stringify(body)}`);
    }
    if (getReplyRequest("reply-missing") !== undefined) {
      throw new Error("unexpected reply row");
    }
  });
});

Deno.test("the same source comment creates only one reply request", async () => {
  await withEnv(async () => {
    const first = createReplyRequestAndJob({
      repo: "acme/widgets",
      prNumber: 1,
      sourceKind: "issue_comment",
      sourceCommentId: "105",
      sourceBody: "First delivery.",
    });
    const second = createReplyRequestAndJob({
      repo: "acme/widgets",
      prNumber: 1,
      sourceKind: "issue_comment",
      sourceCommentId: "105",
      sourceBody: "Duplicate delivery.",
    });
    if (second.created || first.request.id !== second.request.id) {
      throw new Error("source comment was not deduplicated");
    }
  });
});

Deno.test("reply jobs use issue comments for explicit PR mentions", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("issue_comment", "102");
    await runReplyJob(
      job,
      () => {},
      github,
      replyAi("The review is based on the current branch behavior."),
    );
    if (!github.writes[0].endpoint.endsWith("/issues/1/comments")) {
      throw new Error(`unexpected endpoint ${github.writes[0].endpoint}`);
    }
  });
});

Deno.test("a persisted answer is posted without calling the AI again", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const job = requestJob("issue_comment", "103");
    const args = JSON.parse(job.args) as { requestId: string };
    setReplyStatus(args.requestId, "ready", { answer_md: "Persisted answer." });
    const ai: AiProvider = {
      complete: () => Promise.reject(new Error("AI should not run")),
    };
    await runReplyJob(job, () => {}, github, ai);
    const body = (github.writes[0].body as Json).body;
    if (typeof body !== "string" || !body.includes("Persisted answer.")) {
      throw new Error(`persisted answer was not posted: ${String(body)}`);
    }
  });
});

Deno.test("a reply already accepted by GitHub is reconciled by its marker", async () => {
  await withEnv(async () => {
    const github = new FakeGithub();
    const result = createReplyRequestAndJob({
      repo: "acme/widgets",
      prNumber: 1,
      sourceKind: "issue_comment",
      sourceCommentId: "104",
      sourceBody: "Please clarify.",
    });
    setReplyStatus(result.request.id, "posting", {
      answer_md: "Already generated.",
    });
    github.existingReply = {
      id: 901,
      body:
        `<!-- co-maintainer:reply:${result.request.id} -->\nAlready generated.`,
    };
    await runReplyJob(
      getJob(result.request.job_id!)!,
      () => {},
      github,
      replyAi("Should not run."),
    );
    if (github.writes.length !== 0) {
      throw new Error("reconciliation posted a duplicate reply");
    }
    if (getReplyRequest(result.request.id)?.status !== "posted") {
      throw new Error("reply marker was not reconciled");
    }
  });
});
