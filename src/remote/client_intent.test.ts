/** `review --remote --intent-file` through the real CLI against a fake remote
 * server over TLS: the text travels as the revision's description, a server
 * that predates intent is never sent it, and the result says what happened. */
import { test } from "node:test";
import {
  createLocalReviewSandbox,
  type LocalReviewSandbox,
} from "../testing/local_review_sandbox.ts";
import {
  startFakeRemote,
  writeCaCert,
  type FakeRemote,
} from "../testing/fake_remote.ts";
import { runtimeExecPath, writeTextFile } from "../testing/runtime.ts";
import { commandWithInput } from "../util/runtime.ts";

const INTENT = "Fix rounding for JPY totals, amounts have no decimals.";

type Run = { code: number; stdout: string; stderr: string };

async function withRemote(
  options: { features?: string[]; sync?: unknown[] },
  fn: (ctx: {
    sandbox: LocalReviewSandbox;
    remote: FakeRemote;
    run: (
      extra: string[],
      options?: { json?: boolean; stdin?: string },
    ) => Promise<Run>;
  }) => Promise<void>,
): Promise<void> {
  const sandbox = await createLocalReviewSandbox();
  const remote = await startFakeRemote({
    repo: sandbox.repo,
    sync: options.sync,
    handshake:
      options.features === undefined ? {} : { features: options.features },
  });
  try {
    const ca = await writeCaCert(sandbox.home);
    await fn({
      sandbox,
      remote,
      run: async (extra, runOptions = {}) => {
        const result = await commandWithInput(
          runtimeExecPath(),
          {
            args: sandbox.reviewArgs([
              "--remote",
              `--remote-host=${remote.url}`,
              "--remote-token=cmr_inline",
              ...(runOptions.json === false ? [] : ["--json"]),
              ...extra,
            ]),
            cwd: sandbox.worktree,
            env: {
              ...sandbox.env("http://127.0.0.1:1"),
              NODE_EXTRA_CA_CERTS: ca,
            },
          },
          runOptions.stdin ?? "",
        );
        return {
          code: result.code,
          stdout: new TextDecoder().decode(result.stdout),
          stderr: new TextDecoder().decode(result.stderr),
        };
      },
    });
  } finally {
    await remote.close();
    await sandbox.cleanup();
  }
}

type Submitted = { revision: { description: unknown } };

function submitted(remote: FakeRemote): Submitted | undefined {
  return remote.requests.find((r) => r.path === "/api/remote/reviews")?.body as
    | Submitted
    | undefined;
}

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

test("a server that lists intent gets the text as the revision's description", async () => {
  await withRemote({ features: ["byok", "push", "intent"] }, async (ctx) => {
    await writeTextFile(`${ctx.sandbox.home}/task.md`, `\n${INTENT}\n`);
    const result = await ctx.run([`--intent-file=${ctx.sandbox.home}/task.md`]);
    must(result.code === 0, `${result.stdout}\n${result.stderr}`);
    must(submitted(ctx.remote)?.revision.description === INTENT, "description");
    const body = JSON.parse(result.stdout);
    must(
      JSON.stringify(body.subject.intent) ===
        JSON.stringify({ source: "file", chars: INTENT.length }),
      JSON.stringify(body.subject),
    );
    must(
      !body.warnings,
      `a supported intent warned: ${JSON.stringify(body.warnings)}`,
    );
    for (const out of [result.stdout, result.stderr]) {
      must(!out.includes(INTENT), "the intent text was printed");
    }
  });
});

test("a result from a server cannot change what the client says about the intent", async () => {
  await withRemote(
    {
      features: ["intent"],
      sync: [
        {
          schemaVersion: 1,
          status: "done",
          logs: [],
          result: {
            findings: [],
            summary: {},
            subject: { repo: "x/y", intent: { source: "stdin", chars: 1 } },
          },
          abort: null,
        },
      ],
    },
    async (ctx) => {
      const result = await ctx.run([], { json: true });
      must(result.code === 0, `${result.stdout}\n${result.stderr}`);
      const body = JSON.parse(result.stdout);
      must(body.subject.intent === null, JSON.stringify(body.subject));
      must(body.subject.repo === "x/y", "the rest of the subject is kept");
    },
  );
});

test("standard input works with a remote review, and the human output says it was given", async () => {
  await withRemote({ features: ["intent"] }, async (ctx) => {
    const result = await ctx.run(["--intent-file=-"], {
      json: false,
      stdin: `${INTENT}\n`,
    });
    must(result.code === 0, `${result.stdout}\n${result.stderr}`);
    must(submitted(ctx.remote)?.revision.description === INTENT, "description");
    must(result.stdout.includes("\nIntent file: provided\n"), result.stdout);
    must(!result.stdout.includes(INTENT), "the intent text was printed");
  });
});

test("an older server is not sent the text, and the run warns and still reviews", async () => {
  for (const features of [undefined, ["byok", "push"]]) {
    await withRemote({ features }, async (ctx) => {
      await writeTextFile(`${ctx.sandbox.home}/task.md`, INTENT);
      const file = `--intent-file=${ctx.sandbox.home}/task.md`;
      const result = await ctx.run([file]);
      must(result.code === 0, `${result.stdout}\n${result.stderr}`);
      must(submitted(ctx.remote)?.revision.description === "", "sent the text");
      must(
        !JSON.stringify(ctx.remote.requests).includes(INTENT),
        "the text reached an older server",
      );
      const body = JSON.parse(result.stdout);
      must(body.ok === true, "the review did not run");
      must(body.subject.intent === null, JSON.stringify(body.subject));
      const codes = body.warnings.map((w: { code: string }) => w.code);
      must(
        JSON.stringify(codes) === JSON.stringify(["intent_unsupported"]),
        JSON.stringify(codes),
      );

      const human = await ctx.run([file], { json: false });
      must(human.code === 0, human.stderr);
      must(!human.stdout.includes("Intent file"), "claimed an intent");
      must(human.stdout.includes("does not support an intent"), human.stdout);
    });
  }
});

test("without the flag the description stays empty and nothing is added to the result", async () => {
  await withRemote({ features: ["intent"] }, async (ctx) => {
    const result = await ctx.run([]);
    must(result.code === 0, `${result.stdout}\n${result.stderr}`);
    must(submitted(ctx.remote)?.revision.description === "", "description");
    const body = JSON.parse(result.stdout);
    must(body.subject.intent === null, "intent");
    must(body.warnings === undefined, "warnings");
  });
});

test("an empty file sends nothing and warns once", async () => {
  await withRemote({ features: ["intent"] }, async (ctx) => {
    await writeTextFile(`${ctx.sandbox.home}/empty.md`, "\n");
    const result = await ctx.run([
      `--intent-file=${ctx.sandbox.home}/empty.md`,
    ]);
    must(result.code === 0, `${result.stdout}\n${result.stderr}`);
    must(submitted(ctx.remote)?.revision.description === "", "description");
    const body = JSON.parse(result.stdout);
    must(body.subject.intent === null, "intent");
    must(
      JSON.stringify(body.warnings.map((w: { code: string }) => w.code)) ===
        JSON.stringify(["intent_empty"]),
      JSON.stringify(body.warnings),
    );
  });
});

test("a text over the cap is refused before anything is sent", async () => {
  await withRemote({ features: ["intent"] }, async (ctx) => {
    await writeTextFile(`${ctx.sandbox.home}/big.md`, "x".repeat(8001));
    const result = await ctx.run([`--intent-file=${ctx.sandbox.home}/big.md`]);
    must(result.code === 2, `exit ${result.code}`);
    must(
      `${result.stdout}${result.stderr}`.includes(
        "--intent-file: must be at most 8000 characters (got 8001)",
      ),
      `${result.stdout}\n${result.stderr}`,
    );
    must(ctx.remote.requests.length === 0, "a refused run reached the server");
  });
});
