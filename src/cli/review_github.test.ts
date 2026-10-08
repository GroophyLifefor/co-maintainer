import { test } from "node:test";
import { readFileSync } from "node:fs";
import { tempDirSync } from "../testing/runtime.ts";
import {
  MAX_ANNOTATIONS_PER_LEVEL,
  appendStepSummary,
  escapeData,
  escapeProperty,
  githubAnnotations,
  githubSummary,
  neutralizeCommands,
} from "./review_github.ts";
import type { HumanFinding } from "./review_result.ts";

function finding(overrides: Partial<HumanFinding> = {}): HumanFinding {
  return {
    state: "new",
    severity: "P2",
    blocking: false,
    path: "src/a.ts",
    lineFrom: 3,
    lineTo: 3,
    title: "[P2 · non-blocking] `src/a.ts`: `run`",
    body: "Use the argument.",
    suggestion: null,
    ...overrides,
  };
}

test("escapeData escapes exactly the percent sign and the line breaks", () => {
  const got = escapeData("50% done\r\nnext: a, b");
  if (got !== "50%25 done%0D%0Anext: a, b") throw new Error(got);
});

test("escapeProperty also escapes the colon and the comma that end a property", () => {
  const got = escapeProperty("a:b,c%\n");
  if (got !== "a%3Ab%2Cc%25%0A") throw new Error(got);
});

test("a blocking finding becomes an error with its file, lines and title", () => {
  const [line] = githubAnnotations([
    finding({
      blocking: true,
      severity: "P1",
      lineFrom: 3,
      lineTo: 5,
      body: "Handle the null case.",
    }),
  ]);
  const want =
    "::error file=src/a.ts,line=3,endLine=5,title=P1%3A run::Handle the null case.";
  if (line !== want) throw new Error(`${line}\nwanted ${want}`);
});

test("a non-blocking finding is a warning, and a single line has no endLine", () => {
  const [line] = githubAnnotations([finding()]);
  if (!line?.startsWith("::warning file=src/a.ts,line=3,title=P2%3A run::")) {
    throw new Error(String(line));
  }
  if (line.includes("endLine")) throw new Error("one line needs no endLine");
});

test("a finding with no file or no line leaves those properties out", () => {
  const [noFile] = githubAnnotations([
    finding({ path: null, lineFrom: null, lineTo: null, title: "General" }),
  ]);
  if (noFile?.includes("file=") || noFile?.includes("line=")) {
    throw new Error(String(noFile));
  }
  const [noLine] = githubAnnotations([finding({ lineFrom: 0, lineTo: 0 })]);
  if (!noLine?.includes("file=src/a.ts") || noLine.includes("line=")) {
    throw new Error(String(noLine));
  }
});

test("a title with no symbol falls back to the severity, and an empty body to the title", () => {
  const [line] = githubAnnotations([
    finding({
      title: "[P3 · non-blocking] `src/a.ts`",
      severity: "P3",
      body: "",
    }),
  ]);
  if (!line?.includes("title=P3 finding::")) throw new Error(String(line));
  if (line.endsWith("::")) throw new Error("the message must not be empty");
});

test("a finding closed since the last review gets no annotation, errors come first", () => {
  const lines = githubAnnotations([
    finding({ state: "closed", blocking: true, path: "src/closed.ts" }),
    finding({ path: "src/warn.ts" }),
    finding({ blocking: true, severity: "P1", path: "src/err.ts" }),
  ]);
  if (lines.length !== 2) throw new Error(JSON.stringify(lines));
  if (!lines[0]!.startsWith("::error") || !lines[1]!.startsWith("::warning")) {
    throw new Error(JSON.stringify(lines));
  }
  if (lines.join("").includes("closed.ts")) throw new Error("closed annotated");
});

test("text a model wrote can never start a second workflow command", () => {
  const evil = finding({
    blocking: true,
    severity: "P1",
    path: "src/x,y:z.ts",
    title: "[P1 · blocking] `src/x.ts`: `a::b,c`",
    body: "first\n::add-mask::hunter2\r\n  ::set-env name=A::B\n100%",
  });
  const lines = githubAnnotations([evil]);
  if (lines.length !== 1) throw new Error(`${lines.length} lines`);
  const [line] = lines;
  if (/[\r\n]/.test(line!)) throw new Error("a raw line break got through");
  if (!line!.startsWith("::error file=src/x%2Cy%3Az.ts,")) {
    throw new Error(String(line));
  }
  if (!line!.includes("title=P1%3A a%3A%3Ab%2Cc::")) {
    throw new Error(`title: ${line}`);
  }
  if (!line!.includes("first%0A::add-mask::hunter2%0D%0A")) {
    throw new Error(`the injected line must stay inside the message: ${line}`);
  }
  if (!line!.endsWith("100%25")) throw new Error(String(line));
});

test("only ten errors and ten warnings are annotated, and a notice says how many were left", () => {
  const many = [
    ...Array.from({ length: 12 }, (_, i) =>
      finding({ blocking: true, severity: "P1", path: `src/e${i}.ts` }),
    ),
    ...Array.from({ length: 11 }, (_, i) => finding({ path: `src/w${i}.ts` })),
  ];
  const lines = githubAnnotations(many);
  const errors = lines.filter((l) => l.startsWith("::error")).length;
  const warnings = lines.filter((l) => l.startsWith("::warning")).length;
  if (
    errors !== MAX_ANNOTATIONS_PER_LEVEL ||
    warnings !== MAX_ANNOTATIONS_PER_LEVEL
  ) {
    throw new Error(`${errors} errors, ${warnings} warnings`);
  }
  const notice = lines.at(-1)!;
  if (
    !notice.startsWith(
      "::notice title=co-maintainer::3 more findings are not annotated",
    )
  ) {
    throw new Error(notice);
  }
  if (githubAnnotations([finding()]).some((l) => l.startsWith("::notice"))) {
    throw new Error("no notice when nothing was left out");
  }
});

test("the summary is a table with counts, and says no findings when there are none", () => {
  const md = githubSummary({
    title: "owner/repo · feature (remote)",
    findings: [
      finding({ blocking: true, severity: "P1", lineFrom: 3, lineTo: 5 }),
      finding({ state: "open", severity: "P3", path: "src/b.ts" }),
      finding({ state: "closed", path: "src/old.ts" }),
    ],
    run: {
      durationMs: 21000,
      tokensIn: 3125,
      tokensOut: 1308,
      costUsd: 0.0016,
    },
  });
  for (const part of [
    "## co-maintainer review",
    "| Severity | State | Where | Finding |",
    "| P1 (blocking) | new | src/a.ts:3-5 |",
    "| P3 | open | src/b.ts:3 |",
    "**Summary:** 1 new · 1 open · 1 closed · 1 blocking",
    "Done in 21.0s · 3,125 in, 1,308 out tokens · $0.0016",
  ]) {
    if (!md.includes(part)) throw new Error(`missing "${part}" in\n${md}`);
  }
  if (md.includes("old.ts"))
    throw new Error("a closed finding is only counted");
  const clean = githubSummary({ title: "t", findings: [] });
  if (!clean.includes("No actionable findings.")) throw new Error(clean);
  if (clean.includes("| Severity"))
    throw new Error("no table without findings");
});

test("an unknown cost reads unknown with its reason, never zero", () => {
  const md = githubSummary({
    title: "t",
    findings: [],
    run: {
      durationMs: 1000,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: null,
      costNote: "The provider did not report the cost for this review.",
    },
  });
  if (
    !md.includes(
      "cost unknown (The provider did not report the cost for this review.)",
    )
  ) {
    throw new Error(md);
  }
  if (md.includes("$0"))
    throw new Error("an unknown cost must not read as zero");
});

test("model text cannot become markdown structure in the summary", () => {
  const md = githubSummary({
    title: "t",
    findings: [
      finding({
        title: "[P2 · non-blocking] `src/a.ts`: `x`",
        body: "a | b\n| c |\n[click](https://evil.example) <img src=x onerror=1> `code` *bold*",
      }),
    ],
  });
  const row = md.split("\n").find((l) => l.startsWith("| P2"))!;
  if (row.split("\n").length !== 1) throw new Error("a row must stay one line");
  // Four unescaped pipes: the row's own separators, none from the model text.
  if ((row.match(/(?<!\\)\|/g) ?? []).length !== 5) throw new Error(row);
  for (const raw of ["[click](", "<img", "`code`", "*bold*"]) {
    if (row.includes(raw)) throw new Error(`unescaped ${raw} in ${row}`);
  }
});

test("appendStepSummary appends to the file, and a bad path is reported, not thrown", () => {
  const file = `${tempDirSync()}/summary.md`;
  appendStepSummary("first", file);
  appendStepSummary("second", file);
  if (readFileSync(file, "utf8") !== "first\nsecond\n") {
    throw new Error(readFileSync(file, "utf8"));
  }
  appendStepSummary("ignored", undefined);
  const seen: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => seen.push(String(message));
  try {
    appendStepSummary("x", `${tempDirSync()}/missing/dir/summary.md`);
  } finally {
    console.error = original;
  }
  if (!seen[0]?.startsWith("Could not write the job summary")) {
    throw new Error(JSON.stringify(seen));
  }
});

test("neutralizeCommands keeps a log line from starting a command", () => {
  const got = neutralizeCommands(
    "fine\n::error::boom\n   ::add-mask::x\nalso fine",
  );
  if (got !== "fine\n[log] ::error::boom\n[log]    ::add-mask::x\nalso fine") {
    throw new Error(got);
  }
  // A bare carriage return also ends a line for the runner.
  const carried = neutralizeCommands("[info] x\r::stop-commands::tok");
  if (carried !== "[info] x\n[log] ::stop-commands::tok") {
    throw new Error(JSON.stringify(carried));
  }
});
