/** The copied-passage check for private MCP results (issue 79).
 *
 * The prompt asks the model never to quote a private result. This is the
 * check in code: before a review is printed, posted or stored, any run of 8
 * or more consecutive words of its text that also appears in a private
 * result, ignoring case and punctuation, is replaced. It catches copied
 * passages. A single word, such as a customer's name, or a paraphrase passes
 * it. */
import type { CoverageWarning } from "./coverage.ts";

/** Said in the review prompt when the model is offered an MCP tool. */
export const MCP_PRIVATE_GUIDANCE =
  "Results from mcp- tools are private. You may base a finding on them, but never quote, paraphrase or summarize them in a finding.";

/** What a removed passage becomes. */
export const PRIVATE_TEXT_REMOVED = "[private context removed]";

/** The shortest run of words that counts as a copied passage. */
export const PRIVATE_RUN_WORDS = 8;

type Word = { word: string; start: number; end: number };

/** Words are runs of letters and digits, so punctuation and case never
 * decide a match. */
function words(text: string): Word[] {
  const out: Word[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    out.push({
      word: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

function runsOf(text: string): Set<string> {
  const list = words(text).map((item) => item.word);
  const runs = new Set<string>();
  for (let i = 0; i + PRIVATE_RUN_WORDS <= list.length; i++) {
    runs.add(list.slice(i, i + PRIVATE_RUN_WORDS).join(" "));
  }
  return runs;
}

/** One piece of text with every copied run replaced. Overlapping and
 * touching runs make one removal. */
function scrub(
  text: string,
  runs: Set<string>,
): { text: string; removed: number } {
  const list = words(text);
  const covered: boolean[] = Array.from({ length: list.length }, () => false);
  for (let i = 0; i + PRIVATE_RUN_WORDS <= list.length; i++) {
    const key = list
      .slice(i, i + PRIVATE_RUN_WORDS)
      .map((item) => item.word)
      .join(" ");
    if (!runs.has(key)) continue;
    for (let j = i; j < i + PRIVATE_RUN_WORDS; j++) covered[j] = true;
  }
  let out = "";
  let at = 0;
  let removed = 0;
  for (let i = 0; i < list.length; i++) {
    if (!covered[i]) continue;
    let last = i;
    while (last + 1 < list.length && covered[last + 1]) last++;
    out += text.slice(at, list[i]!.start) + PRIVATE_TEXT_REMOVED;
    at = list[last]!.end;
    removed++;
    i = last;
  }
  return { text: out + text.slice(at), removed };
}

/** Lines the check leaves alone: the rendered heading, location, references
 * and suggestion lines, which hold paths and ids written by code. */
const STRUCTURE = /^(#{1,6} |Location: |References: |Suggestion: )/;

/** The review's Markdown with every copied passage replaced, and how many
 * were. A paragraph is checked as one piece, so a passage that wraps a line
 * is still found. A suggestion block is the author's code with a fix and is
 * left as it is. Inside any other fenced block each line is checked on its
 * own, so the block keeps its lines. */
export function removePrivateText(
  markdown: string,
  privateResults: string[],
): { text: string; removed: number } {
  const runs = new Set<string>();
  for (const result of privateResults) {
    for (const run of runsOf(result)) runs.add(run);
  }
  if (runs.size === 0) return { text: markdown, removed: 0 };
  const lines = markdown.split("\n");
  const out: string[] = [];
  let removed = 0;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    const result = scrub(paragraph.join("\n"), runs);
    removed += result.removed;
    out.push(result.text);
    paragraph = [];
  };
  let fence: "suggestion" | "other" | undefined;
  for (const line of lines) {
    const fenceLine = /^\s*```/.test(line);
    if (fence) {
      if (fenceLine) {
        fence = undefined;
        out.push(line);
      } else if (fence === "suggestion") {
        out.push(line);
      } else {
        const result = scrub(line, runs);
        removed += result.removed;
        out.push(result.text);
      }
      continue;
    }
    if (fenceLine) {
      flush();
      fence = /^\s*```suggestion\b/.test(line) ? "suggestion" : "other";
      out.push(line);
      continue;
    }
    if (line.trim() === "" || STRUCTURE.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return { text: out.join("\n"), removed };
}

/** `private_text_removed`, or nothing when no passage was removed. */
export function privateTextWarning(removed: number): CoverageWarning[] {
  if (removed === 0) return [];
  return [
    {
      code: "private_text_removed",
      message: `${removed} ${
        removed === 1 ? "passage" : "passages"
      } copied from a private MCP result ${removed === 1 ? "was" : "were"} removed from this review.`,
    },
  ];
}
