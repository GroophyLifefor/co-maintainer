/** The copied-passage check for private MCP results (issue 79).
 *
 * The prompt asks the model never to quote a private result. This is the
 * check in code: before a review is printed, posted or stored, any run of 8
 * or more consecutive words of its text that also appears in a private
 * result, ignoring case and punctuation, is replaced. It catches copied
 * passages. A single word, such as a customer's name, or a paraphrase passes
 * it. */
import type { CoverageWarning } from "./coverage.ts";
import { isMcpTool } from "../tools/mcp_tools.ts";

/** What the private results sentence says after it names the tools. */
const PRIVATE_RULE =
  "are private. Base a finding on them when they show the change is wrong, and say only that a private source of this repository requires it. Never quote, paraphrase or summarize their text in a finding.";

/** Said in the review prompt when the model is offered an MCP tool. */
export const MCP_PRIVATE_GUIDANCE = `Results from mcp- tools ${PRIVATE_RULE}`;

/** The private results sentence for the tools the model is offered, or
 * `undefined` when none is private. MCP tools are named by their prefix. A
 * remote client's declared tools are private too and are named one by one,
 * since a client picks their names. */
export function privateToolsGuidance(
  tools: { name: string; private?: boolean }[],
): string | undefined {
  const mcp = tools.some((tool) => isMcpTool(tool.name));
  const declared = tools
    .filter((tool) => tool.private && !isMcpTool(tool.name))
    .map((tool) => tool.name);
  if (!mcp && declared.length === 0) return undefined;
  if (declared.length === 0) return MCP_PRIVATE_GUIDANCE;
  const named = `the client ${declared.length === 1 ? "tool" : "tools"} ${declared.join(", ")}`;
  return `Results from ${mcp ? `mcp- tools and from ${named}` : named} ${PRIVATE_RULE}`;
}

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

/** Lines the check leaves alone: the rendered location, references and
 * suggestion lines, which hold paths and ids written by code. */
const STRUCTURE = /^(Location: |References: |Suggestion: )/;

/** A heading. Its text can come from the model, so it is checked on its own,
 * apart from the paragraph around it. */
const HEADING = /^#{1,6} /;

/** The line that anchors a suggestion block. */
const STRUCTURE_SUGGESTION = /^\s*Suggestion: /;

/** The review's Markdown with every copied passage replaced, and how many
 * were. A paragraph is checked as one piece, so a passage that wraps a line
 * is still found. A heading is checked as one piece of its own. A suggestion block is checked as one piece too, and one
 * that holds a copied passage is dropped with its Suggestion line, since a
 * patch with a passage cut out of it would no longer apply. Any other fenced
 * block is checked as one piece as well, so a passage split over its lines is
 * found, and a block that holds one is replaced whole. */
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
  let block: string[] = [];
  const endBlock = (closing: string | undefined) => {
    const result = scrub(block.slice(1).join("\n"), runs);
    if (result.removed === 0) {
      out.push(...block);
      if (closing !== undefined) out.push(closing);
    } else {
      removed += result.removed;
      if (
        fence === "suggestion" &&
        STRUCTURE_SUGGESTION.test(out.at(-1) ?? "")
      ) {
        out.pop();
      }
      out.push(PRIVATE_TEXT_REMOVED);
    }
    block = [];
  };
  for (const line of lines) {
    const fenceLine = /^\s*```/.test(line);
    if (fence) {
      if (fenceLine) {
        endBlock(line);
        fence = undefined;
      } else {
        block.push(line);
      }
      continue;
    }
    if (fenceLine) {
      flush();
      fence = /^\s*```suggestion\b/.test(line) ? "suggestion" : "other";
      block = [line];
      continue;
    }
    if (HEADING.test(line)) {
      flush();
      const result = scrub(line, runs);
      removed += result.removed;
      out.push(result.text);
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
  if (fence) endBlock(undefined);
  return { text: out.join("\n"), removed };
}

/** `private_text_removed`, or nothing when no passage was removed. `from`
 * names where the passages came from. */
export function privateTextWarning(
  removed: number,
  from = "a private MCP result",
): CoverageWarning[] {
  if (removed === 0) return [];
  return [
    {
      code: "private_text_removed",
      message: `${removed} ${
        removed === 1 ? "passage" : "passages"
      } copied from ${from} ${removed === 1 ? "was" : "were"} removed from this review.`,
    },
  ];
}
