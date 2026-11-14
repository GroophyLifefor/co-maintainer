/** Comments on commit watch issues.
 *
 * The webhook already checked that the issue is ours and that the author has
 * write access. The low model then decides whether the comment is meant for
 * co-maintainer at all ("@asd can you take a look" is not) and whether it is
 * a question, a request to ignore the finding, or information. A question
 * gets an answer from the high model, in the comment's language. Ignore and
 * information get a short "noted" and wait for the next sync, which puts the
 * note in the detailed review guide and, for ignore, stops reporting the
 * finding. */
import { createAiProvider } from "../ai/provider.ts";
import { FakeAiProvider } from "../ai/fake.ts";
import { completeWithMermaidTools } from "../ai/mermaid_loop.ts";
import { mermaidToolFields } from "../review/diagram.ts";
import { loadGuides } from "../review/guides.ts";
import { getEnv } from "../util/runtime.ts";
import { hasWriteAccess } from "../github/write_access.ts";
import { getWatchIssue, insertWatchNote } from "../store/watch.ts";
import { registerHandler, type LogFn } from "./jobs.ts";
import { recordAiCost } from "./setup.ts";
import {
  aiFor,
  clientFor,
  humanCopy,
  resolveInstallationId,
  reviewOptions,
} from "./review.ts";
import {
  commentOnIssue,
  excerpt,
  fileAt,
  NOTED_REPLY,
} from "./watch_issues.ts";
import type { AiProvider, Json, Options } from "../types.ts";
import type { JobRow } from "../store/rows.ts";

export const WATCH_COMMENT_JOB = "watch_comment";

export type CommentKind = "question" | "ignore" | "info";

export type Classification = { forUs: boolean; kind: CommentKind | "other" };

function replyMarker(commentId: string): string {
  return `<!-- co-maintainer:watch-reply ${commentId} -->`;
}

function lowAiFor(options: Options): AiProvider {
  if (getEnv("CM_FAKE_AI") === "1") return new FakeAiProvider();
  const provider = createAiProvider(options, options.lowModel ?? "");
  if (!provider) throw new Error("commit watch comments need an AI provider");
  return provider;
}

/** Reads the classifier's answer. Anything unreadable is "not for us", so a
 * broken answer never makes co-maintainer speak. */
export function parseClassification(text: string): Classification {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return { forUs: false, kind: "other" };
  try {
    const value = JSON.parse(match[0]) as { forUs?: unknown; kind?: unknown };
    const kind =
      value.kind === "question" ||
      value.kind === "ignore" ||
      value.kind === "info"
        ? value.kind
        : "other";
    return { forUs: value.forUs === true, kind };
  } catch {
    return { forUs: false, kind: "other" };
  }
}

function classifyPrompt(
  issueTitle: string,
  issueBody: string,
  comment: string,
): string {
  return `An issue was opened by co-maintainer, an automated code reviewer, for a
problem its review found on the default branch. A maintainer commented on it.

Decide two things and answer with one JSON object and nothing else:
{"forUs": true|false, "kind": "question"|"ignore"|"info"|"other"}

forUs: true only when the comment speaks to co-maintainer (or to the bot, or
to whoever opened the issue). A comment that addresses another person, for
example "@asd can you take a look", is false.
kind:
- "question": asks co-maintainer something about the problem.
- "ignore": says the finding is not a problem, is intended, or should be
  ignored from now on.
- "info": tells co-maintainer something it should know for later reviews.
- "other": anything else.

ISSUE TITLE: ${issueTitle}
ISSUE:
${issueBody.slice(0, 4000)}

COMMENT:
${comment.slice(0, 6000)}`;
}

async function alreadyAnswered(
  client: ReturnType<typeof clientFor>,
  repo: string,
  issueNumber: number,
  commentId: string,
): Promise<boolean> {
  try {
    const comments = await client.pages<Json>(
      `repos/${repo}/issues/${issueNumber}/comments`,
      300,
    );
    const marker = replyMarker(commentId);
    return comments.some((comment) =>
      String(comment.body ?? "").includes(marker),
    );
  } catch {
    return false;
  }
}

async function runWatchComment(job: JobRow, log: LogFn): Promise<void> {
  const args = JSON.parse(job.args) as {
    issueNumber: number;
    commentId: string;
    author: string | null;
    body: string;
  };
  const issue = getWatchIssue(job.repo, args.issueNumber);
  if (!issue) {
    log("info", "the issue is no longer tracked");
    return;
  }
  const installationId = await resolveInstallationId(job.repo);
  if (installationId === undefined) {
    throw new Error("no GitHub App installation covers this repository");
  }
  const client = clientFor(installationId);
  if (!(await hasWriteAccess(client, job.repo, args.author))) {
    log("info", `${args.author ?? "the commenter"} has no write access`);
    return;
  }
  if (
    await alreadyAnswered(client, job.repo, args.issueNumber, args.commentId)
  ) {
    log("info", "this comment was already answered");
    return;
  }
  const options = reviewOptions(job.repo, 0);
  const usage = async (response: Parameters<typeof recordAiCost>[2]) => {
    await recordAiCost(job.repo, "watch_comment", response);
  };

  const classified = await lowAiFor(options).complete({
    job: "watch_comment_classify",
    prompt: classifyPrompt(issue.title, issue.body_md, args.body),
    maxTokens: 200,
  });
  await usage(classified);
  const decision = parseClassification(classified.text);
  log(
    "info",
    `comment classified: forUs=${decision.forUs} kind=${decision.kind}`,
  );
  if (!decision.forUs || decision.kind === "other") return;

  const marker = replyMarker(args.commentId);
  if (decision.kind === "ignore" || decision.kind === "info") {
    insertWatchNote({
      repo: job.repo,
      issueNumber: args.issueNumber,
      commentId: args.commentId,
      author: args.author,
      kind: decision.kind,
      body: args.body,
    });
    await commentOnIssue(
      client,
      job.repo,
      args.issueNumber,
      `${NOTED_REPLY}\n\n${marker}`,
    );
    return;
  }

  const guides = await loadGuides(job.repo);
  const content = issue.path
    ? await fileAt(client, job.repo, issue.path, "")
    : undefined;
  const code =
    content && issue.path
      ? `${issue.path}:\n${excerpt(content, issue.line_from ?? 1, issue.line_to ?? issue.line_from ?? 1)}`
      : "The file is not available.";
  const answer = await completeWithMermaidTools(
    aiFor(options),
    {
      job: "watch_comment_answer",
      reasoningEffort: "high",
      maxTokens: 6000,
      ...mermaidToolFields(options),
      system: `You are co-maintainer, the code reviewer that opened this issue. Answer the maintainer's question about the problem in plain prose. Write the answer in the same language as the question. Do not use semicolons.

REVIEW GUIDE:
${(guides.shortGuide || guides.skill || "").slice(0, 20_000)}`,
      prompt: `ISSUE #${args.issueNumber}: ${issue.title}
${issue.body_md.slice(0, 6000)}

CURRENT CODE:
${code.slice(0, 20_000)}

QUESTION from ${args.author ?? "a maintainer"}:
${args.body.slice(0, 6000)}`,
    },
    5,
  );
  await usage(answer);
  const text = humanCopy(answer.text).trim();
  if (!text) throw new Error("the AI returned an empty answer");
  await commentOnIssue(
    client,
    job.repo,
    args.issueNumber,
    `${text}\n\n${marker}`,
  );
}

export function registerWatchCommentHandler(): void {
  registerHandler(WATCH_COMMENT_JOB, { run: runWatchComment });
}
