/** `review --intent-file`: reads what the change is for, from a file or from
 * standard input, and checks it against the repository's cap. */
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { die } from "./error.ts";
import { checkReviewSystemPrompt } from "../review/system_prompt.ts";
import type { IntentRecord, IntentSource } from "../review/intent.ts";

/** The intent a run was given, trimmed. */
export type LoadedIntent = { text: string; source: IntentSource };

export type IntentLoad = {
  /** `null` when the flag was not given, and when the text was empty. */
  intent: LoadedIntent | null;
  warnings: Array<{ code: string; message: string }>;
};

/** Where `-` reads from. Standard input, unless a test hands in another. */
export type IntentInput = AsyncIterable<Buffer | string> & {
  isTTY?: boolean;
};

/** What a result records about an intent: how it came in and how long it is,
 * never the text. */
export function intentRecord(intent: LoadedIntent | null): IntentRecord | null {
  return intent ? { source: intent.source, chars: intent.text.length } : null;
}

/** A source that goes this far past the cap is over it for certain. A text a
 * little past the cap is read to its end instead, so the error can say how long
 * it is. Space around the text is dropped, but it still has to end somewhere,
 * so raw text has a larger bound. */
const TEXT_SLACK = 65_536;
const RAW_SLACK = 1_000_000;

/** Reads `source` until it ends, or until the text is known to be over the
 * cap, so a huge file or a device that never ends is a quick error and not an
 * out-of-memory one. `complete` says the whole source was read. */
async function readBounded(
  source: AsyncIterable<Buffer | string>,
  limit: number | null,
): Promise<{ text: string; complete: boolean }> {
  const decoder = new StringDecoder("utf8");
  let text = "";
  for await (const chunk of source) {
    text += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (
      limit !== null &&
      (text.trim().length > limit + TEXT_SLACK ||
        text.length > limit + RAW_SLACK)
    ) {
      return { text, complete: false };
    }
  }
  return { text: text + decoder.end(), complete: true };
}

/** Reads the flag's value. `die`s with exit 2 when the file cannot be read,
 * when `-` meets a terminal, or when the text is over `limit`. An empty text
 * is no intent and one `intent_empty` warning. */
export async function loadIntentFlag(
  value: string | undefined,
  limit: number | null,
  input: IntentInput = process.stdin,
): Promise<IntentLoad> {
  if (value === undefined) return { intent: null, warnings: [] };
  if (value === "") {
    die("--intent-file: give a path, or - to read standard input");
  }
  let read: { text: string; complete: boolean };
  let source: IntentSource;
  if (value === "-") {
    source = "stdin";
    // A terminal never ends its input, so reading it would wait forever.
    if (input.isTTY === true) {
      die("--intent-file=-: nothing on standard input");
    }
    read = await readBounded(input, limit);
  } else {
    source = "file";
    const stream = createReadStream(value);
    try {
      read = await readBounded(stream, limit);
    } catch (error) {
      die(`--intent-file: could not read ${value}: ${String(error)}`);
    } finally {
      stream.destroy();
    }
  }
  const text = read.text.trim();
  if (!read.complete) {
    // Only the start of the source was read, which is enough to know it is
    // over the cap but not by how much.
    die(
      `--intent-file: must be at most ${limit} characters (got more than ${limit})`,
    );
  }
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
