/** The `INSTRUCTIONS.md` and `RULES.json` half of `init` and `sync`.
 *
 * Kept out of `setup.ts` so the build step there stays one call to build the
 * instructions and one call, under the knowledge lock, to write them with the
 * rules. */
import { reposDir } from "../config.ts";
import type { ReviewDocuments } from "../knowledge/guide.ts";
import { guideWriteLine } from "../knowledge/guide_ids.ts";
import {
  agentInstructionsLimit,
  DEFAULT_AGENT_INSTRUCTIONS,
} from "../knowledge/instruction_files.ts";
import {
  instructionRuleEntries,
  instructionsWriteLine,
  synthesizeInstructions,
  type InstructionCounts,
  type InstructionsResult,
} from "../knowledge/instructions.ts";
import {
  compareRules,
  contradictionLine,
  contradictions,
  ruleChangeLine,
  type Contradiction,
  type RuleChanges,
} from "../knowledge/rule_changes.ts";
import {
  INSTRUCTIONS_FILE,
  mergedDate,
  parseRules,
  RULES_FILE,
  rulesFileText,
  rulesOfKind,
  type RuleEntry,
} from "../knowledge/rules.ts";
import { renameIdsInMarkdown, stableIds } from "../knowledge/stable_ids.ts";
import type { Source } from "../knowledge/types.ts";
import type { AiProvider, AiResponse, Options } from "../types.ts";
import { log, timed } from "../util/log.ts";
import { readTextFile, remove, stat } from "../util/runtime.ts";

export type InstructionsOutcome =
  | InstructionsResult
  | { status: "skipped"; reason: string }
  /** Files matched but none could be read: a GitHub hiccup, not a removed
   * file, so the previous file and its ids are kept. */
  | { status: "unreadable" };

/** Why no instructions are built this run, or `null` when they are. */
function skipReason(options: Options, source: Source): string | null {
  if (!options.includeCodebase) return "--include-codebase is off";
  if (options.agentInstructions?.trim() === "") {
    return "--agent-instructions is blank";
  }
  // `collect` leaves the field out when nothing matched, and leaves it empty
  // when files matched but none could be read.
  if (source.instructionFiles === undefined) {
    return `no file matches ${options.agentInstructions ?? DEFAULT_AGENT_INSTRUCTIONS}`;
  }
  return null;
}

/** One `synth_instructions` call over the files `collect` read. Never
 * throws: the run must not fail over the instructions. */
export async function buildInstructions(
  provider: AiProvider,
  options: Options,
  source: Source,
  usage: (job: string, response: AiResponse) => Promise<void>,
): Promise<InstructionsOutcome> {
  const reason = skipReason(options, source);
  if (reason) return { status: "skipped", reason };
  if (Object.keys(source.instructionFiles ?? {}).length === 0) {
    return { status: "unreadable" };
  }
  log("ai", "starting synth_instructions job");
  // Timed only when it runs, so a repository with no instruction file gets
  // no extra `--log-time` line.
  const result = await timed("synth_instructions AI", options.logTime, () =>
    synthesizeInstructions(
      provider,
      options.repo,
      options.ai,
      options.highModel ?? "",
      source.instructionFiles ?? {},
      source.tree,
      agentInstructionsLimit(options.agentInstructionsMaxChars),
      usage,
    ),
  ).catch((): InstructionsResult => ({ status: "failed" }));
  log("ai", `synth_instructions complete · ${result.status}`);
  return result;
}

/** What `init --json` and `sync --json` say about `INSTRUCTIONS.md`. */
export function instructionsJson(outcome: InstructionsOutcome): {
  status: "written" | "kept" | "empty" | "skipped";
  rules: number;
  reason?: string;
  counts?: InstructionCounts;
} {
  switch (outcome.status) {
    case "written":
      return {
        status: "written",
        rules: outcome.rules.length,
        counts: outcome.counts,
      };
    case "failed":
      return { status: "kept", rules: 0 };
    case "unreadable":
      return {
        status: "kept",
        rules: 0,
        reason: "no matched instruction file could be read",
      };
    case "empty":
      return { status: "empty", rules: 0, counts: outcome.counts };
    case "skipped":
      return { status: "skipped", rules: 0, reason: outcome.reason };
  }
}

export type RulesWriteResult = {
  rules: number;
  /** `null` when there was no earlier `RULES.json` to compare with. */
  changes: { guide: RuleChanges; instructions: RuleChanges } | null;
  /** Old guide rules a new rule goes against, checked by date. */
  contradicted: Contradiction[];
  /** False when nothing happened that the run's output should mention: the
   * instructions were skipped, no guide rule was built, and there was no
   * earlier `INSTRUCTIONS.md` or `RULES.json`. */
  reported: boolean;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readRulesFile(repo: string) {
  try {
    return parseRules(
      await readTextFile(`${reposDir()}/${repo}/${RULES_FILE}`),
    );
  } catch {
    return null;
  }
}

/** The `R` entries for this build. A guide this run wrote brings its own. A
 * guide kept from the last run (the AI produced none) keeps the last run's
 * ids. A guide that was removed has none. */
function guideEntries(
  documents: ReviewDocuments | undefined,
  signalCount: number,
  previous: Record<string, RuleEntry> | undefined,
  source: Source,
): Record<string, RuleEntry> {
  if (!documents) {
    return signalCount > 2 ? rulesOfKind(previous, "R") : {};
  }
  const mergedAt = new Map(
    source.pullRequests.map((pr) => [pr.number, mergedDate(pr.mergedAt)]),
  );
  return Object.fromEntries(
    (documents.rules ?? []).map((rule) => [
      rule.id,
      {
        file: rule.file,
        text: rule.text,
        sources: rule.pullRequests.map((pr) => {
          const date = mergedAt.get(pr);
          const url = rule.links?.find((link) => link.pr === pr)?.url;
          return {
            pr,
            ...(date ? { mergedAt: date } : {}),
            ...(url ? { url } : {}),
          };
        }),
      },
    ]),
  );
}

/** The guides and instructions of this build with their ids mapped onto the
 * last build's, so a rule keeps its id across syncs and a dropped id is never
 * given again. Runs under the knowledge lock, before anything is written. */
export async function stabilizeRuleIds(
  repo: string,
  documents: ReviewDocuments | undefined,
  instructions: InstructionsOutcome,
): Promise<{
  documents: ReviewDocuments | undefined;
  instructions: InstructionsOutcome;
  lastIds: { R: number; I: number };
}> {
  const previous = await readRulesFile(repo);
  const guide = stableIds(
    "R",
    (documents?.rules ?? []).map((rule) => ({
      id: rule.id,
      text: rule.text,
      sources: rule.pullRequests.map((pr) => {
        const url = rule.links?.find((link) => link.pr === pr)?.url;
        return url ? { pr, url } : { pr };
      }),
      // A rule never takes the id of the rule it goes against.
      avoid: rule.overturns ?? [],
    })),
    previous?.rules,
    previous?.lastIds?.R,
  );
  const fromInstructions = stableIds(
    "I",
    instructions.status === "written"
      ? instructions.rules.map((rule) => ({
          id: rule.id,
          text: rule.text.replaceAll("`", ""),
          sources: rule.sources,
        }))
      : [],
    previous?.rules,
    previous?.lastIds?.I,
  );
  const renamedDocuments = documents && {
    ...documents,
    guide: renameIdsInMarkdown(documents.guide, guide.ids),
    ...(documents.detailed !== undefined
      ? { detailed: renameIdsInMarkdown(documents.detailed, guide.ids) }
      : {}),
    ...(documents.rules
      ? {
          rules: documents.rules.map((rule) => ({
            ...rule,
            id: guide.ids.get(rule.id) ?? rule.id,
          })),
        }
      : {}),
  };
  const renamedInstructions: InstructionsOutcome =
    instructions.status === "written"
      ? {
          ...instructions,
          markdown: renameIdsInMarkdown(
            instructions.markdown,
            fromInstructions.ids,
          ),
          rules: instructions.rules.map((rule) => ({
            ...rule,
            id: fromInstructions.ids.get(rule.id) ?? rule.id,
          })),
        }
      : instructions;
  return {
    documents: renamedDocuments,
    instructions: renamedInstructions,
    lastIds: { R: guide.lastId, I: fromInstructions.lastId },
  };
}

/** Never lower than any id in the file or any id given before. */
function lastIdsFor(
  rules: Record<string, RuleEntry>,
  previous: { R: number; I: number } | undefined,
  given: { R: number; I: number } | undefined,
): { R: number; I: number } {
  const top = (kind: "R" | "I") =>
    Math.max(
      previous?.[kind] ?? 0,
      given?.[kind] ?? 0,
      ...Object.keys(rules)
        .filter((id) => id.startsWith(kind))
        .map((id) => Number(id.slice(1)) || 0),
    );
  return { R: top("R"), I: top("I") };
}

function instructionsLine(counts: InstructionCounts): string {
  const dropped = counts.unsupportedSource + counts.unknownName;
  return `${INSTRUCTIONS_FILE} skipped: the instruction files hold no rule a reviewer can check · ${dropped} dropped · ${counts.overCap} over the cap`;
}

/** Writes or removes `INSTRUCTIONS.md`, writes `RULES.json`, and reports
 * what changed since the last build. The caller holds the knowledge lock, so
 * the ids here and the guides just written belong to one build. */
export async function writeInstructionsAndRules(input: {
  repo: string;
  /** `init` names a skip even with nothing to remove, so a first build says
   * why it has no `INSTRUCTIONS.md`. A `sync` stays quiet then. */
  command: "init" | "remake" | "probe" | "review";
  documents: ReviewDocuments | undefined;
  signalCount: number;
  instructions: InstructionsOutcome;
  source: Source;
  /** From `stabilizeRuleIds`. Missing keeps the highest ids in the file. */
  lastIds?: { R: number; I: number };
}): Promise<RulesWriteResult> {
  const { repo, documents, instructions, source } = input;
  const directory = `${reposDir()}/${repo}`;
  const { writeTextFileAtomic } = await import("../util/atomic.ts");
  const previous = await readRulesFile(repo);
  const hadInstructions = await exists(`${directory}/${INSTRUCTIONS_FILE}`);
  const hadRules = await exists(`${directory}/${RULES_FILE}`);
  const guideRules = guideEntries(
    documents,
    input.signalCount,
    previous?.rules,
    source,
  );
  if (
    instructions.status === "skipped" &&
    !hadInstructions &&
    !hadRules &&
    Object.keys(guideRules).length === 0 &&
    (documents?.counts ?? []).length === 0
  ) {
    if (input.command === "init") {
      log("write", `${INSTRUCTIONS_FILE} skipped: ${instructions.reason}`);
    }
    return { rules: 0, changes: null, contradicted: [], reported: false };
  }

  for (const count of documents?.counts ?? []) {
    log("write", guideWriteLine(count));
  }

  let instructionRules: Record<string, RuleEntry> = {};
  switch (instructions.status) {
    case "written": {
      await writeTextFileAtomic(
        `${directory}/${INSTRUCTIONS_FILE}`,
        instructions.markdown,
      );
      const head = source.commits[0] as { sha?: string } | undefined;
      instructionRules = instructionRuleEntries(
        instructions.rules,
        head?.sha ? String(head.sha) : undefined,
      );
      log(
        "write",
        instructionsWriteLine(instructions.rules.length, instructions.counts),
      );
      break;
    }
    case "failed":
      // As with the guide: a provider hiccup must not delete the file the
      // last run wrote, so it and its ids are kept.
      instructionRules = rulesOfKind(previous?.rules, "I");
      log(
        "write",
        `${INSTRUCTIONS_FILE} not regenerated: the AI produced no usable rules, keeping any existing file`,
      );
      break;
    case "unreadable":
      // A failed fetch is not a removed file: keep what the last run wrote.
      instructionRules = rulesOfKind(previous?.rules, "I");
      log(
        "write",
        `${INSTRUCTIONS_FILE} not regenerated: no matched instruction file could be read, keeping any existing file`,
      );
      break;
    case "empty":
      await remove(`${directory}/${INSTRUCTIONS_FILE}`).catch(() => {});
      log("write", instructionsLine(instructions.counts));
      break;
    case "skipped":
      await remove(`${directory}/${INSTRUCTIONS_FILE}`).catch(() => {});
      // Guide rules bring every repository here, so the skip is only named
      // when a file was removed or on a first build.
      if (hadInstructions || input.command === "init") {
        log("write", `${INSTRUCTIONS_FILE} skipped: ${instructions.reason}`);
      }
      break;
  }

  const rules = { ...guideRules, ...instructionRules };
  if (Object.keys(rules).length > 0) {
    await writeTextFileAtomic(
      `${directory}/${RULES_FILE}`,
      rulesFileText({
        schemaVersion: 1,
        builtAt: new Date().toISOString(),
        rules,
        lastIds: lastIdsFor(rules, previous?.lastIds, input.lastIds),
      }),
    );
  } else {
    // No rule means no file, as with `INSTRUCTIONS.md`.
    await remove(`${directory}/${RULES_FILE}`).catch(() => {});
  }

  if (!previous) {
    return {
      rules: Object.keys(rules).length,
      changes: null,
      contradicted: [],
      reported: true,
    };
  }
  const contradicted = contradictions(
    previous.rules,
    rules,
    new Map(
      (documents?.rules ?? [])
        .filter((rule) => rule.overturns?.length)
        .map((rule) => [rule.id, rule.overturns ?? []]),
    ),
  );
  const inWindow = new Set(source.pullRequests.map((pr) => pr.number));
  const changes = {
    guide: compareRules(previous.rules, rules, "R", inWindow),
    instructions: compareRules(previous.rules, rules, "I"),
  };
  for (const [phase, kind, change] of [
    ["guide", "R", changes.guide],
    ["instructions", "I", changes.instructions],
  ] as const) {
    const any =
      Object.keys(rulesOfKind(previous.rules, kind)).length > 0 ||
      Object.keys(rulesOfKind(rules, kind)).length > 0;
    if (any) log(phase, ruleChangeLine(change));
  }
  for (const item of contradicted) log("guide", contradictionLine(item));
  return {
    rules: Object.keys(rules).length,
    changes,
    contradicted,
    reported: true,
  };
}
