/** Turns a review's changed files into the DIFF section the model reads, the
 * `read-full-diff` tool, and the coverage the result reports. Pull request,
 * local, remote and push review all call this one function, so the states a
 * file can reach and the warnings they leave are the same everywhere. */
import type { ToolHandler } from "../ai/mermaid_loop.ts";
import {
  coverageWarnings,
  type Coverage,
  type CoverageWarning,
} from "../review/coverage.ts";
import type { AiProvider, AiResponse } from "../types.ts";
import {
  READ_FULL_DIFF_TOOL,
  readFullDiff,
  summarizeDiff,
  type ReadableDiff,
} from "./diff_summary.ts";
import {
  coverageFromPlan,
  dropUntilFits,
  noDiffBlock,
  notShownBlock,
  planDiff,
  renderSection,
  restoreIntoRoom,
  seenPaths,
  type DiffFile,
  type PlannedFile,
} from "./diff_plan.ts";

export type PreparedDiff = {
  /** The joined file sections, in the order the files came in. */
  sections: string;
  /** The NO DIFF TEXT and NOT SHOWN lists, or `""` when no file is listed. */
  notShown: string;
  /** The whole DIFF section: the sections, then the lists. */
  diff: string;
  /** `read-full-diff`, present when any file can be read with it. */
  tools: ToolHandler[];
  coverage: Coverage;
  warnings: CoverageWarning[];
  /** What counts as reviewed for the next round, see `seenPaths`. */
  seenPaths: string[];
  planned: PlannedFile[];
};

export type PrepareDiffInput = {
  files: DiffFile[];
  /** Files left out because an earlier round saw the same patch. */
  unchangedPaths?: string[];
  /** Whether the next run of this mode sends the files this run dropped,
   * see `coverageWarnings`. */
  catchesUp: boolean;
  /** Whether the review model can call tools. */
  tools: boolean;
  /** The most summary calls in flight at once, `--ai-concurrent`. */
  concurrency: number;
  /** The cap on one `read-full-diff` answer, `null` for none. */
  readDiffMaxChars: number | null;
  /** The low-model provider. Called only when a file is summarized, because
   * building a real provider needs a key a fake-AI run never has. */
  summaryProvider: () => AiProvider;
  usage?: (response: AiResponse) => Promise<void>;
  report: (message: string) => void;
};

/** `fn` over `items` with at most `limit` calls running at once, results in
 * input order. */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

export async function prepareReviewDiff(
  input: PrepareDiffInput,
): Promise<PreparedDiff> {
  const planned = planDiff(input.files);
  const summarize = planned.filter((file) => file.state === "summarized");
  const summaries = new Map<string, string>();
  const failed: string[] = [];
  if (summarize.length > 0) {
    // Built inside the try, so a provider that cannot be built fails each
    // summary the same way a failed call does, and the review goes on.
    let provider: AiProvider | undefined;
    await mapWithLimit(summarize, input.concurrency, async (file) => {
      try {
        provider ??= input.summaryProvider();
        const text = await summarizeDiff(
          file.path,
          file.patch,
          provider,
          input.usage,
        );
        if (!text) throw new Error("the summary came back empty");
        summaries.set(file.path, text);
        input.report(
          `summarized large diff · ${file.path} · ${file.changes} changed lines`,
        );
      } catch (error) {
        // One failed summary must not fail the review. The model gets the
        // start of the patch instead, the same as any other long file.
        file.state = "partial";
        failed.push(file.path);
        input.report(
          `summary failed · ${file.path} · ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
  const render = (file: PlannedFile) =>
    renderSection(file, {
      tools: input.tools,
      summary: summaries.get(file.path),
    });
  // The plan counted a fixed size per summary. The real ones, and any file
  // that fell back to partial, may not fit, so check once more. Real
  // summaries can also be shorter, which leaves room for a dropped file.
  // Keyed by state too: a file restored from dropped renders differently
  // from the summary it was measured as.
  const rendered = new Map<string, string>();
  const textOf = (file: PlannedFile) => {
    const key = `${file.state}\0${file.path}`;
    let text = rendered.get(key);
    if (text === undefined) {
      text = render(file);
      rendered.set(key, text);
    }
    return text;
  };
  const sizeOf = (file: PlannedFile) => textOf(file).length;
  dropUntilFits(planned, sizeOf);
  restoreIntoRoom(planned, sizeOf);
  const sections = planned
    .filter((file) => file.state !== "dropped" && !file.listed)
    .map(textOf)
    .join("\n\n");
  const lists = [
    noDiffBlock(planned),
    notShownBlock(planned, { tools: input.tools }),
  ]
    .filter(Boolean)
    .join("\n\n");

  const readable = new Map<string, ReadableDiff>(
    planned.map((file) => [
      file.path,
      { state: file.state, patch: file.patch },
    ]),
  );
  const anyReadable = planned.some(
    (file) =>
      file.state === "partial" ||
      file.state === "summarized" ||
      file.state === "dropped",
  );
  const tools: ToolHandler[] = anyReadable
    ? [
        {
          name: "read-full-diff",
          tool: READ_FULL_DIFF_TOOL,
          run: (args: unknown) =>
            readFullDiff(readable, args, input.readDiffMaxChars),
        },
      ]
    : [];
  const unchanged = input.unchangedPaths ?? [];
  const coverage = coverageFromPlan(planned, unchanged);
  // A file that fell back to partial and was then dropped is reported as
  // dropped only.
  const stillPartial = failed
    .filter((path) => coverage.partial.includes(path))
    .sort();
  return {
    sections,
    notShown: lists,
    diff: [sections, lists].filter(Boolean).join("\n\n"),
    tools,
    coverage,
    warnings: coverageWarnings(coverage, input.catchesUp, stillPartial),
    seenPaths: seenPaths(planned, unchanged),
    planned,
  };
}
