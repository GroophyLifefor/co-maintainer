/** The severity legend and the review-copy rule (CORE-83 / D11).
 *
 * Product text avoids the em dash and the semicolon: the docs linter rejects
 * them, and the finding parser had to accept both a `—` and a `:` heading
 * separator only because the prompt itself modelled the em dash. The colon is
 * the one separator now. The legacy parser still reads an em dash heading so
 * comments posted before 0.5.0 stay readable. */

/** `[P2] path: symbol` headings and `Summary: 3 new, 1 open, ...` lines are
 * built from this legend, so the four levels read the same everywhere. */
export const SEVERITY_LEGEND: ReadonlyArray<{
  level: string;
  name: string;
  description: string;
}> = [
  {
    level: "P0",
    name: "Critical",
    description: "production outage, data loss, or security issue",
  },
  {
    level: "P1",
    name: "High",
    description: "major behavior is broken and should be fixed before merge",
  },
  {
    level: "P2",
    name: "Medium",
    description: "important correctness or maintainability issue",
  },
  {
    level: "P3",
    name: "Low",
    description: "minor, non-blocking improvement or edge case",
  },
];

/** The `## Severity` block the review text starts with. The colon keeps it
 * free of the em dash the old prompt used. */
export function severitySection(): string {
  const items = SEVERITY_LEGEND.map(
    (row) => `- ${row.level}: ${row.name}: ${row.description}.`,
  );
  return `## Severity\n\n${items.join("\n")}\n`;
}

/** What the model is told about prose (CORE-83). The review body is rendered
 * by our code, not the model, so this only has to keep the fields clean. */
export const REVIEW_COPY_RULE =
  "Write prose without the em dash or the semicolon. Use a colon or a comma instead.";
