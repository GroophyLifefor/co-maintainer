import type { ParsedFinding, Span } from "./findings.ts";
import { type Anchor, anchorFor, rightLines } from "./hunks.ts";

const LINE =
  /^[ \t]*Suggestion:[ \t]*`?(?<path>[^`\s]+?):(?<from>\d+)(?:-(?<to>\d+))?`?[ \t]*\r?$/gm;
const BLOCK =
  /^(?<fence>`{3,})suggestion[ \t]*\r?\n(?<code>[\s\S]*?)^\k<fence>[ \t]*\r?$/gm;
const OPENING_FENCE = /^(`{3,})suggestion\b/gm;

export type Suggestion = Span & { code: string };

/** The one suggestion a finding carries, or undefined when there is none or
 * the model wrote more than one. */
export function readSuggestion(body: string): Suggestion | undefined {
  const lines = [...body.matchAll(LINE)];
  const blocks = [...body.matchAll(BLOCK)];
  if (lines.length !== 1 || blocks.length !== 1) return undefined;
  const { path, from, to } = lines[0].groups!;
  return {
    path,
    from: Number(from),
    to: Number(to ?? from),
    code: blocks[0].groups!.code.replace(/\r?\n$/, ""),
  };
}

export function withoutSuggestionLine(body: string): string {
  return body.replace(LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripSuggestion(body: string): string {
  return withoutSuggestionLine(body.replace(BLOCK, ""));
}

/** Replies explain a fix in a normal code block. A suggestion there would
 * anchor to whatever lines the thread sits on, which may have moved. */
export function plainSuggestionFences(text: string): string {
  return text.replace(OPENING_FENCE, "$1");
}

function sameCode(a: string, b: string): boolean {
  const clean = (value: string) =>
    value.split("\n").map((line) => line.trimEnd()).join("\n");
  return clean(a) === clean(b);
}

/** The anchor for a suggestion GitHub can apply as written: same file,
 * inside the finding's span, one hunk holding the whole range, and an actual
 * change to those lines. */
export function suggestionAnchor(
  finding: ParsedFinding,
  patch: string | undefined,
): Anchor | undefined {
  const suggestion = readSuggestion(finding.excerpt);
  if (!suggestion || !patch || suggestion.path !== finding.path) {
    return undefined;
  }
  const { from, to } = suggestion;
  const low = Math.min(finding.from, finding.to);
  const high = Math.max(finding.from, finding.to);
  if (from > to || from < low || to > high) return undefined;
  const anchor = anchorFor(patch, from, to);
  const whole = anchor?.line === to &&
    anchor.start_line === (from === to ? undefined : from);
  if (!whole) return undefined;
  const lines = rightLines(patch);
  const original: string[] = [];
  for (let line = from; line <= to; line++) {
    const text = lines.get(line);
    if (text === undefined) return undefined;
    original.push(text);
  }
  if (sameCode(original.join("\n"), suggestion.code)) return undefined;
  return anchor;
}
