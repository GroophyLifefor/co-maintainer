const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const GUTTER = 6;

export type Anchor = { line: number; start_line?: number };

/** New file line ranges each hunk covers. A hunk with a zero count (a
 * deleted file) covers nothing on the RIGHT side. */
export function rightHunks(patch: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of patch.matchAll(new RegExp(HUNK.source, "gm"))) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

/** Where GitHub will accept a review comment for this span. The whole span
 * when one hunk holds it, otherwise one end of it, otherwise nowhere. */
export function anchorFor(
  patch: string,
  from: number,
  to: number,
): Anchor | undefined {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  // GitHub withholds the patch for very large files, so there is nothing to
  // check against. Keep the single line anchor reviews always used.
  if (patch === "") return { line: high };
  const hunks = rightHunks(patch);
  const inside = (a: number, b: number) =>
    hunks.some(([start, end]) => a >= start && b <= end);
  if (low < high && inside(low, high)) return { start_line: low, line: high };
  if (inside(high, high)) return { line: high };
  if (inside(low, low)) return { line: low };
  return undefined;
}

type PatchLine = { text: string; number?: number; inHunk: boolean };

function* walk(patch: string): Generator<PatchLine> {
  let next = 0;
  for (const text of patch.split("\n")) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      next = Number(hunk[1]);
      yield { text, inHunk: false };
    } else if (next === 0 || text === "") {
      yield { text, inHunk: false };
    } else if (text.startsWith("-") || text.startsWith("\\")) {
      yield { text, inHunk: true };
    } else {
      yield { text, number: next++, inHunk: true };
    }
  }
}

/** Prefixes each diff line with its line number in the new file, so the
 * reviewer copies Location numbers instead of counting from the @@ header.
 * Removed lines get no number because GitHub cannot anchor a RIGHT side
 * comment to them. */
export function numberPatch(patch: string): string {
  return [...walk(patch)].map(({ text, number, inHunk }) =>
    !inHunk ? text : `${
      number === undefined ? "".padStart(GUTTER) : String(number).padStart(GUTTER)
    } ${text}`
  ).join("\n");
}

/** The new file's text for every line the patch shows, without the diff
 * prefix. */
export function rightLines(patch: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const { text, number } of walk(patch)) {
    if (number !== undefined) lines.set(number, text.slice(1));
  }
  return lines;
}
