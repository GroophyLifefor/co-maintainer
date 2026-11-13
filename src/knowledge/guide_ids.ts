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

/** The source list the prompt asks for: one bracket of numbers at the very
 * end of the line, after a space. `items[3]` has no space before it, so it is
 * never taken. */
const SOURCE_BRACKET = /\s+\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]\s*$/;

/** A top-level `rule · why` bullet, the guide's unit of a check. The link to
 * the detailed file is not a check. */
function isCheckLine(line: string): boolean {
  return line.startsWith("- ") && line.includes(" · ") && !line.includes("](");
}

/** The finding numbers at the end of a check line and the line without them,
 * or `null` when the line does not end in a source list. A bracket inside
 * inline code is code, not a source list. Every other bracket on the line is
 * left exactly as the model wrote it. */
function takeSourceBracket(
  line: string,
): { numbers: number[]; line: string } | null {
  const match = SOURCE_BRACKET.exec(line);
  if (!match) return null;
  const before = line.slice(0, match.index);
  if ((before.split("`").length - 1) % 2 === 1) return null;
  return { numbers: match[1].split(",").map(Number), line: before };
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
    if (!isCheckLine(raw)) return raw;
    rules++;
    const taken = takeSourceBracket(raw);
    if (!taken) return raw;
    const valid = [
      ...new Set(taken.numbers.filter((n) => n >= 1 && n <= findingCount)),
    ].sort((a, b) => a - b);
    // A source list that names no real finding is dropped with no id.
    if (valid.length === 0) return taken.line;
    withIds++;
    return `${taken.line} [${idFor(valid, taken.line)}]`;
  });
  return { text: lines.join("\n"), count: { file, rules, withIds } };
}

/** Gives every check line that ends in a usable source list an `R` id,
 * numbered in file order. With a detailed guide, its lines are numbered first
 * and a short-guide line with the same finding set shares that id. A line with
 * no usable source list keeps no id. No other line is changed. */
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
