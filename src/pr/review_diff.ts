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
  notShownBlock,
  planDiff,
  renderSection,
  seenPaths,
  type DiffFile,
  type PlannedFile,
} from "./diff_plan.ts";

export type PreparedDiff = {
  /** The joined file sections, in the order the files came in. */
  sections: string;
  /** The NOT SHOWN list, or `""` when nothing was dropped. */
  notShown: string;
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
    const provider = input.summaryProvider();
    await mapWithLimit(summarize, input.concurrency, async (file) => {
      try {
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
  // that fell back to partial, may not fit, so check once more.
  const rendered = new Map<PlannedFile, string>();
  const sizeOf = (file: PlannedFile) => {
    let text = rendered.get(file);
    if (text === undefined) {
      text = render(file);
      rendered.set(file, text);
    }
    return text.length;
  };
  dropUntilFits(planned, sizeOf);
  const sections = planned
    .filter((file) => file.state !== "dropped")
    .map((file) => rendered.get(file) ?? render(file))
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
    notShown: notShownBlock(planned, { tools: input.tools }),
    tools,
    coverage,
    warnings: coverageWarnings(coverage, stillPartial),
    seenPaths: seenPaths(planned, unchanged),
    planned,
  };
}
