import { test } from "node:test";
import {
  mergedDate,
  parseRules,
  rulesFileText,
  sortedRuleIds,
  sourceLabel,
} from "./rules.ts";

test("RULES.json round-trips and orders guide rules before instruction rules", () => {
  const text = rulesFileText({
    schemaVersion: 1,
    builtAt: "2026-11-13T09:00:00.000Z",
    rules: {
      I2: { file: "INSTRUCTIONS.md", text: "b", sources: [] },
      R10: { file: "PR_REVIEW_GUIDE.md", text: "c", sources: [{ pr: 3 }] },
      I1: {
        file: "INSTRUCTIONS.md",
        text: "a",
        commit: "abc",
        scope: "",
        sources: [{ path: "AGENTS.md", line: 31 }],
      },
      R2: {
        file: "PR_REVIEW_GUIDE.md",
        text: "d",
        sources: [{ pr: 212, mergedAt: "2026-01-20" }],
      },
    },
  });
  const parsed = parseRules(text);
  if (!parsed) throw new Error("did not parse");
  if (Object.keys(parsed.rules).join(",") !== "R2,R10,I1,I2") {
    throw new Error(`order: ${Object.keys(parsed.rules).join(",")}`);
  }
  if (sortedRuleIds(parsed.rules).join(",") !== "R2,R10,I1,I2") {
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
        R1: {
          file: "PR_REVIEW_GUIDE.md",
          text: "ok",
          sources: [{ pr: 1 }, { nope: 1 }],
        },
        R2: { text: "no file" },
      },
    }),
  );
  if (Object.keys(parsed?.rules ?? {}).join(",") !== "R1") {
    throw new Error(`kept ${Object.keys(parsed?.rules ?? {}).join(",")}`);
  }
  if (parsed?.rules.R1.sources.length !== 1) {
    throw new Error("a bad source was kept");
  }
});

test("source labels and merge dates read the way the reports print them", () => {
  if (sourceLabel({ pr: 212 }) !== "#212") throw new Error("pr label");
  if (sourceLabel({ path: "AGENTS.md", line: 31 }) !== "AGENTS.md:31") {
    throw new Error("line label");
  }
  if (mergedDate("2026-03-04T10:00:00Z") !== "2026-03-04") {
    throw new Error("merge date");
  }
  if (mergedDate(undefined) !== undefined || mergedDate("") !== undefined) {
    throw new Error("a missing date made one up");
  }
});
