/** A local review with extensions, through the real CLI and the fake AI:
 * results and findings in `--json`, the exit code from a verdict, tracking by
 * key across rounds, and the hard off switch. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  Command,
  envToObject,
  mkdirPath,
  readTextFile,
  removePath,
  runtimeExecPath,
  runtimeRunArgs,
  tempDir,
  writeTextFile,
} from "../testing/runtime.ts";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const posixOnly = { skip: process.platform === "win32" };

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await new Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}

/** Round 1 reports two keyed findings and requests changes. Round 2 reports
 * one of them again and one without a key, and only comments. */
const EXTENSION = `import { readFileSync, writeFileSync } from "node:fs";
const details = JSON.parse(readFileSync(process.argv[2], "utf8"));
writeFileSync(process.argv[3], JSON.stringify({ details, cwd: process.cwd(), review: readFileSync(details.reviewResultPath, "utf8") }));
const first = details.round === 1;
const findings = first
  ? [
      { key: "k1", severity: "P1", blocking: true, title: "Kept", body: "b", path: "src/a.ts", lineFrom: 1 },
      { key: "k2", severity: "P2", blocking: true, title: "Fixed later", body: "b" },
    ]
  : [
      { key: "k1", severity: "P1", blocking: true, title: "Kept", body: "b", path: "src/a.ts", lineFrom: 1 },
      { severity: "P3", blocking: false, title: "Untracked", body: "b" },
    ];
console.log(JSON.stringify({
  schemaVersion: 1, name: "probe", status: "ok",
  verdict: first ? "request_changes" : "comment",
  markdown: "**probe**", findings,
  data: { media: [], metrics: [{ name: "checks", value: 3 }] },
  extraData: { round: details.round },
  usage: { costUsd: 0.25 },
}));
`;

async function setup(root: string): Promise<{
  worktree: string;
  env: Record<string, string>;
  seen: string;
}> {
  const worktree = `${root}/worktree`;
  const configPath = `${root}/config.json`;
  const reposDir = `${root}/repos`;
  const repo = "acme/widgets";
  const seen = `${root}/seen.json`;
  await mkdirPath(`${reposDir}/${repo}`, { recursive: true });
  await writeTextFile(
    `${reposDir}/${repo}/PR_REVIEW_GUIDE.md`,
    "# Review guide\n\nPrefer early returns.\n",
  );
  await writeTextFile(`${root}/ext.mjs`, EXTENSION);
  await writeTextFile(
    configPath,
    JSON.stringify({
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
      extensions: [
        {
          name: "probe",
          command: `${process.execPath} ${root}/ext.mjs {{details_path}} ${seen}`,
          repos: "acme/*",
          parallelism: false,
          priority: 0,
          failFast: false,
          retryOnFailTimes: 0,
          maxRequestedRetries: 3,
          timeoutSeconds: 60,
        },
      ],
    }),
  );
  await mkdirPath(`${worktree}/src`, { recursive: true });
  await git(worktree, ["init"]);
  await git(worktree, ["config", "user.email", "t@t"]);
  await git(worktree, ["config", "user.name", "t"]);
  await writeTextFile(`${worktree}/src/a.ts`, "export const a = 0\n");
  await git(worktree, ["add", "src/a.ts"]);
  await git(worktree, ["commit", "-m", "init"]);
  await git(worktree, ["branch", "-M", "main"]);
  await git(worktree, [
    "remote",
    "add",
    "origin",
    `https://github.com/${repo}.git`,
  ]);
  await git(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeTextFile(`${worktree}/src/a.ts`, "export const a = 1\n");
  await git(worktree, ["commit", "-am", "change a"]);
  return {
    worktree,
    seen,
    env: {
      ...envToObject(),
      CM_CONFIG_PATH: configPath,
      CM_REPOS_DIR: reposDir,
      CM_FAKE_AI: "1",
      LOCALAPPDATA: `${root}/localappdata`,
      XDG_CACHE_HOME: `${root}/cache`,
      XDG_CONFIG_HOME: `${root}/config-home`,
      HOME: `${root}/home`,
    },
  };
}

async function review(
  worktree: string,
  env: Record<string, string>,
  extra: string[] = ["--json"],
): Promise<{ code: number; stdout: string }> {
  const result = await new Command(runtimeExecPath(), {
    args: runtimeRunArgs(join(projectRoot, "main.ts"), [
      "review",
      "--repo=acme/widgets",
      "--disable-codegraph",
      ...extra,
    ]),
    cwd: worktree,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
  };
}

type Finding = {
  extensionId: string | null;
  key?: string;
  state: string;
  title: string;
  blocking: boolean;
};

test(
  "a local review runs its extensions, joins their results and tracks keyed findings",
  posixOnly,
  async () => {
    const root = await tempDir({ prefix: "cm-ext-local-" });
    try {
      const { worktree, env, seen } = await setup(root);
      const first = await review(worktree, env);
      const body = JSON.parse(first.stdout);
      const extension = body.extensions?.[0];
      if (extension?.id !== "probe" || extension.status !== "ok") {
        throw new Error(first.stdout);
      }
      if (extension.markdown !== "")
        throw new Error("markdown without the flag");
      if (extension.extraData?.round !== 1) throw new Error(first.stdout);
      const fromExtension = (body.findings as Finding[]).filter(
        (f) => f.extensionId === "probe",
      );
      if (
        fromExtension.length !== 2 ||
        fromExtension.some((f) => f.state !== "new")
      ) {
        throw new Error(JSON.stringify(fromExtension));
      }
      if (
        (body.findings as Finding[]).some((f) => f.extensionId === undefined)
      ) {
        throw new Error("an AI finding has no extensionId");
      }
      if (first.code !== 1)
        throw new Error(`a request_changes verdict exited ${first.code}`);
      if (body.usage.extensionsCostUsd !== 0.25)
        throw new Error(JSON.stringify(body.usage));
      // The extension ran after the review, in the checkout, and was given it.
      const recorded = JSON.parse(await readTextFile(seen));
      if (
        recorded.details.reviewType !== "local" ||
        recorded.details.prNumber !== null
      ) {
        throw new Error(JSON.stringify(recorded.details));
      }
      if (recorded.details.workdir !== recorded.cwd)
        throw new Error("not run in workdir");
      if (!JSON.parse(recorded.review).findings)
        throw new Error("no review results");

      const second = JSON.parse(
        (
          await review(worktree, env, [
            "--json",
            "--include-extension-markdowns",
          ])
        ).stdout,
      );
      const states = new Map(
        (second.findings as Finding[])
          .filter((f) => f.extensionId === "probe")
          .map((f) => [f.title, f.state]),
      );
      if (
        states.get("Kept") !== "open" ||
        states.get("Fixed later") !== "closed" ||
        states.get("Untracked") !== "new"
      ) {
        throw new Error(JSON.stringify([...states]));
      }
      if (second.extensions[0].markdown !== "**probe**") {
        throw new Error("--include-extension-markdowns did not keep it");
      }

      const human = await review(worktree, env, []);
      if (!human.stdout.includes("Extensions\n  probe · comment"))
        throw new Error(human.stdout);
      if (!human.stdout.includes("Extensions: probe · Failed: none"))
        throw new Error(human.stdout);
    } finally {
      await removePath(root, { recursive: true });
    }
  },
);

test(
  "CM_EXTENSIONS_DISABLED=1 runs no extension in a review",
  posixOnly,
  async () => {
    const root = await tempDir({ prefix: "cm-ext-off-" });
    try {
      const { worktree, env, seen } = await setup(root);
      const result = await review(worktree, {
        ...env,
        CM_EXTENSIONS_DISABLED: "1",
      });
      const body = JSON.parse(result.stdout);
      if (body.extensions?.length !== 0) throw new Error(result.stdout);
      let ran = true;
      try {
        await readTextFile(seen);
      } catch {
        ran = false;
      }
      if (ran) throw new Error("the extension ran");
    } finally {
      await removePath(root, { recursive: true });
    }
  },
);
