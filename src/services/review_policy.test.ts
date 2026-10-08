import { test } from "node:test";
import {
  carriesEarlierRequest,
  describePolicy,
  evaluatePolicy,
  isRequestCommand,
  legacyPolicy,
  parsePolicy,
  policyToStore,
  storedPolicyValue,
  TEMPLATES,
  TEMPLATE_NAMES,
  withDefaults,
  type PolicyAction,
  type PolicyFacts,
  type PolicyInput,
  type PolicyRule,
  type ReviewPolicy,
} from "./review_policy.ts";

const base: PolicyFacts = { draft: false, bot: false };

function decide(input: PolicyInput, facts: Partial<PolicyFacts>) {
  return evaluatePolicy(withDefaults(input), { ...base, ...facts });
}

function expectAction(
  input: PolicyInput,
  facts: Partial<PolicyFacts>,
  action: PolicyAction,
  rule: number | null,
): void {
  const got = decide(input, facts);
  if (got.action !== action || got.rule !== rule) {
    throw new Error(
      `wanted ${action} by rule ${rule}, got ${got.action} by rule ${got.rule} (${got.reason})`,
    );
  }
}

test("the default action applies when no rule matches", () => {
  expectAction({ rules: [], default: "on-request" }, {}, "on-request", null);
  expectAction({ rules: [], default: "skip" }, {}, "skip", null);
});

test("the first matching rule wins, in order", () => {
  const input: PolicyInput = {
    rules: [
      { when: { draft: true }, action: "skip" },
      { when: { draft: true }, action: "review" },
      { when: {}, action: "on-request" },
    ],
    default: "review",
  };
  expectAction(input, { draft: true }, "skip", 1);
  expectAction(input, { draft: false }, "on-request", 3);
});

test("every condition in a rule has to hold", () => {
  const input: PolicyInput = {
    rules: [
      {
        when: { association: ["MEMBER"], fork: false, draft: false },
        action: "review",
      },
    ],
    default: "skip",
  };
  expectAction(input, { association: "MEMBER", fork: false }, "review", 1);
  expectAction(input, { association: "MEMBER", fork: true }, "skip", null);
  expectAction(input, { association: "NONE", fork: false }, "skip", null);
  expectAction(
    input,
    { association: "MEMBER", fork: false, draft: true },
    "skip",
    null,
  );
});

test("each condition kind matches on its own", () => {
  const skip = (rule: PolicyRule): PolicyInput => ({
    rules: [rule],
    default: "review",
  });
  expectAction(
    skip({ when: { association: ["NONE", "FIRST_TIMER"] }, action: "skip" }),
    { association: "FIRST_TIMER" },
    "skip",
    1,
  );
  expectAction(
    skip({ when: { fork: true }, action: "skip" }),
    { fork: true },
    "skip",
    1,
  );
  expectAction(
    skip({ when: { bot: true }, action: "skip" }),
    { bot: true },
    "skip",
    1,
  );
  expectAction(
    skip({ when: { labels: ["No-Review"] }, action: "skip" }),
    { labels: ["docs", "no-review"] },
    "skip",
    1,
  );
  expectAction(
    skip({ when: { targetBranch: ["release"] }, action: "skip" }),
    { targetBranch: "release" },
    "skip",
    1,
  );
  expectAction(
    skip({ when: { targetBranch: ["release"] }, action: "skip" }),
    { targetBranch: "main" },
    "review",
    null,
  );
});

test("a changed lines range includes both of its ends", () => {
  const input: PolicyInput = {
    rules: [{ when: { changedLines: { min: 10, max: 20 } }, action: "skip" }],
    default: "review",
  };
  expectAction(input, { changedLines: 9 }, "review", null);
  expectAction(input, { changedLines: 10 }, "skip", 1);
  expectAction(input, { changedLines: 20 }, "skip", 1);
  expectAction(input, { changedLines: 21 }, "review", null);
});

test("a fact GitHub did not send never satisfies a rule that asks about it", () => {
  const input: PolicyInput = {
    rules: [
      { when: { association: ["NONE"] }, action: "skip" },
      { when: { fork: true }, action: "skip" },
      { when: { labels: ["x"] }, action: "skip" },
      { when: { targetBranch: ["main"] }, action: "skip" },
      { when: { changedLines: { min: 0 } }, action: "skip" },
    ],
    default: "review",
  };
  expectAction(input, {}, "review", null);
});

test("the reason names the rule, or the default", () => {
  const input: PolicyInput = {
    rules: [
      { when: { draft: true }, action: "skip" },
      {
        name: "first time contributor",
        when: { association: ["FIRST_TIME_CONTRIBUTOR"] },
        action: "on-request",
      },
    ],
    default: "review",
  };
  const rule = decide(input, { association: "FIRST_TIME_CONTRIBUTOR" });
  if (
    rule.reason !==
    "Rule 2 (first time contributor): waiting for a maintainer request."
  ) {
    throw new Error(rule.reason);
  }
  const unnamed = decide(input, { draft: true });
  if (unnamed.reason !== "Rule 1: skipped by policy.") {
    throw new Error(unnamed.reason);
  }
  const fallback = decide(input, {});
  if (fallback.reason !== "Default rule: reviewing.") {
    throw new Error(fallback.reason);
  }
});

test("the templates decide the way their names say", () => {
  const trusted = TEMPLATES["trusted-auto"]!;
  expectAction(trusted, { association: "OWNER" }, "review", 3);
  expectAction(trusted, { association: "COLLABORATOR" }, "review", 3);
  expectAction(
    trusted,
    { association: "FIRST_TIME_CONTRIBUTOR" },
    "on-request",
    null,
  );
  expectAction(trusted, { association: "NONE" }, "on-request", null);
  expectAction(trusted, { association: "MEMBER", draft: true }, "skip", 1);
  expectAction(trusted, { association: "MEMBER", bot: true }, "skip", 2);

  const everyone = TEMPLATES.everyone!;
  expectAction(everyone, { association: "NONE" }, "review", null);
  expectAction(everyone, { draft: true }, "skip", 1);
  expectAction(everyone, { bot: true }, "skip", 2);

  const onRequest = TEMPLATES["on-request-only"]!;
  expectAction(onRequest, { association: "OWNER" }, "on-request", null);
  expectAction(onRequest, {}, "on-request", null);
});

test("the legacy policy is what the three old switches meant", () => {
  const off = legacyPolicy({ auto_review: 0, skip_drafts: 1, skip_bots: 1 });
  const offDraft = evaluatePolicy(off, { ...base, draft: true });
  if (offDraft.action !== "skip" || offDraft.reason !== "auto-review-off") {
    throw new Error(JSON.stringify(offDraft));
  }
  const on = legacyPolicy({ auto_review: 1, skip_drafts: 1, skip_bots: 1 });
  const draft = evaluatePolicy(on, { ...base, draft: true, bot: true });
  if (draft.action !== "skip" || draft.reason !== "draft") {
    throw new Error(`drafts are checked before bots: ${JSON.stringify(draft)}`);
  }
  const bot = evaluatePolicy(on, { ...base, bot: true });
  if (bot.action !== "skip" || bot.reason !== "bot-author") {
    throw new Error(JSON.stringify(bot));
  }
  const open = legacyPolicy({ auto_review: 1, skip_drafts: 0, skip_bots: 0 });
  if (
    evaluatePolicy(open, { ...base, draft: true, bot: true }).action !==
    "review"
  ) {
    throw new Error("with both switches off nothing is skipped");
  }
});

test("only the pull-request scope carries an earlier request forward", () => {
  const head = withDefaults({ approvalScope: "head" });
  const pull = withDefaults({ approvalScope: "pull-request" });
  if (carriesEarlierRequest(head, true)) throw new Error("head carried");
  if (!carriesEarlierRequest(pull, true)) throw new Error("pull did not carry");
  if (carriesEarlierRequest(pull, false)) throw new Error("nothing to carry");
});

test("a request command has to be the start of the comment, as a whole word", () => {
  const command = "/co-maintainer review";
  for (const yes of [
    "/co-maintainer review",
    "  /Co-Maintainer Review  ",
    "/co-maintainer review please",
    "/co-maintainer review\nthanks",
  ]) {
    if (!isRequestCommand(yes, command)) throw new Error(`missed: ${yes}`);
  }
  for (const no of [
    "please /co-maintainer review",
    "/co-maintainer reviewer",
    "/co-maintainer",
    "",
  ]) {
    if (isRequestCommand(no, command)) throw new Error(`matched: ${no}`);
  }
});

function problem(value: unknown): string {
  const parsed = parsePolicy(value);
  if (parsed.ok) throw new Error(`accepted ${JSON.stringify(value)}`);
  return parsed.problem;
}

test("parsePolicy turns a template name into a policy with the default settings", () => {
  for (const name of TEMPLATE_NAMES) {
    const parsed = parsePolicy(name);
    if (!parsed.ok) throw new Error(`${name}: ${parsed.problem}`);
    const policy: ReviewPolicy = parsed.value;
    if (policy.requestLabel !== "co-maintainer:review") throw new Error(name);
    if (policy.requestCommand !== "/co-maintainer review")
      throw new Error(name);
    if (policy.approvalScope !== "head") throw new Error(name);
    if (policy.requesters.join() !== "OWNER,MEMBER,COLLABORATOR") {
      throw new Error(name);
    }
  }
});

test("parsePolicy reads a full custom policy", () => {
  const parsed = parsePolicy({
    rules: [
      {
        name: "newcomers",
        when: { association: ["FIRST_TIMER"], changedLines: { max: 50 } },
        action: "on-request",
      },
    ],
    default: "review",
    requestLabel: "ask-bot",
    requestCommand: "/review",
    requesters: ["OWNER"],
    approvalScope: "pull-request",
    maxRounds: 3,
  });
  if (!parsed.ok) throw new Error(parsed.problem);
  const policy = parsed.value;
  if (
    policy.requestLabel !== "ask-bot" ||
    policy.approvalScope !== "pull-request" ||
    policy.maxRounds !== 3 ||
    policy.rules[0]?.name !== "newcomers"
  ) {
    throw new Error(JSON.stringify(policy));
  }
});

test("parsePolicy says what is wrong instead of guessing", () => {
  const cases: [unknown, RegExp][] = [
    ["nope", /unknown template "nope"/],
    [7, /template name or an object/],
    [{ surprise: 1 }, /unknown field "surprise"/],
    [{ default: "maybe" }, /default must be one of/],
    [{ rules: "x" }, /rules must be a list/],
    [{ rules: [{ when: {}, action: "later" }] }, /rules\[0\]\.action/],
    [
      { rules: [{ when: { association: ["BOSS"] }, action: "skip" }] },
      /"BOSS"/,
    ],
    [
      { rules: [{ when: { fork: "yes" }, action: "skip" }] },
      /fork must be true or false/,
    ],
    [
      { rules: [{ when: { colour: 1 }, action: "skip" }] },
      /unknown field "colour"/,
    ],
    [
      { rules: [{ when: { changedLines: { min: -1 } }, action: "skip" }] },
      /changedLines\.min/,
    ],
    [{ requestLabel: "" }, /requestLabel must be non-empty/],
    [{ approvalScope: "forever" }, /approvalScope/],
    [{ maxRounds: 0 }, /maxRounds/],
    [{ requesters: ["OWNER", 3] }, /requesters must be a list of strings/],
  ];
  for (const [value, expected] of cases) {
    const text = problem(value);
    if (!expected.test(text)) {
      throw new Error(`${JSON.stringify(value)}: ${text}`);
    }
  }
});

function said(input: PolicyInput): string[] {
  return describePolicy(withDefaults(input));
}

test("describePolicy reads each template as plain sentences", () => {
  const trusted = said(TEMPLATES["trusted-auto"]!);
  const want = [
    "Draft pull requests are not reviewed.",
    "Pull requests by bots are not reviewed.",
    "Pull requests by owners, members or collaborators are reviewed automatically.",
    "Any other pull request waits for a maintainer request.",
  ];
  for (const line of want) {
    if (!trusted.includes(line))
      throw new Error(`missing "${line}" in ${JSON.stringify(trusted)}`);
  }
  const ask = trusted.find((line) => line.includes("can ask"));
  if (
    !ask ||
    !ask.startsWith(
      "Owners, members and collaborators can ask by adding the label",
    ) ||
    !ask.includes("A request covers the commit it was made on.")
  ) {
    throw new Error(String(ask));
  }
  const everyone = said(TEMPLATES.everyone!);
  if (everyone.some((line) => line.includes("can ask"))) {
    throw new Error(
      "nothing waits for a request, so there is nothing to explain",
    );
  }
  const onlyRequested = said(TEMPLATES["on-request-only"]!);
  if (
    onlyRequested[0] !== "Every pull request waits for a maintainer request."
  ) {
    throw new Error(onlyRequested[0]);
  }
});

test("describePolicy names every kind of condition and the limits", () => {
  const lines = said({
    rules: [
      {
        when: {
          association: ["FIRST_TIME_CONTRIBUTOR", "NONE"],
          fork: true,
          labels: ["docs"],
          targetBranch: ["main"],
          changedLines: { min: 10, max: 50 },
        },
        action: "on-request",
      },
      { when: { changedLines: { max: 5 } }, action: "review" },
      { when: {}, action: "skip" },
    ],
    default: "review",
    approvalScope: "pull-request",
    maxRounds: 1,
  });
  const joined = lines.join("\n");
  for (const part of [
    "by first time contributors or people with no relation to the repository",
    "opened from a fork",
    "labeled docs",
    "into main",
    "changing 10 to 50 lines",
    "changing at most 5 lines",
    "All pull requests are not reviewed.",
    "A request covers every later push to the pull request.",
    "at most 1 review from the webhook.",
  ]) {
    if (!joined.includes(part))
      throw new Error(`missing "${part}" in\n${joined}`);
  }
});

test("a policy is stored as its template name only when it is exactly that template", () => {
  const everyone = parsePolicy("everyone");
  if (!everyone.ok || storedPolicyValue(everyone.value) !== "everyone") {
    throw new Error("a template must come back as its name");
  }
  const edited = parsePolicy({ ...TEMPLATES.everyone, maxRounds: 4 });
  if (!edited.ok) throw new Error(edited.problem);
  if (typeof storedPolicyValue(edited.value) === "string") {
    throw new Error("an edited template must stay a full policy");
  }
  const renamed = parsePolicy({
    rules: [{ name: "other name", when: { draft: true }, action: "skip" }],
    default: "review",
  });
  if (!renamed.ok || typeof storedPolicyValue(renamed.value) === "string") {
    throw new Error("a rule with another name is not the template");
  }
});

test("policyToStore keeps null, guards the legacy switches and validates the rest", () => {
  const check = (value: unknown, allowLegacy: boolean) =>
    policyToStore(value, { allowLegacy });
  const none = check(null, false);
  if (!none.ok || none.value !== null)
    throw new Error("null clears the choice");
  const legacy = check("legacy", true);
  if (!legacy.ok || legacy.value !== '"legacy"')
    throw new Error("legacy allowed");
  if (check("legacy", false).ok) throw new Error("legacy needs a repository");
  const named = check("trusted-auto", false);
  if (!named.ok || named.value !== '"trusted-auto"')
    throw new Error("template");
  if (check({ default: "maybe" }, true).ok)
    throw new Error("bad policy accepted");
});
