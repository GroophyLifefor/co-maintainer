/** `RULES.json`: every guide and instruction rule's id, text and sources.
 *
 * The guides carry only a short id per rule (`[R12]`, `[I1]`). Where a rule
 * came from (pull requests and their merge dates, instruction file lines) lives
 * here, outside the prompt, so the guide block stays byte stable for the
 * prompt cache and dates never reach the model. Written in the guide
 * directory under the knowledge lock with the guides, so an id and its text
 * always come from one build. */

export const RULES_FILE = "RULES.json";
export const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";
export const GUIDE_FILE = "PR_REVIEW_GUIDE.md";
export const DETAILED_GUIDE_FILE = "PR_REVIEW_DETAILED_GUIDE.md";

/** A guide rule rests on pull requests, an instruction rule on lines of an
 * instruction file. `mergedAt` is a `YYYY-MM-DD` date, missing for an
 * unmerged pull request or one cached before the date was kept. */
export type RuleSource =
  | { pr: number; mergedAt?: string }
  | { path: string; line: number };

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

/** Ids are `R` for guide rules and `I` for instruction rules, then a number.
 * `C` is kept for built-in checks. */
export const RULE_ID = /^[RI][1-9]\d*$/;

function isSource(value: unknown): value is RuleSource {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.pr === "number") {
    return record.mergedAt === undefined || typeof record.mergedAt === "string";
  }
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

/** Ids in reading order: guide rules, then instruction rules, each by number. */
export function sortedRuleIds(rules: Record<string, RuleEntry>): string[] {
  const kind = (id: string): number => (id.startsWith("R") ? 0 : 1);
  return Object.keys(rules).sort(
    (a, b) => kind(a) - kind(b) || idNumber(a) - idNumber(b),
  );
}

export function rulesFileText(file: RulesFile): string {
  const rules: Record<string, RuleEntry> = {};
  for (const id of sortedRuleIds(file.rules)) rules[id] = file.rules[id];
  return `${JSON.stringify({ ...file, rules }, null, 2)}\n`;
}

/** The rules of one kind, `R` or `I`. */
export function rulesOfKind(
  rules: Record<string, RuleEntry> | undefined,
  kind: "R" | "I",
): Record<string, RuleEntry> {
  return Object.fromEntries(
    Object.entries(rules ?? {}).filter(([id]) => id.startsWith(kind)),
  );
}

/** `#212` or `AGENTS.md:31`: one source as a reader writes it, and as the
 * change report compares it. */
export function sourceLabel(source: RuleSource): string {
  return "pr" in source ? `#${source.pr}` : `${source.path}:${source.line}`;
}

/** `2026-03-04` from an ISO timestamp, or `undefined` when there is none. */
export function mergedDate(iso: string | undefined): string | undefined {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined;
}
