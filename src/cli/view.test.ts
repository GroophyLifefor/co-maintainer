/** `view` command tests (CORE-23).
 *
 * The command is pure filesystem reads, so the tests write a `CM_REPOS_DIR`
 * fixture and assert on what `runView` prints. The git-remote path is covered
 * separately by the fact that `view owner/repo` never touches git. */
import { test } from "node:test";
import { runView } from "./commands/view.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  mkdir,
  remove,
  setEnv,
  writeTextFile,
} from "../util/runtime.ts";

/** Writes `files` under a fresh `CM_REPOS_DIR/acme/widgets` and runs `fn`
 * with `CM_REPOS_DIR` pointed at it. Files are removed afterwards. */
async function withGuides<T>(
  files: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const root = await makeTempDir({ prefix: "cm-view-" });
  const previous = getEnv("CM_REPOS_DIR");
  setEnv("CM_REPOS_DIR", root);
  const dir = `${root}/acme/widgets`;
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeTextFile(`${dir}/${name}`, body);
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", previous);
    await remove(root, { recursive: true });
  }
}

/** Captures stdout while `fn` runs and reports the exit code of a thrown
 * `CliError`. */
async function capture(
  fn: () => Promise<void>,
): Promise<{ code: number; stdout: string }> {
  const sink: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    sink.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stdout.write;
  console.log = (...parts: unknown[]) => void sink.push(`${parts.join(" ")}\n`);
  let code = 0;
  try {
    await fn();
  } catch (thrown) {
    code = (thrown as { exitCode?: number }).exitCode ?? 3;
  } finally {
    process.stdout.write = write;
    console.log = log;
  }
  return { code, stdout: sink.join("") };
}

test("view: a single guide prints raw, with no header", async () => {
  await withGuides(
    {
      "SKILL.md": "# Skill\n\nBuild with `npm test`.\n",
      "CODEBASE.md": "# Codebase\n",
    },
    async () => {
      const { code, stdout } = await capture(() =>
        runView(["acme/widgets", "skill"]),
      );
      if (code !== 0) throw new Error(`exit ${code}`);
      if (stdout !== "# Skill\n\nBuild with `npm test`.\n") {
        throw new Error(`raw output: ${JSON.stringify(stdout)}`);
      }
    },
  );
});

test("view: a guide file name and a bare stem both resolve", async () => {
  await withGuides({ "PR_REVIEW_GUIDE.md": "# Guide\n" }, async () => {
    for (const name of [
      "PR_REVIEW_GUIDE.md",
      "PR_REVIEW_GUIDE",
      "review-guide",
    ]) {
      const { code, stdout } = await capture(() =>
        runView(["acme/widgets", name]),
      );
      if (code !== 0) throw new Error(`${name} exit ${code}`);
      if (stdout !== "# Guide\n") {
        throw new Error(`${name}: ${JSON.stringify(stdout)}`);
      }
    }
  });
});

test("view: every guide prints behind a header with its file and build date", async () => {
  await withGuides(
    {
      "SKILL.md": "# Skill\n",
      "CODEBASE.md": "# Codebase\n",
      "PR_REVIEW_GUIDE.md": "# Guide\n",
    },
    async () => {
      const { code, stdout } = await capture(() => runView(["acme/widgets"]));
      if (code !== 0) throw new Error(`exit ${code}`);
      // The order is skill, codebase, review guide — the reading order.
      const skill = stdout.indexOf("== SKILL.md · built ");
      const codebase = stdout.indexOf("== CODEBASE.md · built ");
      const guide = stdout.indexOf("== PR_REVIEW_GUIDE.md · built ");
      if (skill < 0 || codebase < 0 || guide < 0) {
        throw new Error(`missing a header: ${JSON.stringify(stdout)}`);
      }
      if (!(skill < codebase && codebase < guide)) {
        throw new Error(`headers out of order: ${JSON.stringify(stdout)}`);
      }
    },
  );
});

test("view: the detailed guide is absent from a repo that never generated it", async () => {
  await withGuides({ "SKILL.md": "# Skill\n" }, async () => {
    const { code, stdout } = await capture(() => runView(["acme/widgets"]));
    if (code !== 0) throw new Error(`exit ${code}`);
    if (stdout.includes("DETAILED")) {
      throw new Error(`a missing guide was printed: ${JSON.stringify(stdout)}`);
    }
  });
});

test("view --list: file, size and date per row", async () => {
  await withGuides(
    { "SKILL.md": "# Skill\n", "CODEBASE.md": "# Codebase\n" },
    async () => {
      const { code, stdout } = await capture(() =>
        runView(["acme/widgets", "--list"]),
      );
      if (code !== 0) throw new Error(`exit ${code}`);
      const lines = stdout.trim().split("\n");
      if (lines.length !== 2)
        throw new Error(`rows: ${JSON.stringify(stdout)}`);
      if (
        !/^CODEBASE\.md\s+\d+(\.\d+)? B\s+\d{4}-\d{2}-\d{2}$/.test(lines[0]!)
      ) {
        throw new Error(`first row: ${JSON.stringify(lines[0])}`);
      }
      if (!lines.some((line) => line.startsWith("SKILL.md"))) {
        throw new Error(`SKILL.md row missing: ${JSON.stringify(stdout)}`);
      }
    },
  );
});

test("view --path: prints the guide directory", async () => {
  await withGuides({ "SKILL.md": "# Skill\n" }, async () => {
    const { code, stdout } = await capture(() =>
      runView(["acme/widgets", "--path"]),
    );
    if (code !== 0) throw new Error(`exit ${code}`);
    if (!stdout.trim().endsWith("acme/widgets")) {
      throw new Error(`path: ${JSON.stringify(stdout)}`);
    }
  });
});

test("view: a repo with no guides is a usage error with a probe hint", async () => {
  await withGuides({}, async () => {
    const { code } = await capture(() => runView(["acme/widgets"]));
    if (code !== 2) throw new Error(`exit ${code} (want 2)`);
    const list = await capture(() => runView(["acme/widgets", "--list"]));
    if (list.code !== 2) throw new Error(`--list exit ${list.code} (want 2)`);
  });
});

test("view: an unknown flag is refused, and --remote says it is not ready", async () => {
  await withGuides({ "SKILL.md": "# Skill\n" }, async () => {
    const unknown = await capture(() => runView(["acme/widgets", "--nope"]));
    if (unknown.code !== 2)
      throw new Error(`unknown flag exit ${unknown.code}`);
    const remote = await capture(() => runView(["acme/widgets", "--remote"]));
    if (remote.code !== 2) throw new Error(`--remote exit ${remote.code}`);
  });
});

test("view: an unknown guide name lists the accepted names", async () => {
  await withGuides({ "SKILL.md": "# Skill\n" }, async () => {
    const { code } = await capture(() => runView(["acme/widgets", "nope"]));
    if (code !== 2) throw new Error(`exit ${code} (want 2)`);
  });
});

test("view: a known guide that this repo lacks is its own error", async () => {
  await withGuides({ "SKILL.md": "# Skill\n" }, async () => {
    const { code } = await capture(() =>
      runView(["acme/widgets", "detailed-guide"]),
    );
    if (code !== 2) throw new Error(`exit ${code} (want 2)`);
  });
});
