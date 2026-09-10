import { AiQueue } from "./queue.ts";
import { sectionTitles } from "../analysis/sections.ts";
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  Fact,
  Options,
  PullRequest,
  Source,
} from "../types.ts";

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

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(
    /\s*```$/,
    "",
  );
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0) throw new Error("AI fact output is not JSON");
    if (end > start) return JSON.parse(cleaned.slice(start, end + 1));
    const lastCompleteObject = cleaned.lastIndexOf("}");
    if (lastCompleteObject <= start) {
      throw new Error("AI fact output is truncated");
    }
    return JSON.parse(`${cleaned.slice(start, lastCompleteObject + 1)}]`);
  }
}

function factsFromResponse(
  text: string,
  evidence: string,
  defaultScope: Fact["scope"],
): Fact[] {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) {
    throw new Error("AI fact output must be an array");
  }
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const claim = String(value.claim ?? "").trim();
    const sectionKey = String(value.sectionKey ?? "").trim();
    if (!claim || !allowedSections.has(sectionKey)) return [];
    const scope = value.scope === "current" ||
        value.scope === "repeated-history" ||
        value.scope === "historical-example"
      ? value.scope
      : defaultScope;
    const confidence = value.confidence === "high" ||
        value.confidence === "medium" ||
        value.confidence === "low"
      ? value.confidence
      : "medium";
    return [{
      id: `${sectionKey}:${slug(claim)}`,
      sectionKey,
      claim,
      evidence: [evidence],
      weight: 1,
      scope,
      confidence,
      status: "active",
    }];
  });
}

function hasUnsupportedIdentifier(claim: string, source: Source): boolean {
  const evidence = [
    ...source.tree,
    ...Object.keys(source.files),
    ...Object.values(source.files),
  ].join("\n");
  return [...claim.matchAll(/`([A-Za-z_]\w*)`/g)].some(([_, identifier]) =>
    !evidence.includes(identifier)
  );
}

function allowsContributionSections(source: Source): boolean {
  return Object.keys(source.files).some((path) =>
    /CONTRIBUTING|PULL_REQUEST_TEMPLATE/i.test(path)
  );
}

function hasUnsupportedPath(claim: string, source: Source): boolean {
  const paths = new Set([...source.tree, ...Object.keys(source.files)]);
  const repositoryName = String(source.repo.full_name ?? "");
  const references = [
    ...[...claim.matchAll(/`([^`\n]+\/[^`\n]+)`/g)].map(([, value]) => value),
    ...[...claim.matchAll(
      /(?:^|[\s("'`])((?!@)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.*?{}<>:+-]+(?:\/[A-Za-z0-9_.*?{}<>:+-]+)*)/g,
    )].map(([, value]) => value),
  ];
  return references.some((reference) => {
    if (reference.startsWith("@") || reference === repositoryName) return false;
    const normalized = reference.replace(/^\.\/+/, "").replace(/\/+$/, "");
    const wildcard = normalized.includes("*")
      ? new RegExp(
        `^${
          normalized.split("*").map((part) =>
            part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          ).join(".*")
        }$`,
      )
      : undefined;
    return !paths.has(normalized) &&
      ![...paths].some((path) =>
        wildcard ? wildcard.test(path) : path.startsWith(`${normalized}/`)
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
): AiQueue {
  return new AiQueue(
    provider,
    repo,
    Math.max(1, concurrency),
    `${ai}:v2:${model}`,
  );
}

function extractRequest(prompt: string, maxTokens: number): AiRequest {
  return {
    job: "extract_unit",
    prompt,
    maxTokens,
    system:
      "Extract only repository-specific facts. Never invent files, commands, or process.",
  };
}

function cleanSection(text: string, key: string): string {
  const clean = text.replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, "").trim();
  const heading = sectionTitles[key] ?? key;
  return clean.replace(/^##\s+.+$/m, `## ${heading}`);
}

function validSection(text: string, key: string): boolean {
  const heading = `## ${sectionTitles[key] ?? key}`;
  const bullets = text.match(/^-\s+/gm) ?? [];
  return text.startsWith(heading) &&
    bullets.length > 0 &&
    bullets.length <= 6 &&
    !text.includes("```") &&
    !/\b(?:TODO|TBD)\b/i.test(text);
}

function sectionGoal(key: string): string {
  const goals: Record<string, string> = {
    layout:
      "Describe module responsibilities and important dependency or change-impact paths; do not list routine public symbols.",
    tests:
      "State which verification is required after a behavior change and the dependency/setup that makes it meaningful.",
    devloop:
      "Give local build, debugging, or change-impact guidance that is not already stated in Shipping.",
    ship:
      "Give one concise release/CI checklist; merge overlapping workflow, artifact, and release-gate facts.",
    style:
      "Keep only repository-specific, evidenced conventions. Return only the heading when none are actionable.",
  };
  return goals[key] ?? "Keep only actionable repository-specific guidance.";
}

function synthesisFacts(facts: Fact[], key: string): Fact[] {
  return facts.filter((item) => item.sectionKey === key)
    .sort((a, b) =>
      (b.status === "active" ? 1 : 0) - (a.status === "active" ? 1 : 0) ||
      ({
          current: 3,
          "repeated-history": 2,
          "historical-example": 1,
        }[b.scope] ??
          0) -
        ({
          current: 3,
          "repeated-history": 2,
          "historical-example": 1,
        }[a.scope] ??
          0) ||
      b.weight - a.weight ||
      b.evidence.length - a.evidence.length ||
      a.claim.localeCompare(b.claim)
    )
    .slice(0, 20);
}

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
    requests.push(extractRequest(
      `Analyze this pull request and return only a JSON array of atomic observations. Each item must have exactly:
{"sectionKey":"one allowed section","claim":"one directly evidenced observation","scope":"historical-example","confidence":"medium"}
Allowed sections: ${[...allowedSections].join(", ")}
Use evidence from this PR only. Do not generalize this PR into a repository-wide policy.
Return at most 6 items. Keep each claim under 180 characters. Do not explain the answer.

PULL REQUEST:
${pullRequestUnit(pr)}`,
      1_200,
    ));
    evidence.push(`PR #${pr.number}`);
    scopes.push("historical-example");
  }

  if (options.includeCodebase || options.includeHowRepoWorks) {
    const files = Object.entries(source.files)
      .map(([path, content]) => `${path}\n${promptText(content, 4_000)}`)
      .join("\n\n");
    if (files) {
      requests.push(extractRequest(
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
      ));
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
  );
  const responses = await queue.run(requests, usage);
  const facts: Fact[] = [];
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index];
    if (!response) continue;
    try {
      facts.push(
        ...factsFromResponse(
          response.text,
          evidence[index],
          scopes[index] ?? "historical-example",
        ).filter((item) =>
          !hasUnsupportedIdentifier(item.claim, source) &&
          !hasUnsupportedPath(item.claim, source) &&
          (evidence[index] !== "repository files" ||
            allowsContributionSections(source) ||
            !["title-body", "labels", "review-bar", "process"].includes(
              item.sectionKey,
            ))
        ),
      );
    } catch (error) {
      console.log(
        `[ai] invalid ${evidence[index]} output skipped: ${String(error)}`,
      );
    }
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
): Promise<Record<string, string>> {
  const requests: AiRequest[] = [];
  const keys: string[] = [];
  for (const key of [...new Set(facts.map((item) => item.sectionKey))]) {
    if (onlySections && !onlySections.has(key)) continue;
    const relevant = synthesisFacts(facts, key);
    keys.push(key);
    requests.push({
      job: "synth_section",
      maxTokens: 1_800,
      reasoningEffort: "high",
      system:
        `You synthesize contribution guidance for an unfamiliar open-source repository.
Help developers make correct implementation, testing, review, debugging, and release
decisions. Current repository evidence outranks history. A single historical
observation is not a repository-wide rule. If sources conflict and current evidence
does not resolve the conflict, omit the claim. Never invent paths, commands,
conventions, or policies. Do not summarize README prose or list incidental details.`,
      prompt:
        `Write only the Markdown for the "${key}" section of a repository Agent Skill.
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

  const queue = queueFor(
    provider,
    repo,
    ai,
    model,
    ai === "hetzner" ? 1 : concurrency,
  );
  const responses = await queue.run(requests, usage);
  const overrides: Record<string, string> = {};
  responses.forEach((response, index) => {
    const section = response ? cleanSection(response.text, keys[index]) : "";
    overrides[keys[index]] = validSection(section, keys[index]) ? section : "";
  });
  return overrides;
}
