/** Harness self-tests (CORE-03).
 *
 * The harness is only useful if it really drives the CLI: these run `probe`
 * against the fake `gh` in a child process and check the fake OpenRouter modes
 * through the same `CM_OPENROUTER_URL` seam the CLI reads.
 */
import { test } from "node:test";
import { createCliHarness, writeHarnessConfig } from "./cli_harness.ts";
import { startFakeOpenRouter } from "./fake_openrouter.ts";
import { readTextFile } from "../util/runtime.ts";

test("harness: probe runs in a real process and reads the fake gh", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["probe", "fixture/repo"],
      env: { CM_FAKE_AI: "1" },
    });
    if (result.code !== 0) {
      throw new Error(`probe exited ${result.code}: ${result.stderr}`);
    }
    // The recommendation is computed from the fixture's default branch and
    // recent activity, so a non-empty command proves the fixture was parsed.
    if (!result.stdout.includes("recommended")) {
      throw new Error(`no recommendation in stdout:\n${result.stdout}`);
    }
    if (!/co-maintainer init fixture\/repo/.test(result.stdout)) {
      throw new Error(`no init command:\n${result.stdout}`);
    }
    if (!result.stdout.includes("PRs: 1")) {
      throw new Error(`fixture pull request not counted:\n${result.stdout}`);
    }
    const calls = await readTextFile(`${harness.home}/gh-calls.log`);
    if (!calls.includes("repos/fixture/repo")) {
      throw new Error(`gh call log missing the repo read:\n${calls}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("harness: gh 404 mode fails the run without leaking a raw crash", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["probe", "fixture/repo"],
      ghMode: "notfound",
    });
    if (result.code === 0) {
      throw new Error(`expected a non-zero exit, got 0:\n${result.stdout}`);
    }
    // CORE-12: the raw `gh: Not Found (HTTP 404)` is replaced by a sentence
    // naming the repo and a hint, so assert on that instead of the gh text.
    const output = `${result.stdout}${result.stderr}`;
    if (!/fixture\/repo was not found/.test(output)) {
      throw new Error(`the 404 did not name the repo:\n${output}`);
    }
    if (!/gh auth status/.test(output)) {
      throw new Error(`the 404 lost its hint:\n${output}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("harness: missing gh session surfaces the auth hint", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["probe", "fixture/repo"],
      ghMode: "noauth",
    });
    if (result.code === 0) throw new Error("expected a non-zero exit");
    if (!result.stderr.includes("gh auth login")) {
      throw new Error(`stderr did not mention auth:\n${result.stderr}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("harness: empty stderr from gh still names the endpoint", async () => {
  const harness = await createCliHarness();
  try {
    const result = await harness.run({
      args: ["probe", "fixture/repo"],
      ghMode: "empty-stderr",
    });
    if (result.code === 0) throw new Error("expected a non-zero exit");
    if (!result.stderr.includes("fixture/repo")) {
      throw new Error(`stderr did not name the endpoint:\n${result.stderr}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("harness: isolated dirs mean the real config is never read", async () => {
  const harness = await createCliHarness();
  try {
    await writeHarnessConfig(harness.home + "/config/config.json", {
      auth: "gh",
      ai: "none",
    });
    const result = await harness.run({ args: ["probe", "fixture/repo"] });
    if (result.configPath !== `${harness.home}/config/config.json`) {
      throw new Error(`config path not isolated: ${result.configPath}`);
    }
    if (!result.reposDir.startsWith(harness.home)) {
      throw new Error(`repos dir not isolated: ${result.reposDir}`);
    }
  } finally {
    await harness.cleanup();
  }
});

test("harness: the CLI reaches the fake OpenRouter through CM_OPENROUTER_URL", async () => {
  const harness = await createCliHarness();
  const server = await startFakeOpenRouter("success");
  try {
    await writeHarnessConfig(`${harness.home}/config/config.json`, {
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    });
    const result = await harness.run({
      args: ["init", "fixture/repo", "--include-codebase"],
      openrouterUrl: server.url,
    });
    if (result.code !== 0) {
      throw new Error(`init exited ${result.code}: ${result.stderr}`);
    }
    if (server.requests.length === 0) {
      throw new Error("the CLI never called the fake OpenRouter");
    }
    // The tokened header is the only proof the request came from the provider
    // and not from something else on the machine.
    if (server.requests[0]?.model !== "fake/model") {
      throw new Error(`request body: ${JSON.stringify(server.requests[0])}`);
    }
  } finally {
    await server.close();
    await harness.cleanup();
  }
});

test("harness: a 401 from OpenRouter is surfaced, and 0.4.13 swallows it", async () => {
  const harness = await createCliHarness();
  const server = await startFakeOpenRouter("unauthorized");
  try {
    await writeHarnessConfig(`${harness.home}/config/config.json`, {
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    });
    const result = await harness.run({
      args: ["init", "fixture/repo", "--include-codebase"],
      openrouterUrl: server.url,
    });
    // The provider error is quarantined per unit, not raised, so 0.4.13 still
    // reports success and writes a skill from the surviving facts. That gap is
    // recorded for the later error-handling tasks; this harness only has to
    // prove the 401 reached the CLI and is diagnosable from its output.
    // CORE-12: the diagnosis is now a sentence, not the numeric status.
    const output = `${result.stdout}${result.stderr}`;
    if (!/OpenRouter rejected the API key/.test(output)) {
      throw new Error(`the 401 was not surfaced anywhere:\n${output}`);
    }
    if (!/co-maintainer set --token/.test(output)) {
      throw new Error(`the 401 lost its hint:\n${output}`);
    }
    if (server.requests.length === 0) {
      throw new Error("the CLI never called the fake OpenRouter");
    }
  } finally {
    await server.close();
    await harness.cleanup();
  }
});

test("harness: without a terminal the CLI refuses to prompt instead of hanging", async () => {
  const harness = await createCliHarness();
  const server = await startFakeOpenRouter("success");
  try {
    // No config and no --ai flag: `init` would ask for a provider, but there is
    // no terminal, so it must fail fast rather than wait for an answer.
    const result = await harness.run({
      args: ["init", "fixture/repo", "--include-codebase"],
      openrouterUrl: server.url,
    });
    const output = `${result.stdout}${result.stderr}`;
    if (
      result.code === 0 ||
      !output.includes("without an interactive terminal")
    ) {
      throw new Error(
        `expected a fast non-interactive failure, got:\n${output}`,
      );
    }
    if (server.requests.length !== 0) {
      throw new Error("the CLI called the provider before it had a key");
    }
  } finally {
    await server.close();
    await harness.cleanup();
  }
});

test("fake_openrouter: success mode answers and records the request", async () => {
  const server = await startFakeOpenRouter("success");
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake/model", messages: [] }),
    });
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as { choices?: unknown[] };
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      throw new Error(`no choices: ${JSON.stringify(body)}`);
    }
    if (server.requests.length !== 1) {
      throw new Error(
        `expected 1 recorded request, got ${server.requests.length}`,
      );
    }
    if (server.requests[0]?.model !== "fake/model") {
      throw new Error(`recorded body: ${JSON.stringify(server.requests[0])}`);
    }
  } finally {
    await server.close();
  }
});

for (const [mode, status] of [
  ["bad-model", 400],
  ["unauthorized", 401],
  ["rate-limited", 429],
] as const) {
  test(`fake_openrouter: ${mode} answers ${status}`, async () => {
    const server = await startFakeOpenRouter(mode);
    try {
      const response = await fetch(server.url, { method: "POST", body: "{}" });
      if (response.status !== status) {
        throw new Error(`expected ${status}, got ${response.status}`);
      }
      const body = (await response.json()) as { error?: { message?: string } };
      if (!body.error?.message) {
        throw new Error(`no error message: ${JSON.stringify(body)}`);
      }
    } finally {
      await server.close();
    }
  });
}

test("fake_openrouter: bad-json answers 200 with a non-JSON body", async () => {
  const server = await startFakeOpenRouter("bad-json");
  try {
    const response = await fetch(server.url, { method: "POST", body: "{}" });
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    const text = await response.text();
    if (text === "not json at all") return;
    throw new Error(`unexpected body: ${text}`);
  } finally {
    await server.close();
  }
});

test("fake_openrouter: timeout mode never answers", async () => {
  const server = await startFakeOpenRouter("timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    let aborted = false;
    try {
      await fetch(server.url, {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      });
    } catch {
      aborted = true;
    }
    if (!aborted) throw new Error("timeout mode answered a request");
  } finally {
    clearTimeout(timer);
    await server.close();
  }
});
