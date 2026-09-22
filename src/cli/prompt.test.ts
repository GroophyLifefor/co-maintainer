/** Prompts always settle, even at EOF (CORE-50 / F01).
 *
 * `rl.question` never resolves *or* rejects when stdin hits EOF before an
 * answer; it just stays pending. That is the F01 hang: a top-level `await` on
 * the answer never settled, Node printed `Warning: Detected unsettled
 * top-level await`, and the process exited 13. These drive the real
 * `askLine`/`askConfirm` in a child process with stdin closed.
 */
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Command,
  removePath,
  runtimeExecPath,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";
import { test } from "node:test";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Runs a snippet that imports the real prompt module and prints the result,
 * with stdin closed so `readline` sees EOF immediately. */
async function askWithClosedStdin(
  root: string,
  body: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = `${root}/probe.ts`;
  await writeTextFile(
    script,
    `import { askConfirm, askLine } from ${JSON.stringify(
      pathToFileURL(`${projectRoot}/src/cli/prompt.ts`).href,
    )};\n${body}\n`,
  );
  // `Command` spawns with `stdio: ["ignore", "pipe", "pipe"]`, so the child's
  // stdin is closed: exactly what `</dev/null` gives on the command line.
  const result = await new Command(runtimeExecPath(), {
    args: [script],
    cwd: projectRoot,
    stdout: "piped",
    stderr: "piped",
    // Before the fix this never returned.
    timeoutMs: 20_000,
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

test("askLine settles on EOF instead of hanging", async () => {
  const root = await tempDir({ prefix: "cm-prompt-line-" });
  try {
    const result = await askWithClosedStdin(
      root,
      "console.log(JSON.stringify(await askLine('name', 'fallback')));",
    );
    if (result.code === 124) {
      throw new Error("askLine hung at EOF");
    }
    if (result.code !== 0) {
      throw new Error(`exit ${result.code}:\n${result.stderr}`);
    }
    if (/unsettled top-level await/.test(result.stderr)) {
      throw new Error(`unsettled await:\n${result.stderr}`);
    }
    // Empty input falls back, per askLine's contract.
    if (!result.stdout.includes('"fallback"')) {
      throw new Error(`stdout: ${result.stdout}`);
    }
  } finally {
    await removePath(root, { recursive: true });
  }
});

test("askConfirm settles as 'no' on EOF instead of hanging", async () => {
  const root = await tempDir({ prefix: "cm-prompt-confirm-" });
  try {
    const result = await askWithClosedStdin(
      root,
      "console.log(JSON.stringify(await askConfirm('install?')));",
    );
    if (result.code === 124) {
      throw new Error("askConfirm hung at EOF");
    }
    if (result.code !== 0) {
      throw new Error(`exit ${result.code}:\n${result.stderr}`);
    }
    if (/unsettled top-level await/.test(result.stderr)) {
      throw new Error(`unsettled await:\n${result.stderr}`);
    }
    if (!result.stdout.includes("false")) {
      throw new Error(`stdout: ${result.stdout}`);
    }
  } finally {
    await removePath(root, { recursive: true });
  }
});
