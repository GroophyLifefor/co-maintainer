/** The Server page must describe the process that is actually serving it, not
 * only the saved config. These tests run the real `serve` command for the
 * runtime rows, then use the in-process app for the queue limits and the
 * settings API. */
import { test } from "node:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createApp } from "../app.ts";
import { closeAppDb, openAppDb } from "../../store/app_db.ts";
import { writeUserConfig } from "../../config.ts";
import {
  commandSpawn,
  deleteEnv,
  getEnv,
  makeTempDir,
  makeTempDirSync,
  setEnv,
  writeTextFile,
} from "../../util/runtime.ts";
import { runtimeExecPath, runtimeRunArgs } from "../../testing/runtime.ts";
import { isolateTestFile } from "../../testing/locations.ts";

// These tests resolve the config or cache directory. Keep both in a temp
// home of this file's own, never the developer's real ones.
isolateTestFile();

const PASSWORD = "settings-server-pass";
const PACKAGE = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { version: string };

type RunningServer = {
  base: string;
  port: number;
  sandbox: string;
  dataDir: string;
  stop: () => Promise<void>;
};

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`serve did not come up at ${url} within ${timeoutMs}ms`);
}

/** Start the real CLI, not a hand-built app, so the port, trust-proxy flag and
 * data directory come from the same code path an operator runs. */
async function startServe(options: {
  trustProxy: boolean;
}): Promise<RunningServer> {
  const sandbox = await makeTempDir({ prefix: "cm-settings-server-" });
  const port = await freePort();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.CM_TRUST_PROXY;
  delete env.CM_INJECT_500;
  env.HOME = join(sandbox, "home");
  env.CM_CONFIG_PATH = join(sandbox, "config.json");
  env.CM_REPOS_DIR = join(sandbox, "repos");
  env.CM_APP_DB = join(sandbox, "app.db");
  env.XDG_CACHE_HOME = join(sandbox, "cache");
  env.XDG_CONFIG_HOME = join(sandbox, "config-home");
  env.XDG_DATA_HOME = join(sandbox, "data");
  env.APPDATA = join(sandbox, "appdata");
  env.LOCALAPPDATA = join(sandbox, "localappdata");
  await writeTextFile(
    env.CM_CONFIG_PATH,
    JSON.stringify({ auth: "gh", ai: "none" }),
  );
  const args = ["serve", `--port=${port}`, `--password=${PASSWORD}`];
  if (options.trustProxy) args.push("--trust-proxy");
  const child = commandSpawn(runtimeExecPath(), {
    args: runtimeRunArgs("main.ts", args),
    cwd: join(import.meta.dirname, "..", "..", ".."),
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const base = `http://127.0.0.1:${port}`;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    await child.output().catch(() => undefined);
  };
  try {
    await waitForServer(`${base}/login`, 60_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    base,
    port,
    sandbox,
    // The cache directory serve really uses: LOCALAPPDATA on Windows,
    // ~/Library/Caches on macOS, XDG_CACHE_HOME elsewhere.
    dataDir:
      process.platform === "win32"
        ? join(sandbox, "localappdata", "co-maintainer")
        : process.platform === "darwin"
          ? join(sandbox, "home", "Library", "Caches", "co-maintainer")
          : join(sandbox, "cache", "co-maintainer"),
    stop,
  };
}

async function fetchSettingsServer(server: RunningServer): Promise<string> {
  const login = await fetch(`${server.base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(PASSWORD)}&next=/`,
    redirect: "manual",
  });
  if (login.status !== 303) throw new Error(`login status ${login.status}`);
  const token = login.headers.get("set-cookie")?.match(/^cm=([^;]+)/)?.[1];
  if (!token) throw new Error("the login response set no session cookie");
  const page = await fetch(`${server.base}/settings/server`, {
    headers: { cookie: `cm=${token}` },
    redirect: "manual",
  });
  if (page.status !== 200) {
    throw new Error(`/settings/server returned ${page.status}`);
  }
  return await page.text();
}

function decode(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read a label/value pair from the status card. Accepts a definition list or
 * a two-cell table row so the test does not lock the card to one layout. */
function rowValue(html: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<dt[^>]*>\\s*${escaped}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`,
      "i",
    ),
    new RegExp(
      `<th[^>]*>\\s*${escaped}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
      "i",
    ),
    new RegExp(
      `<td[^>]*>\\s*${escaped}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return decode(match[1]!);
  }
  return undefined;
}

function samePath(shown: string, expected: string, sandbox: string): boolean {
  const expanded = shown.startsWith("~")
    ? join(sandbox, "home", shown.slice(1))
    : shown;
  // Windows paths may mix `\` and `/` (`...\localappdata/co-maintainer`).
  const normalize = (value: string) =>
    value.replace(/[/\\]+/g, "/").replace(/\/+$/, "");
  return normalize(expanded) === normalize(expected);
}

function assertRuntime(
  html: string,
  server: RunningServer,
  trustProxy: boolean,
): void {
  const version = rowValue(html, "Version");
  if (version !== PACKAGE.version) {
    throw new Error(
      `Version shows ${JSON.stringify(version)}, want ${JSON.stringify(PACKAGE.version)}`,
    );
  }
  const port = rowValue(html, "Port");
  if (port !== String(server.port)) {
    throw new Error(
      `Port shows ${JSON.stringify(port)}, want ${JSON.stringify(String(server.port))}`,
    );
  }
  const proxy = rowValue(html, "Behind a proxy");
  const proxyWord = (proxy ?? "").toLowerCase();
  if (!proxyWord.startsWith(trustProxy ? "yes" : "no")) {
    throw new Error(
      `Behind a proxy shows ${JSON.stringify(proxy)}, want ${trustProxy ? "Yes" : "No"}`,
    );
  }
  const data = rowValue(html, "Data");
  if (!data || !samePath(data, server.dataDir, server.sandbox)) {
    throw new Error(
      `Data shows ${JSON.stringify(data)}, want ${JSON.stringify(server.dataDir)}`,
    );
  }
}

function inputValue(html: string, id: string): string | undefined {
  const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0];
  if (!tag) return undefined;
  return /value="([^"]*)"/.exec(tag)?.[1];
}

async function cookieSession(
  app: ReturnType<typeof createApp>,
): Promise<string> {
  const response = await app.fetch(
    new Request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${PASSWORD}&next=/`,
      redirect: "manual",
    }),
  );
  if (response.status !== 303)
    throw new Error(`login status ${response.status}`);
  const token = response.headers.get("set-cookie")?.match(/^cm=([^;]+)/)?.[1];
  if (!token) throw new Error("the login response set no session cookie");
  return `cm=${token}`;
}

async function withEnv(fn: () => Promise<void>): Promise<void> {
  const keys = [
    "CM_APP_DB",
    "CM_CONFIG_PATH",
    "CM_REPOS_DIR",
    "XDG_CACHE_HOME",
  ] as const;
  const original: Record<string, string | undefined> = {};
  for (const key of keys) original[key] = getEnv(key);
  const dir = makeTempDirSync();
  setEnv("CM_APP_DB", `${dir}/app.db`);
  setEnv("CM_CONFIG_PATH", `${dir}/config.json`);
  setEnv("CM_REPOS_DIR", `${dir}/repos`);
  setEnv("XDG_CACHE_HOME", `${dir}/cache`);
  try {
    await openAppDb();
    await writeUserConfig({ auth: "gh", ai: "none" });
    await fn();
  } finally {
    await closeAppDb();
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) deleteEnv(key);
      else setEnv(key, value);
    }
  }
}

test("the server page shows the live version, port, trust-proxy state and data directory", async () => {
  const trusted = await startServe({ trustProxy: true });
  let plain: RunningServer | undefined;
  try {
    plain = await startServe({ trustProxy: false });
    const [trustedHtml, plainHtml] = await Promise.all([
      fetchSettingsServer(trusted),
      fetchSettingsServer(plain),
    ]);
    assertRuntime(trustedHtml, trusted, true);
    assertRuntime(plainHtml, plain, false);

    const trustedPort = rowValue(trustedHtml, "Port");
    const plainPort = rowValue(plainHtml, "Port");
    if (trustedPort === plainPort) {
      throw new Error("two different runtimes rendered the same port");
    }
    const trustedData = rowValue(trustedHtml, "Data");
    const plainData = rowValue(plainHtml, "Data");
    if (trustedData === plainData) {
      throw new Error(
        "two different runtimes rendered the same data directory",
      );
    }
  } finally {
    if (plain) await plain.stop();
    await trusted.stop();
  }
});

test("the server page still renders the job queue, remote timeout, per-token limit and tool-output limit", async () => {
  await withEnv(async () => {
    await writeUserConfig({
      maxConcurrentJobs: 4,
      remoteSyncTimeoutSeconds: 9,
      maxConcurrentRemoteReviewsPerToken: 2,
      remoteToolOutputMaxChars: 12345,
    });
    const app = createApp({
      password: PASSWORD,
      auth: { password: true, github: false },
    });
    const cookie = await cookieSession(app);
    const response = await app.fetch(
      new Request("http://localhost/settings/server", {
        headers: { cookie },
      }),
    );
    const html = await response.text();
    const expected: Array<[string, string]> = [
      ["max-jobs", "4"],
      ["remote-timeout", "9"],
      ["remote-per-token", "2"],
      ["remote-tool-chars", "12345"],
    ];
    for (const [id, value] of expected) {
      if (inputValue(html, id) !== value) {
        throw new Error(`#${id} shows ${inputValue(html, id)}, want ${value}`);
      }
    }
  });
});

test("an invalid server limit is rejected by the API and a valid save round-trips", async () => {
  await withEnv(async () => {
    const app = createApp({
      password: PASSWORD,
      auth: { password: true, github: false },
    });
    const cookie = await cookieSession(app);
    const put = (body: unknown) =>
      app.fetch(
        new Request("http://localhost/api/settings", {
          method: "PUT",
          headers: {
            cookie,
            "content-type": "application/json",
            "x-requested-with": "co-maintainer",
          },
          body: JSON.stringify(body),
        }),
      );

    const invalid = await put({ maxConcurrentJobs: -1 });
    if (invalid.status !== 422) {
      throw new Error(`an invalid job limit returned ${invalid.status}`);
    }
    const invalidBody = (await invalid.json()) as {
      error?: { message?: string };
    };
    if (!(invalidBody.error?.message ?? "").includes("maxConcurrentJobs")) {
      throw new Error(
        `the API reason does not name the field: ${JSON.stringify(invalidBody)}`,
      );
    }

    const page = await app.fetch(
      new Request("http://localhost/settings/server", {
        headers: { cookie },
      }),
    );
    const pageHtml = await page.text();
    if (!pageHtml.includes("Max concurrent jobs")) {
      throw new Error("the server page lost the job limit field");
    }
    if (!pageHtml.includes("must be a positive whole number")) {
      throw new Error(
        "the server page has no visible reason for an invalid value",
      );
    }

    const valid = await put({
      maxConcurrentJobs: 7,
      remoteSyncTimeoutSeconds: 11,
      maxConcurrentRemoteReviewsPerToken: 3,
      remoteToolOutputMaxChars: 900,
    });
    if (valid.status !== 200) {
      throw new Error(`a valid save returned ${valid.status}`);
    }
    const saved = (await (
      await app.fetch(
        new Request("http://localhost/api/settings", {
          headers: { cookie },
        }),
      )
    ).json()) as Record<string, number | null>;
    if (
      saved.maxConcurrentJobs !== 7 ||
      saved.remoteSyncTimeoutSeconds !== 11 ||
      saved.maxConcurrentRemoteReviewsPerToken !== 3 ||
      saved.remoteToolOutputMaxChars !== 900
    ) {
      throw new Error(
        `the API did not keep the saved limits: ${JSON.stringify(saved)}`,
      );
    }

    const after = await app.fetch(
      new Request("http://localhost/settings/server", {
        headers: { cookie },
      }),
    );
    const afterHtml = await after.text();
    for (const [id, value] of [
      ["max-jobs", "7"],
      ["remote-timeout", "11"],
      ["remote-per-token", "3"],
      ["remote-tool-chars", "900"],
    ] as const) {
      if (inputValue(afterHtml, id) !== value) {
        throw new Error(
          `after saving, #${id} shows ${inputValue(afterHtml, id)}, want ${value}`,
        );
      }
    }
  });
});
