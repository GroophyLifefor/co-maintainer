/** `view --sources`: every rule id with where it came from.
 *
 * ```
 * INSTRUCTIONS.md
 *   I1   Format amounts with formatMoney(), never with number methods
 *        AGENTS.md:31 · packages/billing/AGENTS.md:8
 * ```
 */
import {
  INSTRUCTIONS_FILE,
  sortedRuleIds,
  sourceLabel,
  type RuleEntry,
  type RulesFile,
} from "../../knowledge/rules.ts";

const FILE_ORDER = [INSTRUCTIONS_FILE];

/** The second line under a rule: its instruction file lines. */
function sourcesLine(entry: RuleEntry): string {
  if (entry.sources.length === 0) return "no sources";
  return entry.sources.map(sourceLabel).join(" · ");
}

/** The human listing, grouped by the file each rule lives in. */
export function renderSources(file: RulesFile): string {
  const ids = sortedRuleIds(file.rules);
  if (ids.length === 0) return "No rules recorded.";
  const width = Math.max(...ids.map((id) => id.length)) + 2;
  const files = [
    ...FILE_ORDER,
    ...[...new Set(ids.map((id) => file.rules[id].file))].filter(
      (name) => !FILE_ORDER.includes(name),
    ),
  ];
  const lines: string[] = [];
  for (const name of files) {
    const inFile = ids.filter((id) => file.rules[id].file === name);
    if (inFile.length === 0) continue;
    lines.push(name);
    for (const id of inFile) {
      const entry = file.rules[id];
      lines.push(`  ${id.padEnd(width)}${entry.text}`);
      lines.push(`  ${" ".repeat(width)}${sourcesLine(entry)}`);
    }
  }
  return lines.join("\n");
}
