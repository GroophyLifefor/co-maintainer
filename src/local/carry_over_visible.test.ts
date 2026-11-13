/** A fix is judged after a run that did not show its file.
 *
 * A local review leaves unchanged files out of what the model sees. If the
 * saved set of seen paths held only what the model saw, a file left out once
 * was "unverifiable" on the next run and its finding stayed open for good, even
 * after the fix. Four runs on one branch: two findings, the same tree again,
 * a fix to the first file, a fix to the second.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  Command,
  envToObject,
  mkdirPath,
  removePath,
  runtimeExecPath,
  runtimeRunArgs,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function finding(path: string, title: string) {
  return {
    severity: "P2",
    blocking: false,
    path,
    lineFrom: 2,
    lineTo: 2,
    title,
    body: `${title}. The value is never validated before it is used.`,
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await new Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

const body = (name: string, fixed: boolean) =>
  `const ${name} = ${fixed ? "validate(read())" : "read()"}\nuse(${name}.value)\ndone()\n`;

type Row = { path: string | null; state: string };

test("a fix is judged after a run that did not show its file", async () => {
  const root = await tempDir({ prefix: "cm-visible-" });
  // What the next run's model should close: it only does so for a VERIFY entry
  // whose file is not marked unchanged, as a real model would.
  let fixed: string[] = [];
  let run = 1;
  const server = await startFakeOpenRouter("success", {
    chatContent: (prompt) => {
      if (run === 1) {
        return JSON.stringify({
          findings: [
            finding("src/a.ts", "The first value is not validated"),
            finding("src/b.ts", "The second value is not validated"),
          ],
        });
      }
      const verdicts = [
        ...prompt.matchAll(/^(F\d+) · ([^\n]*?) · (\S+?):\d+/gm),
      ].map((m) => ({
        id: m[1]!,
        state:
          !m[2]!.startsWith("file unchanged") && fixed.includes(m[3]!)
            ? "closed"
            : "open",
      }));
      return JSON.stringify({ findings: [], previousFindings: verdicts });
    },
  });
  try {
    const worktree = `${root}/worktree`;
    const configPath = `${root}/config.json`;
    const reposDir = `${root}/repos`;
    const repo = "e2e-visible/carry";
    await mkdirPath(`${reposDir}/${repo}`, { recursive: true });
    await writeTextFile(
      `${reposDir}/${repo}/PR_REVIEW_GUIDE.md`,
      "# Review guide\n\nValidate values.\n",
    );
    await writeTextFile(
      configPath,
      `${JSON.stringify({
        auth: "gh",
        ai: "openrouter",
        token: "fake-key",
        lowModel: "fake/model",
        highModel: "fake/model",
      })}\n`,
    );
    await mkdirPath(`${worktree}/src`, { recursive: true });
    await git(worktree, ["init"]);
    await git(worktree, ["config", "user.email", "t@t"]);
    await git(worktree, ["config", "user.name", "t"]);
    await writeTextFile(`${worktree}/README.md`, "# readme\n");
    await git(worktree, ["add", "README.md"]);
    await git(worktree, ["commit", "-m", "init"]);
    await git(worktree, ["branch", "-M", "main"]);
    await git(worktree, [
      "remote",
      "add",
      "origin",
      `https://github.com/${repo}.git`,
    ]);
    await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await writeTextFile(`${worktree}/src/a.ts`, body("a", false));
    await writeTextFile(`${worktree}/src/b.ts`, body("b", false));
    await git(worktree, ["add", "src"]);
    await git(worktree, ["commit", "-m", "add a and b"]);

    const review = async (): Promise<Row[]> => {
      const result = await new Command(runtimeExecPath(), {
        args: runtimeRunArgs(join(projectRoot, "main.ts"), [
          "review",
          "--json",
          `--repo=${repo}`,
          "--disable-codegraph",
        ]),
        cwd: worktree,
        env: {
          ...envToObject(),
          CM_CONFIG_PATH: configPath,
          CM_REPOS_DIR: reposDir,
          CM_OPENROUTER_URL: server.url,
          LOCALAPPDATA: `${root}/localappdata`,
          XDG_CACHE_HOME: `${root}/cache`,
          CM_FAKE_AI: undefined,
          CM_FAKE_REVIEW_FILE: undefined,
        },
        stdout: "piped",
        stderr: "piped",
        timeoutMs: 60_000,
      }).output();
      const stdout = new TextDecoder().decode(result.stdout);
      try {
        return (JSON.parse(stdout) as { findings: Row[] }).findings;
      } catch {
        throw new Error(
          `no JSON:\n${stdout}${new TextDecoder().decode(result.stderr)}`,
        );
      }
    };
    const states = (rows: Row[]) =>
      Object.fromEntries(rows.map((row) => [row.path, row.state]));

    const r1 = states(await review());
    if (r1["src/a.ts"] !== "new" || r1["src/b.ts"] !== "new") {
      throw new Error(`run 1: ${JSON.stringify(r1)}`);
    }

    // The same tree again: nothing is shown to the model.
    run = 2;
    const r2 = states(await review());
    if (r2["src/a.ts"] !== "open" || r2["src/b.ts"] !== "open") {
      throw new Error(`run 2: ${JSON.stringify(r2)}`);
    }

    // The author fixes a.ts.
    run = 3;
    fixed = ["src/a.ts"];
    await writeTextFile(`${worktree}/src/a.ts`, body("a", true));
    await git(worktree, ["commit", "-am", "fix a"]);
    const r3 = states(await review());
    if (r3["src/a.ts"] !== "closed" || r3["src/b.ts"] !== "open") {
      throw new Error(`run 3: ${JSON.stringify(r3)}`);
    }

    // The author fixes b.ts. a.ts is unchanged and already closed.
    run = 4;
    fixed = ["src/b.ts"];
    await writeTextFile(`${worktree}/src/b.ts`, body("b", true));
    await git(worktree, ["commit", "-am", "fix b"]);
    const r4 = states(await review());
    if (r4["src/b.ts"] !== "closed") {
      throw new Error(`run 4: ${JSON.stringify(r4)}`);
    }
    if (Object.values(r4).includes("open")) {
      throw new Error(`run 4 left a finding open: ${JSON.stringify(r4)}`);
    }
  } finally {
    await server.close();
    await removePath(root, { recursive: true });
  }
});
