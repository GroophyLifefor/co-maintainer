/** Browser smoke: a running job page that is left open must switch to the
 * finished page when the job ends, instead of keeping the running stages and
 * the Stop button on screen. Runs `serve` in a sandbox, never the machine's
 * real config or databases. */
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import { closeAppDb, openAppDb } from "../src/store/app_db.ts";
import { writeUserConfig } from "../src/config.ts";
import { activateRepo } from "../src/store/repos.ts";
import { Database } from "../src/store/sqlite.ts";
import {
  commandSpawn,
  makeTempDir,
  remove,
  setEnv,
} from "../src/util/runtime.ts";
import { runtimeExecPath, runtimeRunArgs } from "../src/testing/runtime.ts";

const PASSWORD = "job-refresh-smoke-pass";
const JOB = "job-refresh-smoke";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const sandbox = await makeTempDir({ prefix: "cm-job-refresh-smoke-" });
const env: Record<string, string | undefined> = {
  ...process.env,
  CM_CONFIG_PATH: join(sandbox, "config.json"),
  CM_REPOS_DIR: join(sandbox, "repos"),
  CM_APP_DB: join(sandbox, "app.db"),
  CM_CLONES_DIR: join(sandbox, "clones"),
  XDG_CONFIG_HOME: join(sandbox, "config"),
  XDG_CACHE_HOME: join(sandbox, "cache"),
  XDG_DATA_HOME: join(sandbox, "data"),
};
for (const [name, value] of Object.entries(env)) {
  if (value !== undefined) setEnv(name, value);
}

/** `serve` owns the app.db lock while it runs, so write to it directly. */
function write(sql: string, ...params: (string | null)[]): void {
  const db = new Database(env.CM_APP_DB!);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

let serve: ReturnType<typeof commandSpawn> | undefined;
let problem: string | undefined;
try {
  await writeUserConfig({ auth: "gh", ai: "none" });
  await openAppDb();
  activateRepo("acme/widgets", 9);
  await closeAppDb();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  serve = commandSpawn(runtimeExecPath(), {
    args: runtimeRunArgs("main.ts", [
      "serve",
      `--port=${port}`,
      `--password=${PASSWORD}`,
    ]),
    cwd: join(import.meta.dirname, ".."),
    env,
    stdout: "piped",
    stderr: "piped",
  });
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${base}/login`)).status < 500) break;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Inserted after serve started, so its orphan recovery leaves it alone.
  const now = new Date().toISOString();
  write(
    `INSERT INTO jobs (id, type, repo, pr_number, status, args, created_at, started_at)
     VALUES (?, 'remake', 'acme/widgets', NULL, 'running', ?, ?, ?)`,
    JOB,
    JSON.stringify({
      stages: [
        { name: "Read code", state: "done" },
        { name: "Extract facts", state: "current", percent: 40 },
      ],
    }),
    now,
    now,
  );

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/login`);
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL(`${base}/`),
      page.click('button[type="submit"]'),
    ]);
    await page.goto(`${base}/activity/${JOB}`);
    if ((await page.locator("[data-job-progress]").count()) !== 1) {
      problem = "the running page has no progress block";
    } else {
      write(
        "UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?",
        new Date().toISOString(),
        JOB,
      );
      try {
        await page.waitForFunction(
          () =>
            !document.querySelector("[data-job-progress]") &&
            !document.body.innerText.includes("Stop after this step"),
          null,
          { timeout: 10_000 },
        );
      } catch {
        problem =
          "the open page kept the running stages and Stop after the job finished";
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  serve?.kill("SIGTERM");
  await serve?.output().catch(() => undefined);
  await remove(sandbox, { recursive: true }).catch(() => {});
}

if (problem) {
  console.error(`job refresh smoke failed: ${problem}`);
  process.exit(1);
}
console.log("job refresh smoke ok");
