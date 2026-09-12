import { OpenRouterProvider } from "../ai/openrouter.ts";
import { completeWithMermaidTools } from "../ai/mermaid_loop.ts";
import { reposDir } from "../config.ts";
import { buildMap } from "./map.ts";
import { computeScope } from "./scope.ts";
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

const REVIEW_DIAGRAM_RULES = `Use Mermaid only when a diagram materially
clarifies a multi-step flow, lifecycle, dependency, data model, protocol, or
architecture. Use zero diagrams when prose is clearer. During the initial
review, use at most one diagram. If a user later asks for detailed reasoning in
a reply, that reply may use up to five diagrams, but only when each adds a
distinct useful view.
${MERMAID_GUIDANCE}
Do not invent nodes, actors, states, services, tables, or events. If syntax is
uncertain, omit the diagram.`;

/** Without tool support the model cannot read the Mermaid syntax docs, so
 * asking for a diagram only invites invented syntax. */
export const NO_DIAGRAM_RULES =
  `Do not use Mermaid or any other diagram. Explain with prose only.`;

const DIAGRAM_PROMPT_RULES = `Use a Mermaid fenced code block only when it
materially improves the explanation. This review may contain at most one
diagram in total, and most reviews need none. Its type must be one of the types
named in the system instructions, and you must read that type with
read-mermaid-syntaxes first. Keep labels short and grounded in the supplied
evidence. Never use a diagram for a one-line fix or for obvious cause and
effect. Close every fenced block.`;

export function reviewSystemPrompt(diagrams: boolean): string {
  return `${REVIEW_ROLE}
${diagrams ? REVIEW_DIAGRAM_RULES : NO_DIAGRAM_RULES}`;
}

function text(value: unknown, limit = 20_000): string {
  const result = String(value ?? "");
  return result.length > limit
    ? `${result.slice(0, limit)}\n[truncated]`
    : result;
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
    const counts = Number.isFinite(changes) && changes > 0
      ? `${changes} changed lines (+${additions} -${deletions})`
      : "an unreported number of changed lines";
    return `[${status}; ${counts}; diff withheld by GitHub, not shown here. ` +
      `Do not treat this file as unchanged and do not report its contents.]`;
  }
  if (patch.length > MAX_FILE_PATCH_CHARS) {
    return `${patch.slice(0, MAX_FILE_PATCH_CHARS)}\n[${status}; ${changes} ` +
      `changed lines total; this file's diff is cut off here, later hunks are ` +
      `not shown.]`;
  }
  return patch;
}

export async function readGuide(repo: string, name: string): Promise<string> {
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
      `guide=${
        shortGuide.length || skill.length
      } chars · codebase=${codebase.length} chars`,
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

  // What the author actually wrote this round, as opposed to code that
  // arrived by merging the default branch in — see scope.ts. A re-review
  // round's diff regularly carries a `merge main` that dwarfs the PR's own
  // change and that no human reviewer reads either; --review-upstream turns
  // this off and reviews everything, matching the pre-scope behavior.
  const headSha = snapshot?.commit ??
    String((pr.head as Json | undefined)?.sha ?? "");
  const baseRevision = snapshot?.base ??
    String((pr.base as Json | undefined)?.ref ?? "main");
  if (options.reviewUpstream) {
    report("scope skipped · --review-upstream");
  } else if (!headSha) {
    report("scope skipped · no head commit for this pull request");
  }
  const scope = options.reviewUpstream || !headSha
    ? undefined
    : await computeScope(options.repo, baseRevision, headSha);
  if (!options.reviewUpstream && headSha && !scope) {
    report("scope unavailable · reviewing every changed file");
  }

  const named = files.map((file) => {
    const value = file as Json;
    return { file: value, path: String(value.filename ?? "") };
  });
  const ownFiles = scope
    ? named.filter(({ path }) => !scope.upstreamFiles.has(path))
    : named;
  const upstreamFiles = scope
    ? named.filter(({ path }) => scope.upstreamFiles.has(path))
    : [];
  if (scope) {
    report(
      `scope resolved · own=${ownFiles.length} files · upstream=${upstreamFiles.length} files`,
    );
  }

  const ownPatch = ownFiles.map(({ file, path }) =>
    `FILE: ${path}\n${filePatch(file)}`
  ).join("\n\n");
  const diffWasTruncated = ownPatch.length > MAX_REVIEW_DIFF_CHARS;
  const ownDiff = text(ownPatch, MAX_REVIEW_DIFF_CHARS);
  const upstreamListing = upstreamFiles.map(({ file, path }) =>
    `- ${path} (+${Number(file.additions ?? 0)} -${
      Number(file.deletions ?? 0)
    })`
  ).join("\n");
  const diff = upstreamFiles.length === 0 ? ownDiff : `${ownDiff}

UPSTREAM CONTEXT — arrived via a merge this round, not authored by this pull
request. Do not raise a finding located only in this code; only note an
interaction if the pull request's own change above relies on or conflicts with
one of these files, and never mark that finding blocking:
${text(upstreamListing, 20_000)}`;

  // The map answers what the diff cannot: who calls the changed symbols and
  // whether a test reaches them. Off by default so the review path stays
  // self-contained, and so its effect can be measured against a run without it.
  let map = "";
  if (options.map) {
    if (!headSha) {
      report("map skipped · no head commit for this pull request");
    } else {
      try {
        const built = await buildMap(
          options.repo,
          number,
          headSha,
          named.map(({ path, file }) => ({
            path,
            changes: Number(file.changes ?? 0),
          })),
          {
            allowInstall: options.allowToolInstall,
            priority: scope?.ownFiles,
          },
        );
        map = built.text;
        report(
          `map ready · ${built.queried.length} files · ${built.chars} chars`,
        );
      } catch (error) {
        // A missing clone or a codegraph failure must not cost the review.
        report(`map unavailable · ${String(error)}`);
      }
    }
  }
  report(
    `diff prepared · ${ownPatch.length} chars${
      diffWasTruncated ? " · truncated for model context" : ""
    }`,
  );
  const provider = ai ?? new OpenRouterProvider(
    options.aiToken ?? "",
    options.highModel ?? "openai/gpt-5.6-luna",
  );
  const diagrams = provider.supportsTools !== false;
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
When the DIFF section below has an UPSTREAM CONTEXT part, that code arrived
through a merge and was not authored by this pull request; do not raise a
finding located only there, and never mark blocking a finding whose only
support is upstream context.
Each finding must use this exact structure, keeping the default finding under
120 words excluding an optional diagram:

### [P1 · blocking] \`path/to/file.ts\` — \`symbol()\`
Location: \`path/to/file.ts:42\`

One sentence describing what is wrong and its impact.

Add one short evidence paragraph explaining the mechanism or reproduction.
Do not add labels such as Mechanism, Symptom, Scenario, Verified, Repro,
Options, or Scope unless that detail is necessary to understand a complex
finding. End every finding with this exact sentence on its own line:
"If you'd like me to explain it in more detail, please ask." No finding may
omit it and nothing may follow it.

Use P0-P3 severity and exactly either "blocking" or "non-blocking".
Keep the Location line machine-readable; it is removed from user-facing
review copies. Use Markdown backticks around paths and symbols.
${diagrams ? DIAGRAM_PROMPT_RULES : NO_DIAGRAM_RULES}

REVIEW GUIDE:
${text(guide)}

DETAILED GUIDE:
${text(detailed)}

CODEBASE CONVENTIONS:
${text(codebase) || "None recorded."}

REPOSITORY MAP:
${
      map
        ? `Symbols in the changed files, their callers, and whether a test
reaches them. Use it to judge completeness and coverage, which the diff alone
cannot show. Absence of a caller or a test here is evidence, not proof.

${text(map, 60_000)}`
        : "Not available for this review."
    }

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

  const matrix = Math.max(1, options.improveMatrix);
  const request: AiRequest = {
    job: "review_pull_request",
    system: reviewSystemPrompt(diagrams),
    prompt,
    // openai/gpt-5.6-luna supports effort above "high" (max > xhigh > high on
    // OpenRouter's scale for this model; verified via its /models endpoint,
    // not assumed). Reasoning tokens draw from the same completion budget the
    // provider caps at 128,000, so maxTokens has to grow with the effort or a
    // "max"-effort call can spend its whole budget thinking and return no
    // findings text at all.
    maxTokens: 48_000 * matrix,
    reasoningEffort: "max",
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
  let response = await completeWithMermaidTools(provider, request, 1);
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
    response = await completeWithMermaidTools(provider, improvementRequest, 1);
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
