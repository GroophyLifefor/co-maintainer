/** `review --intent-file`: reads what the change is for, from a file or from
 * standard input, and checks it against the repository's cap. */
import { die } from "./error.ts";
import { readTextFile } from "../util/runtime.ts";
import { checkReviewSystemPrompt } from "../review/system_prompt.ts";
import type { IntentRecord, IntentSource } from "../review/intent.ts";

/** The intent a run was given, trimmed. */
export type LoadedIntent = { text: string; source: IntentSource };

export type IntentLoad = {
  /** `null` when the flag was not given, and when the text was empty. */
  intent: LoadedIntent | null;
  warnings: Array<{ code: string; message: string }>;
};

/** What a result records about an intent: how it came in and how long it is,
 * never the text. */
export function intentRecord(intent: LoadedIntent | null): IntentRecord | null {
  return intent ? { source: intent.source, chars: intent.text.length } : null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads the flag's value. `die`s with exit 2 when the file cannot be read,
 * when `-` meets a terminal, or when the text is over `limit`. An empty text
 * is no intent and one `intent_empty` warning. */
export async function loadIntentFlag(
  value: string | undefined,
  limit: number | null,
): Promise<IntentLoad> {
  if (value === undefined) return { intent: null, warnings: [] };
  if (value === "") {
    die("--intent-file: give a path, or - to read standard input");
  }
  let raw: string;
  let source: IntentSource;
  if (value === "-") {
    source = "stdin";
    // A terminal never ends its input, so reading it would wait forever.
    if (process.stdin.isTTY === true) {
      die("--intent-file=-: nothing on standard input");
    }
    raw = await readStdin();
  } else {
    source = "file";
    try {
      raw = await readTextFile(value);
    } catch (error) {
      die(`--intent-file: could not read ${value}: ${String(error)}`);
    }
  }
  const text = raw.trim();
  if (text === "") {
    return {
      intent: null,
      warnings: [
        {
          code: "intent_empty",
          message: "The intent is empty, so the review ran without one.",
        },
      ],
    };
  }
  const problem = checkReviewSystemPrompt(text, limit);
  if (problem) die(`--intent-file: ${problem}`);
  return { intent: { text, source }, warnings: [] };
}
