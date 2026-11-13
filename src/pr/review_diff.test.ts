import { test } from "node:test";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";
import type { DiffFile } from "./diff_plan.ts";
import { mapWithLimit, prepareReviewDiff } from "./review_diff.ts";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

function file(path: string, lines: number, width = 20): DiffFile {
  const body = Array.from(
    { length: lines },
    (_, i) => `+${String(i).padEnd(width - 1, "x")}`,
  );
  return {
    path,
    previousPath: null,
    status: "modified",
    additions: lines,
    deletions: 0,
    changes: lines,
    patch: `@@ -0,0 +1,${lines} @@\n${body.join("\n")}`,
  };
}

/** A summary provider that answers per path and records how many calls ran
 * at once. */
function summaries(
  answer: (path: string) => string | Error = () => "It adds rows.",
): AiProvider & { peak: number; calls: number } {
  let running = 0;
  const provider = {
    peak: 0,
    calls: 0,
    async complete(request: AiRequest): Promise<AiResponse> {
      provider.calls++;
      running++;
      provider.peak = Math.max(provider.peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      const path = /`([^`]+)`/.exec(request.prompt)?.[1] ?? "";
      const text = answer(path);
      if (text instanceof Error) throw text;
      return {
        text,
        tokensIn: 1,
        tokensOut: 1,
        cost: 0,
        model: "low",
        provider: "openrouter",
      };
    },
  };
  return provider;
}

function input(files: DiffFile[], provider: AiProvider, concurrency = 3) {
  return {
    files,
    tools: true,
    concurrency,
    readDiffMaxChars: 20_000,
    summaryProvider: () => provider,
    report: () => {},
  };
}

test("mapWithLimit keeps input order and never runs more than the limit", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapWithLimit([5, 1, 4, 2, 3], 2, async (value) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, value));
    running--;
    return value * 10;
  });
  same(out, [50, 10, 40, 20, 30], "order");
  same(peak, 2, "peak");
});

test("a diff that fits builds no provider and offers no read tool", async () => {
  let built = false;
  const prepared = await prepareReviewDiff({
    ...input([file("a.ts", 3)], summaries()),
    summaryProvider: () => {
      built = true;
      return summaries();
    },
  });
  same(built, false, "provider built");
  same(prepared.tools.length, 0, "tools");
  same(prepared.notShown, "", "not shown");
  same(prepared.warnings, [], "warnings");
  same(prepared.seenPaths, ["a.ts"], "seen");
  same(prepared.coverage.full, 1, "full");
});

test("summary calls respect the AI concurrency", async () => {
  const provider = summaries();
  const files = Array.from({ length: 6 }, (_, i) => file(`big${i}.ts`, 501));
  const prepared = await prepareReviewDiff(input(files, provider, 2));
  same(provider.calls, 6, "calls");
  same(provider.peak, 2, "peak in flight");
  same(prepared.coverage.summarized.length, 6, "summarized");
  if (!prepared.sections.includes("It adds rows.")) {
    throw new Error("the summary text is missing from the DIFF section");
  }
});

test("a failed summary turns its file partial and the review goes on", async () => {
  const provider = summaries((path) =>
    path === "b.ts" ? new Error("provider said no") : "It adds rows.",
  );
  const prepared = await prepareReviewDiff(
    input([file("a.ts", 501), file("b.ts", 700, 40)], provider),
  );
  same(prepared.coverage.summarized, ["a.ts"], "summarized");
  same(prepared.coverage.partial, ["b.ts"], "partial");
  same(
    prepared.warnings.map((warning) => warning.code),
    ["summary_failed"],
    "warnings",
  );
  if (!prepared.warnings[0]!.message.includes("b.ts")) {
    throw new Error(prepared.warnings[0]!.message);
  }
  if (!prepared.sections.includes("cut off here")) {
    throw new Error("the failed file should be shown as partial");
  }
  same(prepared.seenPaths.sort(), ["a.ts", "b.ts"], "both were seen");
});

test("a summary provider that cannot be built fails the summaries, not the review", async () => {
  const prepared = await prepareReviewDiff({
    ...input([file("a.ts", 501), file("b.ts", 3)], summaries()),
    summaryProvider: () => {
      throw new Error("No low model is configured.");
    },
  });
  same(prepared.coverage.partial, ["a.ts"], "partial");
  same(prepared.coverage.full, 1, "the other file is untouched");
  same(prepared.warnings[0]?.code, "summary_failed", "warning");
});

test("an empty summary counts as a failed one", async () => {
  const prepared = await prepareReviewDiff(
    input(
      [file("a.ts", 501)],
      summaries(() => "  "),
    ),
  );
  same(prepared.coverage.partial, ["a.ts"], "partial");
  same(prepared.warnings[0]?.code, "summary_failed", "warning");
});

test("summaries longer than planned are caught by the last pass", async () => {
  // Each summary is far over the 700 characters the plan counted, so the
  // real total does not fit and files are dropped from the end.
  const provider = summaries(() => "y".repeat(60_000));
  const files = Array.from({ length: 6 }, (_, i) => file(`big${i}.ts`, 501));
  const prepared = await prepareReviewDiff(input(files, provider));
  if (prepared.sections.length > 240_000) {
    throw new Error(`over budget: ${prepared.sections.length}`);
  }
  same(prepared.coverage.dropped, ["big3.ts", "big4.ts", "big5.ts"], "dropped");
  same(
    prepared.warnings.map((warning) => warning.code),
    ["diff_dropped"],
    "warnings",
  );
  if (!prepared.notShown.includes("- big5.ts")) {
    throw new Error(prepared.notShown);
  }
  if (prepared.seenPaths.includes("big5.ts")) {
    throw new Error("a dropped file is never seen");
  }
});

test("read-full-diff pages a partial file under the configured cap", async () => {
  const prepared = await prepareReviewDiff({
    ...input([file("big.ts", 400, 40), file("small.ts", 2)], summaries()),
    readDiffMaxChars: 500,
  });
  same(prepared.coverage.partial, ["big.ts"], "partial");
  const tool = prepared.tools.find((item) => item.name === "read-full-diff");
  if (!tool) throw new Error("read-full-diff is missing");
  const answer = String(await tool.run({ path: "big.ts", offset: 300 }));
  const body = answer.slice(0, answer.indexOf("\n[more:"));
  if (body.length > 500) throw new Error(`over the cap: ${body.length}`);
  if (!answer.includes("[more: call again with offset=")) {
    throw new Error(answer);
  }
  if (!body.startsWith("   300 +")) {
    throw new Error(`line numbers must be new-file numbers: ${body}`);
  }
  const full = String(await tool.run({ path: "small.ts" }));
  if (!full.includes("already shown")) throw new Error(full);
});

test("unchanged files count as full and stay in the seen set", async () => {
  const prepared = await prepareReviewDiff({
    ...input([file("a.ts", 3)], summaries()),
    unchangedPaths: ["old.ts"],
  });
  same(prepared.coverage.full, 2, "full");
  same(prepared.seenPaths.sort(), ["a.ts", "old.ts"], "seen");
});
