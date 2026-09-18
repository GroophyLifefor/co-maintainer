import {
  binaryPath,
  CODEGRAPH_VERSION,
  type CommandResult,
  detect,
  ensureCodegraph,
  installCommand,
  parseVersion,
  versionDir,
} from "./codegraph.ts";
import {
  mkdirPath,
  mkdirPathSync,
  removePath,
  tempDir,
  writeTextFile,
  writeTextFileSync,
} from "../testing/runtime.ts";
import { test } from "node:test";

const ROOT = "/tmp/cm-tools";

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

function ok(code = 0, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

test("parseVersion tolerates decoration around the number", () => {
  same(parseVersion("1.6.0"), "1.6.0", "bare");
  same(parseVersion("v1.6.0\n"), "1.6.0", "v prefix");
  same(parseVersion("codegraph 1.6.0 (abc123) windows"), "1.6.0", "decorated");
  same(parseVersion("2.0.0-beta.1"), "2.0.0-beta.1", "prerelease");
  same(parseVersion("no version here"), undefined, "absent");
});

test("each version gets its own directory", () => {
  same(versionDir("1.6.0", ROOT), `${ROOT}/codegraph/1.6.0`, "pinned");
  same(versionDir("1.7.0", ROOT), `${ROOT}/codegraph/1.7.0`, "next");
  if (versionDir("1.6.0", ROOT) === versionDir("1.7.0", ROOT)) {
    throw new Error("an upgrade would overwrite the working install");
  }
});

test("install targets the version directory, never the global prefix", () => {
  const { command, args } = installCommand("1.6.0", ROOT);
  same(command, "npm", "command");
  if (args.includes("-g") || args.includes("--global")) {
    throw new Error("must not install globally");
  }
  if (!args.includes("--prefix")) throw new Error("expected --prefix");
  same(
    args[args.indexOf("--prefix") + 1],
    `${ROOT}/codegraph/1.6.0`,
    "prefix target",
  );
  if (!args[1].endsWith("@1.6.0")) throw new Error("expected a pinned spec");
});

test("detect reports missing when the binary is not there", async () => {
  const present = await detect(CODEGRAPH_VERSION, "/tmp/cm-absent", () =>
    Promise.resolve(ok(0, CODEGRAPH_VERSION)),
  );
  same(present.state, "missing", "state");
});

test("ensureCodegraph returns the path when the pinned version is present", async () => {
  const dir = await tempDir();
  const path = binaryPath(CODEGRAPH_VERSION, dir);
  await mkdirPath(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeTextFile(path, "");
  let installs = 0;
  const found = await ensureCodegraph({
    root: dir,
    interactive: false,
    log: () => {},
    run: (command, args) => {
      if (args.includes("--version")) {
        return Promise.resolve(ok(0, CODEGRAPH_VERSION));
      }
      if (command === "npm") installs++;
      return Promise.resolve(ok());
    },
  });
  same(found, path, "path");
  same(installs, 0, "install count");
  await removePath(dir, { recursive: true });
});

test("ensureCodegraph installs after the prompt is accepted", async () => {
  const dir = await tempDir();
  const path = binaryPath(CODEGRAPH_VERSION, dir);
  let installs = 0;
  let asked = 0;
  const found = await ensureCodegraph({
    root: dir,
    interactive: true,
    log: () => {},
    confirm: () => {
      asked++;
      return true;
    },
    run: (command, args) => {
      if (args.includes("--version")) {
        return Promise.resolve(
          installs > 0 ? ok(0, CODEGRAPH_VERSION) : ok(1, "", "not found"),
        );
      }
      if (command === "npm") {
        installs++;
        mkdirPathSync(path.slice(0, path.lastIndexOf("/")), {
          recursive: true,
        });
        writeTextFileSync(path, "");
      }
      return Promise.resolve(ok());
    },
  });
  same([asked, installs, found], [1, 1, path], "prompted install");
  await removePath(dir, { recursive: true });
});
