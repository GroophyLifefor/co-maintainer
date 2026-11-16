import { test } from "node:test";
import {
  compareRules,
  contradictionLine,
  contradictions,
  ruleChangeLine,
} from "./rule_changes.ts";
import type { RuleEntry } from "./rules.ts";

function guide(text: string, prs: number[]): RuleEntry {
  return {
    file: "PR_REVIEW_GUIDE.md",
    text,
    sources: prs.map((pr) => ({ pr })),
  };
}

test("rules are matched by their pull requests, not their text", () => {
  const previous = {
    R1: guide("Money goes through formatMoney · rounding differs", [212]),
    R2: guide(
      "Endpoints declare a rate limit · the limiter is bypassed",
      [198],
    ),
    R3: guide("Old rule · gone now", [101]),
    R4: guide("Tests sit next to modules · they get lost", [150]),
    I1: {
      file: "INSTRUCTIONS.md",
      text: "Keep it",
      sources: [{ path: "AGENTS.md", line: 3 }],
    },
  };
  const next = {
    R1: guide(
      "Endpoints declare a rate limit · the limiter is bypassed",
      [198],
    ),
    R2: guide(
      "Money formatting goes through formatMoney · rounding differs per currency",
      [212, 340],
    ),
    R3: guide("Tests sit next to modules · they get lost", [150]),
    R4: guide(
      "New migrations are reversible · a rollback fails otherwise",
      [402],
    ),
    R5: guide("Workflows pin actions · a moved tag runs with secrets", [407]),
    R6: guide("A line with no bracket · it has no sources", []),
  };
  const changes = compareRules(
    previous,
    next,
    "R",
    new Set([198, 212, 340, 150, 402, 407]),
  );
  if (changes.unchanged !== 2) {
    throw new Error(`unchanged ${changes.unchanged}`);
  }
  if (changes.added.map((rule) => rule.id).join(",") !== "R4,R5") {
    throw new Error(`added ${JSON.stringify(changes.added)}`);
  }
  if (
    changes.rewritten.length !== 1 ||
    changes.rewritten[0].id !== "R2" ||
    changes.rewritten[0].previous.join(",") !== "R1" ||
    changes.rewritten[0].joined.join(",") !== "#340"
  ) {
    throw new Error(`rewritten ${JSON.stringify(changes.rewritten)}`);
  }
  if (
    changes.dropped.length !== 1 ||
    changes.dropped[0].id !== "R3" ||
    changes.dropped[0].leftWindow.join(",") !== "#101"
  ) {
    throw new Error(`dropped ${JSON.stringify(changes.dropped)}`);
  }
  const line = ruleChangeLine(changes);
  if (
    line !==
    "2 rules added (#402, #407) · 1 rewritten (R2, #340 joined) · 1 dropped (#101 left the window)"
  ) {
    throw new Error(`line: ${line}`);
  }
});

test("instruction rules compare by their file lines, and an identical build changes nothing", () => {
  const rules = {
    I1: {
      file: "INSTRUCTIONS.md",
      text: "Format amounts with formatMoney().",
      sources: [{ path: "AGENTS.md", line: 31 }],
    },
  };
  const same = compareRules(rules, rules, "I");
  if (ruleChangeLine(same) !== "no rule changed" || same.unchanged !== 1) {
    throw new Error(`same: ${JSON.stringify(same)}`);
  }
  const moved = compareRules(
    rules,
    {
      I1: {
        file: "INSTRUCTIONS.md",
        text: "Format every amount with formatMoney().",
        sources: [{ path: "AGENTS.md", line: 31 }],
      },
      I2: {
        file: "INSTRUCTIONS.md",
        text: "New rule.",
        sources: [{ path: "AGENTS.md", line: 40 }],
      },
    },
    "I",
  );
  if (
    ruleChangeLine(moved) !== "1 rule added (AGENTS.md:40) · 1 rewritten (I1)"
  ) {
    throw new Error(`moved: ${ruleChangeLine(moved)}`);
  }
});

test("a contradiction is kept only when the new rule is newer than the old one", () => {
  const dated = (text: string, pr: number, mergedAt: string): RuleEntry => ({
    file: "PR_REVIEW_GUIDE.md",
    text,
    sources: [{ pr, mergedAt }],
  });
  const previous = {
    R4: dated("Round half down", 98, "2025-06-01"),
    R5: dated("Newer than the new one", 99, "2026-05-01"),
  };
  const next = { R9: dated("Round half up", 340, "2026-03-02") };
  const found = contradictions(
    previous,
    next,
    new Map([["R9", ["R4", "R5", "R77"]]]),
  );
  if (found.length !== 1 || found[0].id !== "R4") {
    throw new Error(JSON.stringify(found));
  }
  const line = contradictionLine(found[0]);
  if (line !== "R4 dropped, R9 goes against it (#340, 2026-03)") {
    throw new Error(line);
  }
});
