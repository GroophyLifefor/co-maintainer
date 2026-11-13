/** `co-maintainer extension`: registrations round-trip through config.json,
 * the hard off switch refuses, and `debug-run` runs the command against the
 * built-in mock with an empty environment. */
import { test } from "node:test";
import { readConfig } from "../config.ts";
import {
  deleteEnv,
  getEnv,
  readDir,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../testing/runtime.ts";
import { runExtensionCommand } from "./command.ts";
import { readRegistrations } from "./registry.ts";
import { extensionsRoot } from "./run_folder.ts";

const posixOnly = { skip: process.platform === "win32" };

async function withConfig(fn: (dir: string) => Promise<void>): Promise<void> {
  const original = getEnv("CM_CONFIG_PATH");
  const originalDisabled = getEnv("CM_EXTENSIONS_DISABLED");
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  deleteEnv("CM_EXTENSIONS_DISABLED");
  try {
    await fn(dir);
  } finally {
    if (original === undefined) deleteEnv("CM_CONFIG_PATH");
    else setEnv("CM_CONFIG_PATH", original);
    if (originalDisabled === undefined) deleteEnv("CM_EXTENSIONS_DISABLED");
    else setEnv("CM_EXTENSIONS_DISABLED", originalDisabled);
    process.exitCode = 0;
  }
}

async function captured(args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
  console.error = () => {};
  try {
    await runExtensionCommand(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.join("\n");
}

async function refused(args: string[]): Promise<string> {
  try {
    await captured(args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`accepted ${args.join(" ")}`);
}

test("register saves defaults, update changes only what it is given", async () => {
  await withConfig(async () => {
    await captured([
      "register",
      "--name=lint",
      "--command=/opt/lint {{diff_path}}",
    ]);
    await captured([
      "register",
      "--name=qa",
      "--command=/opt/qa {{details_path}}",
      "--repos=acme/*",
      "--review-types=pr,remote",
      "--run-after=lint",
      "--priority=3",
      "--fail-fast",
      "--timeout=30s",
      "--rerun-on-restart=false",
    ]);
    await captured(["update", "--name=lint", "--priority=2"]);
    const [lint, qa] = readRegistrations();
    if (lint?.priority !== 2 || lint.command !== "/opt/lint {{diff_path}}") {
      throw new Error(JSON.stringify(lint));
    }
    if (
      qa?.repos !== "acme/*" ||
      qa.reviewTypes?.join() !== "pr,remote" ||
      qa.runAfter !== "lint" ||
      qa.priority !== 3 ||
      !qa.failFast ||
      qa.timeoutSeconds !== 30 ||
      qa.rerunOnRestart !== false ||
      qa.maxRequestedRetries !== 3 ||
      qa.parallelism !== true
    ) {
      throw new Error(JSON.stringify(qa));
    }
  });
});

test("register refuses a duplicate, a cycle, a bad name and an unknown variable", async () => {
  await withConfig(async () => {
    await captured(["register", "--name=a", "--command=true"]);
    await captured(["register", "--name=b", "--command=true", "--run-after=a"]);
    if (
      !(await refused(["register", "--name=a", "--command=x"])).includes(
        "already registered",
      )
    ) {
      throw new Error("a duplicate was saved");
    }
    const cycle = await refused(["update", "--name=a", "--run-after=b"]);
    if (!cycle.includes("cycle")) throw new Error(cycle);
    if (
      !(await refused(["register", "--name=review", "--command=x"])).includes(
        "AI review",
      )
    ) {
      throw new Error("review was accepted as a name");
    }
    const unknown = await refused([
      "register",
      "--name=c",
      "--command=run {{token}}",
    ]);
    if (!unknown.includes("{{token}}")) throw new Error(unknown);
    if (readRegistrations().length !== 2) throw new Error("a refusal wrote");
  });
});

test("--run-after=Review means the review, in any case", async () => {
  await withConfig(async () => {
    await captured([
      "register",
      "--name=a",
      "--command=true",
      "--run-after=Review",
    ]);
    if (readRegistrations()[0]?.runAfter !== "review") {
      throw new Error(JSON.stringify(readRegistrations()));
    }
  });
});

test("an unregistered run-after target needs --yes when nobody can be asked", async () => {
  await withConfig(async () => {
    const message = await refused([
      "register",
      "--name=a",
      "--command=true",
      "--run-after=later",
    ]);
    if (!message.includes("later")) throw new Error(message);
    await captured([
      "register",
      "--name=a",
      "--command=true",
      "--run-after=later",
      "--yes",
    ]);
    if (readRegistrations()[0]?.runAfter !== "later") {
      throw new Error("--yes did not save it");
    }
  });
});

test("disable, enable and remove keep the registration order", async () => {
  await withConfig(async () => {
    for (const name of ["a", "b", "c"]) {
      await captured(["register", `--name=${name}`, "--command=true"]);
    }
    await captured(["disable", "--name=b"]);
    if (!readRegistrations()[1]?.disabled) throw new Error("not disabled");
    await captured(["enable", "--name=b"]);
    if ("disabled" in readRegistrations()[1]!) throw new Error("not enabled");
    await captured(["remove", "--name=a"]);
    if (
      readRegistrations()
        .map((entry) => entry.name)
        .join() !== "b,c"
    ) {
      throw new Error("remove changed the order");
    }
    await captured(["remove", "--name=b"]);
    await captured(["remove", "--name=c"]);
    if ("extensions" in readConfig()) {
      throw new Error("an empty list was left in config.json");
    }
  });
});

test("CM_EXTENSIONS_DISABLED=1 refuses register and debug-run", async () => {
  await withConfig(async () => {
    setEnv("CM_EXTENSIONS_DISABLED", "1");
    for (const args of [
      ["register", "--name=a", "--command=true"],
      ["debug-run", "--name=a", "--command=true"],
    ]) {
      const message = await refused(args);
      if (!message.includes("CM_EXTENSIONS_DISABLED=1"))
        throw new Error(message);
    }
    if (readRegistrations().length !== 0) throw new Error("it registered");
  });
});

test(
  "debug-run runs against the mock with an empty environment",
  posixOnly,
  async () => {
    await withConfig(async (dir) => {
      const script = `${dir}/ext.mjs`;
      await writeTextFile(
        script,
        `import { readFileSync } from "node:fs";
const details = JSON.parse(readFileSync(process.argv[2], "utf8"));
const diff = readFileSync(process.argv[4], "utf8");
console.log(JSON.stringify({
  schemaVersion: 1, name: "probe", status: "ok", verdict: "request_changes",
  findings: [{ severity: "P2", blocking: true, title: "env " + Object.keys(process.env).filter((k) => !["PWD", "SHLVL", "_"].includes(k)).join(","), body: "b" }],
  data: { media: [{ kind: "video", label: "pr", url: "https://cdn.test/" + details.prNumber }] },
  extraData: { review: process.argv[3], diff: diff.length > 0 },
}));
`,
      );
      setEnv("CM_TEST_SECRET", "do-not-pass");
      try {
        const output = await captured([
          "debug-run",
          "--name=probe",
          `--command=${process.execPath} ${script} {{details_path}} {{review_result_path}} {{diff_path}}`,
        ]);
        // The title lists every variable the command saw besides the ones
        // the shell sets itself. An empty environment leaves none.
        if (!/\[P2 · blocking\] env$/m.test(output)) {
          throw new Error(output);
        }
        if (output.includes("CM_TEST_SECRET") || output.includes("HOME")) {
          throw new Error(`the environment leaked: ${output}`);
        }
        if (!output.includes("video pr: https://cdn.test/45"))
          throw new Error(output);
        if (!output.includes("Extensions: probe · Failed: none"))
          throw new Error(output);
        if (!output.includes("Review results: empty")) throw new Error(output);
      } finally {
        deleteEnv("CM_TEST_SECRET");
      }
      const left: string[] = [];
      try {
        for await (const entry of readDir(extensionsRoot()))
          left.push(entry.name);
      } catch {
        // no folder at all is fine
      }
      if (left.length > 0) throw new Error(`the run folder was left: ${left}`);
    });
  },
);

test(
  "debug-run reports a broken response with the output as details",
  posixOnly,
  async () => {
    await withConfig(async () => {
      const output = await captured([
        "debug-run",
        "--name=broken",
        "--command=echo not json; echo oops >&2; exit 4",
      ]);
      if (
        !output.includes(
          "broken · failed: the response does not match the schema",
        )
      ) {
        throw new Error(output);
      }
      if (!output.includes("exit code: 4") || !output.includes("oops")) {
        throw new Error(output);
      }
      if (process.exitCode !== 3) throw new Error(`exit ${process.exitCode}`);
    });
  },
);
