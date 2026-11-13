/** Ctrl-C at a prompt stops the command.
 *
 * While readline holds the terminal, Ctrl-C is a key press, not a signal. It
 * used to count as "no answer", so a local review went on to the model after
 * a Ctrl-C at the codegraph install prompt. Only a real terminal shows this,
 * so the child runs under `script`, which gives it a pseudo-terminal, and the
 * test types Ctrl-C into it.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runtimeExecPath } from "../testing/runtime.ts";

const child = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "testing/fixtures/prompt_child.ts",
);

const hasScript =
  process.platform === "linux" &&
  spawnSync("script", ["--version"]).status === 0;

/** Runs the child in a pseudo-terminal, types Ctrl-C at the prompt and
 * returns what the terminal showed and the child's exit code. */
async function ctrlCAtPrompt(
  handler: boolean,
): Promise<{ code: number | null; output: string }> {
  const proc = spawn(
    "script",
    ["-qfec", `'${runtimeExecPath()}' '${child}'`, "/dev/null"],
    {
      env: { ...process.env, PROMPT_HANDLER: handler ? "1" : "0" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  proc.stdout.on("data", (chunk: Buffer) => (output += chunk));
  proc.stderr.on("data", (chunk: Buffer) => (output += chunk));
  const exited = new Promise<number | null>((resolve) =>
    proc.on("close", (code) => resolve(code)),
  );
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  try {
    const deadline = Date.now() + 15_000;
    while (!output.includes("[y/N]")) {
      if (Date.now() > deadline) throw new Error(`no prompt:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    proc.stdin.write("\x03");
    return { code: await exited, output };
  } finally {
    clearTimeout(timeout);
    proc.kill("SIGKILL");
  }
}

test(
  "Ctrl-C at a prompt runs the command's interrupt handler before the prompt returns",
  { skip: !hasScript && "needs util-linux script for a pseudo-terminal" },
  async () => {
    const { code, output } = await ctrlCAtPrompt(true);
    const handler = output.indexOf("HANDLER RAN");
    const answer = output.indexOf("ANSWER");
    if (handler < 0 || (answer >= 0 && answer < handler)) {
      throw new Error(`the handler did not run first:\n${output}`);
    }
    if (code !== 3) throw new Error(`exit ${code}, want 3:\n${output}`);
  },
);

test(
  "Ctrl-C at a prompt ends a command that has no handler",
  { skip: !hasScript && "needs util-linux script for a pseudo-terminal" },
  async () => {
    const { code, output } = await ctrlCAtPrompt(false);
    if (output.includes("ANSWER")) {
      throw new Error(`the command went on after Ctrl-C:\n${output}`);
    }
    // `script -e` reports a child ended by SIGINT as 128 + 2.
    if (code !== 130) throw new Error(`exit ${code}, want 130:\n${output}`);
  },
);
