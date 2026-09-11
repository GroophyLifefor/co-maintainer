import { OpenRouterProvider } from "../ai/openrouter.ts";
import { reposDir } from "../config.ts";
import type { Snapshot } from "./snapshot.ts";
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  GitHubClient,
  Json,
  Options,
} from "../types.ts";

type UsageSink = (response: AiResponse) => Promise<void>;
type ProgressSink = (message: string) => void;

const MAX_REVIEW_DIFF_CHARS = 240_000;

function text(value: unknown, limit = 20_000): string {
  const result = String(value ?? "");
  return result.length > limit
    ? `${result.slice(0, limit)}\n[truncated]`
    : result;
}

async function readGuide(repo: string, name: string): Promise<string> {
  try {
    return await Deno.readTextFile(`${reposDir()}/${repo}/${name}`);
  } catch {
    return "";
  }
}

export type { Snapshot };

export async function reviewPullRequest(
  client: GitHubClient,
  options: Options,
  usage?: UsageSink,
  snapshot?: Snapshot,
  ai?: AiProvider,
  progress?: ProgressSink,
): Promise<AiResponse> {
  if (!options.prNumber) throw new Error("review requires a PR number");
  const number = options.prNumber;
  const report = progress ?? (() => {});
  report(`loading PR context for ${options.repo}#${number}`);
  const [pr, allComments, allReviews, shortGuide, detailed, codebase, skill] =
    await Promise.all([
      client.request<Json>(`repos/${options.repo}/pulls/${number}`),
      client.pages<Json>(
        `repos/${options.repo}/issues/${number}/comments`,
      ),
      client.pages<Json>(`repos/${options.repo}/pulls/${number}/reviews`),
      readGuide(options.repo, "PR_REVIEW_GUIDE.md"),
      readGuide(options.repo, "PR_REVIEW_DETAILED_GUIDE.md"),
      readGuide(options.repo, "CODEBASE.md"),
      readGuide(options.repo, "SKILL.md"),
    ]);
  report(
    `context loaded · comments=${allComments.length} · reviews=${allReviews.length} · ` +
      `guide=${shortGuide.length || skill.length} chars · codebase=${codebase.length} chars`,
  );
  const guide = shortGuide || skill;
  const before = (item: Json) =>
    !snapshot || String(item.created_at ?? "") < snapshot.before;
  const comments = allComments.filter(before);
  const reviews = allReviews.filter(before);
  const files = snapshot
    ? ((await client.request<Json>(
      `repos/${options.repo}/compare/${
        snapshot.base ?? String((pr.base as Json | undefined)?.ref ?? "main")
      }...${snapshot.commit}`,
    )).files as Json[] ?? [])
    : await client.pages<Json>(`repos/${options.repo}/pulls/${number}/files`);
  report(`diff files loaded · ${files.length} files`);
  if (!guide) {
    throw new Error(
      `repos/${options.repo}/PR_REVIEW_GUIDE.md was not found; run init first`,
    );
  }
  if (options.debug) {
    console.log(
      `[debug] guides · short=${guide.length} chars · detailed=${detailed.length} chars · codebase=${codebase.length} chars`,
    );
    console.log(
      `[debug] PR #${number} · comments=${comments.length} · reviews=${reviews.length} · files=${files.length}`,
    );
  }

  const patch = files.map((file) => {
    const value = file as Json;
    return `FILE: ${String(value.filename ?? "")}\n${
      text(value.patch, 12_000)
    }`;
  }).join("\n\n");
  const diffWasTruncated = patch.length > MAX_REVIEW_DIFF_CHARS;
  const diff = text(patch, MAX_REVIEW_DIFF_CHARS);
  report(
    `diff prepared · ${patch.length} chars${
      diffWasTruncated ? " · truncated for model context" : ""
    }`,
  );
  const prompt =
    `Review this pull request against the repository's review guide and
codebase conventions. Find only actionable code-level violations supported by
the diff and either the guide or the codebase conventions — a pull request
that departs from how this repository's own code is actually written is a
valid finding even when the review guide has no matching rule.
Do not repeat existing review comments unless the diff still contains the issue.
Do not invent requirements. Ignore bot noise and historical PR identities.
Reason thoroughly, then return concise Markdown only with either:
"## Findings" followed by findings, or "## Findings\\n\\nNo actionable findings."
There is no fixed number of findings. Return every independently actionable
finding supported by the diff and guide, including zero findings when appropriate.
Do not stop early; inspect all supplied diff text first and return the natural
count. If the diff contains a truncation marker, limit claims to the supplied
text and do not imply that omitted files were reviewed.
Do not invent low-value findings.
Each finding must include severity (P0-P3), file and line when available,
problem, why it violates the guide, and a concrete fix.
When a concrete fix changes several adjacent lines in the same file, include
the fix as a fenced \`\`\`diff code block with the file path and +/- lines.
Use a diff only when the exact change is supported by the supplied code; otherwise
describe the fix in prose. Keep the existing finding structure unchanged.

REVIEW GUIDE:
${text(guide)}

DETAILED GUIDE:
${text(detailed)}

CODEBASE CONVENTIONS:
${text(codebase) || "None recorded."}

PULL REQUEST:
${
      JSON.stringify({
        number,
        title: text(pr.title, 2_000),
        body: text(pr.body, 8_000),
        state: pr.state,
        changedFiles: files.map((file) =>
          String((file as Json).filename ?? "")
        ),
        existingComments: comments.map((comment) =>
          text((comment as Json).body, 4_000)
        ),
        existingReviews: reviews.map((review) =>
          text((review as Json).body, 4_000)
        ),
      })
    }

DIFF:
${diff}`;

  const provider = ai ?? new OpenRouterProvider(
    options.aiToken ?? "",
    options.highModel ?? "openai/gpt-5.6-luna",
  );
  const matrix = Math.max(1, options.improveMatrix);
  const request: AiRequest = {
    job: "review_pull_request",
    system:
      "You are a precise open-source code reviewer. Evidence must come from the supplied diff and review guide.",
    prompt,
    maxTokens: 24_000 * matrix,
    reasoningEffort: "high",
  };
  report(
    `AI request · model=${options.highModel ?? "openrouter default"} · ` +
      `prompt=${prompt.length} chars · maxTokens=${request.maxTokens}`,
  );
  if (options.debug) {
    console.log(
      `[debug] review prompt · ${prompt.length} chars · diff=${patch.length} chars`,
    );
    console.log(
      `[debug] openrouter request · model=${
        options.highModel ?? "openai/gpt-5.6-luna"
      } · maxTokens=${request.maxTokens}`,
    );
  }
  let response = await provider.complete(request);
  if (usage) await usage(response);
  report(
    `AI response · input=${response.tokensIn} tokens · output=${response.tokensOut} tokens`,
  );
  if (options.debug) {
    console.log(
      `[debug] initial review response · input=${response.tokensIn} tokens · output=${response.tokensOut} tokens`,
    );
    console.log(`\n----- INITIAL REVIEW -----\n${response.text}\n`);
  }
  if (!response.text.trim()) {
    throw new Error(
      "OpenRouter returned an empty review; the reasoning budget may have been exhausted",
    );
  }
  let reviewText = response.text.trim();
  for (let pass = 2; pass <= matrix; pass++) {
    const improvementRequest: AiRequest = {
      ...request,
      job: "improve_review",
      prompt:
        `Audit the draft review below against the complete pull-request diff
and the supplied review guides. Preserve valid findings, correct inaccurate ones,
remove duplicate or unsupported ones, and add every missing actionable finding.
Do not stop early and do not invent requirements. Keep the existing finding
structure unchanged. Return only the complete revised review in the same format.

ORIGINAL REVIEW CONTEXT:
${prompt}

DRAFT REVIEW:
${reviewText}`,
    };
    if (options.debug) {
      console.log(
        `[debug] improvement ${
          pass - 1
        } request · prompt=${improvementRequest.prompt.length} chars · maxTokens=${improvementRequest.maxTokens}`,
      );
    }
    report(`AI improvement pass ${pass - 1} of ${matrix - 1}`);
    response = await provider.complete(improvementRequest);
    if (usage) await usage(response);
    report(
      `AI improvement response · input=${response.tokensIn} tokens · ` +
        `output=${response.tokensOut} tokens`,
    );
    if (!response.text.trim()) {
      throw new Error(
        `OpenRouter returned an empty review improvement at pass ${pass - 1}`,
      );
    }
    reviewText = response.text.trim();
    if (options.debug) {
      console.log(
        `[debug] improvement ${
          pass - 1
        } response · input=${response.tokensIn} tokens · output=${response.tokensOut} tokens`,
      );
      console.log(
        `\n----- IMPROVED REVIEW ${pass - 1} -----\n${reviewText}\n`,
      );
    }
  }
  return {
    ...response,
    text: `## Severity

- P0 — Critical: production outage, data loss, or security issue.
- P1 — High: major behavior is broken and should be fixed before merge.
- P2 — Medium: important correctness or maintainability issue.
- P3 — Low: minor, non-blocking improvement or edge case.

${reviewText}`,
  };
}
