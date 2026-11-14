/** `init` with the codebase only, on the sample repository.
 *
 * The fake AI's answers are written for `sim/sample`, so the checks see real
 * facts and sections, not empty output. */
import { type InitContext, initChecks, initScores } from "../checks/init.ts";
import type { AiRule } from "../fake_ai.ts";
import { defineFlow, type Sim } from "../flow.ts";
import { SAMPLE_REPO, SAMPLE_REPO_NAME } from "../sample_repo.ts";

const CODEBASE_FACTS = [
  {
    sectionKey: "layout",
    claim:
      "Source modules live in `src/`, and `src/index.ts` re-exports the public functions.",
  },
  {
    sectionKey: "tests",
    claim: "Tests run with `npm test`, which is `node --test test/`.",
  },
  {
    sectionKey: "style",
    claim: "Functions are named exports, with no default exports.",
  },
  {
    sectionKey: "devloop",
    claim: "Type-check with `npm run check` before opening a pull request.",
  },
  {
    sectionKey: "ship",
    claim: "CI runs `npm run check` and `npm test` on every pull request.",
  },
].map((fact) => ({ ...fact, scope: "current", confidence: "high" }));

const SECTION_BULLETS: Record<string, string[]> = {
  identity: [
    "`sim/sample` is a small TypeScript library of math and formatting helpers.",
  ],
  layout: [
    "Source modules live in `src/`, and `src/index.ts` re-exports the public functions.",
    "Tests live in `test/`, one file per module.",
  ],
  tests: [
    "Run the tests with `npm test`.",
    "A change to `src/math.ts` comes with a test in `test/math.test.ts`.",
  ],
  style: ["Use named exports, not default exports."],
  devloop: ["Type-check with `npm run check` before opening a pull request."],
  ship: ["CI runs `npm run check` and `npm test` on every pull request."],
};

const SECTION = /Write only the Markdown for the "([^"]+)" section/;

/** What the model answers init with. */
export const INIT_AI: AiRule[] = [
  {
    name: "codebase facts",
    job: "extract_unit",
    prompt: "canonical repository files",
    reply: { json: CODEBASE_FACTS },
  },
  {
    name: "section",
    job: "synth_section",
    prompt: SECTION,
    reply: ({ prompt }) => {
      const key = SECTION.exec(prompt)![1]!;
      const bullets = SECTION_BULLETS[key] ?? [
        "Follow the repository convention.",
      ];
      // `cleanSection` replaces the heading with the canonical title.
      return `## ${key}\n\n${bullets.map((line) => `- ${line}`).join("\n")}\n`;
    },
  },
];

function context(sim: Sim): InitContext {
  return {
    repo: SAMPLE_REPO_NAME,
    reposDir: sim.paths.reposDir,
    appDbPath: sim.paths.appDb,
    cacheDbPath: sim.paths.cacheDb,
    error: sim.errors.get("init"),
    trace: sim.trace,
    ai: sim.mode,
    files: SAMPLE_REPO,
    judge: sim.judge,
  };
}

export default defineFlow({
  name: "init",
  description: "init with the codebase only, on the sample repository",
  ai: INIT_AI,
  steps: [
    {
      name: "repo opened",
      run(sim) {
        const repo = sim.repo(SAMPLE_REPO_NAME);
        return `${repo.fullName} · ${Object.keys(SAMPLE_REPO).length} files`;
      },
    },
    {
      name: "init",
      async run(sim) {
        const { runInitOrRemake } = await import("../../../services/setup.ts");
        await runInitOrRemake(
          sim.options({ command: "init", repo: SAMPLE_REPO_NAME }),
        );
        const calls = (list: { step: string }[]) =>
          list.filter((call) => call.step === "init").length;
        return `${sim.mode} AI · ${calls(sim.trace.ai)} AI calls · ${calls(sim.trace.github)} GitHub calls`;
      },
    },
  ],
  checks: (sim) => initChecks(context(sim)),
  scores: (sim) => initScores(context(sim)),
});
