/** A bad AI response must not fail the run.
 *
 * A unit whose output does not parse is dropped or used best-effort, and the
 * run keeps whatever else it produced. Spending on extraction and then losing
 * everything to a format deviation is the bug these cover.
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

test("init tolerates a unit whose first output does not parse", async () => {
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
      env: { CM_FAKE_AI: undefined, CM_FAKE_REVIEW_FILE: undefined },
    });
    const output = `${result.stdout}${result.stderr}`;
    if (result.code !== 0) {
      throw new Error(`init exited ${result.code}:\n${output}`);
    }
    if (/AI failed to generate/.test(output)) {
      throw new Error(`a parse problem failed the run:\n${output}`);
    }
    const skill = await readTextFile(
      `${harness.home}/repos/fixture/repo/SKILL.md`,
    );
    if (skill.trim().length === 0) {
      throw new Error("no skill was written");
    }
  } finally {
    await harness.cleanup();
    await server.close();
  }
});

test("a unit that never parses does not fail the run", async () => {
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
    if (first.code !== 0) {
      throw new Error(
        `init should not have failed:\n${first.stdout}${first.stderr}`,
      );
    }
    const second = await harness.run({
      args: ["sync", "fixture/repo"],
      openrouterUrl: server.url,
      env,
    });
    if (second.code !== 0) {
      throw new Error(`sync should not have failed:\n${second.stdout}`);
    }
  } finally {
    await harness.cleanup();
    await server.close();
  }
});
