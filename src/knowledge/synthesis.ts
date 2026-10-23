import { AiBatch } from "../ai/batch.ts";
import type { AiValidator } from "../ai/batch.ts";
import { isPullRequestFact } from "./guide.ts";
import { sectionAllowsPrFacts, sectionTitles } from "./sections.ts";
import type { AiProvider, AiRequest, AiResponse, Options } from "../types.ts";
import type { Fact, PullRequest, Source } from "./types.ts";

type UsageSink = (job: string, response: AiResponse) => Promise<void>;

const allowedSections = new Set([
  "identity",
  "devloop",
  "ship",
  "layout",
  "style",
  "tests",
  "title-body",
  "labels",
  "review-bar",
  "process",
]);

function slug(value: string): string {
  return value.toLowerCase().replaceAll(/\W+/g, "-").replace(/^-|-$/g, "");
}

function promptText(value: string, limit = 6_000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Every balanced top-level `[...]` in the text, string-aware so a `[` inside a
 * string does not shift the depth. */
function balancedArrays(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") {
      if (depth === 0) start = index;
      depth++;
    } else if (char === "]" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return out;
}

function parseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const direct = tryParse(cleaned);
  if (direct !== undefined) return direct;
  // The model sometimes appends a second array (for example `[]` then the real
  // one), so the first-to-last-bracket slice is wrong. Read every balanced
  // top-level array and prefer the first non-empty one.
  const parsed = balancedArrays(cleaned)
    .map((chunk) => tryParse(chunk))
    .filter((value): value is unknown[] => Array.isArray(value));
  const nonEmpty = parsed.find((value) => value.length > 0);
  if (nonEmpty) return nonEmpty;
  if (parsed.length) return parsed[0];
  // Last resort: repair an array whose final bracket was truncated.
  // Nothing usable: return an empty list rather than throw. A format deviation
  // must not cost the whole run.
  const start = cleaned.indexOf("[");
  if (start < 0) return [];
  const lastObject = cleaned.lastIndexOf("}");
  if (lastObject > start) {
    const repaired = tryParse(`${cleaned.slice(start, lastObject + 1)}]`);
    if (repaired !== undefined) return repaired;
  }
  return [];
}

function factsFromResponse(
  text: string,
  evidence: string,
  defaultScope: Fact["scope"],
  origin: Fact["origin"],
): Fact[] {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const claim = String(value.claim ?? "").trim();
    const sectionKey = String(value.sectionKey ?? "").trim();
    const isReview = sectionKey === "review";
    if (!claim || (!isReview && !allowedSections.has(sectionKey))) return [];
    const scope =
      value.scope === "current" ||
      value.scope === "repeated-history" ||
      value.scope === "historical-example"
        ? value.scope
        : defaultScope;
    const confidence =
      value.confidence === "high" ||
      value.confidence === "medium" ||
      value.confidence === "low"
        ? value.confidence
        : "medium";
    // A review finding without an impact and an action is the generic advice
    // that made the old guide hollow, so it is dropped rather than stored.
    const impact = String(value.impact ?? "").trim();
    const action = String(value.action ?? "").trim();
    const location = String(value.location ?? "").trim();
    const trigger = String(value.trigger ?? "").trim();
    if (isReview && (!impact || !action)) return [];
    return [
      {
        id: `${sectionKey}:${slug(claim)}`,
        sectionKey,
        claim,
        evidence: [evidence],
        weight: 1,
        scope,
        confidence,
        status: "active",
        origin,
        ...(isReview
          ? {
              class: String(value.class ?? "general").trim() || "general",
              ...(location ? { location } : {}),
              ...(trigger ? { trigger } : {}),
              impact,
              action,
            }
          : {}),
      },
    ];
  });
}

function hasUnsupportedIdentifier(claim: string, source: Source): boolean {
  const evidence = [
    ...source.tree,
    ...Object.keys(source.files),
    ...Object.values(source.files),
  ].join("\n");
  return [...claim.matchAll(/`([A-Za-z_]\w*)`/g)].some(
    ([_, identifier]) => !evidence.includes(identifier),
  );
}

function allowsContributionSections(source: Source): boolean {
  return Object.keys(source.files).some((path) =>
    /CONTRIBUTING|PULL_REQUEST_TEMPLATE/i.test(path),
  );
}

function hasUnsupportedPath(claim: string, source: Source): boolean {
  const paths = new Set([...source.tree, ...Object.keys(source.files)]);
  const repositoryName = String(source.repo.full_name ?? "");
  const references = [
    ...[...claim.matchAll(/`([^`\n]+\/[^`\n]+)`/g)].map(([, value]) => value),
    ...[...claim.matchAll(/`([^`\n]+\/)`/g)].map(([, value]) => value),
    ...[
      ...claim.matchAll(
        /(?:^|[\s("'`])((?!@)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.*?{}<>:+-]+(?:\/[A-Za-z0-9_.*?{}<>:+-]+)*)/g,
      ),
    ].map(([, value]) => value),
  ];
  return references.some((reference) => {
    if (reference.startsWith("@") || reference === repositoryName) return false;
    const normalized = reference.replace(/^\.\/+/, "").replace(/\/+$/, "");
    const wildcard = normalized.includes("*")
      ? new RegExp(
          `^${normalized
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        )
      : undefined;
    return (
      !paths.has(normalized) &&
      ![...paths].some((path) =>
        wildcard ? wildcard.test(path) : path.startsWith(`${normalized}/`),
      )
    );
  });
}

function pullRequestUnit(pr: PullRequest): string {
  return JSON.stringify({
    number: pr.number,
    title: pr.title,
    body: promptText(pr.body),
    labels: pr.labels,
    comments: pr.comments.map((comment) => promptText(comment, 2_000)),
    reviewComments: pr.reviewComments.map((comment) =>
      promptText(comment, 2_000),
    ),
    reviews: pr.reviews.map((review) => promptText(review, 2_000)),
    changedFiles: pr.changedFiles,
    diff: promptText(pr.diff, 8_000),
  });
}

function queueFor(
  provider: AiProvider,
  repo: string,
  ai: Options["ai"],
  model: string,
  concurrency: number,
  validate?: AiValidator,
): AiBatch {
  return new AiBatch(
    provider,
    repo,
    Math.max(1, concurrency),
    `${ai}:v3:${model}`,
    validate,
  );
}

/** `factsFromResponse` as a validator: `null` when the text parses into facts,
 * otherwise the parse error's message. Used so an unparseable response is never
 * cached. */
/** Whether the response contains a parseable JSON array at all. `parseJson`
 * returns `[]` for anything it cannot read, so this is the only way to tell an
 * empty-but-valid answer from garbage that must not be cached as a result. */
function hasJsonArray(text: string): boolean {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (Array.isArray(tryParse(cleaned))) return true;
  return balancedArrays(cleaned).some((chunk) =>
    Array.isArray(tryParse(chunk)),
  );
}

function validateFacts(
  response: AiResponse,
  evidence: string,
  defaultScope: Fact["scope"],
): string | null {
  if (!hasJsonArray(response.text)) {
    return `${evidence}: AI fact output is not a JSON array`;
  }
  try {
    factsFromResponse(response.text, evidence, defaultScope, "repository");
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${evidence}: ${message}`;
  }
}

function extractRequest(prompt: string, maxTokens: number): AiRequest {
  return {
    job: "extract_unit",
    prompt,
    maxTokens,
    // Reading a discussion into structured findings is multi-step work: with no
    // thinking the model returned an empty array for most pull requests, so a
    // little reasoning is allowed (the answer still fits the token budget).
    reasoningEffort: "low",
    system:
      'Extract only repository-specific facts and review findings. Never invent files, commands, or process. Never write a pull-request number, a commit id, a reviewer name, or quoted comment text in a claim. A review finding (sectionKey "review") states a concrete rule with an impact and an action.',
  };
}

function cleanSection(text: string, key: string): string {
  const clean = text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, "")
    .replace(/```/g, "")
    .trim();
  const heading = `## ${sectionTitles[key] ?? key}`;
  // Guarantee the heading the skill assembler keys on, and keep whatever body
  // the model produced rather than rejecting it.
  if (/^##\s+.+$/m.test(clean)) return clean.replace(/^##\s+.+$/m, heading);
  return clean ? `${heading}\n\n${clean}` : heading;
}

function sectionGoal(key: string): string {
  const goals: Record<string, string> = {
    layout:
      "Describe module responsibilities and important dependency or change-impact paths. Do not list routine public symbols.",
    tests:
      "State which verification is required after a behavior change and the dependency/setup that makes it meaningful.",
    devloop:
      "Give local build, debugging, or change-impact guidance that is not already stated in Shipping.",
    ship: "Give one concise release/CI checklist. Merge overlapping workflow, artifact, and release-gate facts.",
    style:
      "Keep only repository-specific, evidenced conventions. Return only the heading when none are actionable.",
  };
  return goals[key] ?? "Keep only actionable repository-specific guidance.";
}

function synthesisFacts(facts: Fact[], key: string): Fact[] {
  return (
    facts
      // A section that states repository policy never learns from a single pull
      // request's narrative; only `review-bar` may.
      .filter(
        (item) =>
          item.sectionKey === key &&
          (sectionAllowsPrFacts(key) || !isPullRequestFact(item)),
      )
      .sort(
        (a, b) =>
          (b.status === "active" ? 1 : 0) - (a.status === "active" ? 1 : 0) ||
          ({
            current: 3,
            "repeated-history": 2,
            "historical-example": 1,
          }[b.scope] ?? 0) -
            ({
              current: 3,
              "repeated-history": 2,
              "historical-example": 1,
            }[a.scope] ?? 0) ||
          b.weight - a.weight ||
          b.evidence.length - a.evidence.length ||
          a.claim.localeCompare(b.claim),
      )
      .slice(0, 20)
  );
}

export type SynthesisResult = Record<string, string>;

export async function extractAiFacts(
  provider: AiProvider,
  repo: string,
  source: Source,
  options: Options,
  usage?: UsageSink,
): Promise<Fact[]> {
  const requests: AiRequest[] = [];
  const evidence: string[] = [];
  const scopes: Fact["scope"][] = [];
  const prs = options.includePullRequests ? source.pullRequests : [];

  for (const pr of prs) {
    requests.push(
      extractRequest(
        `Analyze this pull request's reviews, comments, code and diff, and return only a JSON array of review findings.
Each item must have exactly:
{"sectionKey":"review","class":"a short area name","claim":"the invariant a reviewer would enforce, imperative and general","location":"path or path:line the finding is about, or empty when none","trigger":"the diff surface that should trigger this rule: a path, glob, or symbol, or empty when none","impact":"why this matters here, from the review's reasoning","action":"what to change or verify","scope":"historical-example","confidence":"medium"}
Rules:
- Include only substantive findings: a reviewer identifies something to fix, change, verify or decide.
- Never write an approval, a merge, "LGTM", thanks, a reviewer name, a pull-request number, a commit id, or quoted comment text.
- The claim is a general invariant, not one past fix: "When X changes, Y must also change", or "Every Z uses W", never "change this one line".
- trigger is what a reviewer can see in a diff: a path, a glob, or a symbol. It is how the rule applies to a future change, so a rule with no trigger is a one-off and is not useful.
- impact and action are mandatory and concrete. Paraphrase the reviewer's reasoning for impact; never quote it.
- class is a short area label chosen from a small, consistent set; reuse the same label for findings of the same kind so related findings can be grouped.
- location is a repository path when the review names one, otherwise leave it empty.
- Return every distinct finding the reviews support, not a summary. Do not explain the answer.

PULL REQUEST:
${pullRequestUnit(pr)}`,
        2_400,
      ),
    );
    evidence.push(`PR #${pr.number}`);
    scopes.push("historical-example");
  }

  if (options.includeCodebase || options.includeHowRepoWorks) {
    const files = Object.entries(source.files)
      .map(([path, content]) => `${path}\n${promptText(content, 4_000)}`)
      .join("\n\n");
    if (files) {
      requests.push(
        extractRequest(
          `Analyze these canonical repository files and return only a JSON array of atomic observations.
Each item must have exactly:
{"sectionKey":"one allowed section","claim":"one directly evidenced observation","scope":"current","confidence":"high"}
Allowed sections: ${[...allowedSections].join(", ")}
Focus on module responsibilities, test-to-code relationships, build/debug constraints,
release gates, and conventions that affect a code change. Ignore end-user feature lists,
installation walkthroughs, and generic programming advice. For source files, identify
what important modules own and how tests exercise them when the files provide evidence.
Do not infer PR titles, labels, review rules, or contributor policy unless the input
contains PR or pull-request-template evidence; every claim must be directly supported
by a provided file. Do not report a current version value; preserve the version
change or release rule instead.
Return at most 10 items. Keep each claim under 180 characters. Do not explain the answer.

FILES:
${files}`,
          2_200,
        ),
      );
      evidence.push("repository files");
      scopes.push("current");
    }
  }

  const queue = queueFor(
    provider,
    repo,
    options.ai,
    options.lowModel ?? "",
    options.aiConcurrent,
    // Each request carries different evidence, so the validator looks the
    // request up by identity to find which evidence it belongs to.
    (request, response) => {
      const at = requests.indexOf(request);
      return validateFacts(
        response,
        evidence[at] ?? "repository files",
        scopes[at] ?? "historical-example",
      );
    },
  );
  const responses = await queue.run(requests, usage);
  const facts: Fact[] = [];
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index];
    if (!response) continue;
    facts.push(
      ...factsFromResponse(
        response.text,
        evidence[index],
        scopes[index] ?? "historical-example",
        evidence[index] === "repository files" ? "repository" : "pull-request",
      ).filter((item) => {
        if (
          hasUnsupportedIdentifier(item.claim, source) ||
          hasUnsupportedPath(item.claim, source)
        ) {
          return false;
        }
        if (
          evidence[index] === "repository files" &&
          !allowsContributionSections(source) &&
          ["title-body", "labels", "review-bar", "process"].includes(
            item.sectionKey,
          )
        ) {
          return false;
        }
        // An invented path is worse than no path: keep the finding and drop
        // the location when it does not exist in the repository. The location
        // may carry a line (`path:12` or `path:12-20`), which is stripped
        // before the path is checked so a real path with a line survives.
        if (item.sectionKey === "review" && item.location) {
          const locationPath = item.location.replace(/:\d+(?:-\d+)?$/, "");
          if (hasUnsupportedPath(locationPath, source)) {
            item.location = undefined;
          }
        }
        return true;
      }),
    );
    if (index % 10 === 0 || index === responses.length - 1) {
      console.log(`[ai] extract units ${index + 1}/${responses.length}`);
    }
  }
  return facts;
}

function mergeFacts(base: Fact[], extra: Fact[]): Fact[] {
  const merged = new Map(
    base.map((item) => [item.id, { ...item, evidence: [...item.evidence] }]),
  );
  for (const item of extra) {
    const existing = merged.get(item.id);
    if (!existing) merged.set(item.id, item);
    else {
      existing.weight += item.weight;
      existing.evidence = [
        ...new Set([...existing.evidence, ...item.evidence]),
      ];
    }
  }
  return [...merged.values()];
}

export async function enrichFacts(
  provider: AiProvider,
  repo: string,
  base: Fact[],
  source: Source,
  options: Options,
  usage?: UsageSink,
): Promise<Fact[]> {
  return mergeFacts(
    base,
    await extractAiFacts(provider, repo, source, options, usage),
  );
}

export async function synthesizeSections(
  provider: AiProvider,
  repo: string,
  facts: Fact[],
  _previousMarkdown: string | undefined,
  ai: Options["ai"],
  model: string,
  concurrency: number,
  usage?: UsageSink,
  onlySections?: Set<string>,
): Promise<{ overrides: Record<string, string> }> {
  const requests: AiRequest[] = [];
  const keys: string[] = [];
  for (const key of [...new Set(facts.map((item) => item.sectionKey))]) {
    // Review findings are the guide's material, not a prose section.
    if (!sectionTitles[key]) continue;
    if (onlySections && !onlySections.has(key)) continue;
    const relevant = synthesisFacts(facts, key);
    // A section whose only facts came from a single pull request has no
    // repository policy to synthesize, so it is skipped instead of asking the
    // model for an empty answer.
    if (!relevant.length) continue;
    keys.push(key);
    requests.push({
      job: "synth_section",
      maxTokens: 4_000,
      reasoningEffort: "high",
      system: `You synthesize contribution guidance for an unfamiliar open-source repository.
Help developers make correct implementation, testing, review, debugging, and release
decisions. Current repository evidence outranks history. A single historical
observation is not a repository-wide rule. If sources conflict and current evidence
does not resolve the conflict, omit the claim. Never invent paths, commands,
conventions, or policies. Do not summarize README prose or list incidental details.`,
      prompt: `Write only the Markdown for the "${key}" section of a repository Agent Skill.
Use only the facts below. Keep rules that change implementation, testing, review,
debugging, or release decisions. Drop end-user README instructions, feature lists,
file inventories, duplicate commands, and generic programming advice. Preserve useful
existing guidance, remove contradictions, deduplicate overlapping facts, and do not
invent anything. Include the correct human-readable section heading. Use inline
backticks instead of fenced code blocks. Do not create examples, placeholder
identifiers, or policies that are not present in the facts. Prefer at most
6 high-value bullets; keep a concrete example only when it changes an agent decision.
Do not preserve a current version value that can become stale. In Shipping,
consolidate CI and release facts instead of repeating the same workflow rule.
Facts are raw candidates, not all mandatory output. A fact supported by only one PR
is an example, not a repository-wide rule; omit it unless canonical files or repeated
evidence support it. Omit conflicting claims rather than guessing. Return only the
heading when this section has no durable guidance. Do not preserve bot-specific
automation commands, reviewer identities, or one-off historical requests as
repository-wide process guidance.

SECTION GOAL:
${sectionGoal(key)}

FACTS:
${JSON.stringify(relevant)}`,
    });
  }

  // No validator: a section that does not match the ideal shape is normalized
  // by `cleanSection` and kept, not rejected. Losing the whole run over a
  // section's format is not worth it.
  const queue = queueFor(provider, repo, ai, model, concurrency);
  const responses = await queue.run(requests, usage);
  // A heading with no bullets is the model saying "no durable guidance", so the
  // section is omitted rather than written empty. Anything with a bullet is
  // kept as the model wrote it.
  const overrides: Record<string, string> = {};
  responses.forEach((response, index) => {
    if (!response) return;
    const section = cleanSection(response.text, keys[index]);
    if (/^- /m.test(section)) overrides[keys[index]] = section;
  });
  return { overrides };
}
