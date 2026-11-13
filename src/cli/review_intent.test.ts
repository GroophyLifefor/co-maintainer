/** `--intent-file`: how the flag is parsed and read, and how a result says an
 * intent was given. The text is never part of a result. */
import { test } from "node:test";
import { filterReviewConfigArgs, parseReviewArgs } from "./review_args.ts";
import { intentRecord, loadIntentFlag } from "./review_intent.ts";
import {
  buildLocalReviewJson,
  buildPrReviewJson,
  formatHumanReview,
  INTENT_LINE,
} from "./review_result.ts";
import { githubSummary } from "./review_github.ts";
import { setCliInteractive } from "./args.ts";
import { writeUserConfig } from "../config.ts";
import {
  cleanIntent,
  intentField,
  intentPromptNote,
} from "../review/intent.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  remove,
  setEnv,
  writeTextFile,
} from "../util/runtime.ts";

const PR_ARGS = [
  "owner/repo",
  "42",
  "--token=test",
  "--low-model=low/model",
  "--high-model=test/model",
];

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
  return "";
}

async function withConfig<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir({ prefix: "cm-intent-" });
  const previous = getEnv("CM_CONFIG_PATH");
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", previous);
    await remove(dir, { recursive: true });
    setCliInteractive(true);
  }
}

test("the flag is in the list that lets pull request parsing accept it", () => {
  const kept = filterReviewConfigArgs(["--intent-file=task.md", "--token=x"]);
  must(JSON.stringify(kept) === JSON.stringify(["--token=x"]), String(kept));
});

test("a pull request review reads the intent into its options and keeps the load result", async () => {
  await withConfig(async (dir) => {
    await writeTextFile(`${dir}/task.md`, "\n  Fix JPY rounding.  \n");
    const parsed = await parseReviewArgs([
      ...PR_ARGS,
      `--intent-file=${dir}/task.md`,
    ]);
    must(parsed.mode === "pr", `mode ${parsed.mode}`);
    if (parsed.mode !== "pr") return;
    must(parsed.options.reviewIntent === "Fix JPY rounding.", "options");
    must(parsed.intentLoad?.intent?.source === "file", "source");
    must(parsed.intentLoad?.warnings.length === 0, "no warnings");
    const plain = await parseReviewArgs(PR_ARGS);
    must(
      plain.mode === "pr" && plain.options.reviewIntent === undefined,
      "no intent without the flag",
    );
  });
});

test("local and remote parsing keep the flag for the run that reads it", async () => {
  const local = await parseReviewArgs(["--intent-file=task.md"]);
  must(local.mode === "local" && local.intentFile === "task.md", "local");
  const remote = await parseReviewArgs(["--remote", "--intent-file=-"]);
  must(remote.mode === "remote" && remote.intentFile === "-", "remote");
});

test("--intent-file is refused with --range", async () => {
  const message = await messageOf(() =>
    parseReviewArgs([
      "--remote",
      `--range=${"a".repeat(40)}..${"b".repeat(40)}`,
      "--intent-file=task.md",
    ]),
  );
  must(
    message === "--intent-file is not supported with --range",
    message || "accepted",
  );
});

test("a file is read as UTF-8 and trimmed, and a cap of the repository applies", async () => {
  await withConfig(async (dir) => {
    await writeTextFile(`${dir}/task.md`, "\n\n  İstanbul vergisi  \n");
    const loaded = await loadIntentFlag(`${dir}/task.md`, 8000);
    must(loaded.intent?.text === "İstanbul vergisi", String(loaded.intent));
    must(loaded.intent?.source === "file", "source");

    await writeTextFile(`${dir}/five.md`, "12345");
    must((await loadIntentFlag(`${dir}/five.md`, 5)).intent !== null, "at cap");
    const over = await messageOf(() => loadIntentFlag(`${dir}/five.md`, 4));
    must(over === "--intent-file: must be at most 4 characters (got 5)", over);
    must(
      (await loadIntentFlag(`${dir}/five.md`, null)).intent !== null,
      "no cap",
    );
  });
});

test("the cap is the repository's reviewSystemPromptMaxChars, read in pull request parsing", async () => {
  await withConfig(async (dir) => {
    await writeUserConfig({
      repos: { "owner/repo": { reviewSystemPromptMaxChars: 3 } },
    });
    await writeTextFile(`${dir}/task.md`, "far too long");
    const message = await messageOf(() =>
      parseReviewArgs([...PR_ARGS, `--intent-file=${dir}/task.md`]),
    );
    must(
      message === "--intent-file: must be at most 3 characters (got 12)",
      message,
    );
  });
});

test("an empty file is no intent and an intent_empty warning", async () => {
  await withConfig(async (dir) => {
    await writeTextFile(`${dir}/empty.md`, "  \n \n");
    const loaded = await loadIntentFlag(`${dir}/empty.md`, 8000);
    must(loaded.intent === null, "intent");
    must(
      loaded.warnings.length === 1 &&
        loaded.warnings[0]!.code === "intent_empty",
      JSON.stringify(loaded.warnings),
    );
    // The size check never runs on text that trims to nothing.
    const padded = await loadIntentFlag(`${dir}/empty.md`, 1);
    must(padded.intent === null, "padded");
  });
});

test("an unreadable file and a missing value are usage errors that name the flag", async () => {
  await withConfig(async (dir) => {
    const missing = await messageOf(() =>
      loadIntentFlag(`${dir}/nope.md`, 8000),
    );
    must(
      missing.startsWith(`--intent-file: could not read ${dir}/nope.md:`),
      missing,
    );
    const directory = await messageOf(() => loadIntentFlag(dir, 8000));
    must(
      directory.startsWith(`--intent-file: could not read ${dir}:`),
      directory,
    );
    const empty = await messageOf(() => loadIntentFlag("", 8000));
    must(empty.startsWith("--intent-file: give a path"), empty);
  });
});

test("- on a terminal is a usage error and never waits for input", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    const message = await messageOf(() => loadIntentFlag("-", 8000));
    must(message === "--intent-file=-: nothing on standard input", message);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
});

test("the record holds the source and the length, never the text", () => {
  const record = intentRecord({ text: "Fix JPY rounding.", source: "stdin" });
  must(
    JSON.stringify(record) === '{"source":"stdin","chars":17}',
    JSON.stringify(record),
  );
  must(intentRecord(null) === null, "none");
});

test("the prompt helpers add nothing without an intent", () => {
  must(cleanIntent(undefined) === "" && cleanIntent("  ") === "", "clean");
  must(JSON.stringify(intentField(undefined)) === "{}", "field");
  must(intentPromptNote("") === "", "note");
  must(JSON.stringify(intentField(" x ")) === '{"intent":"x"}', "field set");
});

test("subject.intent is in local and pull request results", () => {
  const base = {
    repo: "owner/repo",
    guideBuiltAt: null,
    codegraphState: "disabled" as const,
    codegraphReason: null,
    findings: [],
    warnings: [],
    usage: { tokensIn: 0, tokensOut: 0, costUsd: null },
    durationMs: 1,
  };
  const intent = { source: "file" as const, chars: 17 };
  const local = JSON.parse(
    buildLocalReviewJson({
      ...base,
      branch: "feature",
      baseLabel: "main",
      revision: {
        files: [],
        title: "",
        description: "SECRET TEXT",
        baseLabel: "main",
        producer: "local",
      },
      intent,
    }),
  );
  must(
    JSON.stringify(local.subject.intent) === JSON.stringify(intent),
    "local",
  );
  must(
    !JSON.stringify(local).includes("SECRET TEXT"),
    "the description leaked into the result",
  );
  const pr = JSON.parse(
    buildPrReviewJson({ ...base, prNumber: 4, markdown: "", intent }),
  );
  must(JSON.stringify(pr.subject.intent) === JSON.stringify(intent), "pr");
  const none = JSON.parse(
    buildPrReviewJson({ ...base, prNumber: 4, markdown: "" }),
  );
  must(!("intent" in none.subject), "a key without an intent");
});

test("the human output and the job summary carry the line only when an intent was given", () => {
  const input = {
    title: "co-maintainer review · owner/repo · PR #4",
    guideBuiltAt: null,
    codegraphState: "disabled" as const,
    findings: [],
  };
  const given = formatHumanReview({ ...input, intent: true }).split("\n");
  must(given[0] === input.title, "title first");
  must(given[2] === INTENT_LINE, given.slice(0, 4).join("|"));
  must(INTENT_LINE === "Intent file: provided", "the wording");
  must(
    !formatHumanReview(input).includes("Intent file"),
    "a plain review has the line",
  );
  const summary = githubSummary({ title: "owner/repo · PR #4", findings: [] });
  must(!summary.includes("Intent file"), "plain summary");
  must(
    githubSummary({ title: "owner/repo · PR #4", findings: [], intent: true })
      .split("\n")
      .includes(INTENT_LINE),
    "summary line",
  );
});
