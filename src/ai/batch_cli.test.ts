/** Failed AI units are never cached (CORE-30 / F04).
 *
 * F04: a unit whose output did not parse was logged and then, because the
 * provider response itself was cached as `done`, replayed as a `cache hit` on
 * every later `sync` instead of being retried, so the same PR stayed dropped
 * forever. `src/ai/batch.test.ts` covers the retry and skip logic directly;
 * these run the CLI end to end against a fake OpenRouter, checking that an
 * unparseable output is retried, never cached, and reported at the end.
 */
import { test } from "node:test";
import { readTextFile } from "../util/runtime.ts";
import { startFakeOpenRouter } from "../testing/fake_openrouter.ts";
import {
  createCliHarness,
  writeHarnessConfig,
} from "../testing/cli_harness.ts";

/** A good extraction answer: a JSON array of facts (the shape
 * `factsFromResponse` parses), with no backticked identifier or path so no
 * evidence filter drops it. */
const GOOD_FACTS = JSON.stringify([
  {
    claim: "Keep each pull request focused on a single change.",
    sectionKey: "tests",
    scope: "current",
    confidence: "high",
  },
]);

/** Answers each chat request with the shape its parser expects: JSON facts for
 * an extraction request, a small valid section for a synthesis request. */
function chatAnswer(prompt: string): string {
  const match = prompt.match(
    /Write only the Markdown for the "([^"]+)" section/,
  );
  if (!match) return GOOD_FACTS;
  return `## ${match[1]}\n\n- Keep each pull request focused on one change.\n`;
}

function configPath(home: string): string {
  return `${home}/config/config.json`;
}

test("init retries a unit whose first output does not parse", async () => {
  const server = await startFakeOpenRouter("flaky-json", {
    flakyJsonFailures: 1,
    chatContent: chatAnswer,
  });
  const harness = await createCliHarness();
  try {
    await writeHarnessConfig(configPath(harness.home), {
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    });
    const result = await harness.run({
      args: ["init", "fixture/repo", "--include-codebase"],
      openrouterUrl: server.url,
      // The retry must run against the real provider path, so the fake AI
      // switch never leaks in from the environment.
      env: { CM_FAKE_AI: undefined, CM_FAKE_REVIEW_FILE: undefined },
    });
    const output = `${result.stdout}${result.stderr}`;
    if (result.code !== 0) {
      throw new Error(`init exited ${result.code}:\n${output}`);
    }
    // The bad first response is retried rather than dropped on the floor.
    if (!/\[ai\] retrying extract_unit/.test(output)) {
      throw new Error(`no retry in the output:\n${output}`);
    }
    // The retry succeeds, so the unit is not reported as skipped.
    if (/\[done\] \d+ units? skipped/.test(output)) {
      throw new Error(`a successful retry was reported skipped:\n${output}`);
    }
    // And the retried facts reached the guide instead of being dropped.
    const skill = await readTextFile(
      `${harness.home}/repos/fixture/repo/SKILL.md`,
    );
    if (!skill.includes("Keep each pull request focused")) {
      throw new Error(`the retried facts were dropped:\n${skill}`);
    }
  } finally {
    await harness.cleanup();
    await server.close();
  }
});

test("a unit that never parses is reported skipped and not cached", async () => {
  // Every chat call answers with text the extractor cannot parse.
  const server = await startFakeOpenRouter("success", {
    chatContent: () => "I could not find anything useful.",
  });
  const harness = await createCliHarness();
  try {
    await writeHarnessConfig(configPath(harness.home), {
      auth: "gh",
      ai: "openrouter",
      token: "fake-key",
      lowModel: "fake/model",
      highModel: "fake/model",
    });
    const env = { CM_FAKE_AI: undefined, CM_FAKE_REVIEW_FILE: undefined };
    const first = await harness.run({
      args: ["init", "fixture/repo", "--include-codebase"],
      openrouterUrl: server.url,
      env,
    });
    const firstOutput = `${first.stdout}${first.stderr}`;
    if (first.code !== 0) {
      throw new Error(`init exited ${first.code}:\n${firstOutput}`);
    }
    if (!/\[ai\] skipped extract_unit/.test(firstOutput)) {
      throw new Error(`the bad output was not skipped:\n${firstOutput}`);
    }
    // The `[done]` line names the skipped unit (CORE-30, item 3).
    if (!/\[done\] \d+ units? skipped \(/.test(firstOutput)) {
      throw new Error(`no skipped line in the output:\n${firstOutput}`);
    }
    const firstCalls = server.requests.length;

    // Run again. A good result would come from the cache and make no call; a
    // skipped one must not, so the provider is asked afresh.
    const second = await harness.run({
      args: ["sync", "fixture/repo"],
      openrouterUrl: server.url,
      env,
    });
    const secondOutput = `${second.stdout}${second.stderr}`;
    if (second.code !== 0) {
      throw new Error(`sync exited ${second.code}:\n${secondOutput}`);
    }
    if (/\[ai\] cache hit extract_unit/.test(secondOutput)) {
      throw new Error(`the skipped unit was cached anyway:\n${secondOutput}`);
    }
    if (server.requests.length <= firstCalls) {
      throw new Error("the skipped unit was not retried on the next run");
    }
  } finally {
    await harness.cleanup();
    await server.close();
  }
});
