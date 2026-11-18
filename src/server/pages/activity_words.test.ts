import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextFile } from "../../util/runtime.ts";
import {
  cancelReasonText,
  jobDetailText,
  jobKindText,
  reasonText,
  WORDED_CODES,
} from "./activity_words.ts";
import type { JobRow } from "../../store/rows.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function job(type: string, args: unknown = {}): JobRow {
  return {
    id: "j",
    type,
    repo: "acme/widgets",
    pr_number: 7,
    status: "done",
    args: JSON.stringify(args),
    delivery_id: null,
    queue_key: null,
    attempt: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    error: null,
    superseded_by: null,
    cancel_reason: null,
  };
}

/** The codes a source file stores as a delivery or skip reason. */
async function storedCodes(file: string): Promise<string[]> {
  const source = await readTextFile(join(root, file));
  const codes = new Set<string>();
  for (const match of source.matchAll(
    /(?:reason:\s*|skipped\()"([a-z]+(?:-[a-z]+)+)"/g,
  )) {
    codes.add(match[1]!);
  }
  return [...codes];
}

test("the brief's examples read as sentences", () => {
  const cases: [string, string][] = [
    [jobKindText(job("skip")), "Skipped a review"],
    [jobKindText(job("reply")), "Replied in a thread"],
    [reasonText("own-comment"), "Skipped: the bot's own comment"],
    [
      reasonText("nothing-new-since-last-round"),
      "Skipped: nothing new since the last review",
    ],
  ];
  for (const [got, want] of cases) {
    if (got !== want) throw new Error(`${got} is not ${want}`);
  }
});

test("every reason code the webhook and commit watch store has its own sentence", async () => {
  const missing: string[] = [];
  for (const file of [
    "src/services/webhook.ts",
    "src/services/push_review.ts",
    "src/services/review_policy.ts",
  ]) {
    for (const code of await storedCodes(file)) {
      if (!WORDED_CODES.reasons.includes(code))
        missing.push(`${file}: ${code}`);
    }
  }
  if (missing.length) {
    throw new Error(`reason codes without a sentence:\n${missing.join("\n")}`);
  }
});

test("every job type the server queues has its own label", async () => {
  const types = ["init", "remake", "review", "reply", "skip"];
  for (const [file, name] of [
    ["src/services/push_review.ts", "PUSH_JOB"],
    ["src/services/push_review.ts", "PUSH_CHECK_JOB"],
    ["src/services/watch_comments.ts", "WATCH_COMMENT_JOB"],
  ] as const) {
    const source = await readTextFile(join(root, file));
    const value = new RegExp(`${name} = "([a-z_]+)"`).exec(source)?.[1];
    if (!value) throw new Error(`${name} not found in ${file}`);
    types.push(value);
  }
  types.push("remote_review");
  for (const type of types) {
    if (!WORDED_CODES.jobKinds.includes(type)) {
      throw new Error(`job type ${type} has no label`);
    }
  }
});

test("no sentence shows a raw code, a dash joined word or an underscore", () => {
  const all = [
    ...WORDED_CODES.jobKinds.map((type) => jobKindText(job(type))),
    ...WORDED_CODES.skipCommands.map((command) =>
      jobDetailText(job("skip", { command })),
    ),
    ...WORDED_CODES.reasons.map((code) => reasonText(code)),
    ...WORDED_CODES.cancelReasons.map((code) => cancelReasonText(code)),
  ];
  for (const sentence of all) {
    if (!sentence || /_|\b[a-z]+-[a-z]+-[a-z]+\b/.test(sentence)) {
      throw new Error(`not plain words: ${sentence}`);
    }
    if (/;/.test(sentence) || sentence.includes(String.fromCharCode(0x2014))) {
      throw new Error(`bad punctuation: ${sentence}`);
    }
  }
});

test("an unknown code becomes words and a stored sentence stays as it is", () => {
  if (reasonText("some-new-thing") !== "Skipped: some new thing") {
    throw new Error(reasonText("some-new-thing"));
  }
  const policy = "Rule 3 (trusted author): waiting for a maintainer request.";
  if (reasonText(policy) !== policy.replace(/\.$/, "")) {
    throw new Error(reasonText(policy));
  }
  if (
    reasonText("no-write-access: NONE") !==
    "Skipped: the commenter has no write access (none)"
  ) {
    throw new Error(reasonText("no-write-access: NONE"));
  }
  if (jobKindText(job("future_kind")) !== "Ran future kind") {
    throw new Error(jobKindText(job("future_kind")));
  }
  if (cancelReasonText(null) !== "Canceled") throw new Error("null cancel");
  if (reasonText(null, "error") !== "Could not handle this event") {
    throw new Error("error outcome");
  }
});

test("a skip job says which command asked for it", () => {
  if (
    jobDetailText(job("skip", { command: "pr-off" })) !==
    "Skipped: reviews are off for this pull request"
  ) {
    throw new Error("pr-off");
  }
  if (jobDetailText(job("review")) !== "") throw new Error("review detail");
});
