/** `RULES.json`: every instruction rule's id, text and sources.
 *
 * `INSTRUCTIONS.md` carries only a short id per rule (`[I1]`). Where a rule
 * came from (instruction file lines) lives here, outside the prompt, so the
 * guide block stays byte stable for the prompt cache. Written in the guide
 * directory under the knowledge lock with the guides, so an id and its text
 * always come from one build. */

export const RULES_FILE = "RULES.json";
export const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

/** An instruction rule rests on lines of an instruction file. */
export type RuleSource = { path: string; line: number };

export type RuleEntry = {
  file: string;
  text: string;
  /** Instruction rules only: the default branch commit the lines were read
   * at, when the build knew it. */
  commit?: string;
  /** Instruction rules only: the folder the rule applies to, empty for the
   * whole repository. */
  scope?: string;
  sources: RuleSource[];
};

export type RulesFile = {
  schemaVersion: 1;
  builtAt: string;
  rules: Record<string, RuleEntry>;
};

/** Ids are `I` for instruction rules, then a number. `C` is kept for built-in
 * checks. */
export const RULE_ID = /^I[1-9]\d*$/;

function isSource(value: unknown): value is RuleSource {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && typeof record.line === "number";
}

/** The parsed file, or `null` when it is missing, not JSON, or not this
 * schema. An entry that does not fit is skipped rather than losing the rest. */
export function parseRules(text: string): RulesFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  if (!record.rules || typeof record.rules !== "object") return null;
  const rules: Record<string, RuleEntry> = {};
  for (const [id, value] of Object.entries(
    record.rules as Record<string, unknown>,
  )) {
    if (!RULE_ID.test(id) || !value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.file !== "string" || typeof entry.text !== "string") {
      continue;
    }
    const sources = Array.isArray(entry.sources)
      ? entry.sources.filter(isSource)
      : [];
    rules[id] = {
      file: entry.file,
      text: entry.text,
      ...(typeof entry.commit === "string" ? { commit: entry.commit } : {}),
      ...(typeof entry.scope === "string" ? { scope: entry.scope } : {}),
      sources,
    };
  }
  return {
    schemaVersion: 1,
    builtAt: typeof record.builtAt === "string" ? record.builtAt : "",
    rules,
  };
}

function idNumber(id: string): number {
  return Number(id.slice(1));
}

/** Ids in reading order, by number. */
export function sortedRuleIds(rules: Record<string, RuleEntry>): string[] {
  return Object.keys(rules).sort((a, b) => idNumber(a) - idNumber(b));
}

export function rulesFileText(file: RulesFile): string {
  const rules: Record<string, RuleEntry> = {};
  for (const id of sortedRuleIds(file.rules)) rules[id] = file.rules[id];
  return `${JSON.stringify({ ...file, rules }, null, 2)}\n`;
}

/** The rules of one kind, by id prefix. */
export function rulesOfKind(
  rules: Record<string, RuleEntry> | undefined,
  kind: "I",
): Record<string, RuleEntry> {
  return Object.fromEntries(
    Object.entries(rules ?? {}).filter(([id]) => id.startsWith(kind)),
  );
}

/** `AGENTS.md:31`: one source as a reader writes it, and as the change report
 * compares it. */
export function sourceLabel(source: RuleSource): string {
  return `${source.path}:${source.line}`;
}
