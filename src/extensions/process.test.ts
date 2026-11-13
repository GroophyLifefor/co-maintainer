/** One run of a command: a child that holds the pipes open, in the group or
 * out of it, never holds the run open, and the shell's arguments. */
import { test } from "node:test";
import { tempDirSync, readTextFile } from "../testing/runtime.ts";
import { isProcessAlive } from "../util/runtime.ts";
import { runCommandOnce, shellArgs } from "./process.ts";

test("on Windows the command is wrapped in one more pair of quotes for cmd /s", () => {
  const command = `"C:\\Program Files\\nodejs\\node.exe" C:\\qa\\x.mjs "C:\\cm\\details.json" --json`;
  const [, args] = shellArgs(command, true);
  if (args.join(" ") !== `/d /s /c "${command}"`)
    throw new Error(args.join(" "));
  // cmd /s removes exactly the first and the last quote of what follows /c.
  const seen = args[3]!.slice(1, -1);
  if (seen !== command) throw new Error(seen);
  const [shell, posix] = shellArgs(command, false);
  if (shell !== "/bin/sh" || posix[1] !== command) throw new Error("posix");
});

const posixOnly = { skip: process.platform === "win32" };
const OK = `{"schemaVersion":1,"name":"p","status":"ok","verdict":"comment"}`;

test(
  "a child that leaves the group and keeps stdout does not hold the run open",
  posixOnly,
  async () => {
    const started = performance.now();
    const outcome = await runCommandOnce({
      command: `setsid sleep 30 & echo '${OK}'`,
      timeoutMs: 20_000,
      killGraceMs: 200,
    });
    const took = performance.now() - started;
    if (took > 5_000) throw new Error(`took ${Math.round(took)} ms`);
    if (outcome.timedOut || outcome.exitCode !== 0) {
      throw new Error(JSON.stringify(outcome));
    }
    if (outcome.stdout.trim() !== OK) throw new Error(outcome.stdout);
  },
);

test(
  "a detached child cannot stretch a timeout either",
  posixOnly,
  async () => {
    const started = performance.now();
    const outcome = await runCommandOnce({
      command: "setsid sleep 30 & sleep 30",
      timeoutMs: 300,
      killGraceMs: 200,
    });
    const took = performance.now() - started;
    if (took > 5_000) throw new Error(`took ${Math.round(took)} ms`);
    if (!outcome.timedOut) throw new Error(JSON.stringify(outcome));
  },
);

test(
  "a background child still in the group does not cost the response",
  posixOnly,
  async () => {
    const dir = tempDirSync();
    const started = performance.now();
    const outcome = await runCommandOnce({
      command: `sleep 30 & echo $! > '${dir}/pid'; echo '${OK}'`,
      timeoutMs: 20_000,
      killGraceMs: 200,
    });
    const took = performance.now() - started;
    if (took > 5_000) throw new Error(`took ${Math.round(took)} ms`);
    if (outcome.timedOut || outcome.stdout.trim() !== OK) {
      throw new Error(JSON.stringify(outcome));
    }
    const pid = Number((await readTextFile(`${dir}/pid`)).trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (isProcessAlive(pid)) throw new Error(`leftover ${pid} still runs`);
  },
);
