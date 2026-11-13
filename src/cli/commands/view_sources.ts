/** `view --sources`: every rule id with where it came from.
 *
 * ```
 * PR_REVIEW_GUIDE.md
 *   R12  Money formatting goes through formatMoney() · rounding differs per currency
 *        #212, #340 · newest 2026-03
 * INSTRUCTIONS.md
 *   I1   Format amounts with formatMoney(), never with number methods
 *        AGENTS.md:31 · packages/billing/AGENTS.md:8
 * ```
 */
import {
  DETAILED_GUIDE_FILE,
  GUIDE_FILE,
  INSTRUCTIONS_FILE,
  sortedRuleIds,
  sourceLabel,
  type RuleEntry,
  type RulesFile,
} from "../../knowledge/rules.ts";

const FILE_ORDER = [GUIDE_FILE, DETAILED_GUIDE_FILE, INSTRUCTIONS_FILE];

/** The second line under a rule: its pull requests with the newest merge
 * month, or its instruction file lines. */
function sourcesLine(entry: RuleEntry): string {
  if (entry.sources.length === 0) return "no sources";
  const pulls = entry.sources.filter(
    (source): source is { pr: number; mergedAt?: string } => "pr" in source,
  );
  if (pulls.length === 0) {
    return entry.sources.map(sourceLabel).join(" · ");
  }
  const numbers = pulls.map(sourceLabel).join(", ");
  const months = pulls
    .map((source) => source.mergedAt?.slice(0, 7))
    .filter((month): month is string => Boolean(month))
    .sort();
  const newest = months.at(-1);
  if (pulls.length === 1) {
    return [numbers, newest, "1 PR"].filter(Boolean).join(" · ");
  }
  return newest ? `${numbers} · newest ${newest}` : numbers;
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
