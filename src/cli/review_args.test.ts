import { parseReviewArgs } from "./review_args.ts";
import { setCliInteractive } from "./args.ts";
import { test } from "node:test";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  remove,
  setEnv,
} from "../util/runtime.ts";

test("parseReviewArgs: PR mode strips local-only flags before parseArgs", async () => {
  const parsed = await parseReviewArgs([
    "owner/repo",
    "42",
    "--json",
    "--fresh",
    "--to-branch=main",
    "--log-time",
    "--token=test",
    "--low-model=low/model",
    "--high-model=test/model",
  ]);
  if (parsed.mode !== "pr") throw new Error(`mode ${parsed.mode}`);
  if (!parsed.json || !parsed.fresh) throw new Error("flags not captured");
  if (parsed.options.prNumber !== 42) {
    throw new Error(`pr ${parsed.options.prNumber}`);
  }
});

test("parseReviewArgs: --remote selects remote mode", async () => {
  const parsed = await parseReviewArgs(["--remote"]);
  if (parsed.mode !== "remote") {
    throw new Error(`expected remote mode, got ${parsed.mode}`);
  }
});

test("parseReviewArgs: --json fails fast on a missing model instead of prompting", async () => {
  // `--json` is a machine-readable contract, so a missing value must fail fast
  // (plan §8.7), never drive the prompt path. No provider ships a default model
  // now that models go stale, so `--json` without a model is an error, low
  // first because review asks for it first.
  // The parse reads the real config, so isolate it to prove the parse decides
  // on its own rather than inheriting whatever the developer has configured.
  const dir = await makeTempDir({ prefix: "cm-review-args-" });
  const previous = getEnv("CM_CONFIG_PATH");
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  try {
    await assertFailsFast(
      ["owner/repo", "42", "--json", "--token=test"],
      "Missing low model. Pass it as a CLI option when running without an interactive terminal",
    );
    await assertFailsFast(
      [
        "owner/repo",
        "42",
        "--json",
        "--token=test",
        "--low-model=low/model",
        "--high-model=test/model",
      ],
      undefined,
    );
  } finally {
    if (previous === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", previous);
    await remove(dir, { recursive: true });
  }
});

/** Runs `parseReviewArgs` with the interactive flag parked on true, so the only
 * path out of a missing value is the fast non-interactive `die`. When `message`
 * is given the parse must fail with exactly that message, otherwise it must
 * succeed. */
async function assertFailsFast(
  args: string[],
  message: string | undefined,
): Promise<void> {
  setCliInteractive(true);
  try {
    let parsed;
    try {
      parsed = await parseReviewArgs(args);
    } catch (thrown) {
      if (message === undefined) {
        throw new Error(
          `expected a parse, got ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        );
      }
      const got = thrown instanceof Error ? thrown.message : String(thrown);
      if (got !== message) {
        throw new Error(`expected ${JSON.stringify(message)}, got ${got}`);
      }
      return;
    }
    if (message !== undefined) {
      throw new Error(
        `expected ${JSON.stringify(message)}, got mode ${parsed.mode}`,
      );
    }
    if (parsed.mode !== "pr") throw new Error(`mode ${parsed.mode}`);
    if (!parsed.options.lowModel || !parsed.options.highModel) {
      throw new Error("a model was not captured");
    }
  } finally {
    setCliInteractive(true);
  }
}
