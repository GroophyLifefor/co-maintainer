/** Guide rule ids and the findings each guide line rests on.
 *
 * The guide prompt numbers the findings it is given and asks the model to end
 * every check line with the numbers of the findings it merges, `[3, 17]`.
 * Code then replaces that bracket with an `R` id and remembers the findings,
 * so the pull requests behind a line can be recorded in `RULES.json` without
 * a pull request number or a date ever entering the guide. */
import { DETAILED_GUIDE_FILE, GUIDE_FILE } from "./rules.ts";

export type GuideRule = {
  id: string;
  file: string;
  /** The line without its bullet, its id and its backticks. */
  text: string;
  /** 1-based numbers of the findings the line merges, sorted. */
  findings: number[];
};

export type GuideFileCount = { file: string; rules: number; withIds: number };

const FINDING_BRACKET = /\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g;

/** A top-level `rule · why` bullet, the guide's unit of a check. The link to
 * the detailed file is not a check. */
function isCheckLine(line: string): boolean {
  return line.startsWith("- ") && line.includes(" · ") && !line.includes("](");
}

/** Runs `fn` on the parts of a line outside inline code, so `items[0]` in
 * backticks is never read as a finding bracket. */
function outsideCode(line: string, fn: (part: string) => string): string {
  return line
    .split("`")
    .map((part, index) => (index % 2 === 0 ? fn(part) : part))
    .join("`");
}

/** The finding numbers on a line, and the line without them. */
function takeBrackets(line: string): { numbers: number[]; line: string } {
  const numbers: number[] = [];
  const stripped = outsideCode(line, (part) =>
    part.replace(FINDING_BRACKET, (match) => {
      for (const value of match.match(/\d+/g) ?? [])
        numbers.push(Number(value));
      return "";
    }),
  );
  return { numbers, line: stripped.trimEnd() };
}

function setKey(numbers: number[]): string {
  return numbers.join(",");
}

function ruleText(line: string): string {
  return line.replace(/^- /, "").replaceAll("`", "").trim();
}

type FileResult = { text: string; count: GuideFileCount };

/** Rewrites one guide. `idFor` decides the id of a check line from its
 * finding set, so the short guide can reuse the detailed guide's ids. */
function rewrite(
  text: string,
  file: string,
  findingCount: number,
  idFor: (numbers: number[], line: string) => string,
): FileResult {
  let rules = 0;
  let withIds = 0;
  const lines = text.split("\n").map((raw) => {
    const { numbers, line } = takeBrackets(raw);
    if (!isCheckLine(raw)) return numbers.length > 0 ? line : raw;
    rules++;
    const valid = [
      ...new Set(numbers.filter((n) => n >= 1 && n <= findingCount)),
    ].sort((a, b) => a - b);
    if (valid.length === 0) return line;
    withIds++;
    return `${line} [${idFor(valid, line)}]`;
  });
  return { text: lines.join("\n"), count: { file, rules, withIds } };
}

/** Gives every check line with a usable bracket an `R` id, numbered in file
 * order. With a detailed guide, its lines are numbered first and a short-guide
 * line with the same finding set shares that id. A line with no usable bracket
 * keeps no id. Brackets on any other line are removed. */
export function assignGuideIds(
  guide: string,
  detailed: string | undefined,
  findingCount: number,
): {
  guide: string;
  detailed?: string;
  rules: GuideRule[];
  counts: GuideFileCount[];
} {
  const rules: GuideRule[] = [];
  const bySet = new Map<string, string>();
  const add = (file: string, numbers: number[], line: string): string => {
    const id = `R${rules.length + 1}`;
    rules.push({ id, file, text: ruleText(line), findings: numbers });
    return id;
  };
  if (detailed === undefined) {
    const single = rewrite(guide, GUIDE_FILE, findingCount, (numbers, line) =>
      add(GUIDE_FILE, numbers, line),
    );
    return { guide: single.text, rules, counts: [single.count] };
  }
  const full = rewrite(
    detailed,
    DETAILED_GUIDE_FILE,
    findingCount,
    (numbers, line) => {
      const id = add(DETAILED_GUIDE_FILE, numbers, line);
      if (!bySet.has(setKey(numbers))) bySet.set(setKey(numbers), id);
      return id;
    },
  );
  const short = rewrite(
    guide,
    GUIDE_FILE,
    findingCount,
    (numbers, line) =>
      bySet.get(setKey(numbers)) ?? add(GUIDE_FILE, numbers, line),
  );
  return {
    guide: short.text,
    detailed: full.text,
    rules,
    counts: [short.count, full.count],
  };
}

/** `[write] PR_REVIEW_GUIDE.md · 34 rules · 31 with sources`. */
export function guideWriteLine(count: GuideFileCount): string {
  return `${count.file} · ${count.rules} ${count.rules === 1 ? "rule" : "rules"} · ${count.withIds} with sources`;
}
