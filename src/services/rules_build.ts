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
  ruleChangeLine,
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
import type { Source } from "../knowledge/types.ts";
import type { AiProvider, AiResponse, Options } from "../types.ts";
import { log } from "../util/log.ts";
import { readTextFile, remove } from "../util/runtime.ts";

export type InstructionsOutcome =
  | InstructionsResult
  | { status: "skipped"; reason: string };

/** Why no instructions are built this run, or `null` when they are. */
function skipReason(options: Options, source: Source): string | null {
  if (!options.includeCodebase) return "--include-codebase is off";
  if (options.agentInstructions?.trim() === "") {
    return "--agent-instructions is blank";
  }
  if (Object.keys(source.instructionFiles ?? {}).length === 0) {
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
  log("ai", "starting synth_instructions job");
  const result = await synthesizeInstructions(
    provider,
    options.repo,
    options.ai,
    options.highModel ?? "",
    source.instructionFiles ?? {},
    source.tree,
    agentInstructionsLimit(options.agentInstructionsMaxChars),
    usage,
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
};

async function readRulesFile(repo: string) {
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
          return date ? { pr, mergedAt: date } : { pr };
        }),
      },
    ]),
  );
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
  documents: ReviewDocuments | undefined;
  signalCount: number;
  instructions: InstructionsOutcome;
  source: Source;
}): Promise<RulesWriteResult> {
  const { repo, documents, instructions, source } = input;
  const directory = `${reposDir()}/${repo}`;
  const { writeTextFileAtomic } = await import("../util/atomic.ts");
  const previous = await readRulesFile(repo);

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
    case "empty":
      await remove(`${directory}/${INSTRUCTIONS_FILE}`).catch(() => {});
      log("write", instructionsLine(instructions.counts));
      break;
    case "skipped":
      await remove(`${directory}/${INSTRUCTIONS_FILE}`).catch(() => {});
      log("write", `${INSTRUCTIONS_FILE} skipped: ${instructions.reason}`);
      break;
  }

  const rules = {
    ...guideEntries(documents, input.signalCount, previous?.rules, source),
    ...instructionRules,
  };
  await writeTextFileAtomic(
    `${directory}/${RULES_FILE}`,
    rulesFileText({
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      rules,
    }),
  );

  if (!previous) return { rules: Object.keys(rules).length, changes: null };
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
  return { rules: Object.keys(rules).length, changes };
}
