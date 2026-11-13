/** `review --intent-file` through the real CLI against a fake model: where
 * the intent goes, what the result records, and the errors. Standard input is
 * piped to a child process, since a terminal cannot be faked in this one. */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  createLocalReviewSandbox,
  type LocalReviewSandbox,
} from "../testing/local_review_sandbox.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import { runtimeExecPath, writeTextFile } from "../testing/runtime.ts";
import { commandWithInput } from "../util/runtime.ts";
import { INTENT_PROMPT_NOTE } from "../review/intent.ts";

const INTENT = "Fix rounding for JPY totals, amounts have no decimals.";

type Run = { code: number; stdout: string; stderr: string };

async function run(
  sandbox: LocalReviewSandbox,
  url: string,
  extra: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  const result = await commandWithInput(
    runtimeExecPath(),
    {
      args: sandbox.reviewArgs(extra),
      cwd: sandbox.worktree,
      env: { ...sandbox.env(url), ...options.env },
    },
    options.stdin ?? "",
  );
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

type ChatRequest = { messages: { role: string; content: string }[] };

function parts(request: Record<string, unknown>): {
  system: string;
  user: string;
} {
  const messages = (request as ChatRequest).messages;
  return {
    system: messages.find((m) => m.role === "system")?.content ?? "",
    user: messages.find((m) => m.role === "user")?.content ?? "",
  };
}

async function withServer(
  fn: (
    sandbox: LocalReviewSandbox,
    server: Awaited<ReturnType<typeof startFakeOpenRouter>>,
  ) => Promise<void>,
): Promise<void> {
  const sandbox = await createLocalReviewSandbox();
  const server = await startFakeOpenRouter("success");
  try {
    await fn(sandbox, server);
  } finally {
    await server.close();
    await sandbox.cleanup();
  }
}

function must(value: boolean, what: string): void {
  if (!value) throw new Error(what);
}

test("--intent-file: the intent reaches the prompt, the system prompt is unchanged, and the result never holds the text", async () => {
  await withServer(async (sandbox, server) => {
    await writeTextFile(`${sandbox.home}/task.md`, `  ${INTENT}\n\n`);
    const plain = await run(sandbox, server.url, ["--json", "--fresh"]);
    const given = await run(sandbox, server.url, [
      "--json",
      "--fresh",
      `--intent-file=${sandbox.home}/task.md`,
    ]);
    must(
      plain.code === 0 && given.code === 0,
      `${plain.stderr}${given.stderr}`,
    );

    const [plainReq, givenReq] = server.requests.map(parts);
    must(plainReq!.system === givenReq!.system, "the system prompt changed");
    must(
      !givenReq!.system.includes(INTENT),
      "the text is in the system prompt",
    );
    must(
      givenReq!.user.includes(`"intent":${JSON.stringify(INTENT)}`),
      "the intent is not in WORKSPACE",
    );
    must(givenReq!.user.includes(INTENT_PROMPT_NOTE), "no defensive sentences");
    must(!plainReq!.user.includes("INTENT"), "a plain review mentions intent");

    const result = JSON.parse(given.stdout);
    must(
      JSON.stringify(result.subject.intent) ===
        JSON.stringify({ source: "file", chars: INTENT.length }),
      JSON.stringify(result.subject),
    );
    must(JSON.parse(plain.stdout).subject.intent === null, "plain is null");
    for (const out of [given.stdout, given.stderr]) {
      must(!out.includes(INTENT), "the intent text was printed");
    }
  });
});

test("--intent-file=-: reads standard input to its end", async () => {
  await withServer(async (sandbox, server) => {
    const result = await run(
      sandbox,
      server.url,
      ["--json", "--intent-file=-"],
      {
        stdin: `${INTENT}\nSecond line.\n`,
      },
    );
    must(result.code === 0, result.stderr);
    const [request] = server.requests.map(parts);
    must(
      request!.user.includes(
        `"intent":${JSON.stringify(`${INTENT}\nSecond line.`)}`,
      ),
      request!.user.slice(0, 600),
    );
    const intent = JSON.parse(result.stdout).subject.intent;
    must(
      intent.source === "stdin" &&
        intent.chars === `${INTENT}\nSecond line.`.length,
      JSON.stringify(intent),
    );
    must(!result.stdout.includes("Second line."), "the text was printed");
  });
});

test("--intent-file: the human output says it was given, without the text", async () => {
  await withServer(async (sandbox, server) => {
    await writeTextFile(`${sandbox.home}/task.md`, INTENT);
    const given = await run(sandbox, server.url, [
      `--intent-file=${sandbox.home}/task.md`,
    ]);
    must(given.code === 0, given.stderr);
    must(given.stdout.includes("\nIntent file: provided\n"), given.stdout);
    must(!given.stdout.includes(INTENT), "the intent text was printed");
    const plain = await run(sandbox, server.url, []);
    must(!plain.stdout.includes("Intent file"), "a plain review has the line");
  });
});

test("--intent-file with --output=github: the job summary says it was given", async () => {
  await withServer(async (sandbox, server) => {
    await writeTextFile(`${sandbox.home}/task.md`, INTENT);
    const summary = `${sandbox.home}/summary.md`;
    const result = await run(
      sandbox,
      server.url,
      ["--output=github", `--intent-file=${sandbox.home}/task.md`],
      { env: { GITHUB_STEP_SUMMARY: summary } },
    );
    must(result.code === 0, result.stderr);
    const text = readFileSync(summary, "utf8");
    must(text.includes("\nIntent file: provided\n"), text);
    for (const out of [text, result.stdout, result.stderr]) {
      must(!out.includes(INTENT), "the intent text was printed");
    }
  });
});

test("--intent-file: an empty file is no intent and one warning", async () => {
  await withServer(async (sandbox, server) => {
    await writeTextFile(`${sandbox.home}/empty.md`, " \n\n");
    const result = await run(sandbox, server.url, [
      "--json",
      `--intent-file=${sandbox.home}/empty.md`,
    ]);
    must(result.code === 0, result.stderr);
    const body = JSON.parse(result.stdout);
    must(body.subject.intent === null, "an empty file recorded an intent");
    const codes = body.warnings.map((w: { code: string }) => w.code);
    must(
      codes.filter((c: string) => c === "intent_empty").length === 1,
      JSON.stringify(codes),
    );
    const [request] = server.requests.map(parts);
    must(!request!.user.includes("INTENT"), "the prompt mentions intent");
  });
});

test("--intent-file: over the cap, unreadable and with --range are usage errors", async () => {
  await withServer(async (sandbox, server) => {
    await writeTextFile(`${sandbox.home}/big.md`, "x".repeat(8001));
    const big = await run(sandbox, server.url, [
      `--intent-file=${sandbox.home}/big.md`,
    ]);
    must(big.code === 2, `exit ${big.code}`);
    must(
      big.stderr.includes(
        "--intent-file: must be at most 8000 characters (got 8001)",
      ),
      big.stderr,
    );

    const missing = await run(sandbox, server.url, [
      `--intent-file=${sandbox.home}/missing.md`,
    ]);
    must(missing.code === 2, `exit ${missing.code}`);
    must(
      missing.stderr.includes(
        `--intent-file: could not read ${sandbox.home}/missing.md:`,
      ),
      missing.stderr,
    );

    const range = await run(sandbox, server.url, [
      "--remote",
      `--range=${"a".repeat(40)}..${"b".repeat(40)}`,
      `--intent-file=${sandbox.home}/big.md`,
    ]);
    must(range.code === 2, `exit ${range.code}`);
    must(
      range.stderr.includes("--intent-file is not supported with --range"),
      range.stderr,
    );
    must(server.requests.length === 0, "a refused run reached the model");
  });
});
