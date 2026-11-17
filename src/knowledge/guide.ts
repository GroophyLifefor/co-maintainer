import {
  applyGuideEdits,
  GuideEditError,
  guideRuleIds,
  keptSources,
  parseGuideEdits,
  type GuideEdits,
} from "./guide_edit.ts";
import type { RuleEntry } from "./rules.ts";
import { AiBatch } from "../ai/batch.ts";
import type { AiProvider, AiRequest, AiResponse, Options } from "../types.ts";
import type { Fact } from "./types.ts";
import { log } from "../util/log.ts";
import {
  assignGuideIds,
  type GuideFileCount,
  type GuideRule,
} from "./guide_ids.ts";

export type ReviewDocuments = {
  guide: string;
  detailed?: string;
  /** Every check line that got an `R` id, with the pull requests of the
   * findings it merges. */
  rules?: (GuideRule & {
    pullRequests: number[];
    /** The review comment links of the merged findings, when they were
     * kept. A pull request with no link here shows as plain text. */
    links?: { pr: number; url: string }[];
  })[];
  /** Check lines and how many of them got an id, per file. */
  counts?: GuideFileCount[];
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
/** Findings handed to one synthesis call. A repository with more is truncated
 * by recurrence: the most repeated reach the model, and the guide is only as
 * broad as that window. */
const MAX_FINDINGS = 160;

/** How strongly a finding recurs. Repository policy (`current`) outranks
 * repeated history, which outranks a single example. Weight and evidence count
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
 * forbids it. This drops any that slips through, without touching the many
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
 * the point of the guide is the specifics. Recurrence only orders them. */
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
    return `too many passes (${areas.length}), consolidate related areas`;
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
 * one pass per finding (24 areas on one large repository). A flat list lets it cluster
 * related findings into a small set of coherent passes instead. */
function guideMaterial(facts: Fact[]): string {
  const findings = guideFindings(facts)
    .slice(0, MAX_FINDINGS)
    .map((item, index) => ({
      // The number the guide lines cite. The pull requests behind it stay
      // out of the prompt, in `findingPullRequests`.
      number: index + 1,
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

/** The pull requests behind each finding in `guideMaterial`, by position, so
 * finding `n` is `[n - 1]`. A review finding's evidence is `PR #12`. */
export function findingPullRequests(facts: Fact[]): number[][] {
  return guideFindings(facts)
    .slice(0, MAX_FINDINGS)
    .map((item) => [
      ...new Set(
        item.evidence.flatMap((evidence) => {
          const match = /^PR #(\d+)$/.exec(evidence.trim());
          return match ? [Number(match[1])] : [];
        }),
      ),
    ]);
}

/** The review comment links behind each finding in `guideMaterial`, by
 * position like `findingPullRequests`. Never sent to the model. */
export function findingLinks(facts: Fact[]): { pr: number; url: string }[][] {
  return guideFindings(facts)
    .slice(0, MAX_FINDINGS)
    .map((item) => item.links ?? []);
}

const GUIDE_SYSTEM = `You write a code-review method for an unfamiliar open-source repository.
Ground every check in the supplied findings. Never invent a file, path, command, or policy. Never write a pull-request number, a commit id, a reviewer name, a mention, a quoted comment, or an attribution. Never add a priority tag. Never tell the reader to run a command.`;

const CONSOLIDATE = `- Consolidate the findings into a small set of coherent passes: group related findings, merge near-duplicates, and use between 3 and 12 passes. Represent every finding. Never drop one to hit the pass count.
- Name each pass in Title Case. Never a lowercase slug such as "test-cleanup".
- Every rule is a general invariant a future change must satisfy, not a description of one past fix. Keep the specific case only as the example under it.`;

const CHECK_SHAPE = `- Under each pass, write each rule as one general invariant line, then its concrete case indented under it:
  - <when <trigger> changes, <obligation>, or every <surface> must ...> · <why it matters here> [<finding numbers>]
    - <the concrete case: what changed and where>
- Give each pass a \`**Goal:**\` line and an \`**Applies to:**\` line.
- End each pass with \`**Exit check:**\` followed by its obligations, one per line, so a reviewer who sees only a diff can apply the rule:
  - \`<trigger: a path, glob, or symbol>\` → <what must also change or be verified>
- Order passes and rules by how often the findings recur, most first. Prefer the general rule over a one-off, and keep the one-off as the example under it.`;

/** The last build's guide rules as the guide prompt sees them: id and text,
 * never a pull request or a date. Empty when there were none, so a first
 * build sends the same prompt as before. */
export function previousRulesMaterial(
  previous: Record<string, { text: string }> | undefined,
): string {
  const rules = Object.entries(previous ?? {})
    .filter(([id]) => /^R[1-9]\d*$/.test(id))
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([id, entry]) => ({ id, rule: entry.text }));
  return rules.length ? JSON.stringify(rules, null, 2) : "";
}

function fullGuideRequest(material: string, previous = ""): AiRequest {
  const overturns = previous
    ? `
- PREVIOUS RULES lists the rules of the last build by id. When a rule line you write requires the opposite of a previous rule, put \`(overturns R4)\` with that id right before the line's bracket. Name only a previous rule the line clearly contradicts, never one it only rewords or extends.`
    : "";
  // Before FINDINGS, so the findings stay the last block of the prompt.
  const previousBlock = previous ? `PREVIOUS RULES:\n${previous}\n\n` : "";
  return {
    job: "synth_guide",
    maxTokens: 16_000,
    reasoningEffort: "high",
    system: GUIDE_SYSTEM,
    prompt: `Write a Markdown review method from these review findings.
- Start with one \`#\` title, one sentence of purpose, and one line on how to use the method.
${CONSOLIDATE}
${CHECK_SHAPE}
- End every rule line with the numbers of the findings it merges, in square brackets, for example [3, 17]. Each finding has a "number". Put these brackets on no other line.${overturns}
- No priority tags. No commands. No code fences. Return only the Markdown.

${previousBlock}FINDINGS:
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
  - <what to check or require> · <why it matters here> [<finding numbers>]
- End every check line with the bracketed finding numbers of the full-method lines it summarizes, joined into one bracket, for example [3, 17]. Put these brackets on no other line.
- End every pass with \`**Exit check:** <one line>\`.
- No priority tags, commands, pull-request numbers, names, mentions or quotes.
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

const CUT = Symbol("cut off");

/** One guide call that must not be cut. An answer that stopped at the output
 * limit is asked again once with twice the limit. When that one is cut too,
 * `CUT` tells the caller to keep the last run's guide: a guide written from a
 * cut answer ends mid-line and loses its last passes. The limit stays a cost
 * guard, so there is no third try. */
async function uncut(
  queue: AiBatch,
  request: AiRequest,
  usage: UsageSink | undefined,
): Promise<AiResponse | undefined | typeof CUT> {
  const [first] = await queue.run([request], usage);
  if (!first?.cutOff) return first;
  const doubled = (request.maxTokens ?? 0) * 2;
  log(
    "ai",
    `${request.job} stopped at the output limit (${request.maxTokens} tokens), asking once more with ${doubled}`,
  );
  const [second] = await queue.run([{ ...request, maxTokens: doubled }], usage);
  if (!second?.cutOff) return second;
  log(
    "ai",
    `${request.job} stopped at the output limit again (${doubled} tokens), keeping the previous guide`,
  );
  return CUT;
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
  /** The last build's `RULES.json` rules, so the AI can say which old rule a
   * new line goes against. */
  previousRules?: Record<string, { text: string }>,
  /** The guide on disk to edit instead of rewriting it. Left out, the guide
   * is written in full. */
  edit?: GuideEditInput,
  /** Filled with what this build did, for the sync counter. */
  outcome?: { mode?: "full" | "edit" | "unchanged" },
): Promise<ReviewDocuments | undefined> {
  const findings = guideFindings(facts);
  if (findings.length <= 2) return undefined;

  const material = guideMaterial(facts);
  if (edit) {
    const edited = await editReviewGuides(
      provider,
      repo,
      ai,
      model,
      concurrency,
      facts,
      material,
      edit,
      usage,
    );
    if (edited !== FULL) {
      if (outcome) outcome.mode = edited.mode;
      return edited.documents;
    }
  }
  if (outcome) outcome.mode = "full";
  // No validator: the guide is kept as written. Losing the run over format is
  // not worth it, and a later `sync` reuses the cached text.
  const queue = new AiBatch(
    provider,
    repo,
    Math.max(1, concurrency),
    `${ai}:v3:${model}:guide`,
  );
  const fullResponse = await uncut(
    queue,
    fullGuideRequest(material, previousRulesMaterial(previousRules)),
    usage,
  );
  if (fullResponse === CUT) return undefined;
  const full = cleanGuide(fullResponse?.text ?? "");
  if (!full) {
    // Not a failure: SKILL.md and CODEBASE.md are written anyway.
    log("ai", "synth_guide produced nothing usable, skipping the guide");
    return undefined;
  }

  const sources = findingPullRequests(facts);
  const links = findingLinks(facts);
  const fullLines = full.split("\n").length;
  if (fullLines <= DETAIL_THRESHOLD_LINES) {
    return withRuleIds(withTrailingNewline(full), undefined, sources, links);
  }
  // The short guide is asked from the full method with its finding brackets
  // still on, so it can carry them over to the lines it summarizes.
  const shortResponse = await uncut(
    queue,
    shortGuideRequest(material, full),
    usage,
  );
  // A short guide cut twice keeps both files of the last run, so the two
  // guides never come from different builds.
  if (shortResponse === CUT) return undefined;
  const short = cleanGuide(shortResponse?.text ?? "");
  if (!short)
    return withRuleIds(withTrailingNewline(full), undefined, sources, links);
  return withRuleIds(withTrailingNewline(short), full, sources, links);
}

/** What a sync needs to edit the guide: the files on disk, the last build's
 * rules and the findings the guide was written from. */
export type GuideEditInput = {
  guide: string;
  detailed?: string;
  rules: Record<string, RuleEntry>;
  findings: string[];
};

const FULL = Symbol("rewrite in full");

/** The key a finding is compared by between builds. */
function findingKey(item: Fact): string {
  return item.claim.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The findings a guide is written from, by key, for the next edit. */
export function guideFindingKeys(facts: Fact[]): string[] {
  return guideFindings(facts).slice(0, MAX_FINDINGS).map(findingKey);
}

function editGuideRequest(
  current: string,
  added: string,
  gone: string,
): AiRequest {
  return {
    job: "edit_guide",
    maxTokens: 8_000,
    reasoningEffort: "high",
    system: GUIDE_SYSTEM,
    prompt: `Update the review method below with the findings that changed since it was written. Return only this JSON object:
{"add": [{"pass": "<the title of an existing pass>", "rule": "<rule> · <why it matters here> [<finding numbers>]", "example": "<the concrete case>"}],
 "change": [{"id": "R12", "rule": "<rule> · <why it matters here> [<finding numbers>]"}],
 "remove": ["R4"]}
- NEW FINDINGS are numbered. For each one, change the rule that already covers it and end its line with that finding's number, or add a rule under the pass it belongs to. A rule is a general invariant in the same shape as the rules in the method.
- GONE FINDINGS are no longer in the repository's history. Remove a rule only when nothing it says still holds, otherwise leave it.
- Name rules only by the ids at the end of their lines. Change nothing else. Empty lists are fine.

CURRENT METHOD:
${current}

NEW FINDINGS:
${added || "None."}

GONE FINDINGS:
${gone || "None."}`,
  };
}

/** Edits the guide on disk with the findings that changed. Returns `FULL`
 * when the guide must be rewritten instead: no usable answer, or an edit that
 * does not fit the file. A sync whose findings did not change keeps the guide
 * as it is and makes no call. */
async function editReviewGuides(
  provider: AiProvider,
  repo: string,
  ai: Options["ai"],
  model: string,
  concurrency: number,
  facts: Fact[],
  material: string,
  edit: GuideEditInput,
  usage?: UsageSink,
): Promise<
  | { mode: "edit" | "unchanged"; documents: ReviewDocuments | undefined }
  | typeof FULL
> {
  const current = guideFindings(facts).slice(0, MAX_FINDINGS);
  const keys = current.map(findingKey);
  const before = new Set(edit.findings);
  const now = new Set(keys);
  const added = (JSON.parse(material) as { number: number }[]).filter(
    (_item, index) => !before.has(keys[index]!),
  );
  const gone = edit.findings.filter((key) => !now.has(key));
  const main = edit.detailed ?? edit.guide;
  const ids = [
    ...new Set([
      ...guideRuleIds(main),
      ...(edit.detailed ? guideRuleIds(edit.guide) : []),
    ]),
  ];
  const kept = keptSources(ids, edit.rules, current.length);
  const sources = [...findingPullRequests(facts), ...kept.pullRequests];
  const links = [...findingLinks(facts), ...kept.links];
  const total = current.length + kept.pullRequests.length;
  const noEdits: GuideEdits = { add: [], change: [], remove: [] };
  const relabel = (edits: GuideEdits) => {
    const detailed = edit.detailed
      ? applyGuideEdits(edit.detailed, edits, kept.pseudo, current.length, true)
      : undefined;
    const guide = applyGuideEdits(
      edit.guide,
      edits,
      kept.pseudo,
      current.length,
      !edit.detailed,
    );
    return withRuleIds(
      withTrailingNewline(guide),
      detailed === undefined ? undefined : withTrailingNewline(detailed),
      sources,
      links,
      total,
    );
  };
  if (added.length === 0 && gone.length === 0) {
    log(
      "ai",
      "the review guide's findings did not change, keeping it as it is",
    );
    return { mode: "unchanged", documents: relabel(noEdits) };
  }
  const queue = new AiBatch(
    provider,
    repo,
    Math.max(1, concurrency),
    `${ai}:v3:${model}:guide`,
  );
  const response = await uncut(
    queue,
    editGuideRequest(
      main.trim(),
      added.length ? JSON.stringify(added, null, 2) : "",
      gone.length ? JSON.stringify(gone, null, 2) : "",
    ),
    usage,
  );
  if (response === CUT || !response) {
    log("ai", "edit_guide gave no usable answer, rewriting the guide in full");
    return FULL;
  }
  const edits = parseGuideEdits(response.text);
  if (!edits) {
    log(
      "ai",
      "edit_guide did not answer the edit format, rewriting the guide in full",
    );
    return FULL;
  }
  try {
    const documents = relabel(edits);
    log(
      "ai",
      `edit_guide · ${edits.add.length} added · ${edits.change.length} changed · ${edits.remove.length} removed`,
    );
    return { mode: "edit", documents };
  } catch (error) {
    if (!(error instanceof GuideEditError)) throw error;
    log("ai", `edit_guide: ${error.message}, rewriting the guide in full`);
    return FULL;
  }
}

/** Replaces the finding brackets with `R` ids and attaches each id's pull
 * requests. */
function withRuleIds(
  guide: string,
  detailed: string | undefined,
  sources: number[][],
  links: { pr: number; url: string }[][] = [],
  findingCount = sources.length,
): ReviewDocuments {
  const assigned = assignGuideIds(guide, detailed, findingCount);
  return {
    guide: assigned.guide,
    ...(assigned.detailed !== undefined ? { detailed: assigned.detailed } : {}),
    rules: assigned.rules.map((rule) => ({
      ...rule,
      pullRequests: [
        ...new Set(rule.findings.flatMap((n) => sources[n - 1] ?? [])),
      ].sort((a, b) => a - b),
      links: rule.findings
        .flatMap((n) => links[n - 1] ?? [])
        .filter(
          (link, index, all) =>
            all.findIndex((other) => other.url === link.url) === index,
        ),
    })),
    counts: assigned.counts,
  };
}

/** Strips a wrapping code fence and the tokens a guide must never carry (a
 * priority tag, a mention, a pull-request number), so an otherwise good guide is
 * cleaned rather than rejected. Runs of spaces are squeezed only after text: a
 * line's leading indent nests an example under its rule, as the prompt asks. */
function cleanGuide(text: string): string {
  return text
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .replace(/\[\s*P[0-3]\s*\]/gi, "")
    .replace(/@[A-Za-z0-9_-]{2,}/g, "")
    .replace(/\bPR\s*#?\s*\d+\b/gi, "the change")
    .replace(/(\S)[ \t]{2,}/g, "$1 ")
    .trim();
}
