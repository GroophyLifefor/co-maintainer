/** What the fake AI answers when `e2e:simulate` runs without `--ai`.
 *
 * The product talks to a real provider client (OpenRouter's); the simulated
 * fetch hands each chat request here. Answers are written for `sim/sample`, so
 * the deterministic checks see real facts and sections, not empty output. A
 * score computed on them measures nothing about a model and the report marks
 * it as fake. */
import { promptOf } from "../fake_openrouter.ts";

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

function answer(prompt: string): string {
  if (prompt.includes("canonical repository files")) {
    return JSON.stringify(CODEBASE_FACTS);
  }
  const section = /Write only the Markdown for the "([^"]+)" section/.exec(
    prompt,
  );
  if (section) {
    const bullets = SECTION_BULLETS[section[1]] ?? [
      "Follow the repository convention.",
    ];
    // `cleanSection` replaces the heading with the canonical title.
    return `## ${section[1]}\n\n${bullets.map((line) => `- ${line}`).join("\n")}\n`;
  }
  return "[]";
}

/** An OpenRouter chat completion for `body`. Token counts are the prompt and
 * answer length over four, so they move when a prompt grows; cost is zero. */
export function fakeChatCompletion(body: Record<string, unknown>): unknown {
  const prompt = promptOf(body);
  const content = answer(prompt);
  return {
    id: "simulate",
    model: String(body.model ?? "fake"),
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content } },
    ],
    usage: {
      prompt_tokens: Math.ceil(prompt.length / 4),
      completion_tokens: Math.ceil(content.length / 4),
      cost: 0,
    },
  };
}
