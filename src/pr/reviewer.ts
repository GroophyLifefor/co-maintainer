import { OpenRouterProvider } from "../ai/openrouter.ts";
import {
  completeWithMermaidTools,
  type ToolHandler,
} from "../ai/mermaid_loop.ts";
import { loadGuides } from "../review/guides.ts";
import type { Revision } from "../review/revision.ts";
import { computeScope } from "./scope.ts";
import { prepareCodegraphTools } from "./codegraph_tools.ts";
import {
  needsSummary,
  READ_FULL_DIFF_TOOL,
  readFullDiff,
  summarizeDiff,
} from "./diff_summary.ts";
import { numberPatch } from "./hunks.ts";
import {
  FINDINGS_JSON_INSTRUCTIONS,
  FINDINGS_JSON_SCHEMA,
  findingsMarkdownFromJson,
} from "./findings_json.ts";
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

export type ReviewExtras = {
  carryPrompt?: string;
  unchangedPaths?: string[];
  prepareCodegraphTools?: () => Promise<ToolHandler[]>;
};

const MAX_REVIEW_DIFF_CHARS = 240_000;
export const MERMAID_GUIDANCE = `Mermaid selection and minimal syntax:
flowchart = decisions, branches, pipelines, and fallback paths;
swimlane-beta = work crossing owners, actors, services, teams, or layers;
sequenceDiagram = ordered calls, webhooks, retries, responses, and timing;
classDiagram = class, interface, type, inheritance, or composition relationships;
stateDiagram-v2 = lifecycle and state transitions;
erDiagram = database entities, keys, and cardinality;
requirementDiagram = requirements linked to tests or implementation;
usecase-beta = actors and system capabilities;
C4Context = users, systems, boundaries, and integrations;
zenuml = compact nested call sequences;
packet = binary fields, bit ranges, and protocol layout;
architecture-beta = services, containers, storage, and deployment topology;
eventmodeling = commands, events, processors, read models, and timelines;
treeView-beta = directory, file, module, or dependency hierarchy.
If a diagram is useful, call read-mermaid-syntaxes before writing any Mermaid.
Request every type you need in a single call, because repeated tool rounds are
capped. Use the smallest type that matches the evidence.`;

const REVIEW_ROLE = `You are a precise open-source code reviewer.
Evidence must come from the supplied diff and review guide. Keep findings
concise by default.`;

const REVIEW_DIAGRAM_RULES = `People generally find it easier to understand the
problem you've identified when it's presented in diagrams. When a multi-step
flow, lifecycle, dependency, data model, protocol, or architecture change is
part of the finding, you are expected to draw it — do not skip the diagram
just to avoid the extra tool call. During the initial review, use at most one
diagram, so spend it on the finding that benefits most. If a user later asks
for detailed reasoning in a reply, that reply may use up to five diagrams, but
only when each adds a distinct useful view.
${MERMAID_GUIDANCE}
Do not invent nodes, actors, states, services, tables, or events. Omit the
diagram only when no finding actually fits one of the categories above, or
when the syntax is genuinely uncertain.`;

/** Without tool support the model cannot read the Mermaid syntax docs, so
 * asking for a diagram only invites invented syntax. */
export const NO_DIAGRAM_RULES = `Do not use Mermaid or any other diagram. Explain with prose only.`;

const DIAGRAM_PROMPT_RULES = `People generally find it easier to understand the
problem you've identified when it's presented in diagrams. When a finding
involves a multi-step flow, lifecycle, dependency, data model, protocol, or
architecture change, you are expected to include a Mermaid fenced code block
for it — reading the syntax with read-mermaid-syntaxes first is a small cost,
not a reason to skip the diagram. This review may contain at most one diagram
in total, so if more than one finding qualifies, pick the one the diagram
clarifies most. Its type must be one of the types named in the system
instructions. Keep labels short and grounded in the supplied evidence. A
one-line fix or an obvious, single-step cause and effect genuinely needs no
diagram — that is the only reason to omit one. Close every fenced block.`;

export function reviewSystemPrompt(diagrams: boolean): string {
  return `${REVIEW_ROLE}
${diagrams ? REVIEW_DIAGRAM_RULES : NO_DIAGRAM_RULES}`;
}

/** Shared PR and local/remote workspace review instructions: confirm claims
 * against the indexed graph, not only the diff slice. */
export const CODEGRAPH_DIFF_VERIFICATION = `Examine the changes line by line, not just file by file — a single file can
contain more than one independent defect, and a change that looks fine in
isolation can be wrong once you trace what calls it or what else it affects.
When a finding depends on behavior outside the changed lines, confirm it with
codegraph-node, codegraph-callers, codegraph-callees, codegraph-impact, and
codegraph-affected before reporting it. Drop or correct findings that only seem
plausible from the diff but contradict unchanged callers, callees, or the same
pattern elsewhere in the repo. Use those tools to check blast radius and whether
a test reaches the path — do not guess coverage or impact from the diff alone
when a tool can answer. A missing regression test is not a substitute for
identifying the concrete input or code path that misbehaves when you can.`;

function text(value: unknown, limit = 20_000): string {
  const result = String(value ?? "");
  return result.length > limit
    ? `${result.slice(0, limit)}\n[truncated]`
    : result;
}

type UsageSinkForNormalize = UsageSink;

/** Turns a model reply into the Markdown every consumer already parses
 * (CORE-40 / F02). A reply that is not usable JSON is retried once with an
 * explicit reminder; if that also fails, the raw text is returned so the
 * legacy Markdown parser can still read it. This keeps a provider that ignores
 * `response_format` working, and never drops a review on the floor. */
async function normalizeReviewResponse(
  provider: AiProvider,
  request: AiRequest,
  response: AiResponse,
  extraTools: ToolHandler[],
  maxToolRounds: number,
  usage: UsageSinkForNormalize | undefined,
  report: ProgressSink,
  options: Options,
): Promise<string> {
  const direct = findingsMarkdownFromJson(response.text);
  if (direct !== undefined) return direct;
  report("AI response was not valid JSON, asking once more");
  const retry = await completeWithMermaidTools(
    provider,
    {
      ...request,
      job: "review_pull_request_retry",
      prompt: `${request.prompt}\n\nThe previous answer was not valid JSON. Return only the JSON object described above, with no prose and no code fence.`,
    },
    1,
    extraTools,
    maxToolRounds,
  );
  if (usage) await usage(retry);
  if (options.debug) {
    console.log(
      `[debug] JSON retry response · input=${retry.tokensIn} tokens · output=${retry.tokensOut} tokens`,
    );
    console.log(`\n----- JSON RETRY -----\n${retry.text}\n`);
  }
  const afterRetry = findingsMarkdownFromJson(retry.text);
  if (afterRetry !== undefined) return afterRetry;
  report("AI response was still not JSON, falling back to Markdown parsing");
  return response.text.trim();
}

const MAX_FILE_PATCH_CHARS = 12_000;

/** GitHub omits `patch` entirely for files it considers too large, and the file
 * still appears in the compare response with only its counts. Rendering that as
 * an empty body reads as "this file did not change", and a reviewer then
 * reports the absence as a finding (a lockfile that was in fact regenerated,
 * say). Say plainly that the hunks are missing, and mark a per-file truncation
 * for the same reason. */
export function filePatch(file: Json): string {
  const patch = String(file.patch ?? "");
  const status = String(file.status ?? "modified");
  const changes = Number(file.changes ?? 0);
  const additions = Number(file.additions ?? 0);
  const deletions = Number(file.deletions ?? 0);
  if (patch === "") {
    const counts =
      Number.isFinite(changes) && changes > 0
        ? `${changes} changed lines (+${additions} -${deletions})`
        : "an unreported number of changed lines";
    return (
      `[${status}; ${counts}; diff withheld by GitHub, not shown here. ` +
      `Do not treat this file as unchanged and do not report its contents.]`
    );
  }
  if (patch.length > MAX_FILE_PATCH_CHARS) {
    return (
      `${numberPatch(patch.slice(0, MAX_FILE_PATCH_CHARS))}\n[${status}; ${changes} ` +
      `changed lines total; this file's diff is cut off here, later hunks are ` +
      `not shown.]`
    );
  }
  return numberPatch(patch);
}

// Uncapped, a 100,000-line diff would ask for 1,000+ tool-loop rounds, each
// able to spend multiple external calls.
export function clampToolRounds(totalDiffLines: number): number {
  return Math.min(Math.round(4 + totalDiffLines / 100), 8);
}

// Uncapped, --improve-matrix scales maxTokens past what most providers'
// 128k-token context can hold on its own, before the prompt even counts.
export function clampImproveMatrix(matrix: number): number {
  return Math.min(Math.max(1, matrix), 4);
}

export async function readGuide(repo: string, name: string): Promise<string> {
  const guides = await loadGuides(repo);
  switch (name) {
    case "PR_REVIEW_GUIDE.md":
      return guides.shortGuide;
    case "PR_REVIEW_DETAILED_GUIDE.md":
      return guides.detailed;
    case "CODEBASE.md":
      return guides.codebase;
    case "SKILL.md":
      return guides.skill;
    default:
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
  extras?: ReviewExtras,
): Promise<
  AiResponse & { visiblePaths: string[]; guideBuiltAt: string | null }
> {
  if (!options.prNumber) throw new Error("review requires a PR number");
  const number = options.prNumber;
  const report = progress ?? (() => {});
  report(`loading PR context for ${options.repo}#${number}`);
  const [pr, allComments, allReviews, guides] = await Promise.all([
    client.request<Json>(`repos/${options.repo}/pulls/${number}`),
    client.pages<Json>(`repos/${options.repo}/issues/${number}/comments`),
    client.pages<Json>(`repos/${options.repo}/pulls/${number}/reviews`),
    loadGuides(options.repo),
  ]);
  const { shortGuide, detailed, codebase, skill } = guides;
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
    ? (((
        await client.request<Json>(
          `repos/${options.repo}/compare/${
            snapshot.base ??
            String((pr.base as Json | undefined)?.ref ?? "main")
          }...${snapshot.commit}`,
        )
      ).files as Json[]) ?? [])
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

  // What the author actually wrote this round, as opposed to code that
  // arrived by merging the default branch in — see scope.ts. A re-review
  // round's diff regularly carries a `merge main` that dwarfs the PR's own
  // change and that no human reviewer reads either; --review-upstream turns
  // this off and reviews everything, matching the pre-scope behavior.
  const headSha =
    snapshot?.commit ?? String((pr.head as Json | undefined)?.sha ?? "");
  const baseRevision =
    snapshot?.base ?? String((pr.base as Json | undefined)?.ref ?? "main");
  if (options.reviewUpstream) {
    report("scope skipped · --review-upstream");
  } else if (!headSha) {
    report("scope skipped · no head commit for this pull request");
  }
  const scope =
    options.reviewUpstream || !headSha
      ? undefined
      : await computeScope(options.repo, baseRevision, headSha);
  if (!options.reviewUpstream && headSha && !scope) {
    report("scope unavailable · reviewing every changed file");
  }

  const named = files.map((file) => {
    const value = file as Json;
    return { file: value, path: String(value.filename ?? "") };
  });
  const unchanged = new Set(extras?.unchangedPaths ?? []);
  const ownFiles = (
    scope ? named.filter(({ path }) => !scope.upstreamFiles.has(path)) : named
  ).filter(({ path }) => !unchanged.has(path));
  const upstreamFiles = scope
    ? named.filter(({ path }) => scope.upstreamFiles.has(path))
    : [];
  if (scope) {
    report(
      `scope resolved · own=${ownFiles.length} files · upstream=${upstreamFiles.length} files`,
    );
  }

  // Built only if needed: OpenRouterProvider's constructor requires a real
  // API key, which a fake-AI test run never has.
  const filesNeedSummary = ownFiles.some(({ file }) =>
    needsSummary(Number(file.changes ?? 0), String(file.patch ?? "")),
  );
  const lowProvider = filesNeedSummary
    ? (ai ??
      new OpenRouterProvider(
        options.aiToken ?? "",
        options.lowModel ?? "openai/gpt-oss-120b",
      ))
    : undefined;
  const patchByPath = new Map<string, string>();
  const [ownSections, codegraphTools] = await Promise.all([
    Promise.all(
      ownFiles.map(async ({ file, path }) => {
        const changes = Number(file.changes ?? 0);
        const patch = String(file.patch ?? "");
        if (!needsSummary(changes, patch)) {
          return `FILE: ${path}\n${filePatch(file)}`;
        }
        patchByPath.set(path, patch);
        const description = await summarizeDiff(
          path,
          patch,
          lowProvider!,
          usage,
        );
        report(`summarized large diff · ${path} · ${changes} changed lines`);
        return (
          `FILE: ${path}\n[${changes} changed lines — summarized below; ` +
          `call read-full-diff("${path}") for the complete diff if this is not ` +
          `enough]\n${description}`
        );
      }),
    ),
    options.useCodegraph && headSha
      ? prepareCodegraphTools(options.repo, number, headSha)
      : Promise.resolve([] as ToolHandler[]),
  ]);
  if (options.useCodegraph) {
    report(
      `codegraph tools · ${codegraphTools.length > 0 ? "ready" : "unavailable"}`,
    );
  }
  const extraTools: ToolHandler[] = [
    ...codegraphTools,
    ...(patchByPath.size > 0
      ? [
          {
            name: "read-full-diff",
            tool: READ_FULL_DIFF_TOOL,
            run: (args: unknown) => readFullDiff(patchByPath, args),
          },
        ]
      : []),
  ];

  // Bigger own-scope diffs need more codegraph round-trips to trace — fixed
  // at 3 rounds regardless of size caused the model to run out mid-review on
  // large PRs (verified via a tokio benchmark run: it hallucinated fake
  // tool-call text instead of a finding once tools were dropped).
  const totalDiffLines = ownFiles.reduce(
    (sum, { file }) => sum + Number(file.changes ?? 0),
    0,
  );
  const maxToolRounds = clampToolRounds(totalDiffLines);
  report(
    `tool rounds · ${maxToolRounds} (own diff ${totalDiffLines} changed lines)`,
  );

  const ownPatch = ownSections.join("\n\n");
  const diffWasTruncated = ownPatch.length > MAX_REVIEW_DIFF_CHARS;
  const ownDiff = text(ownPatch, MAX_REVIEW_DIFF_CHARS);
  const unchangedListing = extras?.unchangedPaths?.length
    ? `\nUNCHANGED SINCE LAST REVIEW (paths only — do not re-report findings here):\n${extras.unchangedPaths
        .map((path) => `- ${path}`)
        .join("\n")}`
    : "";
  const upstreamListing = upstreamFiles
    .map(
      ({ file, path }) =>
        `- ${path} (+${Number(file.additions ?? 0)} -${Number(file.deletions ?? 0)})`,
    )
    .join("\n");
  const diff =
    upstreamFiles.length === 0
      ? `${ownDiff}${unchangedListing}`
      : `${ownDiff}

UPSTREAM CONTEXT — arrived via a merge this round, not authored by this pull
request. Do not raise a finding located only in this code; only note an
interaction if the pull request's own change above relies on or conflicts with
one of these files, and never mark that finding blocking:
${upstreamListing}${unchangedListing}`;

  report(
    `diff prepared · ${ownPatch.length} chars${
      diffWasTruncated ? " · truncated for model context" : ""
    }`,
  );
  const provider =
    ai ??
    new OpenRouterProvider(
      options.aiToken ?? "",
      options.highModel ?? "openai/gpt-5.6-luna",
    );
  const diagrams = provider.supportsTools !== false;
  const carryBlock = extras?.carryPrompt ? `${extras.carryPrompt}\n` : "";
  const prompt = `Review this pull request against the repository's review guide and
codebase conventions. Find only actionable code-level violations supported by
the diff and either the guide or the codebase conventions — a pull request
that departs from how this repository's own code is actually written is a
valid finding even when the review guide has no matching rule.
Do not repeat existing review comments unless the diff still contains the issue.
Do not invent requirements. Ignore bot noise and historical PR identities.
Reason thoroughly, then answer with the JSON object described below and nothing
else. There is no fixed number of findings. Return every independently
actionable finding supported by the diff and guide, including zero findings
when appropriate. Do not stop early; inspect all supplied diff text first and
return the natural count. If the diff contains a truncation marker, limit
claims to the supplied text and do not imply that omitted files were reviewed.
Do not invent low-value findings.
When the DIFF section below has an UPSTREAM CONTEXT part, that code arrived
through a merge and was not authored by this pull request; do not raise a
finding located only there, and never mark blocking a finding whose only
support is upstream context.
${CODEGRAPH_DIFF_VERIFICATION}
Keep the default finding's "body" under 120 words excluding an optional
suggestion. Write prose only: do not emit Markdown headings, a Location line,
backticks around the path, or the sentence "If you'd like me to explain it in
more detail, please ask." Our code renders the heading, the location, and the
suggestion from your JSON fields. Use P0-P3 severity, and true for blocking.
Every diff line in the DIFF section starts with its line number in the new
file. Copy "lineFrom" and "lineTo" from that column instead of counting from
the @@ header. Removed lines have no number, so anchor a finding about removed
code to the nearest numbered line.
${diagrams ? DIAGRAM_PROMPT_RULES : NO_DIAGRAM_RULES}
${FINDINGS_JSON_INSTRUCTIONS}

REVIEW GUIDE:
${guide}

DETAILED GUIDE:
${detailed}

CODEBASE CONVENTIONS:
${codebase || "None recorded."}

PULL REQUEST:
${JSON.stringify({
  number,
  title: String(pr.title ?? ""),
  body: String(pr.body ?? ""),
  state: pr.state,
  changedFiles: files.map((file) => String((file as Json).filename ?? "")),
  existingComments: comments.map((comment) =>
    String((comment as Json).body ?? ""),
  ),
  existingReviews: reviews.map((review) => String((review as Json).body ?? "")),
})}

${carryBlock}DIFF:
${diff}`;

  const matrix = clampImproveMatrix(options.improveMatrix);
  const request: AiRequest = {
    job: "review_pull_request",
    system: reviewSystemPrompt(diagrams),
    prompt,
    maxTokens: 24_000 * matrix,
    reasoningEffort: "high",
    responseFormat: FINDINGS_JSON_SCHEMA,
  };
  report(
    `AI request · model=${options.highModel ?? "openrouter default"} · ` +
      `prompt=${prompt.length} chars · maxTokens=${request.maxTokens}`,
  );
  if (options.debug) {
    console.log(
      `[debug] review prompt · ${prompt.length} chars · diff=${diff.length} chars`,
    );
    console.log(
      `[debug] openrouter request · model=${
        options.highModel ?? "openai/gpt-5.6-luna"
      } · maxTokens=${request.maxTokens}`,
    );
  }
  let response = await completeWithMermaidTools(
    provider,
    request,
    1,
    extraTools,
    maxToolRounds,
  );
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
  // The model returns JSON; we render the Markdown (CORE-40 / F02). A reply
  // that is not usable JSON is retried once and then falls back to the legacy
  // Markdown parser, so a provider that ignores the schema still works.
  let reviewText = await normalizeReviewResponse(
    provider,
    request,
    response,
    extraTools,
    maxToolRounds,
    usage,
    report,
    options,
  );
  for (let pass = 2; pass <= matrix; pass++) {
    const improvementRequest: AiRequest = {
      ...request,
      job: "improve_review",
      prompt: `Audit the draft review below against the complete pull-request diff
and the supplied review guides. Preserve valid findings, correct inaccurate ones,
remove duplicate or unsupported ones, and add every missing actionable finding.
Do not stop early and do not invent requirements. Return the complete revised
review as the same JSON object the instructions above describe, and nothing else.

ORIGINAL REVIEW CONTEXT:
${prompt}

DRAFT REVIEW (Markdown rendering of the previous JSON answer):
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
    response = await completeWithMermaidTools(
      provider,
      improvementRequest,
      1,
      extraTools,
      maxToolRounds,
    );
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
    reviewText = await normalizeReviewResponse(
      provider,
      improvementRequest,
      response,
      extraTools,
      maxToolRounds,
      usage,
      report,
      options,
    );
    if (options.debug) {
      console.log(
        `[debug] improvement ${
          pass - 1
        } response · input=${response.tokensIn} tokens · output=${response.tokensOut} tokens`,
      );
      console.log(`\n----- IMPROVED REVIEW ${pass - 1} -----\n${reviewText}\n`);
    }
  }
  const visiblePaths = ownFiles.map(({ path }) => path);
  return {
    ...response,
    text: `## Severity

- P0 — Critical: production outage, data loss, or security issue.
- P1 — High: major behavior is broken and should be fixed before merge.
- P2 — Medium: important correctness or maintainability issue.
- P3 — Low: minor, non-blocking improvement or edge case.

${reviewText}`,
    visiblePaths,
    guideBuiltAt: guides.guideBuiltAt,
  };
}

function revisionToGithubFiles(revision: Revision): Json[] {
  return revision.files.map((file) => ({
    filename: file.path,
    status: file.status === "renamed" ? "renamed" : file.status,
    previous_filename: file.previousPath,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    patch: file.patch,
  }));
}

/** Local workspace review — same prompt loop as PR review without GitHub. */
export async function reviewWorkspaceRevision(
  revision: Revision,
  options: Options,
  headSha: string,
  usage?: UsageSink,
  ai?: AiProvider,
  progress?: ProgressSink,
  extras?: ReviewExtras,
): Promise<
  AiResponse & {
    visiblePaths: string[];
    guideBuiltAt: string | null;
    codegraphState: "used" | "disabled" | "unavailable";
  }
> {
  const report = progress ?? (() => {});
  const guides = await loadGuides(options.repo);
  const { shortGuide, detailed, codebase, skill } = guides;
  const guide = shortGuide || skill;
  if (!guide) {
    throw new Error(
      `repos/${options.repo}/PR_REVIEW_GUIDE.md was not found; run init first`,
    );
  }
  const files = revisionToGithubFiles(revision);
  const unchanged = new Set(extras?.unchangedPaths ?? []);
  const ownFiles = files
    .map((file) => ({
      file,
      path: String(file.filename ?? ""),
    }))
    .filter(({ path }) => !unchanged.has(path));
  const patchByPath = new Map<string, string>();
  const ownSections = await Promise.all(
    ownFiles.map(async ({ file, path }) => {
      const changes = Number(file.changes ?? 0);
      const patch = String(file.patch ?? "");
      const lowProvider = needsSummary(changes, patch)
        ? (ai ??
          new OpenRouterProvider(
            options.aiToken ?? "",
            options.lowModel ?? "openai/gpt-oss-120b",
          ))
        : undefined;
      if (!lowProvider) return `FILE: ${path}\n${filePatch(file)}`;
      patchByPath.set(path, patch);
      const description = await summarizeDiff(path, patch, lowProvider, usage);
      return `FILE: ${path}\n[${changes} changed lines — summarized below]\n${description}`;
    }),
  );
  const codegraphTools = options.useCodegraph
    ? extras?.prepareCodegraphTools
      ? await extras.prepareCodegraphTools()
      : await prepareCodegraphTools(options.repo, 0, headSha)
    : [];
  const extraTools: ToolHandler[] = [
    ...codegraphTools,
    ...(patchByPath.size > 0
      ? [
          {
            name: "read-full-diff",
            tool: READ_FULL_DIFF_TOOL,
            run: (args: unknown) => readFullDiff(patchByPath, args),
          },
        ]
      : []),
  ];
  const totalDiffLines = ownFiles.reduce(
    (sum, { file }) => sum + Number(file.changes ?? 0),
    0,
  );
  const maxToolRounds = clampToolRounds(totalDiffLines);
  const ownDiff = text(ownSections.join("\n\n"), MAX_REVIEW_DIFF_CHARS);
  const unchangedListing = extras?.unchangedPaths?.length
    ? `\nUNCHANGED SINCE LAST REVIEW (paths only):\n${extras.unchangedPaths
        .map((path) => `- ${path}`)
        .join("\n")}`
    : "";
  const carryBlock = extras?.carryPrompt ? `${extras.carryPrompt}\n` : "";
  const provider =
    ai ??
    new OpenRouterProvider(
      options.aiToken ?? "",
      options.highModel ?? "openai/gpt-5.6-luna",
    );
  const diagrams = provider.supportsTools !== false;
  const prompt = `Review these local changes against the repository's review guide and
codebase conventions. Find only actionable code-level violations supported by
the diff and either the guide or the codebase conventions.
Do not invent low-value findings. If the diff contains a truncation marker or a
file is summarized, limit claims to the supplied text and use read-full-diff or
codegraph tools before asserting behavior outside what was shown.
${CODEGRAPH_DIFF_VERIFICATION}
${diagrams ? DIAGRAM_PROMPT_RULES : NO_DIAGRAM_RULES}
${FINDINGS_JSON_INSTRUCTIONS}

REVIEW GUIDE:
${guide}

DETAILED GUIDE:
${detailed}

CODEBASE CONVENTIONS:
${codebase || "None recorded."}

WORKSPACE:
${JSON.stringify({
  branch: revision.baseLabel,
  changedFiles: ownFiles.map(({ path }) => path),
})}

${carryBlock}DIFF:
${ownDiff}${unchangedListing}`;

  const matrix = clampImproveMatrix(options.improveMatrix);
  const request: AiRequest = {
    job: "review_local",
    system: reviewSystemPrompt(diagrams),
    prompt,
    maxTokens: 24_000 * matrix,
    reasoningEffort: "high",
    responseFormat: FINDINGS_JSON_SCHEMA,
  };
  report(`AI request · prompt=${prompt.length} chars`);
  let response = await completeWithMermaidTools(
    provider,
    request,
    1,
    extraTools,
    maxToolRounds,
  );
  if (usage) await usage(response);
  if (!response.text.trim()) {
    throw new Error("OpenRouter returned an empty review");
  }
  let reviewText = await normalizeReviewResponse(
    provider,
    request,
    response,
    extraTools,
    maxToolRounds,
    usage,
    report,
    options,
  );
  for (let pass = 2; pass <= matrix; pass++) {
    const improvementRequest: AiRequest = {
      ...request,
      job: "improve_review",
      prompt: `Audit the draft review below against the complete diff and guides.
Preserve valid findings, correct inaccurate ones, remove duplicate or
unsupported ones, and add every missing actionable finding. Re-check each
finding with codegraph when it depends on behavior outside the diff; remove
findings that only looked plausible from the diff slice.
Return the complete revised review as the same JSON object, and nothing else.

ORIGINAL REVIEW CONTEXT:
${prompt}

DRAFT REVIEW (Markdown rendering of the previous JSON answer):
${reviewText}`,
    };
    response = await completeWithMermaidTools(
      provider,
      improvementRequest,
      1,
      extraTools,
      maxToolRounds,
    );
    if (usage) await usage(response);
    reviewText = await normalizeReviewResponse(
      provider,
      improvementRequest,
      response,
      extraTools,
      maxToolRounds,
      usage,
      report,
      options,
    );
  }
  const codegraphState = !options.useCodegraph
    ? "disabled"
    : codegraphTools.length > 0
      ? "used"
      : "unavailable";
  return {
    ...response,
    text: `## Severity

- P0 — Critical: production outage, data loss, or security issue.
- P1 — High: major behavior is broken and should be fixed before merge.
- P2 — Medium: important correctness or maintainability issue.
- P3 — Low: minor, non-blocking improvement or edge case.

${reviewText}`,
    visiblePaths: ownFiles.map(({ path }) => path),
    guideBuiltAt: guides.guideBuiltAt,
    codegraphState,
  };
}
