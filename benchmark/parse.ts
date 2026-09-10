import type { Span } from "./match.ts";

export type ParsedFinding = Span & { heading: string; excerpt: string };

const FILE_LINE =
  /(?<path>(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+):(?<from>\d+)(?:-(?<to>\d+))?/g;

export function parseFindings(markdown: string): ParsedFinding[] {
  const findingsHeading = markdown.search(/^## Findings\b/m);
  const body = findingsHeading === -1
    ? markdown
    : markdown.slice(findingsHeading);
  if (/No actionable findings/i.test(body)) return [];

  const findings: ParsedFinding[] = [];
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
