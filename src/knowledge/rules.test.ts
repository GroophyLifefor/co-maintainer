import { test } from "node:test";
import {
  parseRules,
  rulesFileText,
  sortedRuleIds,
  sourceLabel,
} from "./rules.ts";

test("RULES.json round-trips and orders rules by number", () => {
  const text = rulesFileText({
    schemaVersion: 1,
    builtAt: "2026-11-13T09:00:00.000Z",
    rules: {
      I10: { file: "INSTRUCTIONS.md", text: "c", sources: [] },
      I2: { file: "INSTRUCTIONS.md", text: "b", sources: [] },
      I1: {
        file: "INSTRUCTIONS.md",
        text: "a",
        commit: "abc",
        scope: "",
        sources: [{ path: "AGENTS.md", line: 31 }],
      },
    },
  });
  const parsed = parseRules(text);
  if (!parsed) throw new Error("did not parse");
  if (Object.keys(parsed.rules).join(",") !== "I1,I2,I10") {
    throw new Error(`order: ${Object.keys(parsed.rules).join(",")}`);
  }
  if (sortedRuleIds(parsed.rules).join(",") !== "I1,I2,I10") {
    throw new Error("sortedRuleIds disagrees with the file order");
  }
  if (
    parsed.rules.I1.commit !== "abc" ||
    parsed.builtAt !== "2026-11-13T09:00:00.000Z"
  ) {
    throw new Error(`fields lost: ${text}`);
  }
});

test("a file of another schema or with bad entries is refused or trimmed", () => {
  if (parseRules("not json") !== null) throw new Error("prose parsed");
  if (parseRules('{"schemaVersion":2,"rules":{}}') !== null) {
    throw new Error("a newer schema parsed");
  }
  const parsed = parseRules(
    JSON.stringify({
      schemaVersion: 1,
      builtAt: "x",
      rules: {
        X7: { file: "a", text: "b", sources: [] },
        I1: {
          file: "INSTRUCTIONS.md",
          text: "ok",
          sources: [{ path: "AGENTS.md", line: 3 }, { nope: 1 }],
        },
        I2: { text: "no file" },
      },
    }),
  );
  if (Object.keys(parsed?.rules ?? {}).join(",") !== "I1") {
    throw new Error(`kept ${Object.keys(parsed?.rules ?? {}).join(",")}`);
  }
  if (parsed?.rules.I1.sources.length !== 1) {
    throw new Error("a bad source was kept");
  }
});

test("a source label reads the way the reports print it", () => {
  if (sourceLabel({ path: "AGENTS.md", line: 31 }) !== "AGENTS.md:31") {
    throw new Error("line label");
  }
});
