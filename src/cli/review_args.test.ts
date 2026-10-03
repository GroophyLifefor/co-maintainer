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

test("parseReviewArgs: --remote-byok and --no-remote-byok are captured", async () => {
  const on = await parseReviewArgs(["--remote", "--remote-byok"]);
  if (on.mode !== "remote" || on.remoteByok !== true) {
    throw new Error(`on: mode=${on.mode} remoteByok=${String(on.remoteByok)}`);
  }
  const off = await parseReviewArgs(["--remote", "--no-remote-byok"]);
  if (off.mode !== "remote" || off.remoteByok !== false) {
    throw new Error(
      `off: mode=${off.mode} remoteByok=${String(off.remoteByok)}`,
    );
  }
  const unset = await parseReviewArgs(["--remote"]);
  if (unset.mode !== "remote" || unset.remoteByok !== undefined) {
    throw new Error(
      `unset: mode=${unset.mode} remoteByok=${String(unset.remoteByok)}`,
    );
  }
});

test("parseReviewArgs: --remote-byok and --no-remote-byok together is rejected", async () => {
  let message: string | undefined;
  try {
    await parseReviewArgs(["--remote", "--remote-byok", "--no-remote-byok"]);
  } catch (thrown) {
    message = thrown instanceof Error ? thrown.message : String(thrown);
  }
  if (message !== "--remote-byok and --no-remote-byok cannot both be used") {
    throw new Error(`message: ${message}`);
  }
});

test("parseReviewArgs: --remote-byok without --remote is refused", async () => {
  let message: string | undefined;
  try {
    await parseReviewArgs(["--remote-byok"]);
  } catch (thrown) {
    message = thrown instanceof Error ? thrown.message : String(thrown);
  }
  if (message !== "--remote-byok requires --remote") {
    throw new Error(`message: ${message}`);
  }
});

test("parseReviewArgs: --remote-byok is refused for PR mode", async () => {
  let message: string | undefined;
  try {
    await parseReviewArgs([
      "owner/repo",
      "42",
      "--remote-byok",
      "--token=test",
    ]);
  } catch (thrown) {
    message = thrown instanceof Error ? thrown.message : String(thrown);
  }
  if (message !== "--remote-byok requires --remote") {
    throw new Error(`message: ${message}`);
  }
});

test("parseReviewArgs: --remote-byok is refused for PR mode even with --remote", async () => {
  let message: string | undefined;
  try {
    await parseReviewArgs([
      "owner/repo",
      "42",
      "--remote",
      "--remote-byok",
      "--token=test",
    ]);
  } catch (thrown) {
    message = thrown instanceof Error ? thrown.message : String(thrown);
  }
  if (
    message !== "--remote-byok is only for remote review without a PR number"
  ) {
    throw new Error(`message: ${message}`);
  }
});

test("parseReviewArgs: --json fails fast on a missing model instead of prompting", async () => {
  // `--json` is a machine-readable contract, so a missing value must fail fast,
  // never drive the prompt path. No provider ships a default model
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

test("parseReviewArgs: --output=github is captured in every mode", async () => {
  const remote = await parseReviewArgs(["--remote", "--output=github"]);
  if (remote.mode !== "remote" || remote.output !== "github") {
    throw new Error(`remote: ${remote.mode} ${String(remote.output)}`);
  }
  const local = await parseReviewArgs(["--output=github"]);
  if (local.mode !== "local" || local.output !== "github") {
    throw new Error(`local: ${local.mode} ${String(local.output)}`);
  }
  const pr = await parseReviewArgs([
    "owner/repo",
    "42",
    "--output=github",
    "--token=test",
    "--low-model=low/model",
    "--high-model=test/model",
  ]);
  if (pr.mode !== "pr" || pr.output !== "github") {
    throw new Error(`pr: ${pr.mode} ${String(pr.output)}`);
  }
  const plain = await parseReviewArgs(["--remote"]);
  if (plain.output !== undefined) throw new Error("output is off by default");
});

test("parseReviewArgs: --output takes only github, and never together with --json", async () => {
  const message = async (args: string[]): Promise<string> => {
    try {
      await parseReviewArgs(args);
    } catch (thrown) {
      return thrown instanceof Error ? thrown.message : String(thrown);
    }
    throw new Error(`accepted ${args.join(" ")}`);
  };
  if ((await message(["--output=xml"])) !== "--output must be: github") {
    throw new Error("an unknown format must be named");
  }
  if ((await message(["--output="])) !== "--output must be: github") {
    throw new Error("an empty format is not github");
  }
  if (
    (await message(["--remote", "--output=github", "--json"])) !==
    "--output=github cannot be used with --json"
  ) {
    throw new Error("--json and --output=github conflict");
  }
});
