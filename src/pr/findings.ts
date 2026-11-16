export type Span = {
  path: string;
  from: number;
  to: number;
};

export type ParsedFinding = Span & {
  heading: string;
  excerpt: string;
  severity?: string;
  blocking?: boolean;
  symbol?: string;
  summary?: string;
  /** The ids from the finding's `References:` line, as the model wrote them.
   * Missing when the line is absent. */
  references?: string[];
};

const FILE_LINE =
  /(?<path>(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+):(?<from>\d+)(?:-(?<to>\d+))?/g;
/** The finding heading: `[P2 · non-blocking] \`path\`: \`symbol\``. The model
 * sometimes leaves the symbol off, so the symbol is optional: an unrecognised
 * heading used to send every finding down the fallback path, which is what
 * produced the truncated and shifted output. The separator may also sit
 * directly against the path (`\`src/a.ts\`: \`helper()\``), which is how the
 * model usually writes it. */
const NEW_HEADING =
  /^\[(?<severity>P[0-3])\s*·\s*(?<impact>blocking|non-blocking)\]\s+(?<path>.+?)(?:\s*:\s*(?<symbol>.+))?$/;

function uncode(value: string): string {
  return value.trim().replace(/^`|`$/g, "").trim();
}

function location(block: string):
  | {
      path: string;
      from: number;
      to: number;
    }
  | undefined {
  const match = block.match(/^\s*(?:Location|File)\s*:\s*`?(.+?)`?\s*$/im);
  const source = match?.[1] ?? block;
  const found = [...source.matchAll(FILE_LINE)][0];
  if (!found?.groups?.path || !found.groups.from) return undefined;
  const from = Number(found.groups.from);
  return {
    path: found.groups.path,
    from,
    to: found.groups.to ? Number(found.groups.to) : from,
  };
}

/** The `References:` line, only right under the Location line where
 * `findingMarkdown` writes it, so a body sentence starting with the same word
 * is never taken. */
const REFERENCES_LINE =
  /^(\s*(?:Location|File)\s*:[^\n]*)\n\s*References\s*:\s*([^\n]+?)\s*$/im;

function references(block: string): string[] | undefined {
  const match = REFERENCES_LINE.exec(block);
  if (!match) return undefined;
  return match[2]
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function bodyWithoutLocation(block: string): string {
  return block
    .replace(REFERENCES_LINE, "$1")
    .replace(/^\s*(?:Location|File)\s*:\s*`?.+?`?\s*$/im, "")
    .trim();
}

function newFinding(header: string, block: string): ParsedFinding | undefined {
  const meta = NEW_HEADING.exec(header);
  if (!meta?.groups) return undefined;
  const at = location(block);
  if (!at) return undefined;
  const path = uncode(meta.groups.path);
  const symbol = uncode(meta.groups.symbol ?? "");
  const severity = meta.groups.severity;
  const impact = meta.groups.impact;
  const excerpt = bodyWithoutLocation(block);
  const summary = excerpt.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return {
    ...at,
    // The Location line is authoritative for the path. The heading only names
    // it, and may omit the symbol entirely.
    path: at.path || path,
    heading: symbol
      ? `[${severity} · ${impact}] \`${path}\`: \`${symbol}\``
      : `[${severity} · ${impact}] \`${path}\``,
    excerpt,
    severity,
    blocking: impact === "blocking",
    symbol: symbol || undefined,
    summary,
    ...(() => {
      const ids = references(block);
      return ids ? { references: ids } : {};
    })(),
  };
}

export function parseFindings(markdown: string): ParsedFinding[] {
  const previousHeading = markdown.search(/^## Previous findings\b/im);
  const withoutVerdicts =
    previousHeading === -1 ? markdown : markdown.slice(0, previousHeading);
  const findingsHeading = withoutVerdicts.search(/^## Findings\b/m);
  const body =
    findingsHeading === -1
      ? withoutVerdicts
      : withoutVerdicts.slice(findingsHeading);
  if (/No actionable findings/i.test(body)) return [];

  const findings: ParsedFinding[] = [];
  const headings = [...body.matchAll(/^###\s+(.+)$/gm)];
  for (let index = 0; index < headings.length; index++) {
    const current = headings[index];
    const start = (current.index ?? 0) + current[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    const parsed = newFinding(current[1].trim(), body.slice(start, end));
    if (parsed) findings.push(parsed);
  }
  if (findings.length > 0) return findings;

  const seen = new Set<string>();
  for (const lined of body.matchAll(FILE_LINE)) {
    if (!lined.groups?.path || !lined.groups.from) continue;
    const lineStart = body.lastIndexOf("\n", lined.index ?? 0) + 1;
    if (/^\s*Suggestion\s*:/.test(body.slice(lineStart, lined.index))) continue;
    const from = Number(lined.groups.from);
    const to = lined.groups.to ? Number(lined.groups.to) : from;
    const key = `${lined.groups.path}:${from}-${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = lined.index ?? 0;
    const headingStart = body.lastIndexOf("\n###", at);
    const headingLine =
      headingStart >= 0
        ? body.slice(headingStart, body.indexOf("\n", headingStart + 1)).trim()
        : "";
    findings.push({
      path: lined.groups.path,
      from,
      to,
      heading: headingLine.replace(/^###\s*/, ""),
      excerpt: body.slice(Math.max(0, at - 80), at + 200).trim(),
    });
  }
  return findings;
}
