/** Companions on the remote wire: what a server accepts, the patch limit, and
 * the client against a fake server with and without the `companions`
 * feature. */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capCompanionPatches,
  companionsFromSubmit,
  validateCompanionsPayload,
} from "./companions.ts";
import { validateSubmitRequest } from "./validate.ts";
import {
  createLocalReviewSandbox,
  type LocalReviewSandbox,
} from "../testing/local_review_sandbox.ts";
import {
  startFakeRemote,
  writeCaCert,
  type FakeRemote,
} from "../testing/fake_remote.ts";
import {
  Command,
  mkdirPath,
  runtimeExecPath,
  writeTextFile,
} from "../testing/runtime.ts";
import { commandWithInput } from "../util/runtime.ts";
import type { RevisionFile } from "../review/revision.ts";

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

const FILE: RevisionFile = {
  path: "docs/api.md",
  previousPath: null,
  status: "modified",
  binary: false,
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-old\n+new",
};

const companion = (extra: Record<string, unknown> = {}) => ({
  repo: "owner/docs",
  branch: "feature/a",
  files: [FILE],
  private: true,
  ...extra,
});

test("a server accepts up to 5 companions with valid files, and refuses the rest", () => {
  must(validateCompanionsPayload(undefined) === null, "none");
  must(validateCompanionsPayload([companion()]) === null, "one");
  must(
    validateCompanionsPayload([companion({ files: [] })]) === null,
    "an empty one",
  );
  const cases: [unknown, string][] = [
    [{}, "companions: must be an array"],
    [
      Array.from({ length: 6 }, (_, i) => companion({ repo: `owner/r${i}` })),
      "companions: at most 5",
    ],
    [[companion({ repo: "nope" })], "companions[0].repo: must be owner/repo"],
    [
      [companion(), companion({ repo: "Owner/Docs" })],
      "companions[1].repo: given more than once",
    ],
    [
      [companion({ branch: "a\nb" })],
      "companions[0].branch: invalid characters",
    ],
    [
      [companion({ private: "yes" })],
      "companions[0].private: must be a boolean",
    ],
    [
      [companion({ files: [{ ...FILE, path: "../x" }] })],
      "companions[0].files[0].path: must stay inside the repository",
    ],
    [
      [
        companion({
          files: Array.from({ length: 1001 }, (_, i) => ({
            ...FILE,
            path: `f${i}.md`,
          })),
        }),
      ],
      "companions[0].files: at most 1000",
    ],
  ];
  for (const [value, want] of cases) {
    const got = validateCompanionsPayload(value);
    must(got === want, `${JSON.stringify(value).slice(0, 60)}: ${got}`);
  }
  const fixture = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "fixtures/v1/submit.request.json"),
      "utf8",
    ),
  );
  must(validateSubmitRequest(fixture) === null, "the old submit");
  must(
    validateSubmitRequest({ ...fixture, companions: [companion()] }) === null,
    "with companions",
  );
  must(
    validateSubmitRequest({ ...fixture, companions: "x" }) ===
      "companions: must be an array",
    "a bad one refuses the submit",
  );
});

test("a companion that says nothing about visibility is private", () => {
  const [read] = companionsFromSubmit([companion({ private: undefined })]);
  must(read!.private === true, "private");
  must(
    companionsFromSubmit([companion({ private: false })])[0]!.private === false,
    "public",
  );
  must(companionsFromSubmit("x").length === 0, "garbage reads as none");
});

test("over the patch limit the file lists stay and the patches go, with one warning", () => {
  const list = companionsFromSubmit([companion()]);
  const under = capCompanionPatches(list, 1000);
  must(under.warnings.length === 0, "under");
  must(under.companions[0]!.files[0]!.patch === FILE.patch, "kept");
  const over = capCompanionPatches(list, 5);
  must(over.companions[0]!.files.length === 1, "the list stays");
  must(over.companions[0]!.files[0]!.patch === "", "the patch goes");
  must(
    over.warnings.length === 1 &&
      over.warnings[0]!.code === "companion_list_cut",
    JSON.stringify(over.warnings),
  );
});

// ------------------------------------------------------------- the client

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await new Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}

/** A companion checkout next to the sandbox's worktree, one commit ahead of
 * its `origin/main`. */
async function docsCheckout(sandbox: LocalReviewSandbox): Promise<string> {
  const dir = `${sandbox.home}/docs`;
  await mkdirPath(dir, { recursive: true });
  await git(dir, ["init", "-q"]);
  await writeTextFile(`${dir}/README.md`, "# docs\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "first"]);
  await git(dir, ["branch", "-M", "main"]);
  await git(dir, ["remote", "add", "origin", "git@github.com:owner/docs.git"]);
  await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeTextFile(`${dir}/api.md`, "The session opens itself.\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "docs"]);
  return dir;
}

async function withRemote(
  features: string[] | undefined,
  fn: (
    remote: FakeRemote,
    run: (
      json: boolean,
    ) => Promise<{ code: number; stdout: string; stderr: string }>,
  ) => Promise<void>,
): Promise<void> {
  let made: LocalReviewSandbox | undefined;
  let started: FakeRemote | undefined;
  try {
    const sandbox = await createLocalReviewSandbox();
    made = sandbox;
    const remote = await startFakeRemote({
      repo: sandbox.repo,
      handshake: features === undefined ? {} : { features },
    });
    started = remote;
    const docs = await docsCheckout(sandbox);
    const ca = await writeCaCert(sandbox.home);
    await fn(remote, async (json) => {
      const result = await commandWithInput(
        runtimeExecPath(),
        {
          args: sandbox.reviewArgs([
            "--remote",
            `--remote-host=${remote.url}`,
            "--remote-token=cmr_inline",
            `--with=${docs}`,
            ...(json ? ["--json"] : []),
          ]),
          cwd: sandbox.worktree,
          env: {
            ...sandbox.env("http://127.0.0.1:1"),
            NODE_EXTRA_CA_CERTS: ca,
            // No GitHub is reachable: the visibility read fails at once,
            // and the companion counts as private.
            CM_GH_BIN: "false",
          },
        },
        "",
      );
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    });
  } finally {
    await started?.close();
    await made?.cleanup();
  }
}

type Submitted = { companions?: Record<string, unknown>[] };

const submitted = (remote: FakeRemote) =>
  remote.requests.find((r) => r.path === "/api/remote/reviews")?.body as
    | Submitted
    | undefined;

test("a server with the companions feature is sent each companion, and the result names it", async () => {
  await withRemote(["intent", "companions"], async (remote, run) => {
    const result = await run(true);
    must(result.code === 0, `${result.stdout}\n${result.stderr}`);
    const sent = submitted(remote)?.companions ?? [];
    must(sent.length === 1, JSON.stringify(submitted(remote)));
    must(
      sent[0]!.repo === "owner/docs" &&
        sent[0]!.branch === "main" &&
        sent[0]!.private === true &&
        JSON.stringify(
          (sent[0]!.files as RevisionFile[]).map((f) => f.path),
        ) === '["api.md"]',
      JSON.stringify(sent[0]),
    );
    const body = JSON.parse(result.stdout);
    must(
      JSON.stringify(body.companions) ===
        JSON.stringify([
          {
            repo: "owner/docs",
            branch: "main",
            source: "flag",
            pr: null,
            files: 1,
            status: "read",
          },
        ]),
      JSON.stringify(body.companions),
    );
    must(body.warnings === undefined, JSON.stringify(body.warnings));
    const human = await run(false);
    must(
      human.stdout.includes("\nCompanions: owner/docs@main (1 file)\n"),
      human.stdout,
    );
  });
});

test("an older server is not sent companions, and the run warns and still reviews", async () => {
  for (const features of [undefined, ["intent", "client-tools"]]) {
    await withRemote(features, async (remote, run) => {
      const result = await run(true);
      must(result.code === 0, `${result.stdout}\n${result.stderr}`);
      must(submitted(remote)?.companions === undefined, "sent companions");
      must(
        !JSON.stringify(remote.requests).includes("owner/docs"),
        "a companion reached an older server",
      );
      const body = JSON.parse(result.stdout);
      must(!("companions" in body), JSON.stringify(body.companions));
      must(
        JSON.stringify(body.warnings.map((w: { code: string }) => w.code)) ===
          '["companions_unsupported"]',
        JSON.stringify(body.warnings),
      );
    });
  }
});
