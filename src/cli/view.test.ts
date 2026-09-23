/** `view` command tests (CORE-23, CORE-44).
 *
 * The local command is pure filesystem reads, so the tests write a
 * `CM_REPOS_DIR` fixture and assert on what `runView` prints. The git-remote
 * path is covered separately by the fact that `view owner/repo` never touches
 * git. `--remote` (CORE-44) is exercised against the fake TLS server, because
 * the point is that the same one-time token `review --remote` uses reaches the
 * guides endpoint. */
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runView } from "./commands/view.ts";
import {
  deleteEnv,
  envToObject,
  getEnv,
  makeTempDir,
  mkdir,
  remove,
  setEnv,
  writeTextFile,
} from "../util/runtime.ts";
import {
  Command,
  runtimeExecPath,
  runtimeRunArgs,
} from "../testing/runtime.ts";
import {
  bearerOf,
  startFakeRemote,
  writeCaCert,
} from "../testing/fake_remote.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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

test("view --list: file, size and date per row, in reading order", async () => {
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
      if (!/^SKILL\.md\s+8 B\s+\d{4}-\d{2}-\d{2}$/.test(lines[0]!)) {
        throw new Error(`first row: ${JSON.stringify(lines[0])}`);
      }
      if (
        !/^CODEBASE\.md\s+\d+(\.\d+)? B\s+\d{4}-\d{2}-\d{2}$/.test(lines[1]!)
      ) {
        throw new Error(`second row: ${JSON.stringify(lines[1])}`);
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

test("view: an unknown flag is refused", async () => {
  await withGuides({ "SKILL.md": "# Skill\n" }, async () => {
    const unknown = await capture(() => runView(["acme/widgets", "--nope"]));
    if (unknown.code !== 2)
      throw new Error(`unknown flag exit ${unknown.code}`);
  });
});

test("view --remote: an unconfigured host is a usage error with both setup hints", async () => {
  await withGuides({ "SKILL.md": "# Skill\n" }, async () => {
    const previous = getEnv("CM_CONFIG_PATH");
    const root = await makeTempDir({ prefix: "cm-view-remote-" });
    setEnv("CM_CONFIG_PATH", `${root}/config.json`);
    await writeTextFile(`${root}/config.json`, "{}\n");
    try {
      let error: { exitCode?: number; hint?: string } | undefined;
      await capture(async () => {
        try {
          await runView(["acme/widgets", "--remote"]);
        } catch (thrown) {
          error = thrown as typeof error;
          throw thrown;
        }
      });
      if (error?.exitCode !== 2) {
        throw new Error(`--remote exit ${error?.exitCode} (want 2)`);
      }
      if (
        !error.hint?.includes("config set remote-host") ||
        !error.hint?.includes("config set remote-token")
      ) {
        throw new Error(`hint: ${error?.hint}`);
      }
    } finally {
      if (previous === undefined) deleteEnv("CM_CONFIG_PATH");
      else setEnv("CM_CONFIG_PATH", previous);
      await remove(root, { recursive: true });
    }
  });
});

test("view --remote: the guide directory belongs to this machine", async () => {
  await withGuides({ "SKILL.md": "# Skill\n" }, async () => {
    const { code } = await capture(() =>
      runView(["acme/widgets", "--remote", "--path"]),
    );
    if (code !== 2) throw new Error(`exit ${code} (want 2)`);
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

/** Runs `view --remote` as a real child process against the fake TLS server,
 * with the host, token and CA in the environment only. */
async function runRemoteView(
  root: string,
  args: string[],
  host: string,
  token: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const ca = await writeCaCert(root);
  const configPath = `${root}/config.json`;
  await writeTextFile(
    configPath,
    `${JSON.stringify({
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      remoteHost: host,
      remoteToken: token,
    })}\n`,
  );
  const result = await new Command(runtimeExecPath(), {
    args: runtimeRunArgs(join(projectRoot, "main.ts"), ["view", ...args]),
    cwd: root,
    env: {
      ...envToObject(),
      CM_CONFIG_PATH: configPath,
      NODE_EXTRA_CA_CERTS: ca,
    },
    stdout: "piped",
    stderr: "piped",
    timeoutMs: 30_000,
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

const REMOTE_GUIDES = {
  repo: { fullName: "acme/widgets" },
  guideBuiltAt: "2026-09-15T10:00:00Z",
  guides: [
    {
      kind: "skill",
      file: "SKILL.md",
      size: 8,
      builtAt: "2026-09-15T10:00:00Z",
      content: "# Skill\n",
    },
    {
      kind: "review-guide",
      file: "PR_REVIEW_GUIDE.md",
      size: 8,
      builtAt: "2026-09-15T10:00:00Z",
      content: "# Guide\n",
    },
  ],
};

test("view --remote prints the server's guides with the shared token", async () => {
  const root = await makeTempDir({ prefix: "cm-view-remote-e2e-" });
  const remote = await startFakeRemote({ guides: REMOTE_GUIDES });
  try {
    const all = await runRemoteView(
      root,
      ["acme/widgets", "--remote"],
      remote.url,
      "cmr_saved",
    );
    if (all.code !== 0) {
      throw new Error(`exit ${all.code}: ${all.stderr}`);
    }
    // Same headers a local `view` prints.
    if (!all.stdout.includes("== SKILL.md · built 2026-09-15 ==")) {
      throw new Error(`skill header missing:\n${all.stdout}`);
    }
    if (!all.stdout.includes("== PR_REVIEW_GUIDE.md · built 2026-09-15 ==")) {
      throw new Error(`guide header missing:\n${all.stdout}`);
    }
    const request = remote.requests.find((item) =>
      item.path.startsWith("/api/remote/guides"),
    );
    if (!request) throw new Error("the guides endpoint was never called");
    if (bearerOf(request) !== "cmr_saved") {
      throw new Error(`bearer: ${bearerOf(request)}`);
    }
    if (!request.path.includes("repo=acme%2Fwidgets")) {
      throw new Error(`repo query: ${request.path}`);
    }

    // A single guide is raw, exactly as locally.
    const single = await runRemoteView(
      root,
      ["acme/widgets", "review-guide", "--remote"],
      remote.url,
      "cmr_saved",
    );
    if (single.code !== 0) throw new Error(`single exit ${single.code}`);
    if (single.stdout !== "# Guide\n") {
      throw new Error(`raw remote guide: ${JSON.stringify(single.stdout)}`);
    }
  } finally {
    await remove(root, { recursive: true });
    await remote.close();
  }
});

test("view --remote --list shows size and date from the server", async () => {
  const root = await makeTempDir({ prefix: "cm-view-remote-list-" });
  const remote = await startFakeRemote({ guides: REMOTE_GUIDES });
  try {
    const result = await runRemoteView(
      root,
      ["acme/widgets", "--list", "--remote"],
      remote.url,
      "cmr_saved",
    );
    if (result.code !== 0) throw new Error(`exit ${result.code}`);
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 2) throw new Error(`rows: ${result.stdout}`);
    if (!/^SKILL\.md\s+8 B\s+2026-09-15$/.test(lines[0]!)) {
      throw new Error(`first row: ${JSON.stringify(lines[0])}`);
    }
  } finally {
    await remove(root, { recursive: true });
    await remote.close();
  }
});

test("view --remote names a rejected token with the dashboard hint", async () => {
  const root = await makeTempDir({ prefix: "cm-view-remote-401-" });
  const refusing = await startFakeRemote({ refuse: 401 });
  try {
    const result = await runRemoteView(
      root,
      ["acme/widgets", "--remote"],
      refusing.url,
      "cmr_stale",
    );
    if (result.code !== 2) {
      throw new Error(`exit ${result.code}: ${result.stderr}`);
    }
    if (!result.stderr.includes("rejected the remote review token")) {
      throw new Error(`the rejection was not explained:\n${result.stderr}`);
    }
    if (!result.stderr.includes("Remote review tokens")) {
      throw new Error(`the dashboard hint is missing:\n${result.stderr}`);
    }
  } finally {
    await remove(root, { recursive: true });
    await refusing.close();
  }
});

test("view --remote with no guides on the server says so", async () => {
  const root = await makeTempDir({ prefix: "cm-view-remote-empty-" });
  const remote = await startFakeRemote({ guides: { guides: [] } });
  try {
    const result = await runRemoteView(
      root,
      ["acme/widgets", "--remote"],
      remote.url,
      "cmr_saved",
    );
    if (result.code !== 2) {
      throw new Error(`exit ${result.code}: ${result.stderr}`);
    }
    if (!result.stderr.includes("has no guides")) {
      throw new Error(`unexpected error:\n${result.stderr}`);
    }
  } finally {
    await remove(root, { recursive: true });
    await remote.close();
  }
});
