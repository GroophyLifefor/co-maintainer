/** Editing the review guide instead of rewriting it (#113).
 *
 * A full rewrite sends every finding to the high model and gets a whole new
 * guide back, so every `sync` pays for both guide calls and the text churns.
 * An edit sends the current guide with its rule ids, the findings that are new
 * since the last guide and the ones that are gone, and gets back only what to
 * add, change and remove. Every other line stays byte for byte.
 *
 * The ids come out of the same pipeline as a full rewrite. A kept line's
 * `[R12]` becomes a pseudo finding number past the real findings, and that
 * number carries the rule's old pull requests and links. A changed line keeps
 * the pseudo number next to its new findings. `assignGuideIds` then numbers
 * every line, and the stable id mapping gives each kept rule its old id back
 * by its sources. */
import type { RuleEntry } from "./rules.ts";

export type GuideEdits = {
  add: { pass: string; rule: string; example?: string }[];
  change: { id: string; rule: string }[];
  remove: string[];
};

/** The answer of an edit call, or `null` when it is not usable. An unusable
 * answer falls back to a full rewrite, never to a half-applied edit. */
export function parseGuideEdits(text: string): GuideEdits | null {
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const list = (key: string) =>
    record[key] === undefined ? [] : (record[key] as unknown);
  const add = list("add");
  const change = list("change");
  const remove = list("remove");
  if (!Array.isArray(add) || !Array.isArray(change) || !Array.isArray(remove)) {
    return null;
  }
  const edits: GuideEdits = { add: [], change: [], remove: [] };
  for (const item of add) {
    const entry = item as Record<string, unknown>;
    if (typeof entry?.pass !== "string" || typeof entry.rule !== "string") {
      return null;
    }
    edits.add.push({
      pass: entry.pass.trim(),
      rule: entry.rule.trim(),
      ...(typeof entry.example === "string" && entry.example.trim()
        ? { example: entry.example.trim() }
        : {}),
    });
  }
  for (const item of change) {
    const entry = item as Record<string, unknown>;
    if (typeof entry?.id !== "string" || typeof entry.rule !== "string") {
      return null;
    }
    edits.change.push({ id: entry.id.trim(), rule: entry.rule.trim() });
  }
  for (const item of remove) {
    if (typeof item !== "string") return null;
    edits.remove.push(item.trim());
  }
  return edits;
}

const ID_AT_END = /\s+\[(R[1-9]\d*)\]\s*$/;
const NUMBERS_AT_END = /\s+\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]\s*$/;

function isCheckLine(line: string): boolean {
  return line.startsWith("- ") && line.includes(" · ");
}

/** The rule ids of a guide's check lines, in file order. */
export function guideRuleIds(text: string): string[] {
  return text
    .split("\n")
    .filter(isCheckLine)
    .flatMap((line) => {
      const match = ID_AT_END.exec(line);
      return match ? [match[1]!] : [];
    });
}

/** `- rule · why [3, 17]` as the model wrote it, made a check line: a bullet,
 * and the finding numbers that exist. `null` when the rule has no usable
 * source list. */
function newLine(rule: string, findingCount: number): string | null {
  const text = rule.replace(/^-\s*/, "").trim();
  const match = NUMBERS_AT_END.exec(text);
  if (!match || !text.includes(" · ")) return null;
  const numbers = [
    ...new Set(
      match[1]!
        .split(",")
        .map(Number)
        .filter((n) => n >= 1 && n <= findingCount),
    ),
  ];
  if (numbers.length === 0) return null;
  return `- ${text.slice(0, match.index)} [${numbers.sort((a, b) => a - b).join(", ")}]`;
}

/** Adds a pseudo number to a line that already ends in finding numbers. */
function withPseudo(line: string, pseudo: number): string {
  const match = NUMBERS_AT_END.exec(line)!;
  const numbers = [...match[1]!.split(",").map(Number), pseudo];
  return `${line.slice(0, match.index)} [${[...new Set(numbers)].sort((a, b) => a - b).join(", ")}]`;
}

/** The section of `## title`, matched without case or extra spaces. */
function sectionOf(
  lines: string[],
  title: string,
): { start: number; end: number } | null {
  const want = title
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
  const start = lines.findIndex(
    (line) =>
      /^##\s+/.test(line) &&
      line
        .replace(/^##\s+/, "")
        .trim()
        .toLowerCase() === want,
  );
  if (start === -1) return null;
  let end = lines.findIndex(
    (line, index) => index > start && /^##\s/.test(line),
  );
  if (end === -1) end = lines.length;
  return { start, end };
}

/** Where a new rule goes in a section: after its last rule and that rule's
 * indented lines, so before the exit check. */
function insertAt(
  lines: string[],
  section: { start: number; end: number },
): number {
  let at = section.start + 1;
  for (let index = section.start + 1; index < section.end; index++) {
    if (isCheckLine(lines[index]!)) {
      at = index + 1;
      while (at < section.end && /^\s+\S/.test(lines[at]!)) at++;
    }
  }
  return at;
}

export class GuideEditError extends Error {}

/** Applies `edits` to one guide file. `pseudo` maps each kept id to its
 * pseudo finding number. Every kept line's `[R12]` becomes `[pseudo]`. Throws
 * `GuideEditError` on an edit that does not fit the file, so the caller can
 * rewrite in full instead. `strict` is for the detailed guide: there, every
 * id and pass the edits name must exist. The short guide takes what fits. */
export function applyGuideEdits(
  text: string,
  edits: GuideEdits,
  pseudo: Map<string, number>,
  findingCount: number,
  strict: boolean,
): string {
  let lines = text.split("\n");
  const ids = new Set(guideRuleIds(text));
  if (strict) {
    for (const id of [...edits.remove, ...edits.change.map((c) => c.id)]) {
      if (!ids.has(id)) throw new GuideEditError(`no rule ${id} in the guide`);
    }
  }
  const removed = new Set(edits.remove);
  const changed = new Map(edits.change.map((item) => [item.id, item.rule]));
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const id = isCheckLine(line) ? ID_AT_END.exec(line)?.[1] : undefined;
    if (id && removed.has(id)) {
      // The rule's own indented lines go with it.
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) {
        index++;
      }
      continue;
    }
    if (id && changed.has(id)) {
      const next = newLine(changed.get(id)!, findingCount);
      if (!next) {
        if (strict)
          throw new GuideEditError(`the change to ${id} has no sources`);
        out.push(line.replace(ID_AT_END, ` [${pseudo.get(id)}]`));
        continue;
      }
      out.push(withPseudo(next, pseudo.get(id)!));
      continue;
    }
    if (id && pseudo.has(id)) {
      out.push(line.replace(ID_AT_END, ` [${pseudo.get(id)}]`));
      continue;
    }
    out.push(line);
  }
  lines = out;
  for (const item of edits.add) {
    const line = newLine(item.rule, findingCount);
    if (!line) {
      if (strict) throw new GuideEditError("an added rule has no sources");
      continue;
    }
    let section = sectionOf(lines, item.pass);
    if (!section) {
      if (strict)
        throw new GuideEditError(`no pass "${item.pass}" in the guide`);
      // The short guide may group passes differently: the rule joins its
      // last pass, so the two guides still name the same rules.
      const last = lines.findLastIndex((entry) => /^##\s/.test(entry));
      if (last === -1) continue;
      section = sectionOf(lines, lines[last]!);
      if (!section) continue;
    }
    const at = insertAt(lines, section);
    const added =
      item.example && strict ? [line, `  - ${item.example}`] : [line];
    lines.splice(at, 0, ...added);
  }
  return lines.join("\n");
}

/** The pseudo numbers of the kept rules, past the real findings, and the pull
 * requests and links each one carries. */
export function keptSources(
  ids: string[],
  rules: Record<string, RuleEntry>,
  findingCount: number,
): {
  pseudo: Map<string, number>;
  pullRequests: number[][];
  links: { pr: number; url: string }[][];
} {
  const pseudo = new Map<string, number>();
  const pullRequests: number[][] = [];
  const links: { pr: number; url: string }[][] = [];
  for (const id of ids) {
    if (pseudo.has(id)) continue;
    pseudo.set(id, findingCount + pullRequests.length + 1);
    const sources = rules[id]?.sources ?? [];
    pullRequests.push(
      sources.flatMap((source) => ("pr" in source ? [source.pr] : [])),
    );
    links.push(
      sources.flatMap((source) =>
        "pr" in source && "url" in source && typeof source.url === "string"
          ? [{ pr: source.pr, url: source.url }]
          : [],
      ),
    );
  }
  return { pseudo, pullRequests, links };
}
