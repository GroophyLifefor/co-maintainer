/** The extensions in Markdown: the `#### Extensions` section of a GitHub review
 * and of a job summary, and the length limits both live under.
 *
 * Only an extension's `markdown` can be dropped for length. The AI review, the
 * verdict, the inline comments and the stored result always stay. The longest
 * `markdown` goes first, then the next longest, until the text fits. */
import { stripControlChars } from "../util/sanitize.ts";
import type { ExtensionReport } from "./report.ts";

/** GitHub accepted a 250,000 character review body. */
export const REVIEW_BODY_MAX_CHARS = 250_000;

/** The job summary limit reported for one step. Measured in bytes. */
export const JOB_SUMMARY_MAX_BYTES = 1024 * 1024;

export const REVIEW_LIMIT_NOTE =
  "Not added to this comment because of the length limit, see the dashboard.";
export const JOB_SUMMARY_LIMIT_NOTE =
  "Not added to the job summary because of the length limit.";

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Closes a fence left open, so it cannot swallow what follows it. */
export function closeFences(text: string): string {
  const fences = text
    .split("\n")
    .filter((line) => /^\s*(?:```|~~~)/.test(line));
  return fences.length % 2 === 1 ? `${text.trimEnd()}\n\`\`\`` : text;
}

/** A name inside `<summary>`: no tag can open or close there. */
function summaryName(name: string): string {
  return stripControlChars(name).replace(/[<>&]/g, "");
}

/** The `#### Extensions` section from each extension's `markdown`, or "" when
 * no extension sent any. `markdowns` holds what is shown, which the length
 * limit may have replaced. */
export function extensionsSection(
  report: ExtensionReport,
  markdowns: Map<string, string>,
): string {
  const blocks = report.results
    .filter((result) => markdowns.has(result.name))
    .map(
      (result) =>
        `<details><summary>${summaryName(result.name)}</summary>\n\n${closeFences(markdowns.get(result.name)!.trim())}\n\n</details>`,
    );
  if (blocks.length === 0) return "";
  return `#### Extensions\n\n${blocks.join("\n\n")}`;
}

/** Renders with every extension's `markdown`, then replaces the longest one
 * with `note` until `measure` fits `limit`. */
export function fitMarkdowns(
  report: ExtensionReport,
  render: (markdowns: Map<string, string>) => string,
  limit: number,
  measure: (text: string) => number,
  note: string,
): string {
  const markdowns = new Map(
    report.results
      .filter((result) => result.markdown.trim() !== "")
      .map((result) => [result.name, result.markdown]),
  );
  let text = render(markdowns);
  while (measure(text) > limit) {
    let longest: string | undefined;
    for (const [name, markdown] of markdowns) {
      if (markdown === note) continue;
      if (
        longest === undefined ||
        measure(markdown) > measure(markdowns.get(longest)!)
      ) {
        longest = name;
      }
    }
    if (longest === undefined) break;
    markdowns.set(longest, note);
    text = render(markdowns);
  }
  return text;
}
