import { test } from "node:test";
import { compareRules, ruleChangeLine } from "./rule_changes.ts";
import type { RuleEntry } from "./rules.ts";

function rule(text: string, lines: number[]): RuleEntry {
  return {
    file: "INSTRUCTIONS.md",
    text,
    sources: lines.map((line) => ({ path: "AGENTS.md", line })),
  };
}

test("rules are matched by their file lines, not their text", () => {
  const previous = {
    I1: rule("Format amounts with formatMoney()", [31]),
    I2: rule("Routes declare a rate limit", [12]),
    I3: rule("Old rule", [9]),
    I4: rule("Tests sit next to modules", [20]),
  };
  const next = {
    I1: rule("Routes declare a rate limit", [12]),
    I2: rule("Format every amount with formatMoney()", [31, 32]),
    I3: rule("Tests sit next to modules", [20]),
    I4: rule("Migrations are reversible", [40]),
    I5: rule("Workflows pin actions", [41]),
    I6: rule("A rule with no source", []),
  };
  const changes = compareRules(previous, next, "I");
  if (changes.unchanged !== 2) {
    throw new Error(`unchanged ${changes.unchanged}`);
  }
  if (changes.added.map((item) => item.id).join(",") !== "I4,I5") {
    throw new Error(`added ${JSON.stringify(changes.added)}`);
  }
  if (
    changes.rewritten.length !== 1 ||
    changes.rewritten[0].id !== "I2" ||
    changes.rewritten[0].previous.join(",") !== "I1" ||
    changes.rewritten[0].joined.join(",") !== "AGENTS.md:32"
  ) {
    throw new Error(`rewritten ${JSON.stringify(changes.rewritten)}`);
  }
  if (changes.dropped.length !== 1 || changes.dropped[0].id !== "I3") {
    throw new Error(`dropped ${JSON.stringify(changes.dropped)}`);
  }
  const line = ruleChangeLine(changes);
  if (
    line !==
    "2 rules added (AGENTS.md:40, AGENTS.md:41) · 1 rewritten (I2, AGENTS.md:32 joined) · 1 dropped (AGENTS.md:9)"
  ) {
    throw new Error(`line: ${line}`);
  }
});

test("an identical build changes nothing, and a reworded rule is rewritten", () => {
  const rules = { I1: rule("Format amounts with formatMoney().", [31]) };
  const same = compareRules(rules, rules, "I");
  if (ruleChangeLine(same) !== "no rule changed" || same.unchanged !== 1) {
    throw new Error(`same: ${JSON.stringify(same)}`);
  }
  const moved = compareRules(
    rules,
    {
      I1: rule("Format every amount with formatMoney().", [31]),
      I2: rule("New rule.", [40]),
    },
    "I",
  );
  if (
    ruleChangeLine(moved) !== "1 rule added (AGENTS.md:40) · 1 rewritten (I1)"
  ) {
    throw new Error(`moved: ${ruleChangeLine(moved)}`);
  }
});
