import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appDbPath,
  closeAppDb,
  getAppDb,
  openAppDb,
} from "../../store/app_db.ts";
import {
  deleteEnv,
  getEnv,
  removePath,
  setEnv,
  tempDirSync,
  writeTextFile,
} from "../../testing/runtime.ts";
import { isolateTestFile } from "../../testing/locations.ts";
import { CliError } from "../error.ts";
import { runLoginLink } from "./login_link.ts";

isolateTestFile();

async function withSandbox(fn: () => Promise<void>): Promise<void> {
  const keep = {
    config: getEnv("CM_CONFIG_PATH"),
    db: getEnv("CM_APP_DB"),
    webhook: getEnv("CM_WEBHOOK_URL"),
  };
  const dir = tempDirSync();
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_APP_DB", `${dir}/app.db`);
  deleteEnv("CM_WEBHOOK_URL");
  try {
    await fn();
  } finally {
    try {
      await closeAppDb();
    } finally {
      for (const [name, value] of [
        ["CM_CONFIG_PATH", keep.config],
        ["CM_APP_DB", keep.db],
        ["CM_WEBHOOK_URL", keep.webhook],
      ] as const) {
        if (value === undefined) deleteEnv(name);
        else setEnv(name, value);
      }
      await removePath(dir, { recursive: true }).catch(() => {});
    }
  }
}

/** A database a running serve holds, as the second connection sees it. */
async function serveHolds(): Promise<void> {
  await openAppDb();
  await closeAppDb();
  await writeTextFile(`${appDbPath()}.lock`, String(process.ppid));
}

async function capture(
  fn: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => void out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => void err.push(parts.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("login-link prints one URL while serve holds app.db, and audits it without the token", async () => {
  await withSandbox(async () => {
    await serveHolds();
    setEnv("CM_WEBHOOK_URL", "https://review.example.com/github/webhook");
    const { out, err } = await capture(() => runLoginLink([]));
    assert.match(
      out,
      /^https:\/\/review\.example\.com\/login\/link#[0-9a-f]{64}$/,
    );
    assert.match(err, /5 minutes/);
    const token = out.split("#")[1]!;
    await writeTextFile(`${appDbPath()}.lock`, "999999999");
    await openAppDb();
    const link = getAppDb()
      .prepare<{ host: string }>(`SELECT host FROM login_links`)
      .all();
    assert.deepEqual(
      link.map((row) => row.host),
      ["review.example.com"],
    );
    const audit = getAppDb()
      .prepare(`SELECT * FROM audit_log WHERE summary = 'Made a sign-in link'`)
      .all() as { actor: string }[];
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor, "cli");
    assert.ok(!JSON.stringify(audit).includes(token));
  });
});

test("--origin wins over the webhook URL", async () => {
  await withSandbox(async () => {
    await serveHolds();
    setEnv("CM_WEBHOOK_URL", "https://review.example.com/github/webhook");
    const { out } = await capture(() =>
      runLoginLink(["--origin=http://localhost:3000"]),
    );
    assert.match(out, /^http:\/\/localhost:3000\/login\/link#/);
  });
});

test("login-link refuses with no serve running, and with no address known", async () => {
  await withSandbox(async () => {
    await assert.rejects(
      runLoginLink(["--origin=http://localhost:3000"]),
      (error) =>
        error instanceof CliError && error.code === "serve_not_running",
    );
    await serveHolds();
    await assert.rejects(
      runLoginLink([]),
      (error) =>
        error instanceof CliError && /--origin=/.test(String(error.hint)),
    );
    await assert.rejects(
      runLoginLink(["--origin=ftp://x"]),
      (error) => error instanceof CliError && error.code === "usage",
    );
    setEnv("CM_WEBHOOK_URL", "https://review.example.com/github/webhook");
    await assert.rejects(
      runLoginLink(["--origin="]),
      (error) => error instanceof CliError && error.code === "usage",
    );
  });
});
