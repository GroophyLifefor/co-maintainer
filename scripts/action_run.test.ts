/** The GitHub Action's script and its manifest. The script runs for
 * real here, against a fake `npx` and a real `git`, so what the action does
 * with its inputs is checked without a GitHub runner. */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDirSync } from "../src/testing/runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const script = join(here, "action_run.sh");
const FORK_NOTE =
  "Pull requests from forks do not receive repository secrets, so this step cannot run for them.";

type Run = { code: number | null; stdout: string; stderr: string };

function run(
  env: Record<string, string>,
  options: { cwd?: string; path?: string } = {},
): Run {
  const result = spawnSync("bash", [script], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      PATH: options.path ?? process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const base = {
  REMOTE_HOST: "https://review.example.com",
  REMOTE_TOKEN: "cmr_secret_token",
  ACTION_PATH: root,
  CM_ACTION_DRY_RUN: "1",
};

function commandOf(result: Run): string {
  const line = result.stdout.split("\n").find((l) => l.startsWith("npx "));
  if (!line)
    throw new Error(`no command printed:\n${result.stdout}${result.stderr}`);
  return line;
}

test("an empty remote-token stops the step with exit 2 and says why", () => {
  const result = run({ ...base, REMOTE_TOKEN: "" });
  if (result.code !== 2) throw new Error(`exit ${result.code}`);
  const want = `remote-token is empty. ${FORK_NOTE}`;
  if (result.stderr.trim() !== want) throw new Error(result.stderr);
  if (!result.stdout.includes(`::error title=co-maintainer::${want}`)) {
    throw new Error(`the annotation is missing:\n${result.stdout}`);
  }
  if (result.stdout.includes("npx")) throw new Error("nothing may run");
});

test("an empty remote-host stops the step the same way", () => {
  const result = run({ ...base, REMOTE_HOST: "" });
  if (result.code !== 2) throw new Error(`exit ${result.code}`);
  if (result.stderr.trim() !== `remote-host is empty. ${FORK_NOTE}`) {
    throw new Error(result.stderr);
  }
});

test("the token and the key are masked before anything else is printed", () => {
  const result = run({ ...base, REMOTE_BYOK: "sk-my-own-key" });
  const lines = result.stdout.split("\n");
  const token = lines.indexOf("::add-mask::cmr_secret_token");
  const key = lines.indexOf("::add-mask::sk-my-own-key");
  const command = lines.findIndex((l) => l.startsWith("npx "));
  if (token === -1 || key === -1) throw new Error(result.stdout);
  if (!(token < command && key < command)) {
    throw new Error("secrets must be masked before the command is shown");
  }
  const command_ = commandOf(result);
  if (
    command_.includes("cmr_secret_token") ||
    command_.includes("sk-my-own-key")
  ) {
    throw new Error(`a secret is on the command line: ${command_}`);
  }
});

test("the command is review --remote --output=github with the branches it was given", () => {
  const full = run({
    ...base,
    VERSION: "0.5.1",
    TO_BRANCH: "main",
    HEAD_REF: "feature/x",
  });
  if (full.code !== 0) throw new Error(`exit ${full.code}\n${full.stderr}`);
  if (
    commandOf(full) !==
    "npx --yes -p co-maintainer@0.5.1 co-maintainer review --remote --output=github --to-branch=main --branch=feature/x"
  ) {
    throw new Error(commandOf(full));
  }
  const bare = run({ ...base, VERSION: "0.5.1" });
  if (
    commandOf(bare) !==
    "npx --yes -p co-maintainer@0.5.1 co-maintainer review --remote --output=github"
  ) {
    throw new Error(`a push has no base or head branch: ${commandOf(bare)}`);
  }
});

test("the version defaults to the one in the action's own package.json", () => {
  const wanted = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const result = run(base);
  if (!commandOf(result).includes(`co-maintainer@${wanted} `)) {
    throw new Error(commandOf(result));
  }
});

test("the key adds --remote-byok, and the test hook replaces the package", () => {
  const byok = run({ ...base, VERSION: "0.5.1", REMOTE_BYOK: "sk-k" });
  if (!commandOf(byok).endsWith(" --remote-byok"))
    throw new Error(commandOf(byok));
  const local = run({
    ...base,
    CM_ACTION_PACKAGE: "/tmp/co-maintainer-0.5.1.tgz",
  });
  if (
    !commandOf(local).startsWith(
      "npx --yes -p /tmp/co-maintainer-0.5.1.tgz co-maintainer review",
    )
  ) {
    throw new Error(commandOf(local));
  }
});

test("inputs that could act as options or hide a secret are refused", () => {
  for (const [env, part] of [
    [{ VERSION: "--registry=https://evil.example" }, "version"],
    [{ TO_BRANCH: "--upload-pack=x" }, "to-branch"],
    [{ REMOTE_TOKEN: "line1\nline2" }, "REMOTE-TOKEN"],
    [{ REMOTE_BYOK: "line1\rline2" }, "REMOTE-BYOK"],
  ] as const) {
    const merged: Record<string, string> = { ...base, VERSION: "0.5.1" };
    Object.assign(merged, env);
    const result = run(merged);
    if (result.code !== 2) {
      throw new Error(`${JSON.stringify(env)}: exit ${result.code}`);
    }
    if (
      !result.stderr.includes(part.toLowerCase()) &&
      !result.stderr.includes(part)
    ) {
      throw new Error(`${part}: ${result.stderr}`);
    }
  }
});

test("the base branch is fetched first, and a failed fetch is a runtime error", () => {
  const repo = tempDirSync();
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@t"],
  ]) {
    spawnSync("git", args, { cwd: repo });
  }
  const result = run(
    {
      ...base,
      VERSION: "0.5.1",
      TO_BRANCH: "no-such-branch",
      CM_ACTION_DRY_RUN: "",
    },
    { cwd: repo },
  );
  if (result.code !== 3)
    throw new Error(`exit ${result.code}\n${result.stderr}`);
  if (
    !result.stderr.includes("Could not fetch the base branch no-such-branch")
  ) {
    throw new Error(result.stderr);
  }
});

test("a real run hands the host and keys over by environment and passes the exit code through", () => {
  const bin = tempDirSync();
  const record = join(bin, "record");
  mkdirSync(record);
  const npx = join(bin, "npx");
  writeFileSync(
    npx,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${record.replace(/\\/g, "/")}/argv.txt"
env | grep '^CM_REMOTE' | sort > "${record.replace(/\\/g, "/")}/env.txt"
exit 7
`,
  );
  chmodSync(npx, 0o755);
  const sep = process.platform === "win32" ? ";" : ":";
  const result = run(
    {
      ...base,
      CM_ACTION_DRY_RUN: "",
      VERSION: "0.5.1",
      REMOTE_BYOK: "sk-my-own-key",
    },
    { path: `${bin}${sep}${process.env.PATH ?? ""}` },
  );
  if (result.code !== 7) {
    throw new Error(
      `the exit code must pass through, got ${result.code}\n${result.stderr}`,
    );
  }
  const argv = readFileSync(join(record, "argv.txt"), "utf8");
  if (argv.includes("cmr_secret_token") || argv.includes("sk-my-own-key")) {
    throw new Error(`a secret reached the arguments:\n${argv}`);
  }
  if (
    !argv.includes("--remote-byok") ||
    !argv.includes("co-maintainer@0.5.1")
  ) {
    throw new Error(argv);
  }
  const env = readFileSync(join(record, "env.txt"), "utf8");
  for (const line of [
    "CM_REMOTE_BYOK=sk-my-own-key",
    "CM_REMOTE_HOST=https://review.example.com",
    "CM_REMOTE_TOKEN=cmr_secret_token",
  ]) {
    if (!env.includes(line)) throw new Error(`missing ${line} in\n${env}`);
  }
});

const manifest = readFileSync(join(root, "action.yml"), "utf8");

test("action.yml keeps every documented input, with the documented defaults", () => {
  for (const input of [
    "remote-host",
    "remote-token",
    "remote-byok",
    "to-branch",
    "version",
    "node-version",
  ]) {
    if (!new RegExp(`^  ${input}:`, "m").test(manifest)) {
      throw new Error(`the ${input} input is missing`);
    }
  }
  if (!/^\s+default: "24"$/m.test(manifest))
    throw new Error("node-version default");
  if (!manifest.includes("default: ${{ github.base_ref }}")) {
    throw new Error("to-branch must default to the pull request base");
  }
  if (!manifest.includes("using: composite"))
    throw new Error("not a composite action");
  if (!manifest.toLowerCase().includes("compatib")) {
    throw new Error("the compatibility promise belongs at the top of the file");
  }
});

test("no input is pasted into a script, they all go through env", () => {
  const lines = manifest.split("\n");
  lines.forEach((line, index) => {
    if (/^\s*run:/.test(line) && line.includes("${{")) {
      throw new Error(
        `line ${index + 1} puts an expression in a script: ${line}`,
      );
    }
  });
  const runAt = lines.findIndex((l) => /^\s*run:/.test(l));
  const after = lines.slice(runAt).join("\n");
  if (after.includes("inputs.")) {
    throw new Error("nothing after the script may read an input");
  }
  for (const name of [
    "REMOTE_HOST",
    "REMOTE_TOKEN",
    "REMOTE_BYOK",
    "TO_BRANCH",
    "VERSION",
  ]) {
    if (!new RegExp(`^\\s+${name}: \\$\\{\\{ inputs\\.`, "m").test(manifest)) {
      throw new Error(`${name} is not passed by env`);
    }
  }
});
