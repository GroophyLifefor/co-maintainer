import { test } from "node:test";
import {
  buildInstructions,
  instructionsJson,
  writeInstructionsAndRules,
  type InstructionsOutcome,
} from "./rules_build.ts";
import { loadGuides, withKnowledgeLock } from "../review/guides.ts";
import { parseRules } from "../knowledge/rules.ts";
import type { ReviewDocuments } from "../knowledge/guide.ts";
import { testOptions, testSource } from "../testing/helpers.ts";
import { withLogSink } from "../util/log.ts";
import type { AiProvider, AiResponse } from "../types.ts";
import { mkdir, readTextFile, stat } from "../util/runtime.ts";
import { withIsolatedHome } from "../testing/isolated_home.ts";

const REPO = `acme/rules-${crypto.randomUUID()}`;

async function withReposDir(fn: (dir: string) => Promise<void>): Promise<void> {
  await withIsolatedHome(async (root) => {
    const dir = `${root}/repos/${REPO}`;
    await mkdir(dir, { recursive: true });
    await fn(dir);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const WRITTEN: InstructionsOutcome = {
  status: "written",
  markdown:
    "# Repository instructions\n\nRules.\n\n- Format amounts with `formatMoney()`. [I1]\n",
  rules: [
    {
      id: "I1",
      text: "Format amounts with `formatMoney()`.",
      scope: "",
      sources: [{ path: "AGENTS.md", line: 31 }],
    },
  ],
  counts: { unsupportedSource: 2, unknownName: 0, overCap: 0 },
};

function documents(
  rules: { id: string; prs: number[]; text: string }[],
): ReviewDocuments {
  return {
    guide: "# Guide\n",
    rules: rules.map((rule, index) => ({
      id: rule.id,
      file: "PR_REVIEW_GUIDE.md",
      text: rule.text,
      findings: [index + 1],
      pullRequests: rule.prs,
    })),
    counts: [{ file: "PR_REVIEW_GUIDE.md", rules: 4, withIds: rules.length }],
  };
}

async function write(
  docs: ReviewDocuments | undefined,
  instructions: InstructionsOutcome,
  signalCount = 5,
  command: "init" | "remake" = "remake",
) {
  const lines: string[] = [];
  const source = testSource({
    commits: [{ sha: "abc123" }],
    pullRequests: [
      {
        number: 212,
        mergedAt: "2026-01-20T08:00:00Z",
      },
      { number: 340 },
    ] as never,
  });
  const result = await withLogSink(
    (phase, message) => void lines.push(`[${phase}] ${message}`),
    () =>
      withKnowledgeLock(REPO, () =>
        writeInstructionsAndRules({
          repo: REPO,
          command,
          documents: docs,
          signalCount,
          instructions,
          source,
        }),
      ),
  );
  return { result, lines };
}

test("a sync with no instruction file and nothing from before writes and says nothing", async () => {
  await withReposDir(async (dir) => {
    const skipped: InstructionsOutcome = {
      status: "skipped",
      reason: "no file matches (^|/)AGENTS\\.md$",
    };
    const sync = await write(undefined, skipped);
    if (sync.lines.length > 0 || sync.result.reported) {
      throw new Error(`a quiet sync spoke: ${sync.lines.join("\n")}`);
    }
    if (await exists(`${dir}/RULES.json`)) {
      throw new Error("RULES.json was written with no rule");
    }
    const init = await write(undefined, skipped, 5, "init");
    if (
      init.lines.join("\n") !==
      "[write] INSTRUCTIONS.md skipped: no file matches (^|/)AGENTS\\.md$"
    ) {
      throw new Error(`init did not say why: ${init.lines.join("\n")}`);
    }
  });
});

test("a build writes INSTRUCTIONS.md and RULES.json, and the loader reads both", async () => {
  await withReposDir(async (dir) => {
    const { result, lines } = await write(
      documents([{ id: "R1", prs: [212, 340], text: "Money · rounding" }]),
      WRITTEN,
    );
    if (result.changes !== null) {
      throw new Error("a first build reported changes");
    }
    if (
      !lines.includes(
        "[write] INSTRUCTIONS.md · 1 rule · 2 dropped (unsupported source) · 0 over the cap",
      ) ||
      !lines.includes("[write] PR_REVIEW_GUIDE.md · 4 rules · 1 with sources")
    ) {
      throw new Error(`build output:\n${lines.join("\n")}`);
    }
    const rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (
      JSON.stringify(rules?.rules.R1.sources) !==
        '[{"pr":212,"mergedAt":"2026-01-20"},{"pr":340}]' ||
      rules?.rules.I1.commit !== "abc123" ||
      rules?.rules.I1.text !== "Format amounts with formatMoney()."
    ) {
      throw new Error(`RULES.json: ${JSON.stringify(rules)}`);
    }
    const loaded = await loadGuides(REPO);
    if (!loaded.instructions.includes("[I1]") || !loaded.rules?.rules.R1) {
      throw new Error("loadGuides did not read the new files");
    }
  });
});

test("a failed call keeps the file and its ids, a skipped one removes them", async () => {
  await withReposDir(async (dir) => {
    await write(undefined, WRITTEN);
    const kept = await write(undefined, { status: "failed" });
    if (!(await exists(`${dir}/INSTRUCTIONS.md`))) {
      throw new Error("a failed call removed INSTRUCTIONS.md");
    }
    if (!kept.lines.some((line) => line.includes("not regenerated"))) {
      throw new Error(`no keep line:\n${kept.lines.join("\n")}`);
    }
    const rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (!rules?.rules.I1) throw new Error("a failed call dropped I1");

    const skipped = await write(undefined, {
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
    if (await exists(`${dir}/RULES.json`)) {
      throw new Error("a skipped build kept RULES.json with no rule in it");
    }
  });
});

test("guide rules alone write RULES.json, and a sync does not name a skip it had no file for", async () => {
  await withReposDir(async (dir) => {
    const skipped: InstructionsOutcome = {
      status: "skipped",
      reason: "no file matches (^|/)AGENTS\\.md$",
    };
    const { lines } = await write(
      documents([{ id: "R1", prs: [212], text: "A · b" }]),
      skipped,
    );
    if (lines.some((line) => line.includes("INSTRUCTIONS.md"))) {
      throw new Error(`a sync named a skip:\n${lines.join("\n")}`);
    }
    const rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (!rules?.rules.R1) throw new Error("guide rules were not written");
  });
});

test("a guide kept from the last run keeps its R ids, a removed one loses them", async () => {
  await withReposDir(async (dir) => {
    await write(documents([{ id: "R1", prs: [212], text: "A · b" }]), WRITTEN);
    await write(undefined, WRITTEN, 5);
    let rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (!rules?.rules.R1) throw new Error("a kept guide lost its ids");
    await write(undefined, WRITTEN, 1);
    rules = parseRules(await readTextFile(`${dir}/RULES.json`));
    if (rules?.rules.R1) throw new Error("a removed guide kept its ids");
  });
});

test("a later build reports what changed by source", async () => {
  await withReposDir(async () => {
    await write(
      documents([
        { id: "R1", prs: [212], text: "Money · rounding" },
        { id: "R2", prs: [101], text: "Old · gone" },
      ]),
      WRITTEN,
    );
    const { result, lines } = await write(
      documents([
        { id: "R1", prs: [212, 340], text: "Money formatting · rounding" },
        { id: "R2", prs: [402], text: "New · rule" },
      ]),
      WRITTEN,
    );
    const guideLine = lines.find((line) => line.startsWith("[guide]"));
    if (
      guideLine !==
      "[guide] 1 rule added (#402) · 1 rewritten (R1, #340 joined) · 1 dropped (#101 left the window)"
    ) {
      throw new Error(`guide line: ${guideLine}`);
    }
    if (!lines.includes("[instructions] no rule changed")) {
      throw new Error(`instructions line:\n${lines.join("\n")}`);
    }
    if (result.changes?.guide.dropped[0]?.id !== "R2") {
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
