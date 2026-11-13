import { test } from "node:test";
import {
  checkInstructionRules,
  instructionRuleEntries,
  instructionsRequest,
  instructionsWriteLine,
  parseInstructionRules,
  renderInstructions,
  synthesizeInstructions,
} from "./instructions.ts";
import { cacheDeletePrefix } from "../store/cache_db.ts";
import type { AiProvider, AiRequest, AiResponse } from "../types.ts";

const FILES = {
  "AGENTS.md": [
    "# Agent notes",
    "",
    "Run `npm install` before anything else.",
    "Format amounts with `formatMoney()`, never with number methods.",
    "Every test lives next to its module.",
  ].join("\n"),
  "packages/api/AGENTS.md": [
    "# API",
    "Every new route declares its rate limit in `limits.ts`.",
  ].join("\n"),
};

const TREE = [
  "AGENTS.md",
  "packages/api/AGENTS.md",
  "packages/api/limits.ts",
  "src/money.ts",
];

class Answer implements AiProvider {
  requests: AiRequest[] = [];
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  async complete(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    return {
      text: this.text,
      tokensIn: 1,
      tokensOut: 1,
      model: "fixture",
      provider: "openrouter",
    };
  }
}

test("the request numbers every line and names the job", () => {
  const request = instructionsRequest(FILES);
  if (request.job !== "synth_instructions") {
    throw new Error(`job is ${request.job}`);
  }
  if (!request.prompt.includes("=== AGENTS.md ===\n1: # Agent notes")) {
    throw new Error("the file is not numbered from line 1");
  }
  if (!request.prompt.includes("4: Format amounts")) {
    throw new Error("line numbers are off");
  }
  if (
    !/Drop setup steps, commands to run, tool and MCP usage/.test(
      request.prompt,
    )
  ) {
    throw new Error("the prompt does not drop setup and tool lines");
  }
});

test("parse accepts the rules object, a fenced one, and an empty list, and refuses prose", () => {
  const plain = parseInstructionRules(
    '{"rules":[{"rule":"A","scope":"","sources":["AGENTS.md:4"]}]}',
  );
  if (plain?.length !== 1 || plain[0].sources[0] !== "AGENTS.md:4") {
    throw new Error(`plain: ${JSON.stringify(plain)}`);
  }
  const fenced = parseInstructionRules('```json\n{"rules":[]}\n```');
  if (!fenced || fenced.length !== 0)
    throw new Error("fenced empty list failed");
  if (parseInstructionRules("Here are the rules.") !== null) {
    throw new Error("prose was accepted");
  }
  if (parseInstructionRules('{"items":[]}') !== null) {
    throw new Error("an object without rules was accepted");
  }
});

test("the guard drops a rule whose source is not a real line or whose name is unknown", () => {
  const { rules, counts } = checkInstructionRules(
    [
      {
        rule: "Format amounts with `formatMoney()`, never with number methods.",
        scope: "",
        sources: ["AGENTS.md:4"],
      },
      { rule: "Line past the end.", scope: "", sources: ["AGENTS.md:99"] },
      { rule: "A blank line.", scope: "", sources: ["AGENTS.md:2"] },
      { rule: "A file not read.", scope: "", sources: ["OTHER.md:1"] },
      { rule: "No source at all.", scope: "", sources: [] },
      {
        rule: "Call `inventedHelper` for every amount.",
        scope: "",
        sources: ["AGENTS.md:4"],
      },
    ],
    FILES,
    TREE,
  );
  if (rules.length !== 1 || !rules[0].text.startsWith("Format amounts")) {
    throw new Error(`kept ${JSON.stringify(rules)}`);
  }
  if (counts.unsupportedSource !== 4 || counts.unknownName !== 1) {
    throw new Error(`counts ${JSON.stringify(counts)}`);
  }
});

test("a path in backticks passes when it is in the tree, and rules with the same text merge", () => {
  const { rules } = checkInstructionRules(
    [
      {
        rule: "Keep money code in `src/money.ts`.",
        scope: "",
        sources: ["AGENTS.md:4"],
      },
      {
        rule: "keep money code in `src/money.ts`",
        scope: "",
        sources: ["AGENTS.md:5", "AGENTS.md:4"],
      },
    ],
    FILES,
    TREE,
  );
  if (rules.length !== 1)
    throw new Error(`not merged: ${JSON.stringify(rules)}`);
  const sources = rules[0].sources.map(({ path, line }) => `${path}:${line}`);
  if (sources.join(",") !== "AGENTS.md:4,AGENTS.md:5") {
    throw new Error(`sources ${sources.join(",")}`);
  }
});

test("a rule from a nested file gets that file's folder unless the model named a real one", () => {
  const { rules } = checkInstructionRules(
    [
      {
        rule: "Every new route declares its rate limit in `limits.ts`.",
        scope: "",
        sources: ["packages/api/AGENTS.md:2"],
      },
      {
        rule: "Every test lives next to its module.",
        scope: "invented/folder/",
        sources: ["AGENTS.md:5"],
      },
      {
        rule: "Format amounts with `formatMoney()`.",
        scope: "packages/api",
        sources: ["AGENTS.md:4"],
      },
    ],
    FILES,
    TREE,
  );
  const scopes = rules.map((rule) => rule.scope);
  if (scopes.join("|") !== "packages/api/||packages/api/") {
    throw new Error(`scopes ${scopes.join("|")}`);
  }
});

test("the file is written by code, numbered I1 upward, with a scope prefix", () => {
  const { rules } = checkInstructionRules(
    [
      {
        rule: "Format amounts with `formatMoney()`, never with number methods.",
        scope: "",
        sources: ["AGENTS.md:4"],
      },
      {
        rule: "Every new route declares its rate limit in `limits.ts`.",
        scope: "",
        sources: ["packages/api/AGENTS.md:2"],
      },
    ],
    FILES,
    TREE,
  );
  const rendered = renderInstructions(rules, null);
  const want = `# Repository instructions

Rules from this repository's agent instruction files that a reviewer can check in a diff.

- Format amounts with \`formatMoney()\`, never with number methods. [I1]
- In \`packages/api/\`: every new route declares its rate limit in \`limits.ts\`. [I2]
`;
  if (rendered.markdown !== want) {
    throw new Error(`rendered:\n${rendered.markdown}`);
  }
  if (rendered.rules.map((rule) => rule.id).join(",") !== "I1,I2") {
    throw new Error("ids are not numbered in file order");
  }
  const entries = instructionRuleEntries(rendered.rules, "abc123");
  if (
    entries.I1.text !==
      "Format amounts with formatMoney(), never with number methods." ||
    entries.I1.commit !== "abc123" ||
    entries.I2.scope !== "packages/api/" ||
    JSON.stringify(entries.I2.sources) !==
      '[{"path":"packages/api/AGENTS.md","line":2}]'
  ) {
    throw new Error(`entries ${JSON.stringify(entries)}`);
  }
});

test("rules stop at the cap in the model's order and the rest are counted", () => {
  const rules = Array.from({ length: 5 }, (_, index) => ({
    text: `Rule number ${index + 1} holds.`,
    scope: "",
    sources: [{ path: "AGENTS.md", line: 4 }],
  }));
  const header = renderInstructions([], null).markdown.length;
  const line = "- Rule number 1 holds. [I1]\n".length;
  const rendered = renderInstructions(rules, header + line * 2);
  if (rendered.rules.length !== 2 || rendered.overCap !== 3) {
    throw new Error(
      `kept ${rendered.rules.length}, over the cap ${rendered.overCap}`,
    );
  }
  if (rendered.markdown.length > header + line * 2) {
    throw new Error("the file is over its cap");
  }
  const write = instructionsWriteLine(2, {
    unsupportedSource: 2,
    unknownName: 0,
    overCap: 3,
  });
  if (
    write !==
    "INSTRUCTIONS.md · 2 rules · 2 dropped (unsupported source) · 3 over the cap"
  ) {
    throw new Error(`write line: ${write}`);
  }
});

test("synthesis writes the checked rules, and is failed or empty when it should be", async () => {
  const repo = `instructions-${crypto.randomUUID()}`;
  try {
    const good = await synthesizeInstructions(
      new Answer(
        JSON.stringify({
          rules: [
            {
              rule: "Format amounts with `formatMoney()`, never with number methods.",
              scope: "",
              sources: ["AGENTS.md:4"],
            },
            {
              rule: "Run npm install first.",
              scope: "",
              sources: ["AGENTS.md:40"],
            },
          ],
        }),
      ),
      repo,
      "openrouter",
      "fixture",
      FILES,
      TREE,
      6000,
    );
    if (good.status !== "written" || good.rules.length !== 1) {
      throw new Error(`good: ${JSON.stringify(good)}`);
    }
    if (good.counts.unsupportedSource !== 1) {
      throw new Error("the bad rule was not counted");
    }
    const prose = await synthesizeInstructions(
      new Answer("I could not find any rules."),
      `${repo}-prose`,
      "openrouter",
      "fixture",
      FILES,
      TREE,
      6000,
    );
    if (prose.status !== "failed") {
      throw new Error(`prose: ${prose.status}`);
    }
    const none = await synthesizeInstructions(
      new Answer('{"rules":[]}'),
      `${repo}-none`,
      "openrouter",
      "fixture",
      FILES,
      TREE,
      6000,
    );
    if (none.status !== "empty") throw new Error(`none: ${none.status}`);
  } finally {
    for (const suffix of ["", "-prose", "-none"]) {
      await cacheDeletePrefix("ai-jobs", `${repo}${suffix}:`);
    }
  }
});

test("an unchanged input is answered from the cache on the next build", async () => {
  const repo = `instructions-cache-${crypto.randomUUID()}`;
  const answer = new Answer(
    '{"rules":[{"rule":"Every test lives next to its module.","scope":"","sources":["AGENTS.md:5"]}]}',
  );
  try {
    for (let run = 0; run < 2; run++) {
      const result = await synthesizeInstructions(
        answer,
        repo,
        "openrouter",
        "fixture",
        FILES,
        TREE,
        6000,
      );
      if (result.status !== "written") throw new Error(result.status);
    }
    if (answer.requests.length !== 1) {
      throw new Error(`the model was asked ${answer.requests.length} times`);
    }
  } finally {
    await cacheDeletePrefix("ai-jobs", `${repo}:`);
  }
});
