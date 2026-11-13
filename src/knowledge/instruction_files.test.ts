import { test } from "node:test";
import {
  agentInstructionsError,
  agentInstructionsLimit,
  agentInstructionsPattern,
  capInstructionFiles,
  DEFAULT_AGENT_INSTRUCTIONS_MAX_CHARS,
  leftOutLine,
  matchInstructionPaths,
} from "./instruction_files.ts";

test("the default pattern matches AGENTS.md at any depth and nothing else", () => {
  const pattern = agentInstructionsPattern(undefined);
  if (!pattern) throw new Error("the default turned the feature off");
  const tree = [
    "AGENTS.md",
    "packages/billing/AGENTS.md",
    "CLAUDE.md",
    "docs/AGENTS.md.bak",
    "NOTAGENTS.md",
  ];
  const matched = matchInstructionPaths(tree, pattern);
  if (matched.join(",") !== "AGENTS.md,packages/billing/AGENTS.md") {
    throw new Error(`matched ${matched.join(",")}`);
  }
});

test("a blank pattern turns the feature off and a custom one is a full-path regex", () => {
  if (agentInstructionsPattern("") !== null) {
    throw new Error("a blank pattern did not turn the feature off");
  }
  if (agentInstructionsPattern("   ") !== null) {
    throw new Error("a whitespace pattern did not turn the feature off");
  }
  const pattern = agentInstructionsPattern("(^|/)(AGENTS|CLAUDE)\\.md$");
  const matched = matchInstructionPaths(
    ["CLAUDE.md", "src/AGENTS.md", "README.md"],
    pattern!,
  );
  if (matched.join(",") !== "CLAUDE.md,src/AGENTS.md") {
    throw new Error(`matched ${matched.join(",")}`);
  }
});

test("a pattern that does not compile is named with its parse error", () => {
  if (agentInstructionsError("(^|/)AGENTS\\.md$") !== null) {
    throw new Error("a valid pattern was refused");
  }
  const error = agentInstructionsError("(unclosed");
  if (!error) throw new Error("an invalid pattern was accepted");
  let message = "";
  try {
    agentInstructionsPattern("(unclosed");
  } catch (thrown) {
    message = String(thrown);
  }
  if (!message.includes("not a valid regular expression")) {
    throw new Error(`unclear error: ${message}`);
  }
});

test("the cap defaults to 6000 and 0 or below means no limit", () => {
  if (
    agentInstructionsLimit(undefined) !== DEFAULT_AGENT_INSTRUCTIONS_MAX_CHARS
  ) {
    throw new Error("unset did not take the default");
  }
  if (DEFAULT_AGENT_INSTRUCTIONS_MAX_CHARS !== 6000) {
    throw new Error("the default cap moved");
  }
  if (
    agentInstructionsLimit(0) !== null ||
    agentInstructionsLimit(-1) !== null
  ) {
    throw new Error("0 or a negative did not mean no limit");
  }
  if (agentInstructionsLimit(8000) !== 8000) {
    throw new Error("a set cap was not kept");
  }
});

test("root files come first, then deeper ones, alphabetical within a depth", () => {
  const pattern = agentInstructionsPattern(undefined)!;
  const matched = matchInstructionPaths(
    ["z/y/AGENTS.md", "b/AGENTS.md", "AGENTS.md", "a/AGENTS.md"],
    pattern,
  );
  if (matched.join(",") !== "AGENTS.md,a/AGENTS.md,b/AGENTS.md,z/y/AGENTS.md") {
    throw new Error(`order is ${matched.join(",")}`);
  }
});

test("the size cap leaves out a file that would cross it and keeps later smaller ones", () => {
  const selection = capInstructionFiles(
    [
      { path: "AGENTS.md", content: "a".repeat(60) },
      { path: "big/AGENTS.md", content: "b".repeat(50) },
      { path: "small/AGENTS.md", content: "c".repeat(30) },
      { path: "gone/AGENTS.md", content: undefined },
    ],
    100,
  );
  if (Object.keys(selection.files).join(",") !== "AGENTS.md,small/AGENTS.md") {
    throw new Error(`kept ${Object.keys(selection.files).join(",")}`);
  }
  const reasons = selection.leftOut.map(
    ({ path, reason }) => `${path}=${reason}`,
  );
  if (
    reasons.join("|") !==
    "big/AGENTS.md=over the 100-character cap|gone/AGENTS.md=could not be read"
  ) {
    throw new Error(`left out ${reasons.join("|")}`);
  }
  const line = leftOutLine(selection.leftOut);
  if (!line.includes("big/AGENTS.md (over the 100-character cap)")) {
    throw new Error(`the log line does not name the file: ${line}`);
  }
});
