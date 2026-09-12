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
};

const FILE_LINE =
  /(?<path>(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+):(?<from>\d+)(?:-(?<to>\d+))?/g;
const NEW_HEADING =
  /^\[(?<severity>P[0-3])\s*·\s*(?<impact>blocking|non-blocking)\]\s+(?<path>.+?)\s+—\s+(?<symbol>.+)$/;

function uncode(value: string): string {
  return value.trim().replace(/^`|`$/g, "").trim();
}

function location(block: string): {
  path: string;
  from: number;
  to: number;
} | undefined {
  const match = block.match(
    /^\s*(?:Location|File)\s*:\s*`?(.+?)`?\s*$/im,
  );
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

function bodyWithoutLocation(block: string): string {
  return block.replace(
    /^\s*(?:Location|File)\s*:\s*`?.+?`?\s*$/im,
    "",
  ).trim();
}

function newFinding(
  header: string,
  block: string,
): ParsedFinding | undefined {
  const meta = NEW_HEADING.exec(header);
  if (!meta?.groups) return undefined;
  const at = location(block);
  if (!at) return undefined;
  const path = uncode(meta.groups.path);
  const symbol = uncode(meta.groups.symbol);
  const severity = meta.groups.severity;
  const impact = meta.groups.impact;
  const excerpt = bodyWithoutLocation(block);
  const summary = excerpt.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return {
    ...at,
    path,
    heading: `[${severity} · ${impact}] \`${path}\` — \`${symbol}\``,
    excerpt,
    severity,
    blocking: impact === "blocking",
    symbol,
    summary,
  };
}

export function parseFindings(markdown: string): ParsedFinding[] {
  const findingsHeading = markdown.search(/^## Findings\b/m);
  const body = findingsHeading === -1
    ? markdown
    : markdown.slice(findingsHeading);
  if (/No actionable findings/i.test(body)) return [];

  const findings: ParsedFinding[] = [];
  const headings = [...body.matchAll(/^###\s+(.+)$/gm)];
  for (let index = 0; index < headings.length; index++) {
    const current = headings[index];
    const start = (current.index ?? 0) + current[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    const parsed = newFinding(
      current[1].trim(),
      body.slice(start, end),
    );
    if (parsed) findings.push(parsed);
  }
  if (findings.length > 0) return findings;

  const seen = new Set<string>();
  for (const lined of body.matchAll(FILE_LINE)) {
    if (!lined.groups?.path || !lined.groups.from) continue;
    const from = Number(lined.groups.from);
    const to = lined.groups.to ? Number(lined.groups.to) : from;
    const key = `${lined.groups.path}:${from}-${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = lined.index ?? 0;
    const headingStart = body.lastIndexOf("\n###", at);
    const headingLine = headingStart >= 0
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
