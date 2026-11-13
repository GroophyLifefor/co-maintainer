import { test } from "node:test";
import {
  buildInstructions,
  instructionsJson,
  writeInstructionsAndRules,
  type InstructionsOutcome,
} from "./rules_build.ts";
import { loadGuides, withKnowledgeLock } from "../review/guides.ts";
import { parseRules } from "../knowledge/rules.ts";
import { testOptions, testSource } from "../testing/helpers.ts";
import { withLogSink } from "../util/log.ts";
import type { AiProvider, AiResponse } from "../types.ts";
import {
  deleteEnv,
  getEnv,
  makeTempDir,
  mkdir,
  readTextFile,
  remove,
  setEnv,
  stat,
} from "../util/runtime.ts";

const REPO = "acme/widgets";

async function withReposDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const root = await makeTempDir({ prefix: "cm-rules-" });
  const previous = getEnv("CM_REPOS_DIR");
  setEnv("CM_REPOS_DIR", root);
  await mkdir(`${root}/${REPO}`, { recursive: true });
  try {
    await fn(`${root}/${REPO}`);
  } finally {
    if (previous === undefined) deleteEnv("CM_REPOS_DIR");
    else setEnv("CM_REPOS_DIR", previous);
    await remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function written(
  rules: { id: string; text: string; line: number }[],
): InstructionsOutcome {
  return {
    status: "written",
    markdown: `# Repository instructions\n\nRules.\n\n${rules
      .map((rule) => `- ${rule.text} [${rule.id}]\n`)
      .join("")}`,
    rules: rules.map((rule) => ({
      id: rule.id,
      text: rule.text,
      scope: "",
      sources: [{ path: "AGENTS.md", line: rule.line }],
    })),
    counts: { unsupportedSource: 2, unknownName: 0, overCap: 0 },
  };
}

const WRITTEN = written([
  { id: "I1", text: "Format amounts with `formatMoney()`.", line: 31 },
]);

async function write(instructions: InstructionsOutcome) {
  const lines: string[] = [];
  const source = testSource({ commits: [{ sha: "abc123" }] });
  const result = await withLogSink(
    (phase, message) => void lines.push(`[${phase}] ${message}`),
    () =>
      withKnowledgeLock(REPO, () =>
        writeInstructionsAndRules({ repo: REPO, instructions, source }),
      ),
  );
  return { result, lines };
}

test("a build writes INSTRUCTIONS.md and RULES.json, and the loader reads both", async () => {
  await withReposDir(async (dir) => {
    const { result, lines } = await write(WRITTEN);
    if (result.changes !== null) {
      throw new Error("a first build reported changes");
    }
    if (
      !lines.includes(
        "[write] INSTRUCTIONS.md · 1 rule · 2 dropped (unsupported source) · 0 over the cap",
      )
    ) {
      throw new Error(`build output:\n${lines.join("\n")}`);
    }
    const rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (
      rules?.rules.I1.commit !== "abc123" ||
      rules?.rules.I1.text !== "Format amounts with formatMoney()." ||
      JSON.stringify(rules?.rules.I1.sources) !==
        '[{"path":"AGENTS.md","line":31}]'
    ) {
      throw new Error(`RULES.json: ${JSON.stringify(rules)}`);
    }
    const loaded = await loadGuides(REPO);
    if (!loaded.instructions.includes("[I1]") || !loaded.rules?.rules.I1) {
      throw new Error("loadGuides did not read the new files");
    }
  });
});

test("a failed call keeps the file and its ids, a skipped one removes them", async () => {
  await withReposDir(async (dir) => {
    await write(WRITTEN);
    const kept = await write({ status: "failed" });
    if (!(await exists(`${dir}/INSTRUCTIONS.md`))) {
      throw new Error("a failed call removed INSTRUCTIONS.md");
    }
    if (!kept.lines.some((line) => line.includes("not regenerated"))) {
      throw new Error(`no keep line:\n${kept.lines.join("\n")}`);
    }
    let rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (!rules?.rules.I1) throw new Error("a failed call dropped I1");

    const skipped = await write({
      status: "skipped",
      reason: "--include-codebase is off",
    });
    if (await exists(`${dir}/INSTRUCTIONS.md`)) {
      throw new Error("a skipped build kept INSTRUCTIONS.md");
    }
    if (
      !skipped.lines.includes(
        "[write] INSTRUCTIONS.md skipped: --include-codebase is off",
      )
    ) {
      throw new Error(`skip line:\n${skipped.lines.join("\n")}`);
    }
    rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (rules?.rules.I1) throw new Error("a skipped build kept I1");
  });
});

test("a later build reports what changed by source", async () => {
  await withReposDir(async () => {
    await write(
      written([
        { id: "I1", text: "Format amounts.", line: 31 },
        { id: "I2", text: "Old rule.", line: 9 },
      ]),
    );
    const { result, lines } = await write(
      written([
        { id: "I1", text: "Format every amount.", line: 31 },
        { id: "I2", text: "New rule.", line: 40 },
      ]),
    );
    if (
      !lines.includes(
        "[instructions] 1 rule added (AGENTS.md:40) · 1 rewritten (I1) · 1 dropped (AGENTS.md:9)",
      )
    ) {
      throw new Error(`instructions line:\n${lines.join("\n")}`);
    }
    if (result.changes?.instructions.dropped[0]?.id !== "I2") {
      throw new Error(`json lists: ${JSON.stringify(result.changes)}`);
    }
  });
});

test("buildInstructions says why it skipped, and the JSON names the status", async () => {
  const never: AiProvider = {
    complete: (): Promise<AiResponse> => {
      throw new Error("the model must not be asked");
    },
  };
  const usage = async () => {};
  const cases: [Parameters<typeof testOptions>[0], string][] = [
    [{ includeCodebase: false }, "--include-codebase is off"],
    [{ agentInstructions: "" }, "--agent-instructions is blank"],
    [{}, "no file matches (^|/)AGENTS\\.md$"],
  ];
  for (const [overrides, reason] of cases) {
    const outcome = await buildInstructions(
      never,
      testOptions(overrides),
      testSource(),
      usage,
    );
    if (outcome.status !== "skipped" || outcome.reason !== reason) {
      throw new Error(
        `${JSON.stringify(overrides)}: ${JSON.stringify(outcome)}`,
      );
    }
  }
  const json = instructionsJson(WRITTEN);
  if (json.status !== "written" || json.rules !== 1) {
    throw new Error(`json: ${JSON.stringify(json)}`);
  }
  if (instructionsJson({ status: "failed" }).status !== "kept") {
    throw new Error("a failed call is not reported as kept");
  }
});
