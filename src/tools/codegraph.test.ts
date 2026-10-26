import {
  binaryPath,
  canPrompt,
  CODEGRAPH_VERSION,
  codegraphVersion,
  type CommandResult,
  detect,
  ensureCodegraph,
  ensureCodegraphForReview,
  installCommand,
  installPrompt,
  isCodegraphVersion,
  parseVersion,
  skippedNotice,
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

test("canPrompt needs both streams on a TTY and no CI", () => {
  const tty = { stdin: { isTTY: true }, stdout: { isTTY: true } };
  // The regression that caused the hang: a closed stdin is not a TTY, so no prompt.
  same(
    canPrompt({ ...tty, stdin: { isTTY: false } }, {}),
    false,
    "no stdin tty",
  );
  same(canPrompt(tty, { CI: "1" }), false, "CI set");
  same(canPrompt(tty, { CI: "" }), true, "empty CI is unset");
  // A piped stdout would print the question where nobody reads it.
  same(
    canPrompt({ ...tty, stdout: { isTTY: false } }, {}),
    false,
    "no stdout tty",
  );
  same(canPrompt(tty, {}), true, "interactive terminal");
});

test("skippedNotice names both flags so a CI log explains itself", () => {
  const notice = skippedNotice();
  if (!notice.includes("reviewing without it")) {
    throw new Error(notice);
  }
  if (!notice.includes("--allow-tool-install")) throw new Error(notice);
  if (!notice.includes("--disable-codegraph")) throw new Error(notice);
});

test("installPrompt says what, where from, what for, and how big", () => {
  const prompt = installPrompt("1.6.0", ROOT);
  if (!prompt.includes("@colbymchenry/codegraph")) {
    throw new Error(`package missing: ${prompt}`);
  }
  if (!prompt.includes("1.6.0")) throw new Error(`version missing: ${prompt}`);
  if (!prompt.includes("npm")) throw new Error(`source missing: ${prompt}`);
  if (!prompt.includes("MB")) throw new Error(`size missing: ${prompt}`);
  if (!prompt.includes("calls between files")) {
    throw new Error(`purpose missing: ${prompt}`);
  }
  if (!prompt.includes(`${ROOT}/codegraph/1.6.0`)) {
    throw new Error(`target directory missing: ${prompt}`);
  }
});

test("ensureCodegraph returns the path when the pinned version is present", async () => {
  const dir = await tempDir();
  const path = binaryPath(CODEGRAPH_VERSION, dir);
  await mkdirPath(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeTextFile(path, "");
  let installs = 0;
  const found = await ensureCodegraph({
    root: dir,
    version: CODEGRAPH_VERSION,
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
    version: CODEGRAPH_VERSION,
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

test("ensureCodegraphForReview declines when the async prompt says no", async () => {
  const dir = await tempDir();
  let installs = 0;
  const found = await ensureCodegraphForReview({
    root: dir,
    version: CODEGRAPH_VERSION,
    interactive: true,
    log: () => {},
    // The real `defaultConfirm` is async (`node:readline/promises`), so this
    // mirrors production instead of returning a bare boolean.
    confirm: async () => false,
    run: (command) => {
      if (command === "npm") installs++;
      return Promise.resolve(ok());
    },
  });
  same(installs, 0, "installs after decline");
  same(found, { reason: "codegraph install declined" }, "decline result");
  await removePath(dir, { recursive: true });
});

test("ensureCodegraph does not install when the async prompt says no", async () => {
  const dir = await tempDir();
  let installs = 0;
  let exitCode: number | undefined;
  await ensureCodegraph({
    root: dir,
    version: CODEGRAPH_VERSION,
    interactive: true,
    log: () => {},
    confirm: async () => false,
    exit: (code) => {
      exitCode = code;
      // `process.exit` never returns; stand in for that without killing the
      // test runner.
      throw new Error(`exit ${code}`);
    },
    run: (command) => {
      if (command === "npm") installs++;
      return Promise.resolve(ok());
    },
  }).catch(() => {});
  same([installs, exitCode], [0, 1], "declined install");
  await removePath(dir, { recursive: true });
});

test("ensureCodegraph installs when the async prompt says yes", async () => {
  const dir = await tempDir();
  const path = binaryPath(CODEGRAPH_VERSION, dir);
  let installs = 0;
  const found = await ensureCodegraph({
    root: dir,
    version: CODEGRAPH_VERSION,
    interactive: true,
    log: () => {},
    confirm: async () => true,
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
  same(installs, 1, "accepted install");
  same(found, path, "path");
  await removePath(dir, { recursive: true });
});

test("isCodegraphVersion accepts semver and refuses paths and flags", () => {
  same(isCodegraphVersion("1.6.0"), true, "bare");
  same(isCodegraphVersion("1.7.0-beta.1"), true, "prerelease");
  same(isCodegraphVersion("1.6.0-"), false, "empty prerelease");
  same(isCodegraphVersion("1.6.0-."), false, "dangling prerelease separator");
  same(
    isCodegraphVersion("v1.6.0"),
    false,
    "leading v is normalized elsewhere",
  );
  same(isCodegraphVersion("../../etc/passwd"), false, "path traversal");
  same(isCodegraphVersion("--prefix"), false, "flag like");
  same(isCodegraphVersion(""), false, "empty");
});

test("codegraphVersion prefers env, then config, then the built-in pin", () => {
  const config = () => ({ codegraphVersion: "1.7.0" });
  same(
    codegraphVersion(
      (name) => (name === "CM_CODEGRAPH_VERSION" ? "1.8.0" : undefined),
      config,
    ),
    "1.8.0",
    "env wins",
  );
  same(
    codegraphVersion(() => undefined, config),
    "1.7.0",
    "config next",
  );
  same(
    codegraphVersion(
      () => undefined,
      () => ({}),
    ),
    CODEGRAPH_VERSION,
    "built-in last",
  );
});

test("codegraphVersion skips a layer that is not a plain semver", () => {
  same(
    codegraphVersion(
      (name) => (name === "CM_CODEGRAPH_VERSION" ? "../../etc" : undefined),
      () => ({ codegraphVersion: "1.7.0" }),
    ),
    "1.7.0",
    "bad env falls through to config",
  );
  same(
    codegraphVersion(
      () => undefined,
      () => ({ codegraphVersion: "not-a-version" }),
    ),
    CODEGRAPH_VERSION,
    "bad config falls through to the built-in",
  );
  same(
    codegraphVersion(
      (name) => (name === "CM_CODEGRAPH_VERSION" ? "v1.9.0" : undefined),
      () => ({}),
    ),
    "1.9.0",
    "a leading v is dropped",
  );
});

test("ensureCodegraphForReview installs without prompting when allowInstall is set", async () => {
  const dir = await tempDir();
  const path = binaryPath(CODEGRAPH_VERSION, dir);
  let installs = 0;
  let asked = 0;
  const found = await ensureCodegraphForReview({
    root: dir,
    version: CODEGRAPH_VERSION,
    allowInstall: true,
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
  same([asked, installs, found], [0, 1, { path }], "installs without a prompt");
  await removePath(dir, { recursive: true });
});

test("ensureCodegraphForReview installs the version the config names", async () => {
  const dir = await tempDir();
  const path = binaryPath("1.7.0", dir);
  const specs: string[] = [];
  const found = await ensureCodegraphForReview({
    root: dir,
    version: "1.7.0",
    allowInstall: true,
    interactive: false,
    log: () => {},
    run: (command, args) => {
      if (args.includes("--version")) {
        return Promise.resolve(
          specs.length > 0 ? ok(0, "1.7.0") : ok(1, "", "not found"),
        );
      }
      if (command === "npm") {
        specs.push(args.find((arg) => arg.includes("codegraph@")) ?? "");
        mkdirPathSync(path.slice(0, path.lastIndexOf("/")), {
          recursive: true,
        });
        writeTextFileSync(path, "");
      }
      return Promise.resolve(ok());
    },
  });
  same(specs, ["@colbymchenry/codegraph@1.7.0"], "pinned spec");
  same(found, { path }, "resolved path");
  await removePath(dir, { recursive: true });
});
