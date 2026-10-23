import { AiBatch } from "../ai/batch.ts";
import type { AiProvider, AiRequest, AiResponse, Options } from "../types.ts";
import type { Fact } from "./types.ts";

export type ReviewDocuments = {
  guide: string;
  detailed?: string;
};

type UsageSink = (job: string, response: AiResponse) => Promise<void>;

/** A fact read out of a single pull request describes that request, not the
 * repository. `origin` is absent on facts written before the field existed, so
 * those count as repository policy. */
export function isPullRequestFact(item: Fact): boolean {
  return item.origin === "pull-request";
}

/** Above this many lines the full method is split into the short reviewer file
 * plus `PR_REVIEW_DETAILED_GUIDE.md`. */
const DETAIL_THRESHOLD_LINES = 30;
const MAX_GUIDE_LINES = 600;
const MAX_CHECK_LINES = 400;
/** Findings handed to one synthesis call. A repository with more is summarized
 * by recurrence rather than truncated silently, because the model sees the
 * count in `reviewSignalCount`. */
const MAX_FINDINGS = 160;

/** How strongly a finding recurs. Repository policy (`current`) outranks
 * repeated history, which outranks a single example; weight and evidence count
 * break ties. This is the guide's only ordering signal: rules carry no
 * priority. */
function recurrence(item: Fact): number {
  const scope =
    { current: 3, "repeated-history": 2, "historical-example": 1 }[
      item.scope
    ] ?? 0;
  return scope * 1000 + item.weight * 10 + item.evidence.length;
}

/** Approval/merge narration is not a rule. The extraction prompt already
 * forbids it; this drops any that slips through, without touching the many
 * findings that legitimately begin "Reviewers should require …". */
function isNarrative(claim: string): boolean {
  return (
    /\bLGTM\b/i.test(claim) ||
    /^(the reviewer|a reviewer|reviewers?) (approved|merged|commented|replied|left)\b/i.test(
      claim,
    ) ||
    /\b(was merged|has been merged|approved at)\b/i.test(claim)
  );
}

/** The review findings the guide is built from: a concrete rule with an impact
 * and an action. Nothing is dropped for being a single PR's finding, because
 * the point of the guide is the specifics; recurrence only orders them. */
function guideFindings(facts: Fact[]): Fact[] {
  return facts
    .filter(
      (item) =>
        item.sectionKey === "review" &&
        Boolean(item.impact) &&
        Boolean(item.action) &&
        !isNarrative(item.claim),
    )
    .sort(
      (a, b) => recurrence(b) - recurrence(a) || a.claim.localeCompare(b.claim),
    );
}

/** The selected review findings before the frequency threshold is applied.
 * Exported so `init` can tell the user how far short of the threshold a
 * repository is instead of silently skipping the guide. */
export function reviewSignalCount(facts: Fact[]): number {
  return guideFindings(facts).length;
}

const VAGUE =
  /^(inspect|check whether|look at|consider|review the|ensure that|make sure)\b/i;

/** The guide's concreteness contract. Returns `null` when usable, else the
 * reason the batch retries on. This is the context-loss detector: a rule that
 * could sit in any repository's guide fails it, and it also forces the guide to
 * be a small set of coherent passes rather than one area per finding. */
export function validateGuide(
  text: string,
  options: { minChecks?: number; minPasses?: number; maxPasses?: number } = {},
): string | null {
  const minChecks = options.minChecks ?? 8;
  const minPasses = options.minPasses ?? 3;
  const maxPasses = options.maxPasses ?? 12;
  if (!/^#\s+\S/m.test(text)) return "no title";
  if (!/^##\s+\S/m.test(text)) return "no areas";
  const lines = text.split("\n");
  if (lines.length > MAX_GUIDE_LINES) return "too long";
  if (/\bPR\s*#?\s*\d+/i.test(text)) return "contains a pull-request number";
  if (/(^|\s)[\u2014\u2013]\s*\S/.test(text)) return "contains an attribution";
  if (/@[A-Za-z0-9_-]{2,}/.test(text)) return "contains a mention";
  if (/^\s*>/m.test(text)) return "contains a quote";
  if (text.includes("```")) return "contains a code fence";
  if (/(^|\s)\$\s/m.test(text)) return "contains a shell prompt";
  if (/\b(?:TODO|TBD)\b/i.test(text)) return "contains a placeholder";
  if (/\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i.test(text)) {
    return "contains a commit id";
  }
  if (/\bP[0-3]\b|\[P[0-3]\]/.test(text)) return "contains a priority tag";

  const bullets = lines.filter((line) => /^- /.test(line));
  const isLink = (line: string): boolean => /\]\(/.test(line);
  const isCheck = (line: string): boolean => / · /.test(line);
  const isObligation = (line: string): boolean => / → /.test(line);
  // A top-level bullet is a check (`rule · why`), an obligation
  // (`trigger → must-do`), or the short file's link to the detailed file. A
  // bare "Inspect X" is none of them. Indented example lines are ignored.
  const bare = bullets.find(
    (line) => !isLink(line) && !isCheck(line) && !isObligation(line),
  );
  if (bare)
    return `bullet without a reason or obligation: ${bare.slice(0, 60)}`;
  const checks = bullets.filter((line) => isCheck(line) && !isLink(line));
  if (checks.length > MAX_CHECK_LINES) return "too many checks";
  if (checks.length < minChecks) return "too few concrete checks";
  const vague = checks.find((line) => VAGUE.test(line.replace(/^-\s*/, "")));
  if (vague) return `vague check: ${vague.slice(0, 60)}`;

  const areas = text.split(/^## /m).slice(1);
  if (areas.length < minPasses) {
    return `fewer than ${minPasses} passes`;
  }
  if (areas.length > maxPasses) {
    return `too many passes (${areas.length}); consolidate related areas`;
  }
  for (const area of areas) {
    const name = area.split("\n")[0].trim();
    // A raw class label ("test-cleanup") is not a pass name.
    if (/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      return `unnormalized pass name: ${name}`;
    }
    const areaChecks = (area.match(/^- .*/gm) ?? []).filter(
      (line) => isCheck(line) && !isLink(line),
    );
    if (areaChecks.length < 1) {
      return `pass "${name}" has no concrete check`;
    }
  }
  // The exit check is asked for per pass but not enforced: the model
  // occasionally omits one, and rejecting the whole guide for that is worse
  // than a missing line.
  if (!/\*\*Exit check:\*\*/.test(text)) return "no exit check";
  return null;
}

/** The findings handed to the synthesis, as a flat list. Earlier this was
 * pre-grouped by the extraction's own `class` label, which made the model emit
 * one pass per finding (24 areas in the skunk run); a flat list lets it cluster
 * related findings into a small set of coherent passes instead. */
function guideMaterial(facts: Fact[]): string {
  const findings = guideFindings(facts)
    .slice(0, MAX_FINDINGS)
    .map((item) => ({
      class: (item.class ?? "general").trim() || "general",
      rule: item.claim,
      ...(item.trigger ? { trigger: item.trigger } : {}),
      ...(item.location ? { location: item.location } : {}),
      impact: item.impact,
      action: item.action,
      repeats: item.evidence.length,
    }));
  return JSON.stringify(findings, null, 2);
}

const GUIDE_SYSTEM = `You write a code-review method for an unfamiliar open-source repository.
Ground every check in the supplied findings. Never invent a file, path, command, or policy. Never write a pull-request number, a commit id, a reviewer name, a mention, a quoted comment, or an attribution. Never add a priority tag. Never tell the reader to run a command.`;

const CONSOLIDATE = `- Consolidate the findings into a small set of coherent passes: group related findings, merge near-duplicates, and use between 3 and 12 passes. Represent every finding; never drop one to hit the pass count.
- Name each pass in Title Case. Never a lowercase slug such as "test-cleanup".
- Every rule is a general invariant a future change must satisfy, not a description of one past fix. Keep the specific case only as the example under it.`;

const CHECK_SHAPE = `- Under each pass, write each rule as one general invariant line, then its concrete case indented under it:
  - <when <trigger> changes, <obligation>, or every <surface> must ...> · <why it matters here>
    - <the concrete case: what changed and where>
- Give each pass a \`**Goal:**\` line and an \`**Applies to:**\` line.
- End each pass with \`**Exit check:**\` followed by its obligations, one per line, so a reviewer who sees only a diff can apply the rule:
  - \`<trigger: a path, glob, or symbol>\` → <what must also change or be verified>
- Order passes and rules by how often the findings recur, most first. Prefer the general rule over a one-off, and keep the one-off as the example under it.`;

function fullGuideRequest(material: string): AiRequest {
  return {
    job: "synth_guide",
    maxTokens: 16_000,
    reasoningEffort: "high",
    system: GUIDE_SYSTEM,
    prompt: `Write a Markdown review method from these review findings.
- Start with one \`#\` title, one sentence of purpose, and one line on how to use the method.
${CONSOLIDATE}
${CHECK_SHAPE}
- No priority tags. No commands. No code fences. Return only the Markdown.

FINDINGS:
${material}`,
  };
}

function shortGuideRequest(material: string, full: string): AiRequest {
  return {
    job: "synth_guide_short",
    maxTokens: 8_000,
    reasoningEffort: "high",
    system: GUIDE_SYSTEM,
    prompt: `Write the short, reviewer-facing checklist from the full method below.
- Start with one \`#\` title, one sentence, then a plain line (not a bullet) linking to
  [PR_REVIEW_DETAILED_GUIDE.md](PR_REVIEW_DETAILED_GUIDE.md) for the full method.
${CONSOLIDATE}
- Keep the highest-value checks, one per line, in the same shape:
  - <what to check or require> · <why it matters here>
- End every pass with \`**Exit check:** <one line>\`.
- No priority tags, commands, pull-request numbers, ids, names, mentions or quotes.
- Do not use fenced code blocks. Return only the Markdown.

FULL METHOD:
${full}

FINDINGS:
${material}`,
  };
}

function withTrailingNewline(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

/** Builds the review method with the high model. Returns `undefined` below the
 * signal threshold, which is a data condition, not an AI failure. There is no
 * deterministic fallback: a failed or unusable generation fails the run. */
export async function synthesizeReviewGuides(
  provider: AiProvider,
  repo: string,
  ai: Options["ai"],
  model: string,
  concurrency: number,
  facts: Fact[],
  usage?: UsageSink,
): Promise<ReviewDocuments | undefined> {
  const findings = guideFindings(facts);
  if (findings.length <= 2) return undefined;

  const material = guideMaterial(facts);
  // No validator: the guide is kept as written. Losing the run over format is
  // not worth it, and a later `sync` reuses the cached text.
  const queue = new AiBatch(
    provider,
    repo,
    Math.max(1, concurrency),
    `${ai}:v3:${model}:guide`,
  );
  const [fullResponse] = await queue.run([fullGuideRequest(material)], usage);
  const full = cleanGuide(fullResponse?.text ?? "");
  if (!full) {
    // Not a failure: SKILL.md and CODEBASE.md are written anyway.
    console.log("[ai] synth_guide produced nothing usable; skipping the guide");
    return undefined;
  }

  const fullLines = full.split("\n").length;
  if (fullLines <= DETAIL_THRESHOLD_LINES) {
    return { guide: withTrailingNewline(full) };
  }
  const [shortResponse] = await queue.run(
    [shortGuideRequest(material, full)],
    usage,
  );
  const short = cleanGuide(shortResponse?.text ?? "");
  if (!short) return { guide: withTrailingNewline(full) };
  return { guide: withTrailingNewline(short), detailed: full };
}

/** Strips a wrapping code fence, which the model sometimes adds. */
function cleanGuide(text: string): string {
  return text
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}
